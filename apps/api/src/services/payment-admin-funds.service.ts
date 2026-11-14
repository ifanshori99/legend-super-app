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
import {
  paymentIntents,
  paymentLinks,
  paymentRefunds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { openRefundChainAtRequest } from "./payment-refund.service.ts";
import {
  appendPaymentEvent,
  assertPaymentPermission,
} from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

type Query = ReturnType<typeof endpoint.query.parse>;
type Params = ReturnType<typeof resolveEndpoint.params.parse>;
type Input = ReturnType<typeof resolveEndpoint.body.parse>;

// Evidence is authoritative. A bill (payment link) may carry several
// unallocated funds, one per provider evidence (legend-knev). Each fund is
// resolved for its own amount; together the bill's funds must account for
// exactly the money that arrived but was not applied to the bill (evidence
// received − paid_idr). That holds for overpaid, double-paid, underpaid and
// split bills alike. Anything else is ambiguous evidence and is refused (409)
// rather than fabricating totals.
type BillFundsState = {
  linkId: string;
  excessIdr: number;
  fundsTotalIdr: number;
  liveRefundsIdr: number;
};

async function billFundsState(
  tx: Tx,
  context: ScopedTenantContext,
  paymentIntentId: string,
): Promise<BillFundsState | null> {
  const result = await tx.execute(sql`
    SELECT l.id AS link_id,
      (SELECT coalesce(sum(e.amount_idr), 0) FROM payment_evidence e
       JOIN payment_intents ei ON ei.tenant_id = e.tenant_id AND ei.id = e.payment_intent_id
       WHERE ei.tenant_id = l.tenant_id AND ei.payment_link_id = l.id)
        - l.paid_idr AS excess,
      (SELECT coalesce(sum(bf.amount_idr), 0) FROM payment_unallocated_funds bf
       JOIN payment_intents bi ON bi.tenant_id = bf.tenant_id AND bi.id = bf.payment_intent_id
       WHERE bi.tenant_id = l.tenant_id AND bi.payment_link_id = l.id) AS funds_total,
      (SELECT coalesce(sum(r.amount_idr), 0) FROM payment_refunds r
       JOIN payment_unallocated_funds rf ON rf.tenant_id = r.tenant_id AND rf.id = r.unallocated_fund_id
       JOIN payment_intents ri ON ri.tenant_id = rf.tenant_id AND ri.id = rf.payment_intent_id
       WHERE ri.tenant_id = l.tenant_id AND ri.payment_link_id = l.id
         AND r.status <> 'failed') AS live_refunds
    FROM payment_intents i
    JOIN payment_links l ON l.tenant_id = i.tenant_id AND l.id = i.payment_link_id
    WHERE i.tenant_id = ${context.tenant.tenantId} AND i.id = ${paymentIntentId}::uuid
  `);
  const r = result.rows[0];
  if (!r) return null;
  return {
    linkId: String(r.link_id),
    excessIdr: Number(r.excess),
    fundsTotalIdr: Number(r.funds_total),
    liveRefundsIdr: Number(r.live_refunds),
  };
}

const ambiguous = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Payment evidence cannot represent this unallocated amount.",
  );

// `lenient` (list only): a fund whose evidence is ambiguous is returned with
// status "needs_review" instead of failing the whole list (legend-ftqf). It is
// read-only here: the resolve path stays strict and still answers 409, so a
// needs_review fund can never be refunded or credited.
async function view(
  tx: Tx,
  context: ScopedTenantContext,
  id: string,
  lenient = false,
) {
  const result = await tx.execute(sql`
    SELECT f.*, i.method, l.reference, l.total_idr AS bill_total_idr,
      o.name AS outlet_name, u.name AS resolved_by_name,
      (SELECT ev.amount_idr FROM payment_evidence ev
       WHERE ev.tenant_id = f.tenant_id AND ev.id = f.evidence_id) AS evidence_amount,
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
  // A fund never holds more than the provider transaction that brought it in.
  let needsReview =
    r.evidence_amount !== null &&
    Number(r.amount_idr) > Number(r.evidence_amount);
  const bill = await billFundsState(tx, context, String(r.payment_intent_id));
  if (!bill || bill.fundsTotalIdr !== bill.excessIdr) needsReview = true;
  if (needsReview && !lenient) throw ambiguous();
  const build = (status: "open" | "resolved" | "needs_review") =>
    unallocatedFundViewSchema.safeParse({
      id: r.id,
      tenantId: r.tenant_id,
      outletId: r.outlet_id,
      paymentIntentId: r.payment_intent_id,
      amountIdr: Number(r.amount_idr),
      reason: r.reason,
      approvalRef: r.approval_ref,
      resolution: r.resolution,
      resolvedBy: r.resolved_by,
      paymentReference: r.reference,
      method: r.method,
      paidAmountIdr: Number(r.paid_amount),
      billTotalIdr: Number(r.bill_total_idr),
      outletName: r.outlet_name,
      status,
      evidenceMismatch: needsReview,
      detectedAt: new Date(String(r.created_at)).toISOString(),
      resolvedByName: r.resolved_by_name,
      resolvedAt: r.resolved_at
        ? new Date(String(r.resolved_at)).toISOString()
        : null,
      note: r.note,
    });
  const parsed = r.resolution
    ? build("resolved")
    : build(needsReview ? "needs_review" : "open");
  if (parsed.success) return parsed.data;
  // Evidence that does not fit the view contract is flagged, not hidden.
  const flagged = lenient ? build("needs_review") : parsed;
  if (!flagged.success) throw ambiguous();
  return flagged.data;
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
    for (const row of page) data.push(await view(tx, context, row.id, true));
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
    // Lock order: bill -> payment intent -> fund -> refund. The bill lock is
    // the settlement order (bill, then intent) and serializes resolves of
    // different funds on one bill, so their combined refunds are checked
    // against the bill's excess from committed state (legend-knev).
    const [probe] = await tx
      .select({ paymentIntentId: paymentUnallocatedFunds.paymentIntentId })
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          eq(paymentUnallocatedFunds.id, fundId),
        ),
      );
    if (!probe)
      throw new HttpError(404, "NOT_FOUND", "Unallocated funds not found.");
    const [owner] = await tx
      .select({ paymentLinkId: paymentIntents.paymentLinkId })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, probe.paymentIntentId),
        ),
      );
    if (!owner)
      throw new HttpError(404, "NOT_FOUND", "Unallocated funds not found.");
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, owner.paymentLinkId),
        ),
      )
      .for("update");
    await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, probe.paymentIntentId),
        ),
      )
      .for("update");
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
        // Each fund is refunded for its own amount only (one live refund per
        // fund). It never consumes the bill's refundable amount: the guest
        // paid it on top of the intent (PAY-04). Under the bill lock, the
        // bill's funds must still equal its excess, and every live refund on
        // them plus this one must fit inside that excess.
        const bill = await billFundsState(tx, context, fund.paymentIntentId);
        if (
          !bill ||
          bill.fundsTotalIdr !== bill.excessIdr ||
          bill.liveRefundsIdr + fund.amountIdr > bill.excessIdr
        )
          throw ambiguous();
        const now = new Date();
        const [inserted] = await tx
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
        if (!inserted) throw new Error("Refund insert returned no row");
        const refund = await openRefundChainAtRequest(
          tx,
          context,
          inserted,
          now,
        );
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
            objectId: refund.id,
            reason: request.note,
            maskedChanges: {
              before: null,
              after: {
                amountIdr: fund.amountIdr,
                status: refund.status,
                approvalChainId: refund.approvalChainId,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: isoDateTimeSchema.parse(now.toISOString()),
          },
          ["amountIdr", "status", "approvalChainId"],
        );
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
