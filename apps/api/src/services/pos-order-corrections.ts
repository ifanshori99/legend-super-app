// POS-04 corrections of a completed sale (bead legend-kk7; PRD v1.7 §3 F8
// "Diskon, Void & Refund", POS-02, POS-04, POS-06; contract
// voidPosOrderCorrection / refundPosOrder, posVoidSchema, posRefundSchema).
//
// "Transaksi final tidak dapat dihapus; koreksi dilakukan melalui void atau
// refund yang tertaut": the completed order and its lines are never touched
// (POS-04 triggers). A correction is a new append-only row linked to the
// order — `pos_order_voids` (once per sale, keeps the receipt number, POS-06)
// or `pos_order_refunds` (up to what is still refundable, split back over the
// original tender methods by `refundAllocation`). Both need a verified
// supervisor approval (requester != approver, AUTH-06), are audited and emit
// the contract event (`order.voided` with voidedFinalOrder, `order.refunded`)
// on the transactional outbox. Decisions (PRD silent): a sale with a refund
// is not voided afterwards and a voided sale is not refunded (one correction
// path per sale keeps the day's totals unambiguous, POS-05).

import { and, asc, eq } from "drizzle-orm";
import {
  allocateIdr,
  CoreError,
  idr,
  z,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertCorrectionTargetsFinalOrder,
  assertRefundWithinPaid,
  posRefundSchema,
  posVoidSchema,
  refundAllocation,
  refundPosOrder as refundEndpoint,
  tenderBucket,
  voidPosOrderCorrection as voidCorrectionEndpoint,
  type PosRefund,
  type PosTender,
  type PosVoid,
} from "@starter/shared/pos";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import {
  posOrderRefunds,
  posOrderVoids,
  type PosRefundLineRow,
} from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import { orderGivenOf, type OrderGiven } from "./order-given.ts";
import { livePromoApplicationOf } from "./order-promo-refund.ts";
import {
  assertBusinessDayOpen,
  cashOutExceedsDrawer,
  lockCashierShiftForCash,
} from "./pos-cash-guard.ts";
import { posPromoRefundPort, posReceiptPort } from "./pos-order-ports.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
  businessDateFor,
  consumeApproval,
  itemsOf,
  liveDiscountsOf,
  loadOutlet,
  lockPosOrder,
  posIdempotent,
  tenderDto,
  tendersOf,
  type Locked,
  type PosCaller,
} from "./pos-order-support.ts";
import { requestPosRefundGatewayPart } from "./pos-refund-gateway.ts";
import { assertShiftOutflowBound } from "./pos-shift-support.ts";

type VoidCorrectionInput = z.output<typeof voidCorrectionEndpoint.body>;
type RefundInput = z.output<typeof refundEndpoint.body>;

const rupiah = (value: number): string =>
  `Rp${new Intl.NumberFormat("id-ID").format(value)}`;

type VoidRow = typeof posOrderVoids.$inferSelect;
type RefundRow = typeof posOrderRefunds.$inferSelect;

function voidDto(row: VoidRow): PosVoid {
  return posVoidSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    receiptNumber: row.receiptNumber,
    amountIdr: row.amountIdr,
    reason: row.reason,
    reasonNote: row.reasonNote,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvalRequestId: row.approvalRequestId,
    overrideId: row.overrideId,
    voidedAt: row.voidedAt.toISOString(),
  });
}

function refundDto(row: RefundRow): PosRefund {
  return posRefundSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    amountIdr: row.amountIdr,
    reason: row.reason,
    reasonNote: row.reasonNote,
    lines: row.lines,
    items: row.items,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvalRequestId: row.approvalRequestId,
    overrideId: row.overrideId,
    refundedAt: row.refundedAt.toISOString(),
  });
}

/** Corrections lock the final order (FOR UPDATE does not fire the triggers). */
async function correct<T>(
  context: ScopedTenantContext,
  caller: PosCaller,
  input: {
    outletId: OutletId;
    orderId: string;
    key: string;
    operation: string;
    request: unknown;
  },
  run: (tx: Tx, locked: Locked) => Promise<T>,
): Promise<T> {
  return withTenant(db, context, (tx) =>
    posIdempotent(
      tx,
      context,
      {
        outletId: input.outletId,
        actorId: caller.userId,
        key: input.key,
        operation: input.operation,
        target: input.orderId,
        request: input.request,
      },
      async () => {
        const locked = await lockPosOrder(
          tx,
          context,
          input.outletId,
          input.orderId,
        );
        assertCorrectionTargetsFinalOrder({ status: locked.order.status });
        return run(tx, locked);
      },
    ),
  );
}

async function correctionsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<{ voids: VoidRow[]; refunds: RefundRow[] }> {
  const tenantId = context.tenant.tenantId;
  const [voids, refunds] = await Promise.all([
    tx
      .select()
      .from(posOrderVoids)
      .where(
        and(
          eq(posOrderVoids.tenantId, tenantId),
          eq(posOrderVoids.orderId, orderId),
        ),
      ),
    tx
      .select()
      .from(posOrderRefunds)
      .where(
        and(
          eq(posOrderRefunds.tenantId, tenantId),
          eq(posOrderRefunds.orderId, orderId),
        ),
      )
      // legend-186: the per-tender replay of earlier refunds needs their order.
      .orderBy(asc(posOrderRefunds.refundedAt), asc(posOrderRefunds.id)),
  ]);
  return { voids, refunds };
}

/** POST .../corrections/void — linked void of a completed sale (POS-04). */
export async function voidPosOrderCorrection(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: VoidCorrectionInput,
  now = new Date(),
): Promise<PosVoid> {
  const { idempotencyKey, ...request } = input;
  return correct(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.correction_void",
      request,
    },
    async (tx, { order }) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      if (refunds.length > 0)
        throw new CoreError(
          "CONFLICT",
          "Transaksi ini sudah direfund sebagian; lanjutkan dengan refund.",
        );
      if (order.totalIdr <= 0)
        throw new CoreError(
          "CONFLICT",
          "Tidak ada nilai transaksi untuk di-void.",
        );
      // legend-9pz9: the void pays back only captured cash and books the
      // full total, so a DP applied to the sale would vanish. The refund
      // flow returns captured tenders only, so a DP sale is corrected by
      // an admin.
      if (order.depositAppliedIdr > 0)
        throw new CoreError(
          "CONFLICT",
          "Transaksi ini dibayar dengan DP reservasi dan tidak bisa di-void; hubungi admin untuk koreksi.",
        );
      const override = await consumeApproval(tx, context, {
        action: "void",
        purpose: "correction_void",
        outletId,
        orderId: order.id,
        objectType: "order",
        objectId: order.id,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        overrideId: input.overrideId,
        minValueIdr: order.totalIdr,
        now,
      });
      const receipts = posReceiptPort();
      const receipt = await receipts.findForOrder(tx, context, order.id);
      if (receipt === null)
        throw new CoreError(
          "CONFLICT",
          "Struk transaksi ini tidak ditemukan; void tertaut memerlukan nomor struk.",
        );
      await assertBusinessDayOpen(tx, context, {
        outletId,
        businessDates: [
          businessDateFor(await loadOutlet(tx, context, outletId), now),
        ],
      });
      // legend-ioyg: the void pays back only cash out of the drawer. A
      // gateway, EDC or points tender holding money has no return path here
      // (auto-journal parks such a void as AUTO_JOURNAL_VOID_UNSUPPORTED), so
      // it is refused; the refund flow returns money per tender method. A
      // closed business day is reported first. The refusal rolls back the
      // whole transaction, so the approval stays unused and nothing is
      // written.
      const tenders = await tendersOf(tx, context, order.id);
      if (
        tenders.some(
          (tender) =>
            (tender.status === "captured" || tender.status === "authorized") &&
            tender.method !== "cash",
        )
      )
        throw new CoreError(
          "CONFLICT",
          "Transaksi ini dibayar non-tunai (QRIS, kartu, EDC, atau poin) dan tidak bisa di-void; gunakan refund.",
        );
      // The void pays the sale's captured cash back out of this drawer.
      const voidCashIdr = tenders
        .filter(
          (tender) => tender.method === "cash" && tender.status === "captured",
        )
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
      const shift =
        voidCashIdr > 0
          ? await lockCashierShiftForCash(tx, context, {
              outletId,
              cashierId: caller.userId,
              deviceId: caller.deviceId,
              mode: "out",
              at: now,
            })
          : null;
      // legend-q7jj F3: every outflow of the drawer stays a safe integer.
      if (shift !== null) await assertShiftOutflowBound(tx, shift, voidCashIdr);
      // Held, not refused: a refusal would let the cashier probe the expected
      // drawer cash (legend-utqr). Nothing the cashier reads shows the flag.
      const needsApproval =
        shift !== null && (await cashOutExceedsDrawer(tx, shift, voidCashIdr));
      const [row] = await tx
        .insert(posOrderVoids)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          receiptNumber: receipt.number,
          amountIdr: order.totalIdr,
          reason: input.reason,
          reasonNote: input.reasonNote,
          requestedBy: caller.userId,
          approvedBy: input.approvedBy,
          approvalRequestId: override.approvalRequestId,
          overrideId: override.id,
          voidedAt: now,
          shiftId: shift?.id ?? null,
          needsApproval,
        })
        .returning();
      if (!row) throw new Error("Void insert returned no row");
      // POS-06: the receipt is marked voided; its number stays on record.
      await receipts.voidForOrder(tx, context, {
        orderId: order.id,
        reason: input.reason,
        voidedBy: caller.userId,
        at: now,
      });
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        amountIdr: order.totalIdr,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: input.approvedBy,
        approvalRequestId: override.approvalRequestId,
        overrideId: override.id,
        voidedFinalOrder: true,
        voidId: row.id,
        receiptNumber: receipt.number,
        voidedAt: now.toISOString(),
      };
      await appendPosEvent(tx, context, "order.voided", {
        order,
        payload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.voided",
        payload,
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.correction_voided",
          order,
          caller,
          objectType: "pos_order_void",
          objectId: row.id,
          before: { id: order.id, status: order.status },
          after: {
            id: row.id,
            amountIdr: row.amountIdr,
            reason: row.reason,
            approvedBy: row.approvedBy,
            approvalRequestId: row.approvalRequestId,
            overrideId: row.overrideId,
            receiptNumber: row.receiptNumber,
          },
          reason: input.reasonNote,
        },
        now,
      );
      if (needsApproval)
        await auditPos(
          tx,
          context,
          {
            action: "pos_order.cash_void_held",
            order,
            caller,
            objectType: "pos_order_void",
            objectId: row.id,
            before: null,
            after: {
              id: row.id,
              orderId: row.orderId,
              shiftId: row.shiftId,
              cashIdr: voidCashIdr,
            },
            reason: input.reasonNote,
          },
          now,
        );
      return voidDto(row);
    },
  );
}

/**
 * Splits a refund over the sale's revenue lines for the WS-07 refund rule
 * (gross − discount + service + tax = amount, exactly): service charge and
 * tax pro rata to the bill, discount pro rata to the net, gross the rest.
 *
 * A promo refund that was re-priced (legend-aef1) passes `refundedSubtotalIdr`,
 * the bill value the refunded items carried before the promo. The gross is then
 * that value and the discount is what the guest no longer gets of it (gross −
 * the goods part of the payout): the order's overall discount ratio is wrong
 * when the promo is withdrawn on the kept items (payout 30k of a 100k bill with
 * 20k off, item 50k: gross 50k / discount 20k, not 37.5k / 7.5k). The sum rule
 * above still holds because the goods part is the same as before.
 */
export function refundSplit(
  order: Locked["order"],
  amountIdr: number,
  refundedSubtotalIdr: number | null = null,
): {
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
} {
  // legend-zmc2: an inclusive order's subtotal already contains service and
  // tax; the net line excludes them so the split still adds up to the amount.
  const net = Math.max(0, orderNetSubtotalIdr(order) - order.discountIdr);
  const [netPart, servicePart, taxPart] = allocateIdr(idr(amountIdr), [
    net,
    order.serviceChargeIdr,
    order.taxIdr,
  ]).map(Number);
  if (refundedSubtotalIdr !== null) {
    // An inclusive order's item prices already contain service and tax, but
    // its sale books gross without them (order-revenue.ts): bring the refunded
    // value to the same basis, pro rata. Exclusive orders scale by 1.
    const refundedGross =
      order.subtotalIdr > 0
        ? Number(
            (BigInt(refundedSubtotalIdr) *
              BigInt(Math.max(0, orderNetSubtotalIdr(order)))) /
              BigInt(order.subtotalIdr),
          )
        : refundedSubtotalIdr;
    // The goods part never exceeds what the refunded items carried: a bigger
    // value would mean a negative discount, which has no place in a refund.
    const grossPart = Math.max(refundedGross, netPart);
    return {
      grossSalesIdr: grossPart,
      discountIdr: grossPart - netPart,
      serviceChargeIdr: servicePart,
      pbjtIdr: taxPart,
    };
  }
  const discountPart =
    net > 0
      ? Math.min(
          order.discountIdr,
          Math.floor((order.discountIdr * netPart) / net),
        )
      : 0;
  return {
    grossSalesIdr: netPart + discountPart,
    discountIdr: discountPart,
    serviceChargeIdr: servicePart,
    pbjtIdr: taxPart,
  };
}

/**
 * The captured tenders reduced, per method, by what earlier refunds already
 * returned through that method. A later partial refund is split over what is
 * still refundable, so the per-method refunds never exceed what each method
 * took in (rounding of several pro-rata splits cannot over-refund one method,
 * and the last refund returns exactly the remainder of each method).
 */
export function stillRefundableByMethod(
  tenders: readonly PosTender[],
  refunds: readonly Pick<RefundRow, "lines">[],
): PosTender[] {
  const refunded = new Map<string, number>();
  for (const row of refunds)
    for (const line of row.lines)
      refunded.set(
        line.method,
        (refunded.get(line.method) ?? 0) + Number(line.amountIdr),
      );
  const byMethod = new Map<string, PosTender>();
  const captured = new Map<string, number>();
  for (const tender of tenders) {
    if (tender.status !== "captured") continue;
    if (!byMethod.has(tender.method)) byMethod.set(tender.method, tender);
    captured.set(
      tender.method,
      (captured.get(tender.method) ?? 0) + Number(tender.amountIdr),
    );
  }
  return [...byMethod.entries()].map(([method, tender]) => ({
    ...tender,
    amountIdr: idr(
      Math.max(0, (captured.get(method) ?? 0) - (refunded.get(method) ?? 0)),
    ),
  }));
}

/**
 * legend-186 (8v2yl): a refund payout split per captured tender, so each line
 * can be attributed to one payment intent. The per-method totals come from
 * `refundAllocation` over `stillRefundableByMethod` (unchanged); each method
 * amount is then spread over that method's captured tenders FIFO (requestedAt,
 * id), up to what each tender still holds. Earlier refund lines with a
 * `tenderId` come off that tender; legacy lines (method only) come off the
 * method's tenders FIFO.
 */
export function refundLinesByTender(
  tenders: readonly PosTender[],
  refunds: readonly Pick<RefundRow, "lines">[],
  payoutIdr: number,
): PosRefundLineRow[] {
  const captured = tenders.filter(
    (tender) => tender.status === "captured" && Number(tender.amountIdr) > 0,
  );
  const remaining = new Map(
    captured.map((tender) => [tender.id as string, Number(tender.amountIdr)]),
  );
  const takeFifo = (method: string, amount: number): number => {
    let left = amount;
    for (const tender of captured) {
      if (left <= 0) break;
      if (tender.method !== method) continue;
      const take = Math.min(left, remaining.get(tender.id) ?? 0);
      remaining.set(tender.id, (remaining.get(tender.id) ?? 0) - take);
      left -= take;
    }
    return left;
  };
  for (const row of refunds)
    for (const line of row.lines) {
      let left = Number(line.amountIdr);
      const own = line.tenderId ? remaining.get(line.tenderId) : undefined;
      if (line.tenderId && own !== undefined) {
        const take = Math.min(left, own);
        remaining.set(line.tenderId, own - take);
        left -= take;
      }
      takeFifo(line.method, left);
    }
  const lines: PosRefundLineRow[] = [];
  for (const part of refundAllocation(
    stillRefundableByMethod(tenders, refunds),
    idr(payoutIdr),
  )) {
    let left = Number(part.amountIdr);
    const ofMethod = captured.filter((tender) => tender.method === part.method);
    for (const tender of ofMethod) {
      if (left <= 0) break;
      const take = Math.min(left, remaining.get(tender.id) ?? 0);
      if (take <= 0) continue;
      remaining.set(tender.id, (remaining.get(tender.id) ?? 0) - take);
      lines.push({
        method: part.method,
        amountIdr: take,
        reference: null,
        tenderId: tender.id,
        paymentIntentId: tender.paymentIntentId,
      });
      left -= take;
    }
    // Only an inconsistent earlier row (lines not adding up to what its
    // tenders held) leaves a rest here; rounding never does. Keep the
    // per-method total but write the rest without a tender or intent id
    // (legacy shape), so it is never pinned on one payment intent.
    if (left > 0)
      lines.push({ method: part.method, amountIdr: left, reference: null });
  }
  return lines;
}

type LineItem = Pick<
  Awaited<ReturnType<typeof itemsOf>>[number]["item"],
  "id" | "quantity" | "lineTotalIdr"
>;

/**
 * legend-5g9sn (Q25 per item): what the lines named by a POS refund still
 * hold. Per original line (a replacement maps back through the swap chain):
 * its share of the bill (line total x total / subtotal, floor) less the
 * vouchers and live recovery refunds of its issues and its part of the earlier
 * POS refunds that named items (each row split over its items by value, the
 * last item taking the rest). Rows without items are covered by the order room.
 */
export function lineRoomIdr(
  order: { totalIdr: number; subtotalIdr: number },
  items: readonly LineItem[],
  refunds: readonly Pick<RefundRow, "amountIdr" | "items">[],
  given: Pick<OrderGiven, "lineGivenIdr" | "toOriginal">,
  requested: readonly { itemId: string }[],
): number {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const valueOf = (itemId: string, quantity: number) => {
    const item = byId.get(itemId);
    return item && item.quantity > 0
      ? (Number(item.lineTotalIdr) * quantity) / item.quantity
      : 0;
  };
  const priorPos = new Map<string, number>();
  for (const row of refunds) {
    if (row.items.length === 0) continue;
    const weights = row.items.map((entry) =>
      valueOf(entry.itemId, entry.quantity),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let left = Number(row.amountIdr);
    row.items.forEach((entry, index) => {
      const share =
        index === row.items.length - 1
          ? left
          : total > 0
            ? Math.floor((row.amountIdr * weights[index]!) / total)
            : 0;
      left -= share;
      const line = given.toOriginal(entry.itemId);
      priorPos.set(line, (priorPos.get(line) ?? 0) + share);
    });
  }
  const lines = new Set(
    requested.map((entry) => given.toOriginal(entry.itemId)),
  );
  let room = 0;
  for (const line of lines) {
    const item = byId.get(line);
    const paid =
      item && order.subtotalIdr > 0
        ? Number(
            (BigInt(item.lineTotalIdr) * BigInt(order.totalIdr)) /
              BigInt(order.subtotalIdr),
          )
        : 0;
    room += Math.max(
      0,
      paid - (given.lineGivenIdr.get(line) ?? 0) - (priorPos.get(line) ?? 0),
    );
  }
  return room;
}

/** POST .../corrections/refund — linked refund against a paid sale (POS-04). */
export async function refundPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: RefundInput,
  now = new Date(),
): Promise<PosRefund> {
  const { idempotencyKey, ...request } = input;
  return correct(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.refund",
      request,
    },
    async (tx, { order }) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      const tenders = (await tendersOf(tx, context, order.id)).map(tenderDto);
      const paid = tenders
        .filter((tender) => tender.status === "captured")
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
      const refunded = refunds.reduce((sum, row) => sum + row.amountIdr, 0);
      // legend-5g9sn (Q25): the vouchers and the live recovery refunds of the
      // order count against what the guest paid too (order level, read without
      // lock: only the order lock above, never an issue lock).
      const given = await orderGivenOf(tx, context.tenant.tenantId, order.id);
      const recoveryGivenIdr = given.vouchersIdr + given.recoveryRefundsIdr;
      const roomIdr = Math.max(0, paid - refunded - recoveryGivenIdr);

      // Items: quantities already refunded by earlier rows, then this request.
      const requested = (input.items ?? []).map(({ itemId, quantity }) => ({
        itemId,
        quantity,
      }));
      const allItems = (await itemsOf(tx, context, order.id)).map(
        ({ item }) => item,
      );
      const liveItems = allItems.filter((item) => item.status !== "voided");
      const refundedBefore = new Map<string, number>();
      for (const row of refunds)
        for (const entry of row.items)
          refundedBefore.set(
            entry.itemId,
            (refundedBefore.get(entry.itemId) ?? 0) + entry.quantity,
          );
      const refundedNow = new Map<string, number>();
      for (const entry of requested) {
        const item = liveItems.find(
          (candidate) => candidate.id === entry.itemId,
        );
        if (!item || refundedNow.has(entry.itemId))
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Item refund tidak valid untuk pesanan ini.",
          );
        if (entry.quantity > item.quantity - (refundedBefore.get(item.id) ?? 0))
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Jumlah refund melebihi sisa item yang belum direfund.",
          );
        refundedNow.set(entry.itemId, entry.quantity);
      }

      // A promo order is re-priced (founder rules, legend-q1e0): the payout is
      // what the guest paid minus what the kept items still cost. A failing
      // port aborts the refund.
      let payout = input.amountIdr;
      // legend-wkl3 (CTO): nothing due (e.g. a returned free item, founder Q19)
      // still records the return as a Rp0 row: items, reason and audit, no
      // payment line, no event, no gateway, no stock reversal.
      let goodsReturnOnly = false;
      // legend-186 (s7rx B): the DP case of the Rp0 return, and what the
      // deposit side still owes the guest (not paid back here).
      let depositGoodsReturn = false;
      let depositOwedIdr = 0;
      // legend-aef1: bill value (before promo) of the items this refund returns,
      // set once the promo is re-priced; the revenue split builds on it.
      let promoRefundedSubtotalIdr: number | null = null;
      const promoApplication = await livePromoApplicationOf(
        tx,
        context,
        order.id,
      );
      if (promoApplication) {
        // legend-186 (s7rx A): a promo order refunded without items is a
        // settlement of what the guest is still owed for the goods they kept
        // (e.g. an order locked by a row that paid out less than due). It
        // changes no items, so the kept lines are all that remain.
        const settlement = requested.length === 0;
        // Only an order that already had a refund can be locked; an untouched
        // promo order is refunded by its items (a later promo edit must not
        // make it look owed).
        if (settlement && refunds.length === 0)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Pesanan berpromo: pilih item yang direfund.",
          );
        if (settlement) payout = 0;
        const keptLines = liveItems.flatMap((item) => {
          const keptQty =
            item.quantity -
            (refundedBefore.get(item.id) ?? 0) -
            (refundedNow.get(item.id) ?? 0);
          if (keptQty <= 0) return [];
          const unitPriceIdr = item.unitPriceIdr + item.modifiersTotalIdr;
          return [
            {
              menuItemId: item.menuItemId,
              quantity: keptQty,
              unitPriceIdr: idr(unitPriceIdr),
              lineTotalIdr: idr(unitPriceIdr * keptQty),
            },
          ];
        });
        const recomputed =
          await posPromoRefundPort().recomputeAfterPartialRefund(tx, context, {
            orderId: order.id,
            keptLines,
            reason: input.reasonNote,
            actorUserId: caller.userId,
            at: now,
            deferPayout: true,
          });
        // The re-check can depend on more than this order (same-day spend of
        // the guest's other orders, or the live rule of a pre-0042 promo), so
        // a withdrawal here can repeat on every attempt: no retry hint, the
        // settlement goes to an admin correction instead. The transaction
        // rolls back, so the promo stays as it was.
        if (
          settlement &&
          recomputed.adjusted &&
          recomputed.withdrawn.length > 0
        )
          throw new HttpError(
            422,
            "REFUND_SETTLEMENT_NEEDS_ADMIN",
            "Promo pesanan ini tidak lagi memenuhi syarat untuk item yang tersisa; pelunasan sisa refund perlu koreksi admin.",
          );
        if (recomputed.adjusted) {
          promoRefundedSubtotalIdr = Number(recomputed.refundedSubtotalIdr);
          // Kept goods after the promo (application) and after their pro-rata
          // (by price) share of any manual discount stacked on the sale.
          const keptSubtotal = keptLines.reduce(
            (sum, line) => sum + Number(line.lineTotalIdr),
            0,
          );
          const manualDiscount = (await liveDiscountsOf(tx, context, order.id))
            .filter((row) => row.source === "manual")
            .reduce((sum, row) => sum + Number(row.amountIdr), 0);
          const keptManualShare =
            order.subtotalIdr > 0
              ? Number(
                  (BigInt(manualDiscount) * BigInt(keptSubtotal)) /
                    BigInt(order.subtotalIdr),
                )
              : 0;
          const keptGoods = Math.max(
            0,
            Number(recomputed.keptPayableIdr) - keptManualShare,
          );
          // Bill level: service charge, tax and rounding follow the goods pro
          // rata (total / net of the sale). What the guest paid in counts the
          // deposit applied to the bill; the payout itself is capped at what
          // the tenders still hold (a deposit is not paid back here).
          const net = order.subtotalIdr - order.discountIdr;
          const keptPayableBill =
            net > 0
              ? Number(
                  (BigInt(order.totalIdr) * BigInt(keptGoods)) / BigInt(net),
                )
              : 0;
          const paidIn = paid + Number(order.depositAppliedIdr);
          const dueBill = Math.max(0, paidIn - refunded - keptPayableBill);
          // Rp0 return when the guest is owed nothing, or (s7rx B, below) when
          // what is owed sits only on the deposit; owed with no tender left and
          // no deposit stays refused below. A settlement never writes Rp0.
          goodsReturnOnly = !settlement && dueBill === 0;
          // legend-a0i7 (Codex 127): the returned items are used up by this
          // refund and a promo order cannot be refunded by amount alone, so a
          // payout below what is due would lock the rest for good. Asking
          // less is refused before anything is written; asking more is
          // capped to what is due (unchanged).
          const owedIdr = Math.min(dueBill, roomIdr);
          // legend-186 (s7rx B): owed, but only from the deposit (the tenders
          // are used up): the item still comes back as a Rp0 return and the
          // rest stays on the deposit side.
          if (
            !settlement &&
            dueBill > 0 &&
            paid - refunded <= 0 &&
            Number(order.depositAppliedIdr) > 0
          ) {
            goodsReturnOnly = true;
            depositGoodsReturn = true;
          }
          if (!settlement && owedIdr > 0 && input.amountIdr < owedIdr)
            throw new HttpError(
              422,
              "REFUND_AMOUNT_BELOW_DUE",
              `Refund item ini harus ${rupiah(owedIdr)}; isi jumlah tersebut agar sisa pembayaran tamu tidak tertahan.`,
            );
          payout = Math.min(input.amountIdr, owedIdr);
          // Running balance (the latest audit row holds it; do not sum rows):
          // what is due beyond what the tenders can still pay.
          if (Number(order.depositAppliedIdr) > 0)
            depositOwedIdr = Math.max(0, dueBill - owedIdr);
        }
        if (goodsReturnOnly) payout = 0;
        else if (payout <= 0)
          throw new HttpError(
            422,
            "REFUND_NOTHING_DUE",
            "Tidak ada dana yang perlu dikembalikan.",
          );
      }
      // legend-5g9sn: a refund above what the vouchers and recovery refunds
      // left is cut to it (as the promo payout is capped to what is due);
      // nothing left is refused.
      if (!promoApplication && recoveryGivenIdr > 0) {
        payout = Math.min(payout, roomIdr);
        // Q25 is per item: a refund that names items is also bound by what
        // each named line still holds (paid share of its original line less
        // the vouchers, live recovery refunds and earlier POS refunds of it).
        if (requested.length > 0)
          payout = Math.min(
            payout,
            lineRoomIdr(order, allItems, refunds, given, requested),
          );
        if (payout <= 0)
          throw new HttpError(
            422,
            "REFUND_NOTHING_DUE",
            "Tidak ada dana yang perlu dikembalikan.",
          );
      }
      if (!goodsReturnOnly)
        assertRefundWithinPaid(
          idr(paid),
          idr(Math.min(paid, refunded + recoveryGivenIdr)),
          idr(payout),
        );
      const override = await consumeApproval(tx, context, {
        action: "refund",
        purpose: "refund",
        outletId,
        orderId: order.id,
        objectType: "order",
        objectId: order.id,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        overrideId: input.overrideId,
        minValueIdr: payout,
        now,
      });
      const lines: PosRefundLineRow[] = goodsReturnOnly
        ? []
        : refundLinesByTender(tenders, refunds, payout);
      await assertBusinessDayOpen(tx, context, {
        outletId,
        businessDates: [
          businessDateFor(await loadOutlet(tx, context, outletId), now),
        ],
      });
      const refundCashIdr = lines
        .filter((line) => tenderBucket(line.method as never) === "cash")
        .reduce((sum, line) => sum + line.amountIdr, 0);
      const shift =
        refundCashIdr > 0
          ? await lockCashierShiftForCash(tx, context, {
              outletId,
              cashierId: caller.userId,
              deviceId: caller.deviceId,
              mode: "out",
              at: now,
            })
          : null;
      // legend-q7jj F3: every outflow of the drawer stays a safe integer.
      if (shift !== null)
        await assertShiftOutflowBound(tx, shift, refundCashIdr);
      // Held, not refused: see the void above (legend-utqr).
      const needsApproval =
        shift !== null &&
        (await cashOutExceedsDrawer(tx, shift, refundCashIdr));
      const [row] = await tx
        .insert(posOrderRefunds)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          amountIdr: idr(payout),
          reason: input.reason,
          reasonNote: input.reasonNote,
          lines,
          items: requested,
          requestedBy: caller.userId,
          approvedBy: input.approvedBy,
          approvalRequestId: override.approvalRequestId,
          overrideId: override.id,
          refundedAt: now,
          shiftId: shift?.id ?? null,
          needsApproval,
        })
        .returning();
      if (!row) throw new Error("Refund insert returned no row");
      // legend-ghgei: the gateway part goes back through a WS-05 refund
      // request (nothing pays here). A Rp0 return has no lines.
      if (!goodsReturnOnly)
        await requestPosRefundGatewayPart(tx, context, {
          order,
          caller,
          posRefundId: row.id,
          lines,
          now,
        });
      const split = refundSplit(order, payout, promoRefundedSubtotalIdr);
      // Goods part of the payout goes onto the promo application's ledger.
      if (promoApplication && !goodsReturnOnly)
        await posPromoRefundPort().recordPartialRefundPayout(tx, context, {
          orderId: order.id,
          payoutIdr: split.grossSalesIdr - split.discountIdr,
          at: now,
        });
      const bucket = (name: string) =>
        lines
          .filter((line) => tenderBucket(line.method as never) === name)
          .reduce((sum, line) => sum + line.amountIdr, 0);
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        refundId: row.id,
        amountIdr: payout,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: input.approvedBy,
        approvalRequestId: override.approvalRequestId,
        overrideId: override.id,
        ...split,
        refundCashIdr: bucket("cash"),
        refundGatewayIdr: bucket("gateway"),
        refundEdcIdr: bucket("edc"),
        refundPointsIdr: bucket("points"),
        // One line per method, no tender ids: the event stays as before.
        lines: [
          ...lines.reduce((byMethod, line) => {
            byMethod.set(
              line.method,
              (byMethod.get(line.method) ?? 0) + line.amountIdr,
            );
            return byMethod;
          }, new Map<string, number>()),
        ].map(([method, amountIdr]) => ({ method, amountIdr })),
        refundedAt: now.toISOString(),
      };
      // No money moved on a Rp0 return: order.refunded (journals, loyalty,
      // revenue) is not emitted; the row and its audit are the record.
      if (!goodsReturnOnly) {
        await appendPosEvent(tx, context, "order.refunded", {
          order,
          payload,
          caller,
          now,
        });
        await appendOrderEvent(tx, context, {
          order,
          type: "order.refunded",
          payload,
          caller,
          now,
        });
      }
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.refunded",
          order,
          caller,
          objectType: "pos_order_refund",
          objectId: row.id,
          before: { id: order.id, amountIdr: refunded },
          after: {
            id: row.id,
            amountIdr: row.amountIdr,
            requestedAmountIdr: input.amountIdr,
            items: requested,
            ...(goodsReturnOnly
              ? {
                  goodsReturnOnly: true,
                  goodsReturnNote: depositGoodsReturn
                    ? "Retur barang tanpa dana tunai: sisa hak tamu berada di deposit dan tidak dikembalikan di sini."
                    : "Retur barang tanpa dana: tidak ada yang perlu dikembalikan (item gratis atau tetap tercakup promo).",
                }
              : {}),
            ...(depositOwedIdr > 0 ? { depositOwedIdr } : {}),
            reason: row.reason,
            approvedBy: row.approvedBy,
            approvalRequestId: row.approvalRequestId,
            overrideId: row.overrideId,
          },
          reason: input.reasonNote,
        },
        now,
      );
      if (needsApproval)
        await auditPos(
          tx,
          context,
          {
            action: "pos_order.cash_refund_held",
            order,
            caller,
            objectType: "pos_order_refund",
            objectId: row.id,
            before: null,
            after: {
              id: row.id,
              orderId: row.orderId,
              shiftId: row.shiftId,
              cashIdr: refundCashIdr,
            },
            reason: input.reasonNote,
          },
          now,
        );
      return refundDto(row);
    },
  );
}
