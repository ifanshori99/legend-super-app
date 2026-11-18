// legend-i83ls: the money side of a dearer swap. The swap consumer
// (order-recovery-swap-kitchen.ts) only puts the replacement line on the order;
// the guest owes the price difference D plus its pro-rata service charge and
// PBJT (`recoveryChargeSplit`). This module owns that charge, one
// `order_issue_charges` row per issue:
//
// - `deliverIssueChargeEvent`, wired in worker-main.ts right after
//   `deliverSwapKitchenEvent` in the same transaction, opens the row for an
//   `order_issue.resolved` swap whose replacement line exists and whose
//   `price_difference_idr` is above 0. A cashier bill (`pos_orders` row) is
//   routed to the cashier: `route = pos`, `status = routed_pos`, no link. A QR
//   order gets `route = qr_link`, `status = open`, tied to its table session;
//   the guest pays it through its own payment link (never the order's link:
//   the order is already paid or on the open bill).
// - `handleIssueChargePaid` / `handleIssueChargeClosed` consume the WS-05
//   events of that link; paid appends `order_issue.charge_paid`, the event the
//   journal recognises the revenue from.
// - A charge the guest does not pay is closed by staff (`closeIssueCharge`,
//   order-recovery-charge-staff.ts): waived or expired, no journal (revenue is
//   only recognised when money arrives, and the charge is not a receivable).
//
// - Locks: the issue row, then the order row, then the charge row, then the
//   payment link, then the payment intent (always this sequence).
// - Idempotent: `INSERT ... ON CONFLICT (tenant_id, order_issue_id) DO NOTHING`
//   and the status checks under the charge row lock. A replayed or concurrent
//   event changes nothing.
// - Business conditions (amounts that fail their tax identity, nothing to
//   charge) never throw: a retry cannot fix them and would dead-letter the
//   event. They leave an audit row on the issue. Technical errors throw.
// Events of another tenant or outlet, and every other event, are ignored.

import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  uuidSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { auditLogs } from "../db/schema/core-audit.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { tableSessions } from "../db/schema/floor.ts";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { OrderRevenueMismatch } from "./order-revenue.ts";
import { isOrderVoidedByCorrection } from "./order-recovery-charge-void-guard.ts";
import { recoveryChargeSplit } from "./order-recovery-refund-amount.ts";
import { confirmLinkUnpaidAtProvider } from "./payment-provider-proof.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import type { Tx } from "./permission-resolver.ts";

const AUDIT_OPENED = "order_issue.charge_opened";
const AUDIT_ROUTED_POS = "order_issue.charge_routed_pos";
const AUDIT_BLOCKED = "order_issue.charge_blocked";
export const AUDIT_PAID = "order_issue.charge_paid";
const AUDIT_EXPIRED = "order_issue.charge_expired";
const SESSION_CLOSED_REASON = "session_closed";
const AUDIT_SAFE_FIELDS = [
  "id",
  "orderId",
  "chargeId",
  "route",
  "status",
  "differenceIdr",
  "amountIdr",
  "paymentIntentId",
  "blockedReason",
  "waivedBy",
  "approvedBy",
];

const EVENT_DESTINATION = "cloud-sync";
const CHARGE_PAID_EVENT = "order_issue.charge_paid";

const resolvedPayloadSchema = z.looseObject({
  resolution: z.string(),
  orderIssueId: z.string().min(1),
});
const paidPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
  currency: z.string().optional(),
});
const closedPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  reason: z.string().optional(),
});

type ChargeRow = typeof orderIssueCharges.$inferSelect;
type IssueRow = typeof orderIssues.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

/** One audit row on the issue (`objectType` order_issue, like the refund). */
export function auditCharge(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    issueId: string;
    action: string;
    actorUserId: string | null;
    reason: string | null;
    after: Record<string, string | number>;
    at: Date;
  },
): Promise<void> {
  return recordAudit(
    tx,
    context,
    {
      id: createUlid(input.at.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: input.actorUserId === null ? "system" : "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: "order_issue",
      objectId: input.issueId,
      reason: input.reason,
      maskedChanges: { before: null, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(input.at),
    },
    AUDIT_SAFE_FIELDS,
  );
}

export const chargeAudit = (charge: ChargeRow) => ({
  id: charge.orderIssueId,
  orderId: charge.orderId,
  chargeId: charge.id,
  route: charge.route,
  status: charge.status,
  differenceIdr: charge.differenceIdr,
  amountIdr: charge.amountIdr,
});

/**
 * Opens the charge of one `order_issue.resolved` swap event in the consumption
 * transaction `tx`. Anything that is not a swap of this tenant and outlet with
 * a replacement line and a price difference above 0 is a no-op.
 */
export async function deliverIssueChargeEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
): Promise<void> {
  if (event.name !== "order_issue.resolved") return;
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return;
  const payload = resolvedPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.resolution !== "swap") return;

  const [issue] = await tx
    .select()
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.id, payload.data.orderIssueId),
      ),
    )
    .for("update");
  if (!issue) return;
  const difference = Number(issue.priceDifferenceIdr ?? 0);
  if (
    issue.resolution !== "swap" ||
    issue.status !== "resolved" ||
    event.outletId !== issue.outletId ||
    difference <= 0 ||
    // The swap kitchen consumer ran first: no replacement line, no charge
    // (blocked or skipped swap).
    issue.replacementOrderItemId === null
  )
    return;

  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, issue.orderId)))
    // Lock order after issue (always this sequence).
    .for("update");
  if (!order || order.outletId !== issue.outletId) return;
  if (order.status === "voided") return;

  const [existing] = await tx
    .select({ id: orderIssueCharges.id })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.orderIssueId, issue.id),
      ),
    );
  if (existing) return;

  const at = new Date();
  const actorUserId = event.actor.type === "user" ? event.actor.id : null;
  // The issue row lock makes the blocked audit safe to replay: write it once.
  // The one-day margin before resolvedAt bounds the scan to
  // audit_logs_retention_idx (tenant_id, created_at).
  const auditSince = new Date(
    (issue.resolvedAt ?? issue.createdAt).getTime() - 24 * 60 * 60 * 1000,
  );
  const blocked = async (blockedReason: string): Promise<void> => {
    const [seen] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          gte(auditLogs.createdAt, auditSince),
          sql`${auditLogs.event}->>'objectId' = ${issue.id}`,
          sql`${auditLogs.event}->>'action' = ${AUDIT_BLOCKED}`,
        ),
      )
      .limit(1);
    if (seen) return;
    await auditCharge(tx, context, {
      outletId: order.outletId,
      issueId: issue.id,
      action: AUDIT_BLOCKED,
      actorUserId: null,
      reason: "Selisih swap tidak ditagih",
      after: {
        id: issue.id,
        orderId: order.id,
        differenceIdr: difference,
        blockedReason,
      },
      at,
    });
  };

  let split: ReturnType<typeof recoveryChargeSplit>;
  try {
    split = recoveryChargeSplit({ order, differenceIdr: difference });
  } catch (error) {
    // Order amounts that fail their tax-mode identity: a retry cannot fix them.
    if (error instanceof OrderRevenueMismatch) {
      await blocked("order_amounts_mismatch");
      return;
    }
    throw error;
  }
  if (split.amountIdr <= 0) {
    await blocked("nothing_to_charge");
    return;
  }

  // A cashier bill: the cashier collects the difference, no link.
  const [pos] = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    );
  const route = pos ? "pos" : "qr_link";
  // The table session ended before the event arrived: nobody can pay the
  // charge any more, so it is born `expired` instead of `open`.
  const sessionEnded =
    !pos &&
    (order.status === "completed" ||
      (order.tableSessionId !== null &&
        (await sessionIsClosed(tx, tenantId, order.tableSessionId))));
  const [inserted] = await tx
    .insert(orderIssueCharges)
    .values({
      tenantId,
      outletId: order.outletId,
      orderIssueId: issue.id,
      orderId: order.id,
      tableSessionId: pos ? null : order.tableSessionId,
      route,
      status: pos ? "routed_pos" : sessionEnded ? "expired" : "open",
      closedAt: sessionEnded ? at : null,
      closeReason: sessionEnded ? SESSION_CLOSED_REASON : null,
      differenceIdr: idr(split.differenceIdr),
      grossSalesIdr: idr(split.grossSalesIdr),
      serviceChargeIdr: idr(split.serviceChargeIdr),
      pbjtIdr: idr(split.pbjtIdr),
      amountIdr: idr(split.amountIdr),
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({
      target: [orderIssueCharges.tenantId, orderIssueCharges.orderIssueId],
    })
    .returning();
  // Only the call that inserted the row audits it.
  if (!inserted) return;
  await auditCharge(tx, context, {
    outletId: order.outletId,
    issueId: issue.id,
    action: pos
      ? AUDIT_ROUTED_POS
      : sessionEnded
        ? AUDIT_EXPIRED
        : AUDIT_OPENED,
    actorUserId: sessionEnded ? null : actorUserId,
    reason: pos
      ? "Selisih swap pada bill kasir ditagih kasir"
      : sessionEnded
        ? "Sesi meja sudah ditutup, selisih tidak ditagih"
        : "Selisih swap ditagih lewat link pembayaran",
    after: chargeAudit(inserted),
    at,
  });
}

async function sessionIsClosed(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  sessionId: string,
): Promise<boolean> {
  const [session] = await tx
    .select({ status: tableSessions.status })
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.id, sessionId),
      ),
    );
  return session?.status === "closed" || session?.status === "voided";
}

/**
 * legend-ukbq3: asks the payment provider about the link of every still-taking
 * charge (`open`, `routed_pos`) of `scope` BEFORE the caller's transaction
 * cancels the link locally. Runs outside any transaction and lock (network
 * I/O); the charges are read in a short transaction of their own. A charge the
 * provider already holds money for is settled (`confirmLinkUnpaidAtProvider`
 * applies the payment once), so the caller's transaction finds it no longer
 * `open`. Returns true when any link was settled. A provider that cannot be
 * reached or answers unclearly throws 409 `PAYMENT_PROVIDER_UNCONFIRMED`: the
 * caller must not cancel anything then.
 */
export async function confirmChargeLinksUnpaid(
  context: ScopedTenantContext,
  scope: { chargeId: string } | { sessionId: string },
  now: Date,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ paymentLinkId: orderIssueCharges.paymentLinkId })
      .from(orderIssueCharges)
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          "chargeId" in scope
            ? eq(orderIssueCharges.id, scope.chargeId)
            : eq(orderIssueCharges.tableSessionId, scope.sessionId),
          inArray(orderIssueCharges.status, ["open", "routed_pos"]),
          isNotNull(orderIssueCharges.paymentLinkId),
        ),
      )
      .orderBy(orderIssueCharges.id),
  );
  let settled = false;
  for (const { paymentLinkId } of rows) {
    if (paymentLinkId === null) continue;
    const verdict = await confirmLinkUnpaidAtProvider(
      context,
      paymentLinkId,
      now,
    );
    if (verdict === "settled") settled = true;
  }
  return settled;
}

/**
 * legend-ukbq3: inside the caller's transaction, after `lockChargeChain`, throws
 * 409 when a `paid` intent of the charge's link exists while the charge is
 * still `open`. `payment.paid` is applied by the worker through the outbox, so
 * the charge row lags behind the intent: closing now would make the consumer
 * refund the customer in full (`late_payment_on_closed_charge`). The link is
 * locked first (link, then intent: the confirmation order), so a confirmation
 * cannot commit `paid` between this check and the cancel that follows. Same
 * guard as the POS route (`order-recovery-charge-pos.ts`).
 */
export async function assertNoPaidIntentOnChargeLink(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  paymentLinkId: string | null,
): Promise<void> {
  if (paymentLinkId === null) return;
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, paymentLinkId),
      ),
    )
    .for("update");
  const [taken] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        eq(paymentIntents.status, "paid"),
      ),
    )
    .limit(1);
  if (taken)
    throw new HttpError(
      409,
      "CONFLICT",
      "QRIS sudah dibayar; tunggu konfirmasi.",
    );
}

type OpenChargeClosing = {
  closeReason: string;
  closedBy: string | null;
  linkReason: string;
  auditAction: string;
  auditReason: string;
};

/**
 * Closes every `open` charge of a table session in `tx` with `closing`: the
 * payment link cancelled and one audit row per charge. Each charge is locked
 * through `lockChargeChain` (issue, order, charge, link, intent); one that was
 * paid or closed meanwhile is left alone. Returns the number of charges
 * closed. No journal.
 */
async function closeOpenChargesOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  now: Date,
  closing: OpenChargeClosing,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const open = await tx
    .select({ id: orderIssueCharges.id })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.tableSessionId, sessionId),
        eq(orderIssueCharges.status, "open"),
      ),
    )
    .orderBy(orderIssueCharges.id);
  let closed = 0;
  for (const { id } of open) {
    const locked = await lockChargeChain(tx, tenantId, { chargeId: id });
    if (!locked || locked.charge.status !== "open") continue;
    const { charge, issue } = locked;
    // A paid intent the worker has not applied yet: 409, the close retries.
    await assertNoPaidIntentOnChargeLink(tx, tenantId, charge.paymentLinkId);
    await tx
      .update(orderIssueCharges)
      .set({
        status: "expired",
        closedAt: now,
        closedBy: closing.closedBy,
        closeReason: closing.closeReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
        ),
      );
    if (charge.paymentLinkId !== null)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: charge.paymentLinkId,
        now,
        reason: closing.linkReason,
      });
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: issue.id,
      action: closing.auditAction,
      actorUserId: closing.closedBy,
      reason: closing.auditReason,
      after: { ...chargeAudit(charge), status: "expired" },
      at: now,
    });
    closed += 1;
  }
  return closed;
}

/**
 * Expires every `open` charge of a table session that is ending (forced close
 * by a waiter, session expiry), in the closing transaction `tx`. The caller
 * must run `confirmChargeLinksUnpaid(context, { sessionId }, now)` BEFORE
 * opening that transaction (legend-ukbq3): this function does no provider I/O,
 * and a charge settled by that call is no longer `open` here. Per charge: status
 * `expired`, reason `session_closed`, no closer, the payment link cancelled and
 * one `order_issue.charge_expired` audit row (actor system) per charge. Returns
 * the number of charges expired. No journal: revenue is only recognised when
 * money arrives.
 */
export function expireOpenChargesOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  now: Date,
): Promise<number> {
  return closeOpenChargesOfSession(tx, context, sessionId, now, {
    closeReason: SESSION_CLOSED_REASON,
    closedBy: null,
    linkReason: "issue_charge_expired",
    auditAction: AUDIT_EXPIRED,
    auditReason: "Sesi meja ditutup sebelum selisih dibayar",
  });
}

/**
 * Locks the issue, the order and then the charge row of one charge (the
 * module's lock sequence) and returns the locked rows, or null.
 */
export async function lockChargeChain(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  find: { chargeId: string } | { paymentLinkId: string },
): Promise<{ charge: ChargeRow; issue: IssueRow; order: OrderRow } | null> {
  const [probe] = await tx
    .select({
      id: orderIssueCharges.id,
      orderIssueId: orderIssueCharges.orderIssueId,
      orderId: orderIssueCharges.orderId,
    })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        "chargeId" in find
          ? eq(orderIssueCharges.id, find.chargeId)
          : eq(orderIssueCharges.paymentLinkId, find.paymentLinkId),
      ),
    );
  if (!probe) return null;
  const [issue] = await tx
    .select()
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.id, probe.orderIssueId),
      ),
    )
    .for("update");
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, probe.orderId)))
    .for("update");
  const [charge] = await tx
    .select()
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.id, probe.id),
      ),
    )
    .for("update");
  if (!issue || !order || !charge) return null;
  return { charge, issue, order };
}

export type IssueChargePaidOutcome =
  | "ignored"
  | "paid"
  | "unchanged"
  | "not_settled"
  | "amount_mismatch"
  | "currency_mismatch"
  /** The charge was waived or expired (or is a cashier bill) before the money arrived. */
  | "late_payment_on_closed_charge"
  /** The charge was already paid by another intent of its link. */
  | "double_payment";

/**
 * A verified `payment.paid` of the charge's own payment link: the charge
 * becomes `paid` and `order_issue.charge_paid` is appended in `tx`. A payment
 * for a charge that no longer takes money (`late_payment_on_closed_charge`,
 * `double_payment`) changes nothing here: the caller refunds it. Replay safe.
 */
export async function handleIssueChargePaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<IssueChargePaidOutcome> {
  if (event.name !== "payment.paid") return "ignored";
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return "ignored";
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { intentId, paymentLinkId, currency } = payload.data;
  const locked = await lockChargeChain(tx, tenantId, { paymentLinkId });
  if (!locked) return "ignored";
  const { charge, issue, order } = locked;

  // Paid in cash at the till: the guest's code was cancelled then, so money on
  // it now is a late payment on a closed charge (refunded in full).
  if (charge.status === "paid" && charge.cashMovementId !== null)
    return "late_payment_on_closed_charge";
  // Paid at the till by card/EDC (no intent, no cash movement): the guest's
  // code is dead, so a QRIS landing now is a late payment on a closed charge.
  if (charge.status === "paid" && charge.paymentIntentId === null)
    return "late_payment_on_closed_charge";
  if (charge.status === "paid")
    return charge.paymentIntentId === intentId ? "unchanged" : "double_payment";
  // A cashier bill (`routed_pos`) is open to exactly the QRIS the cashier asked
  // for at the till (`collect-at-pos`); any other intent is a late payment.
  // The void of the order leaves a `routed_pos` charge and its live QRIS alone,
  // so that QRIS paid on a voided order is late (refunded in full).
  // A POS void correction (`pos_order_voids`) leaves the order `completed`: an
  // unpaid charge of it takes no money either, `open` or `routed_pos`
  // (legend-vl6bk, SO 996 F2). The one refund of the late payment follows.
  if (
    (charge.status === "open" || charge.status === "routed_pos") &&
    (await isOrderVoidedByCorrection(tx, tenantId, order.id))
  )
    return "late_payment_on_closed_charge";
  const cashierQris =
    charge.status === "routed_pos" &&
    charge.paymentIntentId === intentId &&
    order.status !== "voided";
  if (charge.status !== "open" && !cashierQris)
    return "late_payment_on_closed_charge";
  if (currency !== undefined && currency !== "IDR") return "currency_mismatch";

  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr, totalIdr: paymentLinks.totalIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, paymentLinkId),
      ),
    )
    .for("update");
  if (!link) return "not_settled";
  // What the guest paid must be the charge's amount, exactly (PAY-01).
  if (link.totalIdr !== charge.amountIdr) return "amount_mismatch";
  if (link.paidIdr < link.totalIdr) return "not_settled";

  const at = await lockIntentsForFact(tx, tenantId, [intentId], now);
  const [intent] = await tx
    .select({
      status: paymentIntents.status,
      paidAt: paymentIntents.paidAt,
      paymentLinkId: paymentIntents.paymentLinkId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  // A refund that completed before this event moves the intent on; it is
  // still the money that paid the charge.
  if (
    !intent ||
    intent.paymentLinkId !== paymentLinkId ||
    intent.paidAt === null ||
    !["paid", "partially_refunded", "refunded"].includes(intent.status)
  )
    return "not_settled";

  const paidAt = intent.paidAt;
  await tx
    .update(orderIssueCharges)
    .set({
      status: "paid",
      paidAt,
      paymentIntentId: intentId,
      updatedAt: at,
    })
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.id, charge.id),
      ),
    );
  await appendChargePaidEvent(tx, context, {
    charge,
    intentId,
    paidAt,
    at,
  });
  await auditCharge(tx, context, {
    outletId: charge.outletId,
    issueId: issue.id,
    action: AUDIT_PAID,
    actorUserId: null,
    reason: "Selisih swap dibayar tamu",
    after: {
      ...chargeAudit(charge),
      status: "paid",
      paymentIntentId: intentId,
    },
    at,
  });
  return "paid";
}

export type IssueChargeClosedOutcome =
  "ignored" | "unchanged" | "retry_allowed";

/**
 * `payment.expired` / `payment.failed` of a charge link's intent. The charge
 * stays `open`: the guest may pay again with a fresh code on the same link
 * (a failed payment can still settle later, `handleIssueChargePaid` takes it).
 * Only the pointer to the dead intent is cleared. A superseded code is not a
 * closed payment. Replay safe.
 */
export async function handleIssueChargeClosed(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<IssueChargeClosedOutcome> {
  if (event.name !== "payment.expired" && event.name !== "payment.failed")
    return "ignored";
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return "ignored";
  const payload = closedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  if (payload.data.reason === "superseded") return "ignored";
  const { intentId } = payload.data;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  if (!intent) return "ignored";
  const locked = await lockChargeChain(tx, tenantId, {
    paymentLinkId: intent.paymentLinkId,
  });
  if (!locked) return "ignored";
  const { charge } = locked;
  if (charge.status !== "open" || charge.paymentIntentId !== intentId)
    return "unchanged";
  await tx
    .update(orderIssueCharges)
    .set({ paymentIntentId: null, updatedAt: now })
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.id, charge.id),
      ),
    );
  return "retry_allowed";
}

/** Appends `order_issue.charge_paid` on the issue's stream, in `tx`. */
export async function appendChargePaidEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    charge: ChargeRow;
    /** Null when the cashier took the charge in cash (`cashMovementId`). */
    intentId: string | null;
    cashMovementId?: string;
    /** Paid by an approved EDC sale at the till (no intent, no cash). */
    edc?: boolean;
    paidAt: Date;
    at: Date;
  },
): Promise<void> {
  const { charge, at } = input;
  const tenantId = context.tenant.tenantId;
  const definition = qrOrderEvents[CHARGE_PAID_EVENT];
  const [last] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, charge.orderIssueId),
      ),
    );
  const sequence = Number(last?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(at.getTime()),
    tenantId,
    outletId: charge.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: charge.orderIssueId,
    sequence,
    occurredAt: toIsoDateTime(at),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey:
      `${definition.name}:${charge.orderIssueId}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: charge.orderId,
      orderIssueId: charge.orderIssueId,
      chargeId: charge.id,
      paymentIntentId: input.intentId,
      ...(input.cashMovementId === undefined
        ? input.edc === true
          ? { method: "pos_edc" }
          : {}
        : { method: "pos_cash", cashMovementId: input.cashMovementId }),
      differenceIdr: charge.differenceIdr,
      grossSalesIdr: charge.grossSalesIdr,
      serviceChargeIdr: charge.serviceChargeIdr,
      pbjtIdr: charge.pbjtIdr,
      amountIdr: charge.amountIdr,
      paidAt: toIsoDateTime(input.paidAt),
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(at.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}
