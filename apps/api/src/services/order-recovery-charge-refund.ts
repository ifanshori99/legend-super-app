// Refund of a PAID dearer-swap charge (legend-nsvu0, brief 982).
//
// The charge has its own payment link and intent (never the order's), so the
// guest's money goes back through a payment refund of THAT intent. Several
// refunds may add up, never past the paid charge.
//
// - Staff: permission `order.recovery.handle` on the charge's outlet, the same
//   as waive / expire. The refund is a REQUEST (`payment_refunds`, pending, its
//   approval chain opened); a second person approves it in the payment module,
//   which pays out. No `order_issue_id` on the row: that column allows one live
//   refund per issue, a charge may be refunded in parts.
// - Race-free in SQL without a counter column: every refund of the charge runs
//   under the charge row lock (`lockChargeChain`: issue, order, charge) and
//   then the intent row lock, and reads "refunded so far" as the sum of the
//   non-failed `payment_refunds` of the intent under those locks. A concurrent
//   request waits, then sees the committed rows. The payment module writes
//   refunds of this intent under the intent lock too, and its own cap counts a
//   paid charge as in use (payment-admin.service.ts `chargeInUseOfIntent`), so
//   no other path can pay this money out.
// - Journal: the refund appends `order_issue.charge_refunded` in the same
//   transaction; the auto-journal reverses the refund's share of the charge
//   revenue (key `aj:order-charge-refund:<refundId>`).
// - Only a charge paid through a payment intent is refundable here. A cash or
//   EDC charge has no intent: 409, the till gives that money back.
//
// `refundPaidChargeInTx` is the core, callable inside an existing transaction
// (the void of an order calls it). Lock order: issue, order, charge, intent.

import { and, eq, isNull, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  idr,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { assertChargeChainBudget, assertOrderBudget } from "./order-given.ts";
import { auditCharge, lockChargeChain } from "./order-recovery-charge.ts";
import { recoveryChargeRefundSplitFromRemaining } from "./order-recovery-refund-amount.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import type { Tx } from "./permission-resolver.ts";

const HANDLE = "order.recovery.handle";
const AUDIT_CHARGE_REFUNDED = "order_issue.charge_refunded";
const EVENT_DESTINATION = "cloud-sync";
const CHARGE_REFUNDED_EVENT = "order_issue.charge_refunded";

type ChargeRow = typeof orderIssueCharges.$inferSelect;

export type IssueChargeRefundView = {
  refundId: string;
  chargeId: string;
  paymentIntentId: string;
  /** What this request gives back. */
  amountIdr: number;
  /** Non-failed refunds of the charge after this request. */
  refundedIdr: number;
  /** What the charge can still give back after this request. */
  remainingIdr: number;
  status: string;
};

const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

/**
 * Files the refund request of a paid charge in `tx`. The caller is inside
 * `withTenant`; this takes the chain locks itself (re-locking is harmless).
 * `authorize` runs on the locked charge, before anything is written (the
 * route checks the actor's permission there; a system caller passes none).
 * Refused with 409 when the charge is not paid through an intent or the
 * amount passes what is still refundable; 404 when the charge is not visible.
 */
export async function refundPaidChargeInTx(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    chargeId: string;
    amountIdr: number;
    reason: string;
    /** Recorded as the requester; the approver must be someone else. */
    requestedBy: string;
    actor: { type: "user"; id: string } | { type: "system" };
    now: Date;
    authorize?: (charge: ChargeRow) => void;
  },
): Promise<IssueChargeRefundView> {
  const tenantId = context.tenant.tenantId;
  const locked = await lockChargeChain(tx, tenantId, {
    chargeId: input.chargeId,
  });
  if (!locked)
    throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
  const { charge } = locked;
  assertOutletInScope(context.outletScope, charge.outletId);
  input.authorize?.(charge);

  if (charge.status !== "paid")
    throw conflict(
      "Hanya tagihan selisih yang sudah dibayar yang dapat direfund.",
    );
  if (charge.paymentIntentId === null)
    throw conflict(
      "Tagihan ini dibayar di kasir tanpa pembayaran online; kembalikan uangnya lewat kasir.",
    );
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0)
    throw conflict("Jumlah refund harus lebih dari nol.");

  // The intent row lock; the fact clock keeps the refund after the payment.
  const at = await lockIntentsForFact(
    tx,
    tenantId,
    [charge.paymentIntentId],
    input.now,
  );
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, charge.paymentIntentId),
      ),
    );
  if (
    !intent ||
    intent.paidAt === null ||
    !["paid", "partially_refunded"].includes(intent.status)
  )
    throw conflict("Pembayaran tagihan ini belum dapat direfund.");

  const refundedBefore = await refundedOfIntent(tx, tenantId, intent.id);
  const remaining = charge.amountIdr - refundedBefore;
  if (input.amountIdr > remaining)
    throw conflict(
      `Refund melebihi sisa tagihan yang dibayar; paling banyak ${Math.max(0, remaining)} IDR.`,
    );

  // legend-0zfr1: the split comes from what is left of each component after
  // the non-failed refunds that exist, so a failed refund frees its share.
  const refundedParts = await refundedComponentsOfCharge(
    tx,
    tenantId,
    charge,
    intent.id,
  );
  if (
    refundedParts.grossSalesIdr +
      refundedParts.serviceChargeIdr +
      refundedParts.pbjtIdr !==
    refundedBefore
  )
    throw conflict(
      "Rincian refund tagihan ini tidak sesuai dengan refund yang tercatat; hubungi tim teknis.",
    );
  const split = recoveryChargeRefundSplitFromRemaining({
    charge,
    refunded: refundedParts,
    refundIdr: input.amountIdr,
  });

  const [inserted] = await tx
    .insert(paymentRefunds)
    .values({
      tenantId,
      outletId:
        charge.outletId as (typeof paymentRefunds.$inferInsert)["outletId"],
      paymentIntentId: intent.id,
      amountIdr: idr(input.amountIdr),
      reason: input.reason,
      note: null,
      requestedBy: input.requestedBy,
      // The fact clock of the guard (lockIntentsForFact), not the DB default.
      createdAt: at,
    })
    .returning();
  if (!inserted) throw new Error("Charge refund insert returned no row");
  const row = await openRefundChainSafely(tx, context, inserted, at);
  // 1131: the one order budget (vouchers, POS and ORD-09 refunds count);
  // under the order lock of lockChargeChain, the throw rolls the row back.
  await assertOrderBudget(tx, tenantId, charge.orderId);
  // 1145: and the swap chain of the charge's item.
  await assertChargeChainBudget(
    tx,
    tenantId,
    charge.orderId,
    charge.orderIssueId,
  );

  await recordAudit(
    tx,
    context,
    {
      id: createUlid(at.getTime()),
      tenantId,
      outletId: row.outletId,
      actorType: input.actor.type,
      actorId: input.actor.type === "user" ? input.actor.id : null,
      deviceId: null,
      action: "payment.refund_requested",
      objectType: "payment_refund",
      objectId: row.id,
      reason: row.reason,
      maskedChanges: {
        before: null,
        after: { amountIdr: row.amountIdr, status: row.status },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(at),
    },
    ["amountIdr", "status"],
  );
  await appendPaymentEvent(tx, context, {
    name: "payment.refund_requested",
    aggregateId: row.id,
    outletId: row.outletId,
    actor: input.actor,
    payload: {
      refundId: row.id,
      paymentIntentId: row.paymentIntentId,
      amountIdr: row.amountIdr,
    },
    now: at,
  });
  await appendChargeRefundedEvent(tx, context, {
    charge,
    refundId: row.id,
    intentId: intent.id,
    amountIdr: input.amountIdr,
    split,
    at,
  });
  await auditCharge(tx, context, {
    outletId: charge.outletId,
    issueId: charge.orderIssueId,
    action: AUDIT_CHARGE_REFUNDED,
    actorUserId: input.actor.type === "user" ? input.actor.id : null,
    reason: input.reason,
    after: {
      id: charge.orderIssueId,
      orderId: charge.orderId,
      chargeId: charge.id,
      status: charge.status,
      amountIdr: input.amountIdr,
      paymentIntentId: intent.id,
    },
    at,
  });

  const refundedIdr = refundedBefore + input.amountIdr;
  return {
    refundId: row.id,
    chargeId: charge.id,
    paymentIntentId: intent.id,
    amountIdr: input.amountIdr,
    refundedIdr,
    remainingIdr: charge.amountIdr - refundedIdr,
    status: row.status,
  };
}

/**
 * Staff refund of a paid charge. The permission is checked on the charge's
 * outlet, under the locks; `reason` goes on the refund and in the audit trail.
 */
export async function refundIssueCharge(
  context: ScopedTenantContext,
  actorUserId: string,
  chargeId: string,
  input: { amountIdr: number; reason: string },
  now = new Date(),
): Promise<IssueChargeRefundView> {
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    return refundPaidChargeInTx(tx, context, {
      chargeId,
      amountIdr: input.amountIdr,
      reason: input.reason,
      requestedBy: actorUserId,
      actor: { type: "user", id: actorUserId },
      now,
      authorize: (charge) => {
        if (!snapshot.allows(HANDLE, { type: "outlet", id: charge.outletId }))
          throw new AccessError(
            "PERMISSION_DENIED",
            "Anda tidak dapat menangani tagihan selisih di outlet ini.",
          );
      },
    });
  });
}

/** Non-failed refunds of the intent (reserved money counts), under its lock. */
async function refundedOfIntent(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  intentId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.paymentIntentId, intentId),
        sql`${paymentRefunds.status} <> 'failed'`,
        // A refund of an unallocated fund gives back money that is not the charge's.
        isNull(paymentRefunds.unallocatedFundId),
      ),
    );
  return Number(row?.total ?? "0");
}

/**
 * legend-0zfr1: gross / service / PBJT already given back by the non-failed
 * refunds of the charge's intent, read from their `order_issue.charge_refunded`
 * events (the split is frozen there), under the charge and intent locks.
 */
async function refundedComponentsOfCharge(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  charge: ChargeRow,
  intentId: string,
): Promise<{
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
}> {
  const payload = sql`${domainEventOutbox.event}->'payload'`;
  const [row] = await tx
    .select({
      gross: sql<string>`coalesce(sum((${payload}->>'grossSalesIdr')::bigint), 0)::text`,
      service: sql<string>`coalesce(sum((${payload}->>'serviceChargeIdr')::bigint), 0)::text`,
      pbjt: sql<string>`coalesce(sum((${payload}->>'pbjtIdr')::bigint), 0)::text`,
    })
    .from(domainEventOutbox)
    .innerJoin(
      paymentRefunds,
      and(
        eq(paymentRefunds.tenantId, domainEventOutbox.tenantId),
        sql`${paymentRefunds.id}::text = ${payload}->>'refundId'`,
      ),
    )
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateId, charge.orderIssueId),
        sql`${domainEventOutbox.event}->>'name' = ${CHARGE_REFUNDED_EVENT}`,
        sql`${payload}->>'chargeId' = ${charge.id}`,
        eq(paymentRefunds.paymentIntentId, intentId),
        sql`${paymentRefunds.status} <> 'failed'`,
      ),
    );
  return {
    grossSalesIdr: Number(row?.gross ?? "0"),
    serviceChargeIdr: Number(row?.service ?? "0"),
    pbjtIdr: Number(row?.pbjt ?? "0"),
  };
}

/**
 * Appends `order_issue.charge_refunded` on the issue's stream, in `tx`.
 * `intentId` null with `method` pos_cash is the cash return of a voided order
 * (legend-s61sg); `refundId` is then its cash_out movement. Method pos_cash
 * with a manual refund's cash_out, or edc_manual with the manual refund row
 * as `refundId`, is the till refund of legend-mrwtp (no intent either).
 */
export async function appendChargeRefundedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    charge: ChargeRow;
    refundId: string;
    intentId: string | null;
    method?: "gateway" | "pos_cash" | "edc_manual";
    amountIdr: number;
    split: {
      grossSalesIdr: number;
      serviceChargeIdr: number;
      pbjtIdr: number;
    };
    at: Date;
  },
): Promise<void> {
  const { charge, at } = input;
  const tenantId = context.tenant.tenantId;
  const definition = qrOrderEvents[CHARGE_REFUNDED_EVENT];
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
    idempotencyKey: `${definition.name}:${input.refundId}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: charge.orderId,
      orderIssueId: charge.orderIssueId,
      chargeId: charge.id,
      refundId: input.refundId,
      paymentIntentId: input.intentId,
      ...(input.method ? { method: input.method } : {}),
      grossSalesIdr: input.split.grossSalesIdr,
      serviceChargeIdr: input.split.serviceChargeIdr,
      pbjtIdr: input.split.pbjtIdr,
      amountIdr: input.amountIdr,
      refundedAt: toIsoDateTime(at),
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
