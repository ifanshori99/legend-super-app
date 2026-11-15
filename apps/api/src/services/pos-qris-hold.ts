// QRIS hold (design legend-yhia9 D-01..D-05; migrations 0368 + 0369).
//
// A QRIS stays payable at the provider until it expires and no provider lets us
// cancel it. So while a POS QRIS tender is collectible the bill's money is
// frozen: a hold row (`open` -> `cancelling` -> `paid` | `closed`) gates every
// money mutator (service guard `assertNoActiveQrisHold`, then the database
// triggers of 0369 as the backstop). The cashier "cancel" only hides the QR
// (`open` -> `cancelling`); the hold closes only on provider proof (D-03) or an
// audited manager release (Q93). Nothing here voids a QR on the local clock.
//
// Lock order (legend-s0u8c, see payment-late-settlement.ts): orders ->
// pos_orders -> pos_qris_holds -> pos_order_tenders -> payment_links ->
// payment_intents -> funds/refunds. Every writer below follows it.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { PosError, type PosQrisHold } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import {
  orders,
  paymentIntents,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { posOrders, posOrderTenders } from "../db/schema/pos-order.ts";
import {
  posQrisHolds,
  type PosQrisHoldCloseReason,
} from "../db/schema/pos-qris-hold.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import {
  cancelPaymentLinkInTx,
  settleGatewayIntentNow,
} from "./payment.service.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { mutatePosOrder } from "./pos-order.service.ts";
import {
  appendOrderEvent,
  auditPos,
  bumpPos,
  consumeApproval,
  lockPosOrder,
  notFound,
  type OrderRow,
  type PosCaller,
  type PosRow,
} from "./pos-order-support.ts";

type HoldRow = typeof posQrisHolds.$inferSelect;

/** Q92 (founder, 13 Nov 2026): a cashier QR lives 5 minutes. */
export const POS_QRIS_LIFETIME_MS = 5 * 60_000;
/** D-03: clock skew margin between us and the provider. */
export const HOLD_CLOSE_MARGIN_MS = 60_000;
/** Q93: a manager may release a hold only this long after the QR expired. */
export const HOLD_RELEASE_AFTER_MS = 30 * 60_000;

const ACTIVE_STATES = ["open", "cancelling"] as const;
const isActive = (hold: Pick<HoldRow, "state">) =>
  hold.state === "open" || hold.state === "cancelling";

// ---- Guard ------------------------------------------------------------------

/**
 * A hold of the bill that still gates its money, if any. A bill may carry
 * several active backfilled holds (one per provider code that may still be
 * collectible, migration 0379): any active hold freezes the bill, so callers
 * only ask whether one exists. The oldest is returned, so the answer is stable.
 */
export async function activeHoldOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<HoldRow | null> {
  const [hold] = await tx
    .select()
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.orderId, orderId),
        inArray(posQrisHolds.state, [...ACTIVE_STATES]),
      ),
    )
    .orderBy(posQrisHolds.id)
    .limit(1);
  return hold ?? null;
}

/**
 * D-01 service guard: call right after the order lock in every money mutator
 * (the database trigger of migration 0369 is the backstop). 409
 * QRIS_HOLD_ACTIVE while a QR can still be paid.
 */
export async function assertNoActiveQrisHold(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  if (await activeHoldOf(tx, context.tenant.tenantId, orderId))
    throw new PosError("QRIS_HOLD_ACTIVE");
}

/** Locks every hold of the bill (lock order: after pos_orders, before tenders). */
export async function lockHoldsOfOrder(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<HoldRow[]> {
  return tx
    .select()
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.orderId, orderId),
      ),
    )
    .orderBy(posQrisHolds.id)
    .for("update");
}

// ---- Issue ------------------------------------------------------------------

/**
 * D-01: one hold per issued QR tender, in the same POS transaction as the
 * tender. The basis (total, DP, captured at issue) is what D-05 compares at
 * apply time. The partial unique index makes a second active hold fail even if
 * a path skipped the order lock.
 */
export async function openQrisHold(
  tx: Tx,
  input: {
    order: OrderRow;
    tender: typeof posOrderTenders.$inferSelect;
    paymentIntentId: string;
    capturedIdr: number;
    openedBy: string;
    now: Date;
  },
): Promise<HoldRow> {
  const { order, tender, now } = input;
  const [row] = await tx
    .insert(posQrisHolds)
    .values({
      tenantId: order.tenantId,
      id: createUlid(now.getTime()),
      outletId: order.outletId,
      orderId: order.id,
      tenderId: tender.id,
      paymentIntentId: input.paymentIntentId,
      amountIdr: tender.amountIdr,
      basisTotalIdr: order.totalIdr,
      basisDepositIdr: order.depositAppliedIdr,
      basisCapturedIdr: idr(input.capturedIdr),
      backfilled: false,
      state: "open",
      openedAt: now,
      openedBy: input.openedBy,
    })
    .returning();
  if (!row) throw new Error("QRIS hold insert returned no row");
  return row;
}

/**
 * A guest QR (`POST /table-sessions/:id/payments`) has no POS tender, so its
 * hold has `tenderId` null: `billSplitId` set for a split-bill part, null for
 * the whole-order code (legend-kf104). Same transaction as the intent; the
 * caller holds the order lock. The basis is stored for the record, but a part
 * is one share of the bill, so the 0368 equation check is not asked of a
 * guest hold. `openedBy` stays null: a guest is not a staff user.
 */
export async function openGuestQrisHold(
  tx: Tx,
  input: {
    order: Pick<
      OrderRow,
      "tenantId" | "id" | "outletId" | "totalIdr" | "depositAppliedIdr"
    >;
    billSplitId: string | null;
    intentId: string;
    amount: number;
    now?: Date;
  },
): Promise<HoldRow> {
  const { order } = input;
  const now = input.now ?? new Date();
  const [row] = await tx
    .insert(posQrisHolds)
    .values({
      tenantId: order.tenantId,
      id: createUlid(now.getTime()),
      outletId: order.outletId,
      orderId: order.id,
      tenderId: null,
      paymentIntentId: input.intentId,
      billSplitId: input.billSplitId,
      amountIdr: idr(input.amount),
      basisTotalIdr: order.totalIdr,
      basisDepositIdr: order.depositAppliedIdr,
      basisCapturedIdr: idr(0),
      backfilled: false,
      state: "open",
      openedAt: now,
      openedBy: null,
    })
    .returning();
  if (!row) throw new Error("QRIS hold insert returned no row");
  return row;
}

/** A guest split-bill QR: the hold of one part (see `openGuestQrisHold`). */
export function openSplitQrisHold(
  tx: Tx,
  input: Omit<Parameters<typeof openGuestQrisHold>[1], "billSplitId"> & {
    billSplitId: string;
  },
): Promise<HoldRow> {
  return openGuestQrisHold(tx, input);
}

/**
 * The provider reported this guest intent paid: its hold, if any, ends `paid`
 * (never moves money by itself; the payment path books it). Call before
 * anything that the 0369 triggers refuse while the hold is active. Only guest
 * holds (split part or whole order, no tender): a POS hold ends in the POS
 * paid handler together with its tender.
 * Returns true when a hold was moved.
 */
export async function markSplitQrisHoldPaidByIntentTx(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(posQrisHolds)
    .set({
      state: "paid",
      closedAt: now,
      closeReason: "provider_paid",
      closeEvidence: { intentId },
      nextCheckAt: null,
    })
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.paymentIntentId, intentId),
        isNull(posQrisHolds.tenderId),
        inArray(posQrisHolds.state, [...ACTIVE_STATES]),
      ),
    )
    .returning({ id: posQrisHolds.id });
  return rows.length > 0;
}

/**
 * The provider reported this intent paid (so-879 P1): every active hold of THIS
 * intent ends `paid`, whatever its tender is (a backfilled hold of a code whose
 * tender was voided locally, or a sibling code with no tender). A paid code
 * cannot be paid again, so it no longer gates the bill; any other QR of the
 * bill keeps its own hold. Only an intent that really is paid (the money is
 * recorded on it) moves a hold: a wrong-amount payment parked as unallocated
 * funds leaves the intent as it was and the hold active. Never moves money.
 * Call under the orders / pos_orders / hold locks. Returns the moved hold ids.
 */
export async function markQrisHoldsPaidByIntentTx(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  now: Date,
  evidence: Record<string, unknown> = {},
): Promise<string[]> {
  const rows = await tx
    .update(posQrisHolds)
    .set({
      state: "paid",
      closedAt: now,
      closeReason: "provider_paid",
      closeEvidence: { intentId, ...evidence },
      nextCheckAt: null,
    })
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.paymentIntentId, intentId),
        inArray(posQrisHolds.state, [...ACTIVE_STATES]),
        sql`EXISTS (SELECT 1 FROM payment_intents i
          WHERE i.tenant_id = ${tenantId} AND i.id = ${intentId}
            AND i.status IN ('paid', 'partially_refunded', 'refunded'))`,
      ),
    )
    .returning({ id: posQrisHolds.id });
  return rows.map((row) => row.id);
}

// ---- Close ------------------------------------------------------------------

/**
 * One transaction that ends an active hold WITHOUT a payment: hold `closed`
 * first (the 0369 tender trigger allows the void only then), tender `voided`,
 * link cancelled (pending intent `expired`), bill unlocked. The caller holds
 * the orders, pos_orders and hold locks. Returns false when the hold was no
 * longer active (nothing written).
 */
export async function closeQrisHoldTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: OrderRow;
    /** null for a guest split-bill hold: its order has no POS row. */
    pos: PosRow | null;
    hold: HoldRow;
    reason: PosQrisHoldCloseReason;
    evidence: Record<string, unknown>;
    caller: PosCaller | null;
    auditAction: string;
    now: Date;
  },
): Promise<boolean> {
  const { order, pos, hold, now } = input;
  const tenantId = context.tenant.tenantId;
  const closed = await tx
    .update(posQrisHolds)
    .set({
      state: "closed",
      closedAt: now,
      closeReason: input.reason,
      closeEvidence: input.evidence,
      nextCheckAt: null,
    })
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.id, hold.id),
        inArray(posQrisHolds.state, [...ACTIVE_STATES]),
      ),
    )
    .returning({ id: posQrisHolds.id });
  if (closed.length === 0) return false;
  // A guest split-bill hold has no POS tender (tenderId null).
  const [tender] =
    hold.tenderId === null
      ? []
      : await tx
          .select()
          .from(posOrderTenders)
          .where(
            and(
              eq(posOrderTenders.tenantId, tenantId),
              eq(posOrderTenders.id, hold.tenderId),
            ),
          )
          .for("update");
  if (tender && tender.status === "authorized") {
    await tx
      .update(posOrderTenders)
      .set({ status: "voided", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.id, tender.id),
          eq(posOrderTenders.status, "authorized"),
        ),
      );
    if (tender.paymentLinkId)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: tender.paymentLinkId,
        now,
        reason: "cancelled",
      });
  }
  // Provider proof says the QR is dead: the intent is closed too (a lapsed
  // gateway code stays `pending` in the link cancel above, awaiting exactly
  // this proof). A manager release keeps it as is. Payment that still arrives
  // is parked (D-07).
  if (
    input.reason === "provider_expired" ||
    input.reason === "provider_failed"
  ) {
    const failed = input.reason === "provider_failed";
    const lapsed = await tx
      .update(paymentIntents)
      .set({ status: failed ? "failed" : "expired", updatedAt: now })
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, hold.paymentIntentId),
          eq(paymentIntents.status, "pending"),
        ),
      )
      .returning({ id: paymentIntents.id, outletId: paymentIntents.outletId });
    for (const intent of lapsed)
      await appendPaymentEvent(tx, context, {
        name: failed ? "payment.failed" : "payment.expired",
        aggregateId: intent.id,
        outletId: intent.outletId,
        actor: { type: "system" },
        payload: { intentId: intent.id, reason: input.reason },
        now,
      });
  }
  if (pos) {
    await bumpPos(tx, context, pos, now);
    await appendOrderEvent(tx, context, {
      order,
      type: "order.tender_voided",
      payload: {
        tenderId: hold.tenderId,
        method: "qris",
        amountIdr: hold.amountIdr,
        reason: input.reason,
        holdId: hold.id,
      },
      caller: input.caller,
      now,
    });
  }
  await auditPos(
    tx,
    context,
    {
      action: input.auditAction,
      order,
      caller: input.caller,
      before: { id: order.id, holdId: hold.id, state: hold.state },
      after: {
        id: order.id,
        holdId: hold.id,
        state: "closed",
        closeReason: input.reason,
      },
      objectType: "pos_qris_hold",
      objectId: hold.id,
    },
    now,
  );
  return true;
}

function paidQrisReleaseError(): CoreError {
  return new CoreError(
    "CONFLICT",
    "QRIS ini sudah dibayar pelanggan, tidak bisa dirilis.",
  );
}

/**
 * Money of one QR that was APPLIED to the bill: payment evidence beyond what
 * sits in unallocated funds (parked money cannot be paid again on this QR).
 * Locks the intent row, so a settlement in flight finishes first. Call it under
 * the orders / pos_orders / hold locks, right before any close (legend-zff37).
 */
async function appliedQrisMoneyTx(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
): Promise<boolean> {
  await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    )
    .for("update");
  const result = await tx.execute(sql`
    SELECT
      (SELECT coalesce(sum(e.amount_idr), 0)::bigint FROM payment_evidence e
        WHERE e.tenant_id = ${tenantId}
          AND e.payment_intent_id = ${intentId}) AS evidence,
      (SELECT coalesce(sum(f.amount_idr), 0)::bigint FROM payment_unallocated_funds f
        WHERE f.tenant_id = ${tenantId}
          AND f.payment_intent_id = ${intentId}) AS parked
  `);
  const row = result.rows[0] as
    { evidence: string | number; parked: string | number } | undefined;
  return Number(row?.evidence ?? 0) > Number(row?.parked ?? 0);
}

// ---- Read model -------------------------------------------------------------

async function holdDto(
  tx: Tx,
  tenantId: TenantId,
  hold: HoldRow,
): Promise<PosQrisHold> {
  const [intent] = await tx
    .select({ expiresAt: paymentIntents.expiresAt })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, hold.paymentIntentId),
      ),
    );
  return {
    id: hold.id,
    orderId: hold.orderId,
    tenderId: hold.tenderId,
    state: hold.state,
    amountIdr: hold.amountIdr,
    expiresAt: intent?.expiresAt.toISOString() ?? null,
    cancelRequestedAt: hold.cancelRequestedAt?.toISOString() ?? null,
    lastCheckedAt: hold.lastCheckedAt?.toISOString() ?? null,
    closeReason: hold.closeReason,
  } as PosQrisHold;
}

async function newestHold(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<HoldRow | null> {
  const [hold] = await tx
    .select()
    .from(posQrisHolds)
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posQrisHolds.orderId, orderId),
      ),
    )
    // An active hold first (several backfilled ones may be active at once),
    // then the newest.
    .orderBy(
      desc(sql`(${posQrisHolds.state} IN ('open', 'cancelling'))`),
      desc(posQrisHolds.openedAt),
      desc(posQrisHolds.id),
    )
    .limit(1);
  return hold ?? null;
}

/** GET .../qris: the active hold of the bill, else the newest. */
export async function getPosQrisHold(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<PosQrisHold> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [order] = await tx
      .select({ id: posOrders.orderId })
      .from(posOrders)
      .where(
        and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, orderId)),
      );
    if (!order) throw notFound();
    const hold = await newestHold(tx, tenantId, orderId);
    if (!hold || hold.outletId !== outletId)
      throw notFound("Pesanan ini belum punya QRIS.");
    return holdDto(tx, tenantId, hold);
  });
}

// ---- Cashier cancel (D-04) ----------------------------------------------------

/**
 * POST .../qris/cancel: `open` -> `cancelling`, who and when recorded. The
 * tender stays `authorized` and the intent `pending` until provider proof
 * arrives; one status read follows the commit. A repeat (same or another key)
 * changes nothing; a `paid` / `closed` hold is returned as is.
 */
export async function cancelPosQris(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: { idempotencyKey: string },
  now = new Date(),
): Promise<PosQrisHold> {
  const cancelledIds: string[] = [];
  const result = await mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: input.idempotencyKey,
      operation: "order.qris_cancel",
      request: {},
    },
    async (tx, locked) => {
      const { order } = locked;
      const tenantId = context.tenant.tenantId;
      const holds = await lockHoldsOfOrder(tx, tenantId, order.id);
      // The cashier cancels the bill's QR: every open hold (a bill may carry
      // several backfilled ones) goes to `cancelling`; each closes on its own
      // provider proof.
      const newest = holds.at(-1);
      if (!newest) throw notFound("Pesanan ini belum punya QRIS.");
      const open = holds.filter((h) => h.state === "open");
      if (open.length === 0)
        return holdDto(tx, tenantId, holds.find(isActive) ?? newest);
      let first: HoldRow | null = null;
      for (const hold of open) {
        const [updated] = await tx
          .update(posQrisHolds)
          .set({
            state: "cancelling",
            cancelRequestedAt: now,
            cancelRequestedBy: caller.userId,
            nextCheckAt: now,
          })
          .where(
            and(
              eq(posQrisHolds.tenantId, tenantId),
              eq(posQrisHolds.id, hold.id),
              eq(posQrisHolds.state, "open"),
            ),
          )
          .returning();
        if (!updated) throw new Error("QRIS hold cancel returned no row");
        cancelledIds.push(updated.id);
        first ??= updated;
        await appendOrderEvent(tx, context, {
          order,
          type: "order.qris_cancel_requested",
          payload: { holdId: updated.id, tenderId: updated.tenderId },
          caller,
          now,
        });
        await auditPos(
          tx,
          context,
          {
            action: "pos_qris_hold.cancel_requested",
            order,
            caller,
            before: { id: order.id, holdId: hold.id, state: "open" },
            after: { id: order.id, holdId: hold.id, state: "cancelling" },
            objectType: "pos_qris_hold",
            objectId: hold.id,
          },
          now,
        );
      }
      return holdDto(tx, tenantId, first ?? newest);
    },
  );
  if (cancelledIds.length === 0) return result;
  // One immediate status read after commit. The provider failing is not the
  // cashier's failure: the hold stays frozen and the job asks again.
  for (const holdId of cancelledIds) {
    try {
      await checkQrisHold(context, holdId, now);
    } catch {
      // Intentionally ignored; see above.
    }
  }
  return withTenant(db, context, async (tx) => {
    const hold = await newestHold(tx, context.tenant.tenantId, orderId);
    return hold ? holdDto(tx, context.tenant.tenantId, hold) : result;
  });
}

// ---- Provider proof (D-03) ----------------------------------------------------

/** When the hold check job should look again (design D-04). */
export function nextHoldCheckAt(expiresAt: Date, now: Date): Date {
  const proofAt = expiresAt.getTime() + HOLD_CLOSE_MARGIN_MS;
  if (now.getTime() < proofAt) return new Date(proofAt);
  const quick = expiresAt.getTime() + 30 * 60_000;
  return new Date(now.getTime() + (now.getTime() < quick ? 2 : 10) * 60_000);
}

/**
 * Reads the provider once for one active hold and closes it only on D-03
 * proof: the provider's own expired/failed answer about THIS reference, at or
 * after `expires_at` + 60 s (Duitku: raw code `02`; other providers: mapped
 * `expired` / `failed`). Errors, timeouts, pending answers, answers about
 * another reference, a mapped Duitku status without its raw code and answers
 * before the margin never close it. A `paid` answer is not handled here (the
 * payment poll and the webhook settle it through `confirmPayment`).
 * Provider call outside any transaction; the decision is re-read under the
 * locks. Returns the state afterwards.
 */
export async function checkQrisHold(
  context: ScopedTenantContext,
  holdId: string,
  now: Date,
): Promise<HoldRow["state"] | null> {
  const tenantId = context.tenant.tenantId;
  const target = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ hold: posQrisHolds, intent: paymentIntents })
      .from(posQrisHolds)
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, posQrisHolds.tenantId),
          eq(paymentIntents.id, posQrisHolds.paymentIntentId),
        ),
      )
      .where(
        and(eq(posQrisHolds.tenantId, tenantId), eq(posQrisHolds.id, holdId)),
      );
    return row ?? null;
  });
  if (!target || !isActive(target.hold)) return target?.hold.state ?? null;
  const { intent } = target;
  let answer: Awaited<
    ReturnType<ReturnType<typeof paymentGatewayFor>["getStatus"]>
  > | null = null;
  if (intent.providerRef !== null) {
    try {
      answer = await paymentGatewayFor(intent.provider).getStatus({
        context,
        outletId: intent.outletId,
        integrationId: intent.gatewayIntegrationId,
        providerRef: intent.providerRef,
        intentId: intent.id,
      });
    } catch {
      answer = null;
    }
  }
  const sameReference =
    answer !== null && answer.providerRef === intent.providerRef;
  if (answer?.status === "paid" && sameReference) {
    // The customer paid: settle through the normal path (evidence, link, the
    // payment.paid event that captures the tender). Never closes the hold.
    try {
      await settleGatewayIntentNow(context, intent.id, now);
    } catch {
      // The next check retries.
    }
  }
  const dead =
    answer !== null &&
    sameReference &&
    (intent.provider === "duitku"
      ? answer.rawStatus === "02"
      : answer.status === "expired" || answer.status === "failed");
  const provenAt = intent.expiresAt.getTime() + HOLD_CLOSE_MARGIN_MS;
  const proof = dead && now.getTime() >= provenAt;
  let settleAfter = false;
  const state = await withTenant(db, context, async (tx) => {
    // A guest split-bill hold has no POS row: lock the bill (orders) only.
    const split = target.hold.tenderId === null;
    let order: OrderRow;
    let pos: PosRow | null = null;
    if (split) {
      const [row] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.id, target.hold.orderId),
          ),
        )
        .for("update");
      if (!row) return null;
      order = row;
    } else {
      ({ order, pos } = await lockPosOrder(
        tx,
        context,
        target.hold.outletId as OutletId,
        target.hold.orderId,
      ));
    }
    const [hold] = await tx
      .select()
      .from(posQrisHolds)
      .where(
        and(eq(posQrisHolds.tenantId, tenantId), eq(posQrisHolds.id, holdId)),
      )
      .for("update");
    if (!hold || !isActive(hold)) return hold?.state ?? null;
    // so-879 P1: the provider says this QR was paid and the money is recorded
    // (read under the locks). A hold whose tender can no longer take it (none,
    // or not `authorized`: voided locally before the cutover, or a sibling
    // code) is not ended by the payment.paid consumer, which refunds that
    // money and leaves the hold; it would freeze the bill for good. The code
    // is paid, so it is dead: the hold ends `paid`. A hold whose tender is
    // still `authorized` ends with that tender's capture, as before.
    if (
      answer?.status === "paid" &&
      sameReference &&
      (await appliedQrisMoneyTx(tx, tenantId, intent.id))
    ) {
      const tenderStatus =
        hold.tenderId === null
          ? null
          : ((
              await tx
                .select({ status: posOrderTenders.status })
                .from(posOrderTenders)
                .where(
                  and(
                    eq(posOrderTenders.tenantId, tenantId),
                    eq(posOrderTenders.id, hold.tenderId),
                  ),
                )
            )[0]?.status ?? null);
      if (tenderStatus !== "authorized") {
        await markQrisHoldsPaidByIntentTx(tx, tenantId, intent.id, now, {
          providerRef: intent.providerRef,
          checkedAt: now.toISOString(),
        });
        return "paid";
      }
    }
    // Re-read the money under the locks: a payment committed after the provider
    // read (or a stale expired answer) must never close the hold (legend-zff37).
    const paidUnderLock =
      proof && answer
        ? await appliedQrisMoneyTx(tx, tenantId, intent.id)
        : false;
    if (paidUnderLock) settleAfter = true;
    if (proof && answer && !paidUnderLock) {
      const failed = answer.status === "failed";
      await closeQrisHoldTx(tx, context, {
        order,
        pos,
        hold,
        reason: failed ? "provider_failed" : "provider_expired",
        evidence: {
          provider: intent.provider,
          rawStatus: answer.rawStatus ?? null,
          status: answer.status,
          providerRef: intent.providerRef,
          checkedAt: now.toISOString(),
        },
        caller: null,
        auditAction: "pos_qris_hold.closed_by_provider",
        now,
      });
      return "closed";
    }
    // Money of this QR already parked (wrong amount): nothing more can be
    // learned from the provider, so stop reading it every few minutes. The
    // hold stays active until the manager releases it.
    const [parkedRow] = await tx
      .select({ id: paymentUnallocatedFunds.id })
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, tenantId),
          eq(paymentUnallocatedFunds.paymentIntentId, intent.id),
        ),
      )
      .limit(1);
    const parked = parkedRow !== undefined;
    await tx
      .update(posQrisHolds)
      .set({
        lastCheckedAt: now,
        checkAttempts: hold.checkAttempts + 1,
        nextCheckAt: parked
          ? new Date(now.getTime() + 24 * 3_600_000)
          : nextHoldCheckAt(intent.expiresAt, now),
      })
      .where(
        and(
          eq(posQrisHolds.tenantId, tenantId),
          eq(posQrisHolds.id, hold.id),
          inArray(posQrisHolds.state, [...ACTIVE_STATES]),
        ),
      );
    // Stuck: still active 30 min after the QR lapsed. One alert per hold (the
    // notification consumer dedupes on the hold id used as the event id).
    if (now.getTime() >= intent.expiresAt.getTime() + HOLD_RELEASE_AFTER_MS)
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId: context.tenant.tenantId,
          outletId: hold.outletId as OutletId,
          alsoOwners: true,
          alsoUserIds: hold.openedBy ? [hold.openedBy] : [],
          id: hold.id,
          eventName: "pos_qris_hold.stuck",
          aggregateType: "pos_qris_hold",
          aggregateId: hold.id,
          payload: { holdId: hold.id, orderId: hold.orderId },
          title: "QRIS belum bisa ditutup",
          body: "Penyedia belum memastikan QRIS ini kedaluwarsa. Tagihan tetap terkunci; manajer dapat merilisnya dengan PIN.",
        },
        now,
      );
    return hold.state;
  });
  if (settleAfter) {
    // Money was recorded: finish the payment (capture once) outside the locks.
    try {
      await settleGatewayIntentNow(context, intent.id, now);
    } catch {
      // The next check retries.
    }
  }
  return state;
}

// ---- Manager release (Q93) ----------------------------------------------------

/**
 * POST .../qris/release: a manager closes a stuck hold (`force_released`),
 * only from `expires_at` + 30 min and with a pos-overrides approval (action
 * `void` on the order, worth at least the QR). The local void is audited. A
 * payment that still arrives on that QR is parked as unallocated funds (the
 * link is cancelled, so the late settlement is refused; D-07). Never a capture.
 */
export async function releasePosQris(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: { approvedBy: string; overrideId: string; idempotencyKey: string },
  now = new Date(),
): Promise<PosQrisHold> {
  const { idempotencyKey, ...request } = input;
  // Last provider read before the manager gives up on the QR: when it says
  // the customer paid, the payment is settled and the release is refused.
  const waiting = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({
        paymentIntentId: posQrisHolds.paymentIntentId,
        tenderId: posQrisHolds.tenderId,
      })
      .from(posQrisHolds)
      .where(
        and(
          eq(posQrisHolds.tenantId, context.tenant.tenantId),
          eq(posQrisHolds.orderId, orderId),
          inArray(posQrisHolds.state, [...ACTIVE_STATES]),
        ),
      );
    if (!row) return null;
    const [pos] = await tx
      .select({ id: posOrders.orderId })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.tenantId, context.tenant.tenantId),
          eq(posOrders.orderId, orderId),
        ),
      );
    return { ...row, hasPos: pos !== undefined };
  });
  // legend-kf104: a guest hold (no tender) of a bill without a POS row has no
  // approval record to spend and no tender to void, so a manager cannot release
  // it. Only the hold check job closes it, on provider proof it is dead or
  // paid. Nothing is read from the provider and nothing moves.
  if (waiting && waiting.tenderId === null && !waiting.hasPos)
    throw new HttpError(
      409,
      "QRIS_HOLD_ACTIVE",
      "QR tamu hanya ditutup oleh pengecekan penyedia setelah terbukti kedaluwarsa atau dibayar; manajer tidak bisa merilisnya.",
    );
  if (waiting) {
    // Provider paid and nothing recorded yet: apply or park it first.
    try {
      await settleGatewayIntentNow(context, waiting.paymentIntentId, now);
    } catch {
      // A rejected (parked) payment is decided below from what was recorded.
    }
    // Refuse only when money of this QR was APPLIED to the bill (evidence
    // beyond what sits in unallocated funds). Parked money cannot be paid
    // again on this QR, so the manager may release. Read again under the
    // locks below: this early read is only a shortcut.
    const applied = await withTenant(db, context, (tx) =>
      appliedQrisMoneyTx(tx, context.tenant.tenantId, waiting.paymentIntentId),
    );
    if (applied) throw paidQrisReleaseError();
  }
  let paidIntentId: string | null = null;
  try {
    return await mutatePosOrder(
      context,
      caller,
      {
        outletId,
        orderId,
        key: idempotencyKey,
        operation: "order.qris_release",
        request,
      },
      async (tx, locked) => {
        const { order, pos } = locked;
        const tenantId = context.tenant.tenantId;
        const holds = await lockHoldsOfOrder(tx, tenantId, order.id);
        const hold = holds.find(isActive);
        if (!hold)
          throw new CoreError("CONFLICT", "Tidak ada QRIS yang perlu dirilis.");
        // Money re-read under the order / hold / intent locks (legend-zff37): a
        // payment that committed after the early read refuses the release. The
        // transaction rolls back (no void, no refund); the payment is finished
        // below, outside the locks.
        if (await appliedQrisMoneyTx(tx, tenantId, hold.paymentIntentId)) {
          paidIntentId = hold.paymentIntentId;
          throw paidQrisReleaseError();
        }
        const [intent] = await tx
          .select({ expiresAt: paymentIntents.expiresAt })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, tenantId),
              eq(paymentIntents.id, hold.paymentIntentId),
            ),
          );
        if (
          !intent ||
          now.getTime() < intent.expiresAt.getTime() + HOLD_RELEASE_AFTER_MS
        )
          throw new CoreError(
            "CONFLICT",
            "QRIS baru boleh dirilis 30 menit setelah kedaluwarsa.",
          );
        const override = await consumeApproval(tx, context, {
          action: "void",
          purpose: "qris_release",
          outletId,
          orderId: order.id,
          objectType: "order",
          objectId: order.id,
          requesterId: caller.userId,
          approvedBy: input.approvedBy,
          overrideId: input.overrideId,
          minValueIdr: hold.amountIdr,
          deviceId: caller.deviceId,
          now,
        });
        await closeQrisHoldTx(tx, context, {
          order,
          pos,
          hold,
          reason: "force_released",
          evidence: {
            approvedBy: input.approvedBy,
            overrideId: override.id,
            releasedBy: caller.userId,
            releasedAt: now.toISOString(),
          },
          caller,
          auditAction: "pos_qris_hold.force_released",
          now,
        });
        const [released] = await tx
          .select()
          .from(posQrisHolds)
          .where(
            and(
              eq(posQrisHolds.tenantId, tenantId),
              eq(posQrisHolds.id, hold.id),
            ),
          );
        return holdDto(tx, tenantId, released ?? hold);
      },
    );
  } catch (error) {
    if (paidIntentId !== null) {
      // Finish the payment (capture once); the bill stays frozen until then.
      try {
        await settleGatewayIntentNow(context, paidIntentId, now);
      } catch {
        // Already recorded; the consumer or the next check finishes it.
      }
    }
    throw error;
  }
}
