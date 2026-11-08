// WS-05 refunds. All reservations and audit records share the tenant transaction.
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import * as contract from "@starter/shared/payment/admin";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  approvalRequests,
  outlets,
  paymentIntents,
  paymentLinks,
  paymentRefunds,
  user,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { approveRefund as approveRefundWithPayout } from "./payment-refund.service.ts";
import {
  appendPaymentEvent,
  assertPaymentPermission,
} from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

export const missing = () =>
  new HttpError(404, "NOT_FOUND", "Payment or refund not found.");
export const conflict = (message: string) =>
  new HttpError(409, "CONFLICT", message);

export type Intent = typeof paymentIntents.$inferSelect;
export type Refund = typeof paymentRefunds.$inferSelect;
// Evidence and fund rows are written under the intent lock by settlement.
// Compute in PostgreSQL numeric and bigint to avoid rounding aggregate sums.
export async function refundableBalance(tx: Tx, intent: Intent) {
  const result = await tx.execute(sql`
    SELECT
      (SELECT coalesce(sum(amount_idr), 0) FROM payment_evidence
       WHERE tenant_id = ${intent.tenantId} AND payment_intent_id = ${intent.id}::uuid)::text AS received,
      (SELECT coalesce(sum(amount_idr), 0) FROM payment_unallocated_funds
       WHERE tenant_id = ${intent.tenantId} AND payment_intent_id = ${intent.id}::uuid)::text AS unallocated,
      (SELECT coalesce(sum(amount_idr), 0) FROM payment_refunds
       WHERE tenant_id = ${intent.tenantId} AND payment_intent_id = ${intent.id}::uuid
         AND status <> 'failed' AND unallocated_fund_id IS NULL)::text AS reserved
  `);
  const row = result.rows[0]!;
  const allocated =
    BigInt(String(row.received)) - BigInt(String(row.unallocated));
  const cap =
    allocated < 0n
      ? 0n
      : allocated > BigInt(intent.amountIdr)
        ? BigInt(intent.amountIdr)
        : allocated;
  const reserved = BigInt(String(row.reserved));
  return { cap, reserved };
}

async function paymentInfo(tx: Tx, intent: Intent) {
  const [link] = await tx
    .select()
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, intent.tenantId),
        eq(paymentLinks.id, intent.paymentLinkId),
      ),
    );
  const [outlet] = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, intent.tenantId),
        eq(outlets.id, intent.outletId),
      ),
    );
  if (!link || !outlet) throw missing();
  return { link, outlet };
}
export async function refundView(
  tx: Tx,
  refund: Refund,
  viewerCanApprove = false,
) {
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, refund.tenantId),
        eq(paymentIntents.id, refund.paymentIntentId),
      ),
    );
  if (!intent) throw missing();
  const { link, outlet } = await paymentInfo(tx, intent);
  const names = await tx
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(
      inArray(user.id, [
        refund.requestedBy,
        ...(refund.approvedBy ? [refund.approvedBy] : []),
      ]),
    );
  return contract.refundViewSchema.parse({
    id: refund.id,
    tenantId: refund.tenantId,
    outletId: refund.outletId,
    paymentIntentId: refund.paymentIntentId,
    amountIdr: refund.amountIdr,
    reason: refund.reason,
    providerRef: refund.providerRef,
    status: refund.status,
    approvedBy: refund.approvedBy,
    paymentReference: link.reference,
    method: intent.method,
    paidAmountIdr: intent.amountIdr,
    outletName: outlet.name,
    requestedBy: refund.requestedBy,
    requestedByName:
      names.find((n) => n.id === refund.requestedBy)?.name ??
      systemRequesterName(refund.requestedBy) ??
      refund.requestedBy,
    viewerCanApprove,
    approvedByName: refund.approvedBy
      ? (names.find((n) => n.id === refund.approvedBy)?.name ??
        refund.approvedBy)
      : null,
    note: refund.note,
    createdAt: refund.createdAt.toISOString(),
    decidedAt: refund.decidedAt?.toISOString() ?? null,
    failureReason: refund.failureReason,
    payoutAttempts: refund.payoutAttempts,
    lastPayoutError: refund.lastPayoutError,
    completedAt: refund.completedAt?.toISOString() ?? null,
  });
}
/**
 * Whether `viewerId` may act on the refund's approval: pending, not the
 * requester or chain submitter, holds `payment.reconcile` at the outlet, and
 * has not decided an earlier level. The matrix still decides on the write.
 */
async function canViewerApprove(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  viewerId: string,
): Promise<boolean> {
  if (refund.status !== "pending" || refund.requestedBy === viewerId)
    return false;
  try {
    await authorize(
      tx,
      context,
      viewerId,
      "payment.reconcile",
      refund.outletId,
    );
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
  if (!refund.approvalChainId) return true;
  const [involved] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, refund.tenantId),
        eq(approvalRequests.chainId, refund.approvalChainId),
        sql`(${approvalRequests.decidedBy} = ${viewerId}
          OR (${approvalRequests.level} = 1 AND ${approvalRequests.requestedBy} = ${viewerId}))`,
      ),
    )
    .limit(1);
  return !involved;
}
/** `refundView` with `viewerCanApprove` computed for the signed-in viewer. */
export async function refundViewFor(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  viewerId: string,
) {
  return refundView(
    tx,
    refund,
    await canViewerApprove(tx, context, refund, viewerId),
  );
}
function systemRequesterName(requestedBy: string): string | null {
  const actor = contract.systemRefundActorSchema.safeParse(requestedBy);
  return actor.success ? contract.systemRefundActorNames[actor.data] : null;
}
/** Audit row for one refund transition; `actorId` null = the system (payout, sweep). */
export async function refundAudit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorId: string | null;
    row: Refund;
    action: string;
    now: Date;
    reason?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown>;
  },
) {
  const { row } = input;
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: row.outletId,
      actorType: input.actorId === null ? "system" : "user",
      actorId: input.actorId,
      deviceId: null,
      action: input.action,
      objectType: "payment_refund",
      objectId: row.id,
      reason: input.reason === undefined ? row.reason : input.reason,
      maskedChanges: {
        before: input.before === undefined ? null : input.before,
        after: input.after ?? { amountIdr: row.amountIdr, status: row.status },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    },
    ["amountIdr", "status", "failureReason", "providerCode"],
  );
}
export async function authorize(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  permission: "payment.transaction.view" | "payment.reconcile",
  outletId?: string,
) {
  await assertPaymentPermission(
    tx,
    context,
    actor,
    permission,
    outletId ? { type: "outlet", id: outletId } : { type: "tenant" },
    new Date(),
  );
}
export async function createRefund(
  context: ScopedTenantContext,
  actor: string,
  input: contract.CreateRefundInput,
  key: string,
) {
  const body = contract.createRefundInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, body.paymentIntentId),
        ),
      )
      .for("update");
    if (!intent) throw missing();
    await authorize(tx, context, actor, "payment.reconcile", intent.outletId);
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      "refund.create",
      body,
      async () => {
        if (
          !intent.paidAt ||
          !["paid", "partially_refunded"].includes(intent.status)
        )
          throw conflict("Payment is not refundable.");
        const { cap, reserved } = await refundableBalance(tx, intent);
        if (reserved + BigInt(body.amountIdr) > cap)
          throw conflict("Refund exceeds available paid amount.");
        const now = new Date();
        const [row] = await tx
          .insert(paymentRefunds)
          .values({
            tenantId: intent.tenantId,
            outletId: intent.outletId,
            paymentIntentId: intent.id,
            amountIdr: body.amountIdr,
            reason: body.reason,
            note: body.note ?? null,
            requestedBy: actor,
          })
          .returning();
        if (!row) throw new Error("Refund insert returned no row");
        await refundAudit(tx, context, {
          actorId: actor,
          row,
          action: "payment.refund_requested",
          now,
        });
        await appendPaymentEvent(tx, context, {
          name: "payment.refund_requested",
          aggregateId: row.id,
          outletId: row.outletId,
          actor: { type: "user", id: actor },
          payload: {
            refundId: row.id,
            paymentIntentId: row.paymentIntentId,
            amountIdr: row.amountIdr,
          },
          now,
        });
        return refundViewFor(tx, context, row, actor);
      },
    );
  });
}
export async function listRefundablePayments(
  context: ScopedTenantContext,
  actor: string,
  query: z.infer<typeof contract.listRefundablePayments.query>,
) {
  return withTenant(db, context, async (tx) => {
    await authorize(
      tx,
      context,
      actor,
      "payment.transaction.view",
      query.outletId,
    );
    const intents = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          query.outletId
            ? eq(paymentIntents.outletId, query.outletId)
            : undefined,
          inArray(paymentIntents.status, ["paid", "partially_refunded"]),
        ),
      )
      .orderBy(desc(paymentIntents.paidAt));
    const payments = [];
    for (const intent of intents) {
      if (!intent.paidAt) continue;
      const { cap, reserved } = await refundableBalance(tx, intent);
      if (reserved >= cap) continue;
      const { link, outlet } = await paymentInfo(tx, intent);
      payments.push(
        contract.refundablePaymentSchema.parse({
          paymentIntentId: intent.id,
          reference: link.reference,
          outletId: intent.outletId,
          outletName: outlet.name,
          method: intent.method,
          paidAmountIdr: Number(cap),
          refundedAmountIdr: Number(reserved),
          refundableAmountIdr: Number(cap - reserved),
          paidAt: intent.paidAt.toISOString(),
        }),
      );
    }
    return { payments };
  });
}
export async function listRefunds(
  context: ScopedTenantContext,
  actor: string,
  query: z.infer<typeof contract.listRefunds.query>,
) {
  return withTenant(db, context, async (tx) => {
    await authorize(
      tx,
      context,
      actor,
      "payment.transaction.view",
      query.outletId,
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      if (typeof at !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      cursor = sql`(${paymentRefunds.createdAt}, ${paymentRefunds.id}) < (${at}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          query.outletId
            ? eq(paymentRefunds.outletId, query.outletId)
            : undefined,
          query.status ? eq(paymentRefunds.status, query.status) : undefined,
          cursor,
        ),
      )
      .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const data = [];
    for (const row of page)
      data.push(await refundViewFor(tx, context, row, actor));
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
/** Runs the approval matrix, then the provider payout (see payment-refund.service.ts). */
export async function approveRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.ApproveRefundInput,
  key: string,
  opts: { mfaVerified: boolean } = { mfaVerified: false },
) {
  return approveRefundWithPayout(context, actor, params, input, key, opts);
}
