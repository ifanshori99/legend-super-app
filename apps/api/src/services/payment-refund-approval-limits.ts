// Founder Q63: refund authority is an amount ceiling for the entire bill,
// independent of the tenant's approval matrix and of the provider payout cap.
import type { ScopedTenantContext } from "@starter/shared/core";
import { sql } from "drizzle-orm";
import type { paymentRefunds } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

type Refund = typeof paymentRefunds.$inferSelect;

/**
 * Every durable way ONE payment intent identifies the bill it paid, as typed
 * (kind, ref) keys. Resolved from the intent row first, so each lookup is a
 * point read on an indexed column instead of a scan of all tenant intents.
 */
function intentKeys(tenantId: string, paymentIntentId: string) {
  return sql`intent_keys AS (
    SELECT 'link'::text AS kind, p.payment_link_id AS ref
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'order'::text, p.order_id
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
       AND p.order_id IS NOT NULL
    UNION
    SELECT 'order'::text, s.order_id
      FROM payment_intents p JOIN bill_splits s
        ON s.tenant_id = p.tenant_id AND s.id = p.bill_split_id
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'order'::text, o.id
      FROM payment_intents p JOIN orders o
        ON o.tenant_id = p.tenant_id AND o.payment_link_id = p.payment_link_id
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'order'::text, o.id
      FROM payment_intents p JOIN orders o
        ON o.tenant_id = p.tenant_id AND o.payment_intent_id = p.id
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'order'::text, t.order_id
      FROM payment_intents p JOIN pos_order_tenders t
        ON t.tenant_id = p.tenant_id AND t.payment_link_id = p.payment_link_id
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'order'::text, t.order_id
      FROM payment_intents p JOIN pos_order_tenders t
        ON t.tenant_id = p.tenant_id AND t.payment_intent_id = p.id
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
    UNION
    SELECT 'reservation'::text, p.reservation_id
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentIntentId}::uuid
       AND p.reservation_id IS NOT NULL
  )`;
}

/**
 * The intents that share a key with the one intent: the intent itself plus
 * every other intent of the same link, order, split, tender or reservation,
 * found through indexed columns of the keys already resolved above.
 */
function relatedIntents(tenantId: string, paymentIntentId: string) {
  return sql`${intentKeys(tenantId, paymentIntentId)}, related AS (
    SELECT ${paymentIntentId}::uuid AS intent_id
    UNION
    SELECT q.id FROM intent_keys k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.payment_link_id = k.ref
     WHERE k.kind = 'link'
    UNION
    SELECT q.id FROM intent_keys k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.order_id = k.ref
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k
      JOIN bill_splits s ON s.tenant_id = ${tenantId} AND s.order_id = k.ref
      JOIN payment_intents q ON q.tenant_id = s.tenant_id AND q.bill_split_id = s.id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k
      JOIN orders o ON o.tenant_id = ${tenantId} AND o.id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = o.tenant_id AND q.payment_link_id = o.payment_link_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k
      JOIN orders o ON o.tenant_id = ${tenantId} AND o.id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = o.tenant_id AND q.id = o.payment_intent_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k
      JOIN pos_order_tenders t
        ON t.tenant_id = ${tenantId} AND t.order_id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = t.tenant_id AND q.payment_link_id = t.payment_link_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k
      JOIN pos_order_tenders t
        ON t.tenant_id = ${tenantId} AND t.order_id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = t.tenant_id AND q.id = t.payment_intent_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM intent_keys k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.reservation_id = k.ref
     WHERE k.kind = 'reservation'
  )`;
}

/** Group locks precede intent, fund, refund and approval-chain row locks. */
export async function lockRefundApprovalScope(
  tx: Tx,
  tenantId: string,
  paymentIntentId: string,
): Promise<void> {
  const { rows } = await tx.execute<{ group_key: string }>(sql`
    WITH ${intentKeys(tenantId, paymentIntentId)}
    SELECT DISTINCT kind || ':' || ref::text AS group_key FROM intent_keys
     ORDER BY group_key
  `);
  for (const { group_key: group } of rows)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`refund-authority:${tenantId}:${group}`}, 0))`,
    );
  // POS cash/EDC writers lock this same row before recording their refund.
  // Taking it before any intent or chain row serializes their commitment
  // with the payment-admin amount check without reversing the POS lock order.
  for (const { group_key: group } of rows)
    if (group.startsWith("order:"))
      await tx.execute(sql`
        SELECT order_id FROM pos_orders
         WHERE tenant_id = ${tenantId} AND order_id = ${group.slice(6)}::uuid
         FOR UPDATE
      `);
}

/** A bill's approval facts follow commit order, even across separate intents. */
export async function refundApprovalDecisionTime(
  tx: Tx,
  refund: Refund,
  now: Date,
): Promise<Date> {
  const { rows } = await tx.execute<{ at_ms: string }>(sql`
    WITH ${relatedIntents(refund.tenantId, refund.paymentIntentId)}, facts AS (
      SELECT r.decided_at AS at FROM payment_refunds r
       WHERE r.tenant_id = ${refund.tenantId}
         AND r.payment_intent_id IN (SELECT intent_id FROM related)
         AND r.decided_at IS NOT NULL
      UNION ALL
      SELECT r.completed_at FROM payment_refunds r
       WHERE r.tenant_id = ${refund.tenantId}
         AND r.payment_intent_id IN (SELECT intent_id FROM related)
         AND r.completed_at IS NOT NULL
      UNION ALL
      SELECT a.decided_at FROM approval_requests a
        JOIN payment_refunds r ON r.tenant_id = a.tenant_id
          AND r.approval_chain_id = a.chain_id AND a.object_id = r.id::text
       WHERE r.tenant_id = ${refund.tenantId}
         AND r.payment_intent_id IN (SELECT intent_id FROM related)
         AND a.source_module = 'payment' AND a.object_type = 'payment_refund'
         AND a.status = 'approved' AND a.decided_at IS NOT NULL
      UNION ALL
      SELECT n.refunded_at FROM pos_order_refunds n
       WHERE n.tenant_id = ${refund.tenantId}
         AND n.order_id IN (SELECT ref FROM intent_keys WHERE kind = 'order')
    )
    SELECT floor(extract(epoch FROM greatest(
      ${now}::timestamptz,
      clock_timestamp(),
      (SELECT max(at) + interval '1 millisecond' FROM facts)
    )) * 1000)::bigint::text AS at_ms
  `);
  return new Date(Number(rows[0]!.at_ms));
}

/**
 * Count commitments once per refund, including a fully approved chain whose
 * settlement event has not yet changed the refund from pending to approved.
 * Other pending requests have no approval yet; they cannot consume authority
 * before the first valid decision. Native POS refunds count their full value
 * once; their gateway payout mirrors do not add a second refund. A final
 * provider decline releases a standalone payment refund's commitment. The
 * current POS source always counts, even if legacy fact clocks put its
 * refunded_at after the recorded gateway approval.
 */
async function committedAmount(
  tx: Tx,
  refund: Refund,
  approvedBefore?: Date,
): Promise<bigint> {
  const { rows } = await tx.execute<{ total: string }>(sql`
    WITH ${relatedIntents(refund.tenantId, refund.paymentIntentId)}, native_refunds AS (
      SELECT n.* FROM pos_order_refunds n
       WHERE n.tenant_id = ${refund.tenantId}
         AND n.order_id IN (SELECT ref FROM intent_keys WHERE kind = 'order')
         ${
           approvedBefore === undefined
             ? sql``
             : sql`AND (
           n.refunded_at <= ${approvedBefore}
           OR (${refund.requestedBy} = 'system:pos' AND EXISTS (
             SELECT 1 FROM payment_admin_idempotency source
              WHERE source.tenant_id = n.tenant_id
                AND source.key = 'pos-refund-gateway:' || n.id::text || ':' || ${refund.paymentIntentId}
                AND source.response->>'refundId' = ${refund.id}
           ))
         )`
         }
    ), mirrors AS (
      SELECT r.id FROM payment_refunds r
        JOIN payment_admin_idempotency i
          ON i.tenant_id = r.tenant_id AND i.response->>'refundId' = r.id::text
        JOIN native_refunds n
          ON i.key = 'pos-refund-gateway:' || n.id::text || ':' || r.payment_intent_id::text
       WHERE r.tenant_id = ${refund.tenantId} AND r.requested_by = 'system:pos'
    )
    SELECT (
      coalesce((SELECT sum(r.amount_idr) FROM payment_refunds r
       WHERE r.tenant_id = ${refund.tenantId} AND r.id <> ${refund.id}::uuid
         AND r.payment_intent_id IN (SELECT intent_id FROM related)
         AND r.id NOT IN (SELECT id FROM mirrors)
         AND (
           r.status IN ('approved', 'completed')
           OR (r.status = 'pending' AND EXISTS (
             SELECT 1 FROM approval_requests a
              WHERE a.tenant_id = r.tenant_id AND a.chain_id = r.approval_chain_id
                AND a.status = 'approved' AND a.level = a.required_levels
                AND a.source_module = 'payment' AND a.object_type = 'payment_refund'
                AND a.object_id = r.id::text AND a.amount_idr = r.amount_idr
           ))
         )
         ${approvedBefore === undefined ? sql`` : sql`AND coalesce(r.decided_at, (SELECT max(a.decided_at) FROM approval_requests a WHERE a.tenant_id = r.tenant_id AND a.chain_id = r.approval_chain_id AND a.status = 'approved'), r.created_at) <= ${approvedBefore}`}
      ), 0)
      + coalesce((SELECT sum(amount_idr) FROM native_refunds), 0)
      + CASE WHEN EXISTS (SELECT 1 FROM mirrors WHERE id = ${refund.id}::uuid)
          THEN 0 ELSE ${refund.amountIdr} END
    )::text AS total
  `);
  return BigInt(rows[0]?.total ?? "0");
}

/**
 * Named authority must itself reach this outlet and hold refund approval.
 * Custom/finance-only roles cannot acquire an unbounded ceiling. For payout
 * revalidation, grants made after the recorded decision do not count, and
 * later higher-authority refunds do not invalidate an earlier valid approval.
 */
export async function refundApprovalWithinLimit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  refund: Refund,
  at: Date,
  options: {
    readonly approvedBefore?: Date;
    readonly historical?: boolean;
  } = {},
): Promise<boolean> {
  const data = await loadTenantAccessInTransaction(tx, context, actor);
  const access = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actor,
    ...data,
    assignments: options.historical
      ? data.assignments.filter(
          (assignment) => Date.parse(assignment.assignedAt) <= at.getTime(),
        )
      : data.assignments,
    mfaVerified: false,
    now: at,
  });
  const target = { type: "outlet", id: refund.outletId } as const;
  const holds = (template: string) =>
    access.allowsVia(template, "pos.refund.approve", target);
  if (holds("owner")) return true;
  const ceiling = holds("general_manager")
    ? 5_000_000n
    : holds("outlet_manager")
      ? 1_000_000n
      : holds("supervisor")
        ? 200_000n
        : 0n;
  if (BigInt(refund.amountIdr) > ceiling) return false;
  return (await committedAmount(tx, refund, options.approvedBefore)) <= ceiling;
}

export const refundApprovalLimitRefused = () =>
  new HttpError(
    403,
    "REFUND_APPROVAL_LIMIT_EXCEEDED",
    "Total refund pesanan melebihi batas kewenangan penyetuju.",
  );
