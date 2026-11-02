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
import {
  appendPaymentEvent,
  assertPaymentPermission,
} from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

const missing = () =>
  new HttpError(404, "NOT_FOUND", "Payment or refund not found.");
const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

type Intent = typeof paymentIntents.$inferSelect;
type Refund = typeof paymentRefunds.$inferSelect;
// Evidence and fund rows are written under the intent lock by settlement.
// Compute in PostgreSQL numeric and bigint to avoid rounding aggregate sums.
async function refundableBalance(tx: Tx, intent: Intent) {
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
async function refundView(tx: Tx, refund: Refund) {
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
      refund.requestedBy,
    // The approval inbox/provider is not wired yet; never advertise an unsafe approval.
    viewerCanApprove: false,
    approvedByName: refund.approvedBy
      ? (names.find((n) => n.id === refund.approvedBy)?.name ??
        refund.approvedBy)
      : null,
    note: refund.note,
    createdAt: refund.createdAt.toISOString(),
    decidedAt: refund.decidedAt?.toISOString() ?? null,
  });
}
async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actorId: string,
  row: Refund,
  now: Date,
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: row.outletId,
      actorType: "user",
      actorId,
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
      createdAt: now.toISOString(),
    },
    ["amountIdr", "status"],
  );
}
async function authorize(
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
        await audit(tx, context, actor, row, now);
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
        return refundView(tx, row);
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
    for (const row of page) data.push(await refundView(tx, row));
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
export async function approveRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.ApproveRefundInput,
  key: string,
) {
  void input;
  void key;
  return withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, params.refundId),
        ),
      )
      .for("update");
    if (!refund) throw missing();
    await authorize(tx, context, actor, "payment.reconcile", refund.outletId);
    if (refund.requestedBy === actor)
      throw new AccessError("APPROVER_IS_REQUESTER");
    // Fail closed until the multi-level approval and actual refund provider are wired.
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Refund approval is not configured.",
    );
  });
}
