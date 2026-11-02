// PAY-04: unallocated money is held until an approved refund or credit exists.
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  isoDateTimeSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  listUnallocatedFunds as endpoint,
  resolveUnallocatedFund as resolveEndpoint,
  unallocatedFundViewSchema,
} from "@starter/shared/payment/admin";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { paymentRefunds, paymentUnallocatedFunds } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  appendPaymentEvent,
  assertPaymentPermission,
} from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

type Query = ReturnType<typeof endpoint.query.parse>;
type Params = ReturnType<typeof resolveEndpoint.params.parse>;
type Input = ReturnType<typeof resolveEndpoint.body.parse>;

// Evidence is authoritative. The contract can represent only a single excess
// against a bill; ambiguous evidence is refused rather than fabricating totals.
async function view(tx: Tx, context: ScopedTenantContext, id: string) {
  const result = await tx.execute(sql`
    SELECT f.*, i.method, l.reference, l.total_idr AS bill_total_idr,
      o.name AS outlet_name, u.name AS resolved_by_name,
      (SELECT coalesce(sum(e.amount_idr), 0)::text FROM payment_evidence e
       JOIN payment_intents ei ON ei.tenant_id = e.tenant_id AND ei.id = e.payment_intent_id
       WHERE ei.tenant_id = f.tenant_id AND ei.payment_link_id = l.id) AS paid_amount
    FROM payment_unallocated_funds f
    JOIN payment_intents i ON i.tenant_id = f.tenant_id AND i.id = f.payment_intent_id
    JOIN payment_links l ON l.tenant_id = i.tenant_id AND l.id = i.payment_link_id
    JOIN outlets o ON o.tenant_id = f.tenant_id AND o.id = f.outlet_id
    LEFT JOIN "user" u ON u.id = f.resolved_by
    WHERE f.tenant_id = ${context.tenant.tenantId} AND f.id = ${id}::uuid
  `);
  const r = result.rows[0];
  if (!r) throw new HttpError(404, "NOT_FOUND", "Unallocated funds not found.");
  const parsed = unallocatedFundViewSchema.safeParse({
    id: r.id,
    tenantId: r.tenant_id,
    outletId: r.outlet_id,
    paymentIntentId: r.payment_intent_id,
    amountIdr: Number(r.amount_idr),
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    paymentReference: r.reference,
    method: r.method,
    paidAmountIdr: Number(r.paid_amount),
    billTotalIdr: Number(r.bill_total_idr),
    outletName: r.outlet_name,
    status: r.resolution ? "resolved" : "open",
    detectedAt: new Date(String(r.created_at)).toISOString(),
    resolvedByName: r.resolved_by_name,
    resolvedAt: r.resolved_at
      ? new Date(String(r.resolved_at)).toISOString()
      : null,
    note: r.note,
  });
  if (!parsed.success)
    throw new HttpError(
      409,
      "CONFLICT",
      "Payment evidence cannot represent this unallocated amount.",
    );
  return parsed.data;
}

export async function listUnallocatedFunds(
  context: ScopedTenantContext,
  actor: string,
  input: Query,
) {
  assertTrustedScopedContext(context);
  const query = endpoint.query.parse(input);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      query.outletId
        ? { type: "outlet", id: query.outletId }
        : { type: "tenant" },
      new Date(),
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      const [created, id] = decodeCursor(query.cursor);
      if (typeof created !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      cursor = sql`(${paymentUnallocatedFunds.createdAt}, ${paymentUnallocatedFunds.id}) < (${created}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          query.outletId
            ? eq(paymentUnallocatedFunds.outletId, query.outletId)
            : sql`TRUE`,
          query.status === "open"
            ? sql`${paymentUnallocatedFunds.resolution} IS NULL`
            : query.status === "resolved"
              ? sql`${paymentUnallocatedFunds.resolution} IS NOT NULL`
              : sql`TRUE`,
          cursor,
        ),
      )
      .orderBy(
        sql`${paymentUnallocatedFunds.createdAt} DESC`,
        sql`${paymentUnallocatedFunds.id} DESC`,
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const data = [];
    for (const row of page) data.push(await view(tx, context, row.id));
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

export async function resolveUnallocatedFund(
  context: ScopedTenantContext,
  actor: string,
  params: Params,
  input: Input,
  key: string,
) {
  assertTrustedScopedContext(context);
  const { fundId } = resolveEndpoint.params.parse(params);
  const request = resolveEndpoint.body.parse(input);
  return withTenant(db, context, async (tx) => {
    const [fund] = await tx
      .select()
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          eq(paymentUnallocatedFunds.id, fundId),
        ),
      )
      .for("update");
    if (!fund)
      throw new HttpError(404, "NOT_FOUND", "Unallocated funds not found.");
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      { type: "outlet", id: fund.outletId },
      new Date(),
    );
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      "resolve-unallocated",
      { fundId, ...request },
      async () => {
        if (fund.resolution)
          throw new HttpError(409, "CONFLICT", "Funds already resolved.");
        // Credit has no approved ledger adapter; do not represent it as completed.
        if (request.resolution === "credit")
          throw new HttpError(
            503,
            "SERVICE_UNAVAILABLE",
            "Credit approval is not available.",
          );
        const existing = await tx
          .select()
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.tenantId, context.tenant.tenantId),
              eq(paymentRefunds.unallocatedFundId, fund.id),
              sql`${paymentRefunds.status} <> 'failed'`,
            ),
          );
        if (existing.length)
          throw new HttpError(
            409,
            "CONFLICT",
            "A refund is already pending for these funds.",
          );
        // The excess is capped by this fund row (locked above, at most one
        // live refund per fund). It never consumes the bill's refundable
        // amount: the guest paid it on top of the intent (PAY-04).
        const now = new Date();
        const [refund] = await tx
          .insert(paymentRefunds)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: fund.outletId,
            paymentIntentId: fund.paymentIntentId,
            unallocatedFundId: fund.id,
            amountIdr: fund.amountIdr,
            reason: "Unallocated funds",
            note: request.note,
            requestedBy: actor,
            status: "pending",
          })
          .returning();
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId: context.tenant.tenantId,
            outletId: fund.outletId,
            actorType: "user",
            actorId: actor,
            deviceId: null,
            action: "payment.unallocated_refund_requested",
            objectType: "payment_refund",
            objectId: refund!.id,
            reason: request.note,
            maskedChanges: {
              before: null,
              after: { amountIdr: fund.amountIdr, status: "pending" },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: isoDateTimeSchema.parse(now.toISOString()),
          },
          ["amountIdr", "status"],
        );
        if (!refund) throw new Error("Refund insert returned no row");
        await appendPaymentEvent(tx, context, {
          name: "payment.refund_requested",
          aggregateId: refund.id,
          outletId: fund.outletId,
          actor: { type: "user", id: actor },
          payload: {
            refundId: refund.id,
            paymentIntentId: fund.paymentIntentId,
            amountIdr: fund.amountIdr,
            unallocatedFundId: fund.id,
          },
          now,
        });
        return view(tx, context, fund.id);
      },
    );
  });
}
