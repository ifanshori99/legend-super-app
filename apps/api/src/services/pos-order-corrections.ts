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

import { and, asc, eq, inArray } from "drizzle-orm";
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
  PosError,
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
import { edcTransactions } from "../db/schema/edc.ts";
import { edgeOrderIngests } from "../db/schema/edge-order-ingest.ts";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { posDepositRefunds } from "../db/schema/pos-deposit-refund.ts";
import {
  posOrderRefunds,
  posOrderVoids,
  type PosRefundLineRow,
} from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import { pointLedger } from "../db/schema/crm-ledger.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import {
  assertNothingBackThroughProvider,
  lineRoomIdr,
  orderGivenOf,
} from "./order-given.ts";
import { assertNoOrd09Refund } from "./order-refund-lane.ts";
import { settleOrderVouchersForVoid } from "./order-voucher-void.ts";
import { liveRouteManualRefundWhere } from "./order-issue-route-refund.ts";
import {
  lockIssuesOfOrder,
  paidChargesOfOrder,
  returnPaidChargesOfVoidedOrder,
} from "./order-recovery-charge-void.ts";
import { loadDeferredRefundCommitments } from "./payment-refund-edge-history.ts";
import {
  monotonicFactTime,
  refundApprovalLimitRefused,
  refundApprovalWithinLimit,
  refundCommittedAmount,
} from "./payment-refund-approval-limits.ts";
import {
  assertBusinessDayOpen,
  cashOutExceedsDrawer,
  lockCashierShiftForCash,
} from "./pos-cash-guard.ts";
import { assertPosOrderWriteOnCloud } from "./pos-edge-outlet.ts";
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
import { refundPosTicketsOfRefundedLines } from "./facility-pos-tickets.ts";
import {
  depositRefundedByPosRefund,
  depositRefundedOfOrder,
  depositRefundFactTime,
  requestPosRefundDepositPart,
} from "./pos-deposit-refund.ts";
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

/**
 * Money guard: an order the cloud ingested from an edge node (state
 * `ingested` or `voided`) may already have been, or be about to be, paid out
 * offline by the edge, so a cloud void or refund on it could pay twice. Refused
 * until the founder decides the rule. One query, shared by void and refund.
 */
async function assertNotEdgeIngested(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  const [row] = await tx
    .select({ orderId: edgeOrderIngests.orderId })
    .from(edgeOrderIngests)
    .where(
      and(
        eq(edgeOrderIngests.tenantId, context.tenant.tenantId),
        eq(edgeOrderIngests.orderId, orderId),
        inArray(edgeOrderIngests.state, ["ingested", "voided"]),
      ),
    )
    .limit(1);
  if (row)
    throw new HttpError(
      409,
      "EDGE_ORDER_CORRECTION_BLOCKED",
      "Pesanan ini dibayar di kasir edge dan sudah diterima server pusat, jadi tidak bisa di-void atau di-refund dari pusat. Refund penjualan kasir offline belum didukung di rilis 1; hubungi finance.",
    );
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
  run: (tx: Tx, locked: Locked, factAt: Date) => Promise<T>,
  requestedAt: Date,
  // Locks taken BEFORE the order row (legend-s61sg: the issues of the order,
  // the module's lock order is issue, order, charge).
  beforeOrderLock?: (tx: Tx) => Promise<void>,
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
        if (beforeOrderLock) await beforeOrderLock(tx);
        const locked = await lockPosOrder(
          tx,
          context,
          input.outletId,
          input.orderId,
        );
        // 1271 F3: the window share-locked in this transaction, so a return
        // started meanwhile waits and no correction lands after its closing event.
        await assertPosOrderWriteOnCloud(
          tx,
          context.tenant.tenantId,
          input.outletId,
          locked.pos.failoverWindowId,
          "core",
        );
        assertCorrectionTargetsFinalOrder({ status: locked.order.status });
        await assertNotEdgeIngested(tx, context, locked.order.id);
        // legend-ykk88: the fact time is taken after the lock, later than every
        // money fact already committed on the bill, whatever clock the request
        // read before it waited. Persistence and events use this one time.
        const factAt = await monotonicFactTime(
          tx,
          {
            tenantId: context.tenant.tenantId,
            outletId: locked.order.outletId,
            orderId: locked.order.id,
          },
          requestedAt,
        );
        return run(tx, locked, factAt);
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
  requestedAt = new Date(),
): Promise<PosVoid> {
  // A cash void is a refund (Q63): same authoritative-cloud requirement as
  // refundPosOrder, since an edge snapshot cannot prove admin/POS refund history.
  if (getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true")
    throw new HttpError(
      409,
      "REFUND_HISTORY_UNVERIFIED",
      "Void tunai atau refund tidak bisa dilakukan di kasir edge karena riwayat refund tidak bisa diverifikasi. Refund penjualan kasir offline belum didukung di rilis 1; hubungi finance.",
    );
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
    async (tx, { order }, now) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      if (refunds.length > 0)
        throw new CoreError(
          "CONFLICT",
          "Transaksi ini sudah direfund sebagian; lanjutkan dengan refund.",
        );
      // legend-980: a void books the full total, so it never runs next to a
      // live manual refund of one of the order's lines.
      await assertNoLiveManualRefund(tx, context, order.id);
      await assertNoOrd09Refund(tx, context.tenant.tenantId, order.id);
      // legend-3dsih (1095): a voucher given for this order is cancelled with
      // the void, or the void is refused when the guest already used it.
      const vouchersOfOrder = await settleOrderVouchersForVoid(tx, context, {
        orderId: order.id,
        actor: { userId: caller.userId },
        now,
      });
      if (vouchersOfOrder.kind === "used")
        throw new HttpError(
          409,
          "VOID_APOLOGY_VOUCHER_USED",
          "Pesanan ini punya voucher yang sudah dipakai; tidak bisa di-void.",
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
      // legend-s61sg: a swap charge already paid on this order goes back with
      // the void, in this transaction, or the void is refused (409).
      const paidCharges = await paidChargesOfOrder(tx, context, order.id);
      // legend-vl6bk (SO 996 F2): a guest card approved (or pending/unknown)
      // on the EDC terminal for a charge still unpaid has no refund path once
      // the order is voided (the collect is refused, a manual refund needs a
      // paid charge, the void only returns paid charges): refuse the void.
      const unpaidCharges = await tx
        .select({ id: orderIssueCharges.id })
        .from(orderIssueCharges)
        .where(
          and(
            eq(orderIssueCharges.tenantId, context.tenant.tenantId),
            eq(orderIssueCharges.orderId, order.id),
            inArray(orderIssueCharges.status, ["open", "routed_pos"]),
          ),
        );
      if (unpaidCharges.length > 0) {
        const [edcHeld] = await tx
          .select({ id: edcTransactions.id })
          .from(edcTransactions)
          .where(
            and(
              eq(edcTransactions.tenantId, context.tenant.tenantId),
              eq(edcTransactions.type, "sale"),
              inArray(edcTransactions.status, [
                "approved",
                "pending",
                "unknown",
              ]),
              inArray(
                edcTransactions.reference,
                unpaidCharges.map((charge) => charge.id),
              ),
            ),
          )
          .limit(1);
        if (edcHeld !== undefined)
          throw new HttpError(
            409,
            "edc_charge_pending",
            "Ada transaksi kartu EDC untuk tagihan selisih swap yang belum selesai; selesaikan pembayaran di kasir atau void di terminal EDC dulu, lalu void ulang.",
          );
      }
      // 936 D: the facility tickets of the bill are refunded; one already used
      // refuses the void here, before any money moves.
      await refundPosTicketsOfRefundedLines(tx, context, {
        orderId: order.id,
        itemIds: null,
        moneyRefund: true,
        now,
        actorUserId: caller.userId,
      });
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
        deviceId: caller.deviceId,
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
      // Founder Q63: a cash void pays money back out, so it is a refund and
      // answers to the same cumulative ceiling and paid cap. It has no native
      // refund rows (a prior refund refuses the void above), so any deferred
      // edge refund fact or earlier admin refund must be reconciled first.
      // legend-s61sg: the drawer also gives back the cash charges of the order.
      const outflowIdr = voidCashIdr + paidCharges.cashIdr;
      if (voidCashIdr > 0) {
        const committed = await refundCommittedAmount(
          tx,
          {
            tenantId: context.tenant.tenantId,
            outletId: order.outletId,
            orderId: order.id,
            amountIdr: voidCashIdr,
          },
          { includePendingReservations: true, paidCapScope: true },
        );
        if (committed > BigInt(voidCashIdr))
          throw new PosError("REFUND_EXCEEDS_PAID");
      }
      // 1116 (SO 1114 P1): the void pays the whole bill back, so any money
      // that already went back through the provider (or an intent flagged
      // refunded with no sure amount) refuses it. After the paid cap above,
      // so a refund it already sees keeps its REFUND_EXCEEDS_PAID answer.
      // 1127: currently unreachable for gateway sales (the non-cash void
      // refusal fires first); kept as defense in depth.
      await assertNothingBackThroughProvider(tx, context, order.id);
      // The approver's ceiling covers the whole outflow, also when the order
      // itself holds no captured cash and only the charge cash goes out.
      if (outflowIdr > 0) {
        if (
          !(await refundApprovalWithinLimit(
            tx,
            context,
            override.approvedBy!,
            {
              tenantId: context.tenant.tenantId,
              outletId: order.outletId,
              orderId: order.id,
              amountIdr: outflowIdr,
            },
            now,
          ))
        )
          throw refundApprovalLimitRefused();
        const deferred = await loadDeferredRefundCommitments(tx, {
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderIds: [order.id],
        });
        if (deferred.length > 0)
          throw new HttpError(
            409,
            "REFUND_HISTORY_UNVERIFIED",
            "Ada refund dari kasir edge lama yang belum tercatat di pusat, jadi refund berikutnya ditahan. Hubungi finance untuk rekonsiliasi.",
          );
      }
      const shift =
        outflowIdr > 0
          ? await lockCashierShiftForCash(tx, context, {
              outletId,
              cashierId: caller.userId,
              deviceId: caller.deviceId,
              mode: "out",
              at: now,
            })
          : null;
      // legend-q7jj F3: every outflow of the drawer stays a safe integer.
      if (shift !== null) await assertShiftOutflowBound(tx, shift, outflowIdr);
      // Held, not refused: a refusal would let the cashier probe the expected
      // drawer cash (legend-utqr). Nothing the cashier reads shows the flag.
      const needsApproval =
        shift !== null && (await cashOutExceedsDrawer(tx, shift, outflowIdr));
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
      await returnPaidChargesOfVoidedOrder(tx, context, {
        charges: paidCharges,
        shift,
        voidId: row.id,
        held: needsApproval,
        caller,
        orderNumber: order.number,
        now,
      });
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
        requestedBy: caller.userId,
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
    requestedAt,
    (tx) => lockIssuesOfOrder(tx, context, orderId),
  );
}

/**
 * One refund's goods / service / tax parts: the cumulative largest-remainder
 * split of everything returned (including `amountIdr`) minus what earlier
 * refunds booked per part, a part that would shrink held at 0, a part capped
 * at what the sale still holds of it, and the difference put back so the parts
 * add up to `amountIdr` exactly (legend-980). Only a refund above the sum of
 * the weights (bill rounding) leaves a rest no part has room for: it goes on
 * the biggest part so the journal still balances.
 */
function refundPartsStep(
  weights: readonly number[],
  booked: readonly number[],
  cumulativeIdr: number,
  amountIdr: number,
): number[] {
  const target = allocateIdr(idr(cumulativeIdr + amountIdr), weights).map(
    Number,
  );
  const room = weights.map((weight, index) =>
    Math.max(0, weight - (booked[index] ?? 0)),
  );
  const parts = target.map((cumulative, index) =>
    Math.min(Math.max(0, cumulative - (booked[index] ?? 0)), room[index] ?? 0),
  );
  let diff = amountIdr - parts.reduce((sum, part) => sum + part, 0);
  while (diff < 0) {
    let biggest = 0;
    for (const [index, part] of parts.entries())
      if (part > (parts[biggest] ?? 0)) biggest = index;
    const take = Math.min(parts[biggest] ?? 0, -diff);
    if (take <= 0) break;
    parts[biggest] = (parts[biggest] ?? 0) - take;
    diff += take;
  }
  while (diff > 0) {
    let best = 0;
    for (const index of parts.keys())
      if (
        (room[index] ?? 0) - (parts[index] ?? 0) >
        (room[best] ?? 0) - (parts[best] ?? 0)
      )
        best = index;
    const free = (room[best] ?? 0) - (parts[best] ?? 0);
    if (free <= 0) {
      let heaviest = 0;
      for (const [index, weight] of weights.entries())
        if (weight > (weights[heaviest] ?? 0)) heaviest = index;
      parts[heaviest] = (parts[heaviest] ?? 0) + diff;
      break;
    }
    const give = Math.min(free, diff);
    parts[best] = (parts[best] ?? 0) + give;
    diff -= give;
  }
  return parts;
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
  alreadyRefundedIdr: number | readonly number[] = 0,
): {
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
} {
  // legend-zmc2: an inclusive order's subtotal already contains service and
  // tax; the net line excludes them so the split still adds up to the amount.
  const net = Math.max(0, orderNetSubtotalIdr(order) - order.discountIdr);
  const weights = [net, order.serviceChargeIdr, order.taxIdr];
  // legend-9z1r5: rounding every partial refund on its own can reverse Rp1
  // more goods (and Rp1 less tax) than the sale holds. Each refund takes the
  // cumulative split of everything returned so far minus what the earlier
  // refunds really booked per part (replayed here from their amounts, oldest
  // first, with the same rule), so over several refunds each part follows one
  // allocateIdr of the total. Largest remainder is not monotone in the total:
  // a part that would shrink is held at 0 and the shortfall is taken from the
  // biggest growing part. A part is also capped at what the sale still holds
  // of it (weight minus what earlier refunds booked), and a shortfall from the
  // cap goes to the parts with room, so the sum stays the amount and a part
  // never passes its weight (legend-980).
  const earlier =
    typeof alreadyRefundedIdr === "number"
      ? [alreadyRefundedIdr]
      : [...alreadyRefundedIdr];
  const priorParts = weights.map(() => 0);
  let cumulativeIdr = 0;
  for (const earlierIdr of earlier) {
    if (!(earlierIdr > 0)) continue;
    refundPartsStep(weights, priorParts, cumulativeIdr, earlierIdr).forEach(
      (part, index) => {
        priorParts[index] = (priorParts[index] ?? 0) + part;
      },
    );
    cumulativeIdr += earlierIdr;
  }
  const deltas = refundPartsStep(weights, priorParts, cumulativeIdr, amountIdr);
  const [netPart = 0, servicePart = 0, taxPart = 0] = deltas;
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
  // The discount floors on the cumulative goods part too, so earlier refunds
  // cannot add up to more than the order's discount.
  const discountOf = (goodsIdr: number) =>
    net > 0
      ? Math.min(
          order.discountIdr,
          Math.floor((order.discountIdr * goodsIdr) / net),
        )
      : 0;
  const priorGoods = priorParts[0] ?? 0;
  const discountPart = Math.max(
    0,
    discountOf(priorGoods + netPart) - discountOf(priorGoods),
  );
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

/**
 * legend-980 (restrictive, "jangan sampai rugi"): a POS refund and a manual
 * refund of an order's lines are mutually exclusive per order. A manual refund
 * pays the line's net share (service charge and PBJT included, see
 * order-issue-manual-refund.ts) and a POS refund counts items and amounts by
 * its own rules, so mixing them could pay one line or one rupiah twice. An
 * issue whose refund was rejected or that was cancelled paid nothing and does
 * not block. Only manual refunds of the approval route count: an ORD-09
 * failed-item manual issue sends the guest to this very POS refund
 * (order-issue-route-refund.ts). Business-rule restriction pending founder
 * review. Also guards the cash void, which is a refund too.
 */
async function assertNoLiveManualRefund(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        liveRouteManualRefundWhere(context.tenant.tenantId),
        eq(orderIssues.orderId, orderId),
      ),
    )
    .limit(1);
  if (row)
    throw new HttpError(
      409,
      "REFUND_MANUAL_REFUND_EXISTS",
      "Pesanan ini sudah punya refund manual per item. Selesaikan sisanya lewat alur refund manual per item, bukan refund kasir.",
    );
}

/**
 * What each earlier refund returned in total (payout plus the deposit part it
 * released), oldest first: the history `refundSplit` replays so every part is
 * capped by what earlier refunds really booked.
 */
async function earlierRefundTotals(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  refunds: readonly RefundRow[],
): Promise<number[]> {
  const depositOf = new Map<string, number>();
  if (refunds.length > 0)
    for (const row of await tx
      .select({
        posRefundId: posDepositRefunds.posRefundId,
        amountIdr: posDepositRefunds.amountIdr,
      })
      .from(posDepositRefunds)
      .where(
        and(
          eq(posDepositRefunds.tenantId, context.tenant.tenantId),
          eq(posDepositRefunds.orderId, orderId),
        ),
      ))
      depositOf.set(
        row.posRefundId,
        (depositOf.get(row.posRefundId) ?? 0) + Number(row.amountIdr),
      );
  return refunds.map((row) => row.amountIdr + (depositOf.get(row.id) ?? 0));
}

/** POST .../corrections/refund — linked refund against a paid sale (POS-04). */
export async function refundPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: RefundInput,
  requestedAt = new Date(),
): Promise<PosRefund> {
  // An edge snapshot cannot prove the bill's admin/POS refund history, even
  // while its cloud link is connected. Require the authoritative cloud path;
  // the static setting also covers the interval before edge runtime boots.
  if (getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true")
    throw new HttpError(
      409,
      "REFUND_HISTORY_UNVERIFIED",
      "Refund tidak bisa dilakukan di kasir edge karena riwayat refund tidak bisa diverifikasi. Refund penjualan kasir offline belum didukung di rilis 1; hubungi finance.",
    );
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
    async (tx, { order }, now) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      // legend-980: never next to a live manual refund of the same order.
      await assertNoLiveManualRefund(tx, context, order.id);
      await assertNoOrd09Refund(tx, context.tenant.tenantId, order.id);
      const tenders = (await tendersOf(tx, context, order.id)).map(tenderDto);
      // 936: a points tender redeemed through the member ledger (a
      // `pos_tender` redeem row keyed by the tender id) has no return path yet:
      // no points would be given back. Refuse before anything is written;
      // founder decides the rule. Older points tenders without that row refund
      // as before.
      const pointsTenderIds = tenders
        .filter(
          (tender) =>
            tender.status === "captured" && tender.method === "points",
        )
        .map((tender) => tender.id);
      if (pointsTenderIds.length > 0) {
        const [ledgered] = await tx
          .select({ id: pointLedger.id })
          .from(pointLedger)
          .where(
            and(
              eq(pointLedger.tenantId, context.tenant.tenantId),
              eq(pointLedger.type, "redeem"),
              eq(pointLedger.sourceType, "pos_tender"),
              inArray(pointLedger.sourceId, pointsTenderIds),
            ),
          )
          .limit(1);
        if (ledgered)
          throw new HttpError(
            409,
            "REFUND_POINTS_TENDER_UNSUPPORTED",
            "Transaksi ini dibayar dengan poin member; refund transaksi berpoin belum tersedia.",
          );
      }
      const paid = tenders
        .filter((tender) => tender.status === "captured")
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
      const posRefunded = refunds.reduce((sum, row) => sum + row.amountIdr, 0);
      const refunded = posRefunded;
      const depositRefunded =
        Number(order.depositAppliedIdr) > 0
          ? await depositRefundedOfOrder(tx, context, order.id)
          : 0;
      // legend-5g9sn (Q25): the vouchers and the live recovery refunds of the
      // order count against what the guest paid too (order level, read under
      // the order lock only: never an issue lock, the voucher side is
      // issue then order).
      const given = await orderGivenOf(tx, context.tenant.tenantId, order.id);
      const recoveryGivenIdr = given.vouchersIdr + given.recoveryRefundsIdr;
      // CTO 11 Nov: no refund while a dearer-swap charge of the order is still
      // open; settle or close the charge first.
      if (given.openChargesCount > 0)
        throw new HttpError(
          422,
          "REFUND_OPEN_CHARGE",
          "Tagihan selisih penukaran pesanan ini belum selesai; selesaikan tagihan selisih dulu.",
        );
      let capCutIdr = 0;
      // 1116 (SO 1114 P1): money that already went back through the provider
      // (its own refunds, our gateway refunds not inside `refunded`, or an
      // intent flagged refunded with no sure amount, counted whole) comes off
      // too. `given.paidIdr` is the non-points tenders net of it.
      const nonPointsPaid = tenders
        .filter(
          (tender) =>
            tender.status === "captured" && tender.method !== "points",
        )
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
      const providerOutIdr = Math.max(0, nonPointsPaid - given.paidIdr);
      const roomIdr = Math.max(
        0,
        paid - providerOutIdr - refunded - recoveryGivenIdr,
      );

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
      // 936 D: a returned ticket line refunds its ticket (a used one refuses);
      // money without any item on a bill with an issued ticket is refused.
      await refundPosTicketsOfRefundedLines(tx, context, {
        orderId: order.id,
        itemIds: [...refundedNow.keys()],
        moneyRefund: Number(input.amountIdr) > 0,
        now,
        actorUserId: caller.userId,
      });

      // A promo order is re-priced (founder rules, legend-q1e0): the payout is
      // what the guest paid minus what the kept items still cost. A failing
      // port aborts the refund.
      let payout = input.amountIdr;
      // legend-wkl3 (CTO): nothing due (e.g. a returned free item, founder Q19)
      // still records the return as a Rp0 row: items, reason and audit, no
      // payment line, no event, no gateway, no stock reversal.
      let goodsReturnOnly = false;
      // A DP-only return has no drawer payout; its original payment receives
      // a separate, exact WS-05 refund request in this transaction.
      let depositGoodsReturn = false;
      let depositOwedIdr = 0;
      let depositRefundIdr = 0;
      // legend-aef1: bill value (before promo) of the items this refund returns,
      // set once the promo is re-priced; the revenue split builds on it.
      let promoRefundedSubtotalIdr: number | null = null;
      const promoApplication =
        await posPromoRefundPort().livePromoApplicationOf(
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
        // legend-xhl5j: the manual discount stacked on the sale decides whether
        // a voucher may come back (the guest keeps it on the kept goods).
        const manualDiscount = (await liveDiscountsOf(tx, context, order.id))
          .filter((row) => row.source === "manual")
          .reduce((sum, row) => sum + Number(row.amountIdr), 0);
        const recomputed =
          await posPromoRefundPort().recomputeAfterPartialRefund(tx, context, {
            orderId: order.id,
            keptLines,
            reason: input.reasonNote,
            actorUserId: caller.userId,
            at: now,
            deferPayout: true,
            manualDiscountIdr: manualDiscount,
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
          // deposit applied to the bill. Q81 returns its proportional DP
          // share through the original intent; tenders pay only their share.
          const net = order.subtotalIdr - order.discountIdr;
          const keptPayableBill =
            net > 0
              ? Number(
                  (BigInt(order.totalIdr) * BigInt(keptGoods)) / BigInt(net),
                )
              : 0;
          const paidIn = paid + Number(order.depositAppliedIdr);
          const cumulativeDue = Math.max(0, paidIn - keptPayableBill);
          const dueBill = Math.max(
            0,
            cumulativeDue - refunded - depositRefunded,
          );
          // Rp0 return when the guest is owed nothing, or (s7rx B, below) when
          // what is owed sits only on the deposit; owed with no tender left and
          // no deposit stays refused below. A settlement never writes Rp0.
          // Q25 per item: `dueBill` is cumulative, so what every line returned
          // so far (earlier POS refunds and this request, each once) already
          // gave back through recovery (vouchers, live recovery refunds) is
          // not owed again.
          const namedGivenIdr = [
            ...new Set(
              [...refundedBefore.keys(), ...requested.map((r) => r.itemId)].map(
                (itemId) => given.toOriginal(itemId),
              ),
            ),
          ].reduce((sum, line) => sum + (given.lineGivenIdr.get(line) ?? 0), 0);
          const dueIdr = Math.max(0, dueBill - namedGivenIdr);
          goodsReturnOnly = !settlement && dueBill === 0;
          // legend-a0i7 (Codex 127): the returned items are used up by this
          // refund and a promo order cannot be refunded by amount alone, so a
          // payout below what is due would lock the rest for good. Asking
          // less is refused before anything is written; asking more is
          // capped to what is due (unchanged).
          const depositTarget =
            paidIn > 0
              ? Number(
                  (BigInt(cumulativeDue) * BigInt(order.depositAppliedIdr)) /
                    BigInt(paidIn),
                )
              : 0;
          depositRefundIdr = Math.min(
            Math.max(0, Number(order.depositAppliedIdr) - depositRefunded),
            Math.max(0, depositTarget - depositRefunded),
            dueIdr,
          );
          const owedIdr = Math.min(
            Math.max(0, dueIdr - depositRefundIdr),
            roomIdr,
          );
          // legend-186 (s7rx B): owed, but only from the deposit (the tenders
          // are used up): the item still comes back as a Rp0 return and the
          // rest stays on the deposit side.
          if (
            !settlement &&
            dueIdr > 0 &&
            owedIdr === 0 &&
            depositRefundIdr > 0
          ) {
            goodsReturnOnly = true;
            depositGoodsReturn = true;
          }
          if (dueIdr > 0 && input.amountIdr < dueIdr)
            throw new HttpError(
              422,
              "REFUND_AMOUNT_BELOW_DUE",
              `Refund item ini harus ${rupiah(dueIdr)}; isi jumlah tersebut agar sisa pembayaran tamu tidak tertahan.`,
            );
          payout = Math.min(input.amountIdr, owedIdr);
          capCutIdr = Math.max(0, dueIdr - depositRefundIdr) - owedIdr;
          // A residual must never silently become cash or customer credit.
          if (Number(order.depositAppliedIdr) > 0)
            depositOwedIdr = Math.max(0, dueIdr - owedIdr - depositRefundIdr);
        }
        if (goodsReturnOnly) payout = 0;
        else if (payout <= 0 && depositRefundIdr <= 0)
          throw new HttpError(
            422,
            "REFUND_NOTHING_DUE",
            "Tidak ada dana yang perlu dikembalikan.",
          );
      }
      if (!promoApplication && Number(order.depositAppliedIdr) > 0) {
        const paidIn = paid + Number(order.depositAppliedIdr);
        if (input.amountIdr > paidIn - refunded - depositRefunded)
          throw new PosError("REFUND_EXCEEDS_PAID");
        depositRefundIdr = Math.min(
          Math.max(0, Number(order.depositAppliedIdr) - depositRefunded),
          Math.max(
            0,
            Number(
              (BigInt(posRefunded + depositRefunded + input.amountIdr) *
                BigInt(order.depositAppliedIdr)) /
                BigInt(paidIn),
            ) - depositRefunded,
          ),
        );
        payout = input.amountIdr - depositRefundIdr;
        if (payout === 0) goodsReturnOnly = true;
      }
      // legend-5g9sn: a refund above what the vouchers and recovery refunds
      // left is cut to it (as the promo payout is capped to what is due);
      // nothing left is refused. Q25 is per item: a refund that names items is
      // also bound by what each named line still holds.
      if (
        !promoApplication &&
        recoveryGivenIdr > 0 &&
        payout + depositRefundIdr > 0
      ) {
        const askedIdr = payout + depositRefundIdr;
        payout = Math.min(payout, roomIdr);
        // A deposit order: the line room holds the cash payout and the deposit
        // share together.
        if (requested.length > 0) {
          const depositOfRefund = await depositRefundedByPosRefund(
            tx,
            context,
            order.id,
          );
          const lineRoom = lineRoomIdr(
            order,
            allItems,
            refunds.map((row) => ({
              ...row,
              amountIdr: row.amountIdr + (depositOfRefund.get(row.id) ?? 0),
            })),
            given,
            requested,
          );
          depositRefundIdr = Math.min(depositRefundIdr, lineRoom);
          payout = Math.min(payout, lineRoom - depositRefundIdr);
        }
        capCutIdr = askedIdr - payout - depositRefundIdr;
        if (payout <= 0) {
          if (depositRefundIdr <= 0)
            throw new HttpError(
              422,
              "REFUND_NOTHING_DUE",
              "Tidak ada dana yang perlu dikembalikan.",
            );
          payout = 0;
          goodsReturnOnly = true;
        }
      }
      const totalReturnIdr = payout + depositRefundIdr;
      if (depositRefundIdr > 0)
        now = await depositRefundFactTime(tx, context, order, now);
      if (depositRefundIdr > 0 && requested.length === 0)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Refund DP harus menyebut item yang diretur.",
        );
      if (!goodsReturnOnly)
        assertRefundWithinPaid(
          idr(paid),
          // 1116: what already went back through the provider is spent too.
          idr(Math.min(paid, refunded + recoveryGivenIdr + providerOutIdr)),
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
        minValueIdr: totalReturnIdr,
        deviceId: caller.deviceId,
        now,
      });
      // A Rp0 goods return only records item quantities: it has no refund
      // lines, money event or gateway request, so it consumes no authority.
      if (totalReturnIdr > 0) {
        const candidate = {
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          amountIdr: payout,
        };
        // The order locks serialize this decision with admin approvals. Pending
        // admin requests reserve money too; gateway mirrors count only once.
        const committed = await refundCommittedAmount(tx, candidate, {
          includePendingReservations: true,
          paidCapScope: true,
        });
        if (committed > BigInt(paid)) throw new PosError("REFUND_EXCEEDS_PAID");
        if (
          !(await refundApprovalWithinLimit(
            tx,
            context,
            override.approvedBy!,
            { ...candidate, amountIdr: totalReturnIdr },
            now,
          ))
        )
          throw refundApprovalLimitRefused();
      }
      // Deferred money events have no complete per-tender/item history. Until
      // each fact has its native refund row, allocating another refund could
      // return more through one tender or return the same goods twice.
      const deferred = await loadDeferredRefundCommitments(tx, {
        tenantId: context.tenant.tenantId,
        outletId: order.outletId,
        orderIds: [order.id],
      });
      const nativeIds = new Set(refunds.map((row) => row.id.toLowerCase()));
      if (deferred.some((fact) => !nativeIds.has(fact.refundId)))
        throw new HttpError(
          409,
          "REFUND_HISTORY_UNVERIFIED",
          "Ada refund dari kasir edge lama yang belum tercatat di pusat, jadi refund berikutnya ditahan. Hubungi finance untuk rekonsiliasi.",
        );
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
          approvedBy: override.approvedBy!,
          approvalRequestId: override.approvalRequestId,
          overrideId: override.id,
          refundedAt: now,
          shiftId: shift?.id ?? null,
          needsApproval,
        })
        .returning();
      if (!row) throw new Error("Refund insert returned no row");
      const depositLines = await requestPosRefundDepositPart(tx, context, {
        order,
        caller,
        posRefundId: row.id,
        lines,
        amountIdr: depositRefundIdr,
        now,
      });
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
      const split = refundSplit(
        order,
        totalReturnIdr,
        promoRefundedSubtotalIdr,
        await earlierRefundTotals(tx, context, order.id, refunds),
      );
      // Goods part of the payout goes onto the promo application's ledger.
      if (promoApplication && totalReturnIdr > 0)
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
        amountIdr: totalReturnIdr,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: override.approvedBy!,
        approvalRequestId: override.approvalRequestId,
        overrideId: override.id,
        ...split,
        refundCashIdr: bucket("cash"),
        refundGatewayIdr: bucket("gateway") + depositRefundIdr,
        refundEdcIdr: bucket("edc"),
        refundPointsIdr: bucket("points"),
        ...(depositLines.length > 0 ? { depositLines } : {}),
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
      if (totalReturnIdr > 0) {
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
          before: { id: order.id, amountIdr: posRefunded },
          after: {
            id: row.id,
            amountIdr: row.amountIdr,
            requestedAmountIdr: input.amountIdr,
            ...(capCutIdr > 0 ? { recoveryCapCutIdr: capCutIdr } : {}),
            ...(depositRefundIdr > 0 ? { depositRefundIdr } : {}),
            items: requested,
            ...(goodsReturnOnly
              ? {
                  goodsReturnOnly: true,
                  goodsReturnNote: depositGoodsReturn
                    ? "Retur barang tanpa dana tunai: refund DP diminta melalui pembayaran asal."
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
    requestedAt,
  );
}
