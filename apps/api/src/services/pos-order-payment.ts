// POS payment panel: tenders and the WS-05 hand-off (bead legend-kk7; PRD
// v1.7 §3 F8 "Pembayaran", §3.13 "Siklus Pembayaran"; PAY-01/PAY-02;
// contract @starter/shared/pos `addPosTender`, calculations.ts).
//
// - The body never carries an applied amount (TEN-02 money rule): cash sends
//   what the customer handed over and the server applies min(received,
//   remaining) and computes change (`planCashTender`); every other method
//   settles the remaining balance.
// - Cash is captured at once. QRIS opens a WS-05 payment link + intent for the
//   remaining balance and stays `authorized` until the verified `payment.paid`
//   (PAY-02) arrives: `handlePosPaymentPaid` captures it, idempotently. The
//   link is stored on the tender row, never on `orders.payment_link_id`, so
//   the QR consumer (qr-order-payment.ts) never mistakes a POS bill for a QR
//   pay-first order.
// - EDC and points settle through ports (legend-m0k, loyalty); VA, e-wallet
//   and online card need a bank/channel the contract body does not carry and
//   are refused for now.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  CoreError,
  idr,
  uuidSchema,
  z,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  addPosTender as addTenderEndpoint,
  assertPosOrderSettleable,
  planCashTender,
  posTenderResultSchema,
  PosError,
  type PosTenderResult,
} from "@starter/shared/pos";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { posOrders, posOrderTenders } from "../db/schema/pos-order.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { getEdgeRuntimeState } from "../edge/runtime";
import { loadActiveIntegrationCredentials } from "./platform-integration.service.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { netAllocatedIdrSql } from "./payment-net-allocated-sql.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import {
  cancelPaymentLinkInTx,
  createIntent,
  createPaymentLink,
} from "./payment.service.ts";
import { assertNoOpenFundsOfPosOrderTx } from "./pos-order-open-funds.ts";
import {
  isBusinessDayClosed,
  lockCashierShiftForCash,
} from "./pos-cash-guard.ts";
import {
  pendingRefundIdr,
  requestPosLatePaymentRefund,
} from "./pos-order-late-payment.ts";
import { settlePosEdcStandalone } from "./pos-edc-standalone.ts";
import { posEdcTenderPort, posPointsTenderPort } from "./pos-order-ports.ts";
import { freshDetail, mutatePosOrder } from "./pos-order.service.ts";
import {
  POS_QRIS_LIFETIME_MS,
  assertNoActiveQrisHold,
  closeQrisHoldTx,
  lockHoldsOfOrder,
  markQrisHoldsPaidByIntentTx,
  openQrisHold,
  voidSupersededQrisTendersTx,
} from "./pos-qris-hold.ts";
import { assertPosTicketsIssuable } from "./facility-pos-tickets.ts";
import {
  appendOrderEvent,
  assertExpectedStatus,
  assertMutable,
  assertNoOpenEdcRequest,
  auditPos,
  bumpPos,
  capturedIdr,
  hasOpenEdcRequest,
  remainingIdr,
  tenderDto,
  tendersOf,
  type OrderRow,
  type PosCaller,
  type PosRow,
} from "./pos-order-support.ts";

type AddTenderInput = z.output<typeof addTenderEndpoint.body>;

/** The envelope a WS-05 outbox consumer hands over (`payment.paid`). */
export type DomainEvent = EventEnvelope;

function linkSealAad(tenantId: string, tenderId: string): string {
  return `pos-order-payment-link:${tenantId}:${tenderId}`;
}

const closedPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  reason: z.string().optional(),
});

const paidPayloadSchema = z.looseObject({
  paymentLinkId: uuidSchema,
  intentId: uuidSchema,
  providerRef: z.string().min(1).max(100).nullable().optional(),
});

/** True on an edge node (same rule as device-pin.service.ts). */
export function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

export async function edgeHasGatewayCredentials(
  context: ScopedTenantContext,
  outletId: string,
): Promise<boolean> {
  for (const provider of ["doit", "duitku"] as const)
    if (await loadActiveIntegrationCredentials(context, provider, outletId))
      return true;
  return false;
}

/**
 * Voids every QRIS tender of the order that still waits for its payment and
 * closes its WS-05 link (bead legend-b0au), inside the caller's transaction:
 * the tender becomes `voided` with `resolvedAt`, the link stops taking money
 * (`cancelPaymentLinkInTx`: link expired, pending intent `expired`, one
 * `payment.expired` event). Idempotent: a tender already resolved is not
 * returned and nothing is cancelled twice. The caller writes its own order
 * event / audit, as before (complete and void order added none for this).
 * `caller` is accepted for symmetry with the callers; the void has no actor
 * column.
 */
export async function voidPendingQrisTenders(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    now: Date;
    caller?: PosCaller | null;
    /** Refuse (409) when the guest already paid a pending QRIS (void order). */
    refuseWhenPaid?: boolean;
    /**
     * Wall-clock time the links close at (default `now`). legend-r5brx: a
     * caller stamping the tenders with a fact time that may run ahead of the
     * clock still closes the link at the real time, so no new intent can open
     * on it in between.
     */
    linkClosedAt?: Date;
  },
): Promise<(typeof posOrderTenders.$inferSelect)[]> {
  const tenantId = context.tenant.tenantId;
  if (input.refuseWhenPaid) {
    const pending = await tx
      .select({ linkId: posOrderTenders.paymentLinkId })
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.orderId, input.orderId),
          eq(posOrderTenders.status, "authorized"),
          isNotNull(posOrderTenders.paymentLinkId),
        ),
      );
    const linkIds = pending.flatMap((row) =>
      row.linkId === null ? [] : [row.linkId],
    );
    if (linkIds.length > 0) await assertNoPaidQrisIntent(tx, tenantId, linkIds);
  }
  const voided = await tx
    .update(posOrderTenders)
    .set({ status: "voided", resolvedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, input.orderId),
        eq(posOrderTenders.status, "authorized"),
        isNotNull(posOrderTenders.paymentLinkId),
      ),
    )
    .returning();
  for (const tender of voided)
    if (tender.paymentLinkId)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: tender.paymentLinkId,
        now: input.linkClosedAt ?? input.now,
        reason: "cancelled",
      });
  return voided;
}

/**
 * A QRIS the guest already paid (verified `paid` intent on the link) whose
 * `payment.paid` event the consumer has not booked yet must not be voided:
 * the money is in, so the cashier waits for the confirmation.
 */
async function assertNoPaidQrisIntent(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  linkIds: readonly string[],
): Promise<void> {
  // Lock the links first (link -> intent, the WS-05 confirmation order), so a
  // confirmation cannot commit `paid` between this check and the cancel.
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        inArray(paymentLinks.id, [...linkIds]),
      ),
    )
    .orderBy(asc(paymentLinks.id))
    .for("update");
  const [paid] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.paymentLinkId, [...linkIds]),
        eq(paymentIntents.status, "paid"),
      ),
    )
    .limit(1);
  if (paid)
    throw new CoreError("CONFLICT", "QRIS sudah dibayar; tunggu konfirmasi.");
}

/**
 * POST .../tenders. Serialized on the order row: two cashiers splitting one
 * bill never apply more than what is due; the loser of a stale screen gets
 * PRECONDITION_FAILED (expectedStatus / If-Match).
 */
export async function addPosTender(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  // The HTTP body always states `expectedStatus`; the points redeem route
  // (936) does not, and then the order is taken as it is under the lock.
  input: Omit<AddTenderInput, "expectedStatus"> &
    Partial<Pick<AddTenderInput, "expectedStatus">>,
  now = new Date(),
): Promise<PosTenderResult> {
  // The member QR is a single-use proof, not part of what the payment is: a
  // replay of the same key answers the stored result even with another token.
  const { idempotencyKey, ...request } = input;
  delete request.memberToken;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.tender",
      request,
    },
    async (tx, locked) => {
      const { order } = locked;
      let { pos } = locked;
      const tenantId = context.tenant.tenantId;
      assertExpectedStatus(order, input.expectedStatus ?? order.status);
      assertMutable(order);
      assertPosOrderSettleable({ status: order.status });
      // EDC-01 (legend-ig2sl): an open or unbooked ECR sale already asked the
      // terminal for this bill; another tender would be a second payment. Only
      // the ECR tender that carries that request's id settles it.
      const settlesEcrRequest =
        input.edcTransactionId != null &&
        !input.standalone &&
        (input.method === "edc_card" || input.method === "edc_qris");
      // legend-yhia9 D-01: while a QR can still be paid the bill is frozen, so
      // no other tender and no second QR (the 0369 trigger is the backstop).
      // legend-w0ows: not for the tender that books a card sale already sent
      // to the terminal (the card wins, founder Q7). The agent refuses to START
      // a sale while a hold is active, so a hold seen here came in while the
      // sale ran: it ends first (QR tender voided, link closed locally), then
      // the card tender books. Lock order: orders -> pos_orders -> holds ->
      // EDC advisory -> tender. A QR paid at the provider later meets a voided
      // tender and is refunded in full (late payment), never kept.
      // 936 D: a bill whose ticket hold lapsed takes no money (a card sale
      // already sent to the terminal is booked regardless: the card wins).
      if (!settlesEcrRequest)
        await assertPosTicketsIssuable(tx, context, order.id);
      if (!settlesEcrRequest) {
        await assertNoActiveQrisHold(tx, context, order.id);
        await assertNoOpenEdcRequest(tx, context, order);
        // SO-896 (legend-o6q8i): guest money of an earlier QR sits parked
        // open (e.g. paid late after a force release): no second payment.
        // A hand-keyed (standalone) card/QR tender is a new payment too: it
        // refuses here, before settlePosEdcStandalone spends the override or
        // writes the EDC ledger. Only an ECR request already running
        // (settlesEcrRequest) skips this guard (founder Q7).
        if (
          input.method === "cash" ||
          input.method === "qris" ||
          input.method === "points" ||
          ((input.method === "edc_card" || input.method === "edc_qris") &&
            input.standalone)
        )
          await assertNoOpenFundsOfPosOrderTx(tx, tenantId, order);
      } else {
        const lockedHolds = await lockHoldsOfOrder(tx, tenantId, order.id);
        await hasOpenEdcRequest(tx, context, order);
        // so-879 P1: the 0380 trigger refuses a tender void while ANY other
        // hold of the bill is active, so the hold whose tender is still
        // `authorized` closes last; the others (voided tender, no tender) end
        // first and touch no tender.
        const waitingTenderIds = new Set(
          (await tendersOf(tx, context, order.id))
            .filter((row) => row.status === "authorized")
            .map((row) => row.id),
        );
        const holds = [...lockedHolds].sort(
          (a, b) =>
            Number(a.tenderId !== null && waitingTenderIds.has(a.tenderId)) -
            Number(b.tenderId !== null && waitingTenderIds.has(b.tenderId)),
        );
        for (const hold of holds) {
          if (hold.state !== "open" && hold.state !== "cancelling") continue;
          await closeQrisHoldTx(tx, context, {
            order,
            pos,
            hold,
            reason: "force_released",
            evidence: {
              anomaly: "card_sale_booked",
              edcTransactionId: input.edcTransactionId ?? null,
            },
            caller,
            auditAction: "pos_qris_hold.closed_by_card_sale",
            now,
          });
          // The close bumped the POS version; the tender below bumps it again
          // from the fresh row (compare-and-set).
          const [fresh] = await tx
            .select()
            .from(posOrders)
            .where(
              and(
                eq(posOrders.tenantId, tenantId),
                eq(posOrders.orderId, order.id),
              ),
            );
          if (fresh) pos = fresh;
        }
      }
      // Native POS payments use tender-level links. A legacy order-level
      // link can still collect through its public token or a remote code,
      // even after a nominal expiry, so do not open a second payment source.
      if (order.paymentLinkId !== null)
        throw new CoreError(
          "CONFLICT",
          "Pesanan ini memiliki tautan pembayaran lama; selesaikan sumber pembayaran itu terlebih dahulu.",
        );
      let tenders = await tendersOf(tx, context, order.id);
      // legend-b0au: another method while a QRIS waits closes that QRIS first
      // (its link stops taking money) unless the guest already paid it.
      if (input.method !== "qris") {
        const waiting = tenders.filter(
          (tender) =>
            tender.status === "authorized" && tender.paymentLinkId !== null,
        );
        if (waiting.length > 0) {
          await assertNoPaidQrisIntent(
            tx,
            tenantId,
            waiting.map((tender) => tender.paymentLinkId as string),
          );
          const voided = await voidPendingQrisTenders(tx, context, {
            orderId: order.id,
            now,
            caller,
          });
          for (const tender of voided) {
            await appendOrderEvent(tx, context, {
              order,
              type: "order.tender_voided",
              payload: {
                tenderId: tender.id,
                method: tender.method,
                amountIdr: tender.amountIdr,
                reason: "replaced_by_other_method",
              },
              caller,
              now,
            });
            await auditPos(
              tx,
              context,
              {
                action: "pos_order.tender_voided",
                order,
                caller,
                before: { id: order.id, status: "authorized" },
                after: {
                  id: order.id,
                  method: tender.method,
                  amountIdr: tender.amountIdr,
                  status: "voided",
                },
              },
              now,
            );
          }
          tenders = await tendersOf(tx, context, order.id);
        }
      }
      const remaining = remainingIdr(order, tenders);
      if (remaining <= 0)
        throw new PosError("ORDER_NOT_PAYABLE", "Tagihan ini sudah lunas.");
      if (
        input.method !== "points" &&
        (input.pointsUsed != null || input.memberToken != null)
      )
        throw new PosError("CASH_TENDER_MISMATCH");
      const base = {
        tenantId,
        outletId: order.outletId,
        orderId: order.id,
        method: input.method,
        reference: input.reference ?? null,
        edcTransactionId: input.edcTransactionId ?? null,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      let inserted: typeof posOrderTenders.$inferSelect | undefined;
      switch (input.method) {
        case "cash": {
          if (input.receivedIdr === undefined)
            throw new PosError("CASH_TENDER_MISMATCH");
          const plan = planCashTender(idr(remaining), idr(input.receivedIdr));
          const shift = await lockCashierShiftForCash(tx, context, {
            outletId,
            cashierId: caller.userId,
            deviceId: caller.deviceId,
            mode: "in",
            at: now,
          });
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              shiftId: shift.id,
              provider: "manual",
              amountIdr: plan.amountIdr,
              receivedIdr: plan.receivedIdr,
              changeIdr: plan.changeIdr,
              status: "captured",
              resolvedAt: now,
              capturedBy: caller.userId,
            })
            .returning();
          break;
        }
        case "qris": {
          if (
            tenders.some(
              (tender) =>
                tender.status === "authorized" && tender.paymentLinkId !== null,
            )
          )
            throw new CoreError(
              "CONFLICT",
              "Masih ada QRIS yang menunggu pembayaran untuk pesanan ini.",
            );
          // D-09: an edge node calls the provider itself, so it needs gateway
          // credentials locally; without them the QR cannot be issued (and a
          // hold could never be closed there).
          if (
            isEdgeProcess() &&
            !(await edgeHasGatewayCredentials(context, order.outletId))
          )
            throw new PosError("QRIS_NEEDS_CLOUD");
          // WS-05 bill for exactly the remaining balance (PAY-01: the amount
          // is the server's). The already covered part shows as a reduction.
          const covered = order.totalIdr - remaining;
          const opened = await createPaymentLink(
            context,
            {
              outletId: order.outletId,
              reference: order.number,
              tableLabel: null,
              pax: null,
              // legend-zmc2: the link adds service and tax to the subtotal.
              subtotalIdr: orderNetSubtotalIdr(order),
              discountIdr: idr(order.discountIdr + covered),
              serviceChargeIdr: order.serviceChargeIdr,
              taxIdr: order.taxIdr,
              roundingIdr: order.roundingIdr,
              totalIdr: idr(remaining),
              returnPath: null,
            },
            caller.userId,
            now,
          );
          const intent = await createIntent(
            context,
            opened.token,
            {
              method: "qris",
              channelCode: null,
              idempotencyKey: `pos-${createHash("sha256")
                // legend-yhia9 QH-17: bound to the link too. A POS transaction
                // that rolled back after the provider made the intent leaves
                // an orphan intent on a link nobody holds; the retry opens a
                // new link and must get its own intent, not hit the old one.
                .update(`${order.id}:${opened.linkId}:${idempotencyKey}`)
                .digest("hex")
                .slice(0, 48)}`,
              // Q92: the cashier QR lives 5 minutes (a per-tender decision;
              // the shared QRIS intent lifetime stays 10 minutes).
              expiresAt: new Date(
                now.getTime() + POS_QRIS_LIFETIME_MS,
              ).toISOString(),
            },
            now,
            { orderLockedByCaller: true },
          );
          // The intent names the gateway that issued the code (routing rule or
          // its fallback); it committed before this read.
          const [issued] = await tx
            .select({ provider: paymentIntents.provider })
            .from(paymentIntents)
            .where(
              and(
                eq(paymentIntents.tenantId, tenantId),
                eq(paymentIntents.id, intent.id),
              ),
            );
          if (!issued) throw new Error("Payment intent not found");
          const tenderId = randomUUID();
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              id: tenderId,
              provider: issued.provider,
              paymentLinkId: opened.linkId,
              paymentLinkTokenSealed: sealSecret(
                opened.token,
                linkSealAad(tenantId, tenderId),
              ),
              paymentIntentId: intent.id,
              amountIdr: idr(remaining),
              status: "authorized",
              resolvedAt: null,
            })
            .returning();
          if (!inserted) throw new Error("Tender insert returned no row");
          // D-01: the hold opens in the same POS transaction as the tender.
          await openQrisHold(tx, {
            order,
            tender: inserted,
            paymentIntentId: intent.id,
            capturedIdr: capturedIdr(tenders),
            openedBy: caller.userId,
            now,
          });
          break;
        }
        case "edc_card":
        case "edc_qris":
        case "points": {
          if (input.method === "points" && input.pointsUsed == null)
            throw new CoreError(
              "VALIDATION_ERROR",
              "Pembayaran poin mencantumkan jumlah poin.",
            );
          // EDC-04: a hand-keyed terminal payment takes the supervisor-approved
          // standalone path; everything else settles through its port.
          const settled =
            input.standalone &&
            (input.method === "edc_card" || input.method === "edc_qris")
              ? await settlePosEdcStandalone(tx, context, {
                  orderId: order.id,
                  orderNumber: order.number,
                  outletId: order.outletId,
                  method: input.method,
                  amountIdr: remaining,
                  terminalId: input.standalone.terminalId,
                  bankRef: input.standalone.bankRef,
                  approvalCode: input.standalone.approvalCode ?? null,
                  overrideId: input.standalone.overrideId,
                  cashierId: caller.userId,
                  deviceId: caller.deviceId,
                  at: now,
                })
              : await (
                  input.method === "points"
                    ? posPointsTenderPort()
                    : posEdcTenderPort()
                )(tx, context, {
                  orderId: order.id,
                  outletId: order.outletId,
                  method: input.method,
                  amountIdr: remaining,
                  reference: input.reference ?? null,
                  edcTransactionId: input.edcTransactionId ?? null,
                  pointsUsed: input.pointsUsed ?? null,
                  memberToken: input.memberToken ?? null,
                  cashierId: caller.userId,
                  at: now,
                });
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              ...("tenderId" in settled && settled.tenderId
                ? { id: settled.tenderId }
                : {}),
              provider: input.method === "points" ? "manual" : "edc",
              reference: settled.reference ?? base.reference,
              edcTransactionId:
                "edcTransactionId" in settled
                  ? settled.edcTransactionId
                  : base.edcTransactionId,
              pointsUsed:
                input.method === "points" ? (input.pointsUsed ?? null) : null,
              // A points tender covers what its points are worth (never more
              // than the remaining balance); every other tender settles it all.
              amountIdr: idr(
                input.method === "points" &&
                  "amountIdr" in settled &&
                  settled.amountIdr !== undefined
                  ? Math.min(settled.amountIdr, remaining)
                  : remaining,
              ),
              status: "captured",
              resolvedAt: now,
              capturedBy: caller.userId,
              approvedBy: settled.approvedBy,
            })
            .returning();
          break;
        }
        default:
          throw new CoreError(
            "VALIDATION_ERROR",
            "Metode ini belum tersedia di POS; gunakan tunai, QRIS atau EDC.",
          );
      }
      if (!inserted) throw new Error("Tender insert returned no row");
      await bumpPos(tx, context, pos, now);
      await appendOrderEvent(tx, context, {
        order,
        type: "order.tender_added",
        payload: {
          tenderId: inserted.id,
          method: inserted.method,
          amountIdr: inserted.amountIdr,
          status: inserted.status,
        },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.tender_added",
          order,
          caller,
          before: null,
          after: {
            id: order.id,
            method: inserted.method,
            amountIdr: inserted.amountIdr,
            status: inserted.status,
          },
        },
        now,
      );
      const detail = await freshDetail(tx, context, outletId, orderId);
      const after = await tendersOf(tx, context, order.id);
      const current = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
      const fresh = current[0] ?? order;
      return posTenderResultSchema.parse({
        order: detail,
        tender: tenderDto(inserted),
        remainingIdr: remainingIdr(fresh, after),
      });
    },
  );
}

/**
 * Voids the order's pending QRIS tenders (event + audit with `reason`), bumps
 * the order, and requests the full late-payment refund for the paid intent.
 * Shared by the webhook branches that cannot capture the money
 * (`bill_below_tender`, `business_day_closed`, `edc_request_open`,
 * `refund_reserved`). Never throws for these cases.
 */
async function voidTendersAndRefundPaidQris(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: OrderRow;
    pos: PosRow;
    paymentLinkId: string;
    intentId: string;
    /** The tender whose payment arrived; its own hold ends, no other. */
    tenderId: string;
    reason:
      | "bill_below_tender"
      | "business_day_closed"
      | "edc_request_open"
      | "refund_reserved"
      | "provider_refunded";
    now: Date;
    /** Wall-clock time the link closes at, when `now` is a fact time. */
    linkClosedAt?: Date;
  },
): Promise<void> {
  const { order, pos, now } = input;
  // legend-yhia9: money arrived that the bill cannot take. While the QR's hold
  // is active the 0369 trigger refuses the tender void, so the hold ends first
  // (the payment is real, the refund below returns it; never a second capture).
  // The hold is picked by this tender, never by "any active hold of the order":
  // another QR of the same order keeps its own hold.
  await tx
    .update(posQrisHolds)
    .set({
      state: "paid",
      closedAt: now,
      closeReason: "provider_paid",
      closeEvidence: { anomaly: input.reason, intentId: input.intentId },
      nextCheckAt: null,
    })
    .where(
      and(
        eq(posQrisHolds.tenantId, context.tenant.tenantId),
        eq(posQrisHolds.orderId, order.id),
        eq(posQrisHolds.tenderId, input.tenderId),
        inArray(posQrisHolds.state, ["open", "cancelling"]),
      ),
    );
  const voided = await voidPendingQrisTenders(tx, context, {
    orderId: order.id,
    now,
    ...(input.linkClosedAt ? { linkClosedAt: input.linkClosedAt } : {}),
  });
  await bumpPos(tx, context, pos, now);
  for (const row of voided) {
    await appendOrderEvent(tx, context, {
      order,
      type: "order.tender_voided",
      payload: {
        tenderId: row.id,
        method: row.method,
        amountIdr: row.amountIdr,
        reason: input.reason,
      },
      caller: null,
      now,
    });
    await auditPos(
      tx,
      context,
      {
        action: "pos_order.tender_voided",
        order,
        caller: null,
        before: { id: order.id, status: "authorized" },
        after: {
          id: order.id,
          method: row.method,
          amountIdr: row.amountIdr,
          status: "voided",
        },
      },
      now,
    );
  }
  await requestPosLatePaymentRefund(tx, context, {
    order,
    paymentLinkId: input.paymentLinkId,
    intentId: input.intentId,
    now,
  });
}

/**
 * Policy (one place, easy to change; founder Q5 pending): a QRIS payment
 * captured by webhook while a card (EDC) sale for the same bill is open. The
 * card wins: the QRIS tender is voided and the intent refunded in full, so the
 * guest is never charged twice. A declined card sale reopens the bill and the
 * QRIS stays valid (the open-sale check is false then, so it is captured).
 * A QRIS that arrives while the sale is still open is refunded at once, even
 * if the card is declined later: the guest pays again, nobody is short.
 */
export const QRIS_CAPTURED_WHILE_CARD_SALE_OPEN = "void_and_refund" as const;

/** Applies `QRIS_CAPTURED_WHILE_CARD_SALE_OPEN`: true when the QRIS must be voided and refunded. */
function voidQrisForOpenCardSale(edcOpen: boolean): boolean {
  return edcOpen && QRIS_CAPTURED_WHILE_CARD_SALE_OPEN === "void_and_refund";
}

/**
 * Outbox consumer entry for WS-05 `payment.paid` (wired by legend-x4qy).
 * Captures the POS QRIS tender whose payment link the event names, once the
 * link is fully covered by verified money and a `paid` intent exists on it
 * (decision re-read from the locked rows, never from the event alone).
 * Idempotent and safe on replay: a tender already captured, or a link that is
 * not a POS tender's, changes nothing. A payment that lands on a voided/failed
 * tender or a final order is refunded in full by a system WS-05 refund request
 * (`pos-order-late-payment.ts`, legend-b0au), once per intent.
 *
 * legend-r5brx: the capture decides under the paid intent's row lock
 * (`lockIntentsForFact`), the lock every refund writer takes first
 * (`lockRefundGraph`). An approved or completed refund already taking money
 * the tender needs (above `cap`, which already excludes this open order's
 * tender) voids the tender and refunds the rest instead of capturing, so the
 * guest is never paid back for a sale that then keeps the same money. A
 * refund still pending does not block; its approval fails later.
 *
 * legend-56gg2 (EDC-01): the capture also takes the bill's EDC advisory lock
 * (tenant, outlet:number), the lock `assertNoOpenEdcRequest` and the edge
 * write-ahead take, so it never interleaves with a card sale starting on the
 * same bill. While an EDC request is open (`hasOpenEdcRequest`), the card
 * wins: the QRIS tender is voided and the intent refunded in full
 * (`edc_request_open`), so the guest is never charged twice. Lock order:
 * orders -> pos_orders -> EDC advisory (as in `addPosTender`) -> tender ->
 * link -> intent (the link -> intent order of the WS-05 confirmation and
 * `cancelPaymentLinkInTx`) -> day lock (shared; closePosDay locks no intent).
 * The advisory lock is only ever taken after the order and pos_orders rows
 * (the EDC writers hold it without locking an order row), and no path locks
 * an intent and then an order, pos_orders, advisory, tender or link row of
 * this order, so it adds no cycle.
 */
export async function handlePosPaymentPaid(
  context: ScopedTenantContext,
  event: DomainEvent,
): Promise<void> {
  if (event.name !== "payment.paid") return;
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return;
  const now = new Date();
  await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [probe] = await tx
      .select({ orderId: posOrderTenders.orderId })
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.paymentLinkId, payload.data.paymentLinkId),
        ),
      );
    if (!probe) return;
    // Lock order: orders row -> pos_orders row -> tender row.
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, probe.orderId)))
      .for("update");
    if (!order) return;
    const orderFinal =
      order.status === "completed" || order.status === "voided";
    const [pos] = await tx
      .select()
      .from(posOrders)
      .where(
        and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
      )
      .for("update");
    if (!pos) return;
    // legend-yhia9 lock order: orders -> pos_orders -> pos_qris_holds -> tender.
    const holds = await lockHoldsOfOrder(tx, tenantId, order.id);
    // so-879 P1: the intent that was paid ends its own active hold(s) first,
    // by intent and not by tender, and before any branch that only refunds
    // (tender already voided, order final). A hold of a code that is paid is
    // dead; left `open` it would freeze the bill for good (the 0380 trigger
    // refuses every later tender change while any hold is active). Another
    // QR's hold stays: its code may still be collected. `holds` above is the
    // state before this, which the basis check below still needs.
    await markQrisHoldsPaidByIntentTx(
      tx,
      tenantId,
      payload.data.intentId,
      now,
      { providerRef: payload.data.providerRef ?? null },
    );
    // legend-56gg2: EDC advisory lock (same order as addPosTender), taken
    // before the tender row; decided below once the intent is known.
    const edcOpen = await hasOpenEdcRequest(tx, context, order);
    const [tender] = await tx
      .select()
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.paymentLinkId, payload.data.paymentLinkId),
        ),
      )
      .for("update");
    if (!tender || tender.status === "captured") return;
    // legend-b0au: money arrived for a tender that can no longer take it (it
    // was voided or failed, or the order closed). Refund what the intent holds.
    if (tender.status !== "authorized" || orderFinal) {
      await requestPosLatePaymentRefund(tx, context, {
        order,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: payload.data.intentId,
        now,
      });
      return;
    }
    // legend-r5brx: the link is locked before the intent (link -> intent,
    // the WS-05 confirmation order), so a void below that closes the link
    // never waits on it while holding the intent.
    const [link] = await tx
      .select({
        paidIdr: paymentLinks.paidIdr,
        totalIdr: paymentLinks.totalIdr,
      })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, tenantId),
          eq(paymentLinks.id, payload.data.paymentLinkId),
        ),
      )
      .for("update");
    if (!link || link.paidIdr < link.totalIdr) return;
    // A refund that completed before this event moves the intent on to
    // (partially_)refunded; it is still the money this tender was paid with,
    // so it is decided below (voided, the rest refunded), never skipped.
    const settled = await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.paymentLinkId, payload.data.paymentLinkId),
          inArray(paymentIntents.status, [
            "paid",
            "partially_refunded",
            "refunded",
          ]),
        ),
      );
    if (settled.length === 0) return;
    // legend-r5brx: decide under the intent row locks every refund writer
    // takes first: all settled intents of the link in one call (ascending id).
    // The fact time it gives (`at`: now, or just after the latest refund
    // completion or sale completion already committed on them) stamps the
    // capture or void, so the tender never resolves before a refund of the
    // same money that committed earlier, whatever the host clock says.
    const at = await lockIntentsForFact(
      tx,
      tenantId,
      settled.map((row) => row.id),
      now,
    );
    // A second payment of a covered link (`double_payment`) is also `paid`,
    // but its money sits in unallocated funds and is refunded from there.
    // The tender takes the intent whose money the link counted (allocated =
    // evidence - unallocated - provider's own refunds > 0); ties by payment
    // time, then id.
    const counted = await tx.execute(sql`
      SELECT i.id
        FROM payment_intents i
       WHERE i.tenant_id = ${tenantId}
         AND i.payment_link_id = ${payload.data.paymentLinkId}::uuid
         AND i.status IN ('paid', 'partially_refunded', 'refunded')
         AND ${netAllocatedIdrSql(sql`i.tenant_id`, sql`i.id`)} > 0
       ORDER BY i.paid_at ASC NULLS LAST, i.id ASC
       LIMIT 1
    `);
    let countedId = counted.rows[0]?.id;
    if (countedId === undefined || countedId === null) {
      // legend-6i91b: every settled intent nets to 0 (the provider refunded it
      // all on its own). The tender cannot be captured and must not stay
      // `authorized` with its hold closed: the intent that carries the void is
      // the first settled one by payment time, then id (nothing is left to
      // refund, so no refund row is made).
      const first = await tx.execute(sql`
        SELECT i.id
          FROM payment_intents i
         WHERE i.tenant_id = ${tenantId}
           AND i.payment_link_id = ${payload.data.paymentLinkId}::uuid
           AND i.status IN ('paid', 'partially_refunded', 'refunded')
         ORDER BY i.paid_at ASC NULLS LAST, i.id ASC
         LIMIT 1
      `);
      countedId = first.rows[0]?.id;
    }
    if (countedId === undefined || countedId === null) return;
    const [paid] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, String(countedId)),
        ),
      );
    if (!paid) return;
    // legend-mf0.1 (safety net): the order's business day is closed. Today
    // closePosDay refuses while an order of that date is unfinished, so an
    // open QRIS on a closed day should not exist; if one does, capturing would
    // strand the money on an order that can never complete (complete is
    // refused), so the tender is voided and the intent refunded. This is a
    // decision, never a throw: the consumer would retry forever. Lock order:
    // orders row -> pos_orders row -> tender row -> link -> intent -> day
    // lock (shared); closePosDay takes no order or intent row locks, so no
    // cycle.
    if (
      await isBusinessDayClosed(tx, context, {
        outletId: order.outletId,
        businessDates: [order.businessDate],
      })
    ) {
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "business_day_closed",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    // legend-56gg2 (EDC-01): a card sale for this bill is open (pending,
    // unknown, flagged, or approved and not booked yet), so the terminal may
    // take or already took this bill's money. The card wins: void the QRIS
    // tender and refund the intent in full, never charge the guest twice.
    if (voidQrisForOpenCardSale(edcOpen)) {
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "edc_request_open",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    // legend-6i91b: the provider refunded part of the money on its own, so the
    // link's settled intents net less than the tender. Capturing would count
    // money the guest no longer has paid in. Restrictive: void the tender and
    // refund the net (the refund cap already nets provider refunds); the order
    // keeps its full balance.
    const netRows = await tx.execute(sql`
      SELECT coalesce(sum(${netAllocatedIdrSql(sql`i.tenant_id`, sql`i.id`)}), 0)::text AS total
        FROM payment_intents i
       WHERE i.tenant_id = ${tenantId}
         AND i.payment_link_id = ${payload.data.paymentLinkId}::uuid
         AND i.status IN ('paid', 'partially_refunded', 'refunded')
    `);
    if (Number(netRows.rows[0]?.total ?? 0) < Number(tender.amountIdr)) {
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "provider_refunded",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    // A tender may never take the order above its total (contract refine).
    const tenders = await tendersOf(tx, context, order.id);
    if (tender.amountIdr > remainingIdr(order, tenders)) {
      // legend-b0au: the bill shrank under the open QRIS (e.g. more deposit
      // applied). The tender cannot take the money, so it is voided, its link
      // closed, and what the intent holds is refunded instead of stranded.
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "bill_below_tender",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    // legend-r5brx: an approved or completed refund already takes money of
    // the intent this tender needs. `cap` excludes what this open order's
    // tender holds (posSaleInUse), so committed refunds above `cap` mean
    // capturing would count money the guest is also being paid back. Void and
    // refund what is left (cap - reserved after the void) instead. A refund
    // still `pending` does not block: the sale wins, and its approval (under
    // this same intent lock) then finds the captured tender held and fails
    // `cap_exceeded`, so no money is stranded on a voided tender.
    const balance = await refundableBalance(tx, paid);
    const pendingIdr = await pendingRefundIdr(tx, tenantId, paid.id);
    if (balance.reserved - pendingIdr > balance.cap) {
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "refund_reserved",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    // legend-yhia9 D-05: the hold goes `paid` first; only then does the 0369
    // trigger let the tender be captured. The bill is unchanged while the hold
    // was active, so the paid amount is exactly what is due.
    const hold = holds.find(
      (row) =>
        row.tenderId === tender.id &&
        (row.state === "open" || row.state === "cancelling"),
    );
    // Defence in depth (D-05): the basis the hold froze must still be the
    // bill, and the paid money exactly the hold's amount. Anything else is an
    // anomaly: never a capture; the safety net voids the tender and refunds
    // what the intent holds (one pending refund, the outlet holds the money).
    if (
      hold &&
      ((hold.basisTotalIdr !== null && hold.basisTotalIdr !== order.totalIdr) ||
        (hold.basisDepositIdr !== null &&
          hold.basisDepositIdr !== order.depositAppliedIdr) ||
        Number(paid.amountIdr) !== Number(hold.amountIdr))
    ) {
      await voidTendersAndRefundPaidQris(tx, context, {
        order,
        pos,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: paid.id,
        tenderId: tender.id,
        reason: "bill_below_tender",
        now: at,
        linkClosedAt: now,
      });
      return;
    }
    if (hold)
      await tx
        .update(posQrisHolds)
        .set({
          state: "paid",
          closedAt: at,
          closeReason: "provider_paid",
          closeEvidence: {
            intentId: paid.id,
            providerRef: paid.providerRef ?? null,
          },
          nextCheckAt: null,
        })
        .where(
          and(
            eq(posQrisHolds.tenantId, tenantId),
            eq(posQrisHolds.id, hold.id),
            inArray(posQrisHolds.state, ["open", "cancelling"]),
          ),
        );
    await tx
      .update(posOrderTenders)
      .set({
        status: "captured",
        resolvedAt: at,
        paymentIntentId: paid.id,
        reference:
          (paid.providerRef ?? tender.reference)?.slice(0, 100) ?? null,
        updatedAt: at,
      })
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.id, tender.id),
          eq(posOrderTenders.status, "authorized"),
        ),
      );
    // legend-xb20o: an older QR of the same bill (its hold already closed)
    // can still be `authorized`. This QR's hold is `paid` now, so the 0369
    // trigger lets the stale tender go (unless another hold of the bill is
    // still active: then it waits); void it so it never takes money as a
    // second tender (a late payment of it is parked once).
    await voidSupersededQrisTendersTx(tx, context, {
      order,
      caller: null,
      now: at,
      linkClosedAt: now,
      reason: "superseded_by_paid_qris",
    });
    await bumpPos(tx, context, pos, at);
    await appendOrderEvent(tx, context, {
      order,
      type: "order.tender_captured",
      payload: {
        tenderId: tender.id,
        method: tender.method,
        amountIdr: tender.amountIdr,
        paymentIntentId: paid.id,
      },
      caller: null,
      now: at,
    });
    await auditPos(
      tx,
      context,
      {
        action: "pos_order.tender_captured",
        order,
        caller: null,
        before: { id: order.id, status: "authorized" },
        after: {
          id: order.id,
          method: tender.method,
          amountIdr: tender.amountIdr,
          status: "captured",
        },
      },
      at,
    );
  });
}

/**
 * WS-05 `payment.expired` / `payment.failed` for the intent of a POS QRIS
 * tender (bead legend-b0au). Runs IN the outbox consumption transaction (`tx`)
 * so the change commits with the consumed offset. The lock order matches
 * `handlePosPaymentPaid`: orders row -> pos_orders row -> tender row. The tender
 * is decided from the locked row: only a still `authorized` tender whose
 * `paymentIntentId` is the event's intent becomes `failed`, so the cashier can
 * open a new QRIS; a voided/captured tender or a replay changes nothing.
 * Returns true when the intent's link belongs to a POS tender (handled or
 * ignored as stale), false when it is not a POS bill (the router then ignores
 * the event). Rows of another tenant are never visible (RLS + explicit filter).
 */
export async function handlePosPaymentClosed(
  context: ScopedTenantContext,
  event: DomainEvent,
  tx: Tx,
  now: Date,
): Promise<boolean> {
  if (event.name !== "payment.expired" && event.name !== "payment.failed")
    return false;
  const payload = closedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return false;
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    );
  if (!intent) return false;
  const [probe] = await tx
    .select({ orderId: posOrderTenders.orderId })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.paymentLinkId, intent.paymentLinkId),
      ),
    );
  if (!probe) return false;
  // Lock order: orders row -> pos_orders row -> tender row.
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, probe.orderId)))
    .for("update");
  if (!order) return true;
  const [pos] = await tx
    .select()
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    )
    .for("update");
  if (!pos) return true;
  const holds = await lockHoldsOfOrder(tx, tenantId, order.id);
  const [tender] = await tx
    .select()
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.paymentLinkId, intent.paymentLinkId),
      ),
    )
    .for("update");
  if (
    !tender ||
    tender.status !== "authorized" ||
    tender.paymentIntentId !== payload.data.intentId
  )
    return true;
  // legend-yhia9 D-04: a local expiry or failure never unlocks the bill. While
  // the QR's hold is active the tender stays `authorized` (the QR may still be
  // paid); only provider proof or a manager release closes the hold.
  if (
    holds.some(
      (row) =>
        row.tenderId === tender.id &&
        (row.state === "open" || row.state === "cancelling"),
    )
  )
    return true;
  // A guest who paid just before the expiry sweep: the webhook may already
  // have moved the intent on to `paid` (WS-05 accepts a late settlement). Its
  // `payment.paid` captures the tender; failing it here would refund the money
  // and make the cashier charge again. Lock order link -> intent, the same as
  // the WS-05 confirmation and `cancelPaymentLinkInTx`.
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, intent.paymentLinkId),
      ),
    )
    .for("update");
  const [current] = await tx
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    )
    .for("update");
  if (current && current.status !== "expired" && current.status !== "failed")
    return true;
  await tx
    .update(posOrderTenders)
    .set({ status: "failed", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.id, tender.id),
        eq(posOrderTenders.status, "authorized"),
      ),
    );
  // The link would otherwise keep taking new intents for a tender that is no
  // longer waiting (the cashier opens a fresh QRIS); close it like a void.
  if (tender.paymentLinkId)
    await cancelPaymentLinkInTx(tx, context, {
      linkId: tender.paymentLinkId,
      now,
      reason: "cancelled",
    });
  await bumpPos(tx, context, pos, now);
  await appendOrderEvent(tx, context, {
    order,
    type: "order.tender_failed",
    payload: {
      tenderId: tender.id,
      method: tender.method,
      amountIdr: tender.amountIdr,
      paymentIntentId: tender.paymentIntentId,
      reason: event.name === "payment.expired" ? "expired" : "failed",
    },
    caller: null,
    now,
  });
  await auditPos(
    tx,
    context,
    {
      action: "pos_order.tender_failed",
      order,
      caller: null,
      before: { id: order.id, status: "authorized" },
      after: {
        id: order.id,
        method: tender.method,
        amountIdr: tender.amountIdr,
        status: "failed",
      },
    },
    now,
  );
  return true;
}
