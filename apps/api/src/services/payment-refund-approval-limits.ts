// Founder Q63: refund authority is an amount ceiling for the entire bill,
// independent of the tenant's approval matrix and of the provider payout cap.
import {
  ulidToUuid,
  uuidSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { sql } from "drizzle-orm";
import type { paymentRefunds } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { loadDeferredRefundCommitments } from "./payment-refund-edge-history.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

type Refund = typeof paymentRefunds.$inferSelect;

/** A native POS refund is checked before its append-only row is written. */
export type NativeRefundApproval = {
  readonly tenantId: string;
  readonly outletId: string;
  readonly orderId: string;
  readonly amountIdr: number;
};

type RefundApprovalSubject = Refund | NativeRefundApproval;

/**
 * Every durable way the intents of `scope_intents` identify the bill they
 * paid, as typed (kind, ref) keys. Resolved from the intent rows first, so each
 * lookup is a point read on an indexed column instead of a scan of all tenant
 * intents. A native POS refund also keeps its own order as a key.
 */
function scopeIntentKeys(
  tenantId: string,
  nativeSeed = false,
  includeDeposit = true,
) {
  return sql`intent_keys AS (
    SELECT 'link'::text AS kind, p.payment_link_id AS ref
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'order'::text, p.order_id
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
       AND p.order_id IS NOT NULL
    UNION
    SELECT 'order'::text, s.order_id
      FROM payment_intents p JOIN bill_splits s
        ON s.tenant_id = p.tenant_id AND s.id = p.bill_split_id
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'order'::text, o.id
      FROM payment_intents p JOIN orders o
        ON o.tenant_id = p.tenant_id AND o.payment_link_id = p.payment_link_id
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'order'::text, o.id
      FROM payment_intents p JOIN orders o
        ON o.tenant_id = p.tenant_id AND o.payment_intent_id = p.id
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'order'::text, t.order_id
      FROM payment_intents p JOIN pos_order_tenders t
        ON t.tenant_id = p.tenant_id AND t.payment_link_id = p.payment_link_id
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'order'::text, t.order_id
      FROM payment_intents p JOIN pos_order_tenders t
        ON t.tenant_id = p.tenant_id AND t.payment_intent_id = p.id
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
    UNION
    SELECT 'reservation'::text, p.reservation_id
      FROM payment_intents p
     WHERE p.tenant_id = ${tenantId} AND p.id IN (SELECT id FROM scope_intents)
       AND p.reservation_id IS NOT NULL
    ${
      includeDeposit
        ? sql`UNION
    SELECT 'order'::text, d.order_id FROM pos_deposit_refunds d
     WHERE d.tenant_id = ${tenantId}
       AND d.payment_intent_id IN (SELECT id FROM scope_intents)`
        : sql``
    }
    ${nativeSeed ? sql`UNION SELECT kind, ref FROM native_seed` : sql``}
  )`;
}

/** The (kind, ref) keys of ONE payment intent. */
function intentKeys(tenantId: string, paymentIntentId: string) {
  return sql`scope_intents AS (
    SELECT ${paymentIntentId}::uuid AS id
  ), ${scopeIntentKeys(tenantId)}`;
}

/**
 * The intents that share a key with the resolved keys: every intent of the
 * same link, order, split, tender or reservation, found through indexed
 * columns of the keys already resolved above.
 */
function relatedBranches(
  tenantId: string,
  keys: "intent_keys" | "native_seed",
  includeDeposit = true,
) {
  const k = sql.raw(keys);
  return sql`SELECT q.id AS intent_id FROM ${k} k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.payment_link_id = k.ref
     WHERE k.kind = 'link'
    UNION
    SELECT q.id FROM ${k} k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.order_id = k.ref
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k
      JOIN bill_splits s ON s.tenant_id = ${tenantId} AND s.order_id = k.ref
      JOIN payment_intents q ON q.tenant_id = s.tenant_id AND q.bill_split_id = s.id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k
      JOIN orders o ON o.tenant_id = ${tenantId} AND o.id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = o.tenant_id AND q.payment_link_id = o.payment_link_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k
      JOIN orders o ON o.tenant_id = ${tenantId} AND o.id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = o.tenant_id AND q.id = o.payment_intent_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k
      JOIN pos_order_tenders t
        ON t.tenant_id = ${tenantId} AND t.order_id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = t.tenant_id AND q.payment_link_id = t.payment_link_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k
      JOIN pos_order_tenders t
        ON t.tenant_id = ${tenantId} AND t.order_id = k.ref
      JOIN payment_intents q
        ON q.tenant_id = t.tenant_id AND q.id = t.payment_intent_id
     WHERE k.kind = 'order'
    UNION
    SELECT q.id FROM ${k} k JOIN payment_intents q
        ON q.tenant_id = ${tenantId} AND q.reservation_id = k.ref
     WHERE k.kind = 'reservation'
    ${
      includeDeposit
        ? sql`UNION
    SELECT d.payment_intent_id FROM ${k} k
      JOIN pos_deposit_refunds d ON d.tenant_id = ${tenantId} AND d.order_id = k.ref
     WHERE k.kind = 'order'`
        : sql``
    }`;
}

/** The intent itself plus every intent that shares a key with it. */
function relatedIntents(tenantId: string, paymentIntentId: string) {
  return sql`${intentKeys(tenantId, paymentIntentId)}, related AS (
    SELECT id AS intent_id FROM scope_intents
    UNION
    ${relatedBranches(tenantId, "intent_keys")}
  )`;
}

/**
 * Scope of a native POS refund that has no row (and no payment intent) yet:
 * the intents of its order, widened to every bill key those intents reach.
 * Only the intents of the order itself are "related"; the wider keys decide
 * which native refunds, voided cash and edge facts count.
 */
function nativeRefundScope(
  tenantId: string,
  orderUuid: string,
  includeDeposit = true,
) {
  return sql`native_seed AS (
    SELECT 'order'::text AS kind, ${orderUuid}::uuid AS ref
  ), native_related AS (
    ${relatedBranches(tenantId, "native_seed", includeDeposit)}
  ), scope_intents AS (
    SELECT intent_id AS id FROM native_related
  ), ${scopeIntentKeys(tenantId, true, includeDeposit)}, related AS (
    SELECT intent_id FROM native_related
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

/**
 * legend-ykk88: the fact time of a money fact of one bill, read AFTER the bill
 * lock. Never earlier than the caller's clock, the database clock now, or one
 * millisecond past the latest fact already committed on the bill (refund
 * decisions and completions, approved chain decisions, native POS refunds and
 * cloud voids), so facts follow commit order whatever clock was read before
 * waiting for the lock. Truncated to the millisecond a JS Date keeps.
 */
async function billFactTime(
  tx: Tx,
  refund: RefundApprovalSubject,
  now: Date,
  useDbClock: boolean,
): Promise<Date> {
  const { rows } = await tx.execute<{ at_ms: string }>(sql`
    WITH ${refundScope(refund)}, facts AS (
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
      UNION ALL
      SELECT v.voided_at FROM pos_order_voids v
       WHERE v.tenant_id = ${refund.tenantId}
         AND v.order_id IN (SELECT ref FROM intent_keys WHERE kind = 'order')
    )
    SELECT floor(extract(epoch FROM greatest(
      ${now}::timestamptz,
      ${useDbClock ? sql`clock_timestamp()` : sql`${now}::timestamptz`},
      (SELECT max(at) + interval '1 millisecond' FROM facts)
    )) * 1000)::bigint::text AS at_ms
  `);
  return new Date(Number(rows[0]!.at_ms));
}

/** A bill's approval facts follow commit order, even across separate intents. */
export function refundApprovalDecisionTime(
  tx: Tx,
  refund: Refund,
  now: Date,
): Promise<Date> {
  return billFactTime(tx, refund, now, true);
}

/**
 * legend-ykk88: decision time of a chain approval of a payment refund, taken
 * after the bill lock. Later than every fact already committed on the bill but
 * without the database clock, so it stays comparable with the application
 * clock the rest of the request reads.
 */
export function refundChainDecisionTime(
  tx: Tx,
  refund: Refund,
  now: Date,
): Promise<Date> {
  return billFactTime(tx, refund, now, false);
}

/**
 * legend-ykk88: fact time of a native POS refund or void of `orderId`, to be
 * taken after the order lock so it is monotonic against every fact of the bill.
 */
export function monotonicFactTime(
  tx: Tx,
  bill: Omit<NativeRefundApproval, "amountIdr">,
  now: Date,
): Promise<Date> {
  // No database clock here: the caller's clock must stay comparable with the
  // application clock used elsewhere on the request (approval created_at).
  return billFactTime(tx, { ...bill, amountIdr: 0 }, now, false);
}

function nativeOrderUuid(refund: NativeRefundApproval): string {
  return refund.orderId.length === 26
    ? ulidToUuid(refund.orderId)
    : ulidToUuid(uuidToUlid(refund.orderId));
}

/**
 * Money that is not a refund of the bill's own tenders: an overpayment refund
 * (it pays out an unallocated fund) and a late-payment refund (it returns a
 * payment that arrived after the bill was settled or closed). Neither reduces
 * what this bill's tenders hold, so a native POS refund does not count them
 * against the bill. LATE_PAYMENT_REFUND_KEY_PREFIXES mirrors
 * payment-refund.service.ts (import cycle).
 */
const LATE_PAYMENT_REFUND_KEY_PREFIXES = [
  "pos-late-payment-refund:",
  "qr-late-payment-refund:",
];

function notBillTenderRefund(tenantId: string) {
  return sql`r.unallocated_fund_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM payment_admin_idempotency late
     WHERE late.tenant_id = ${tenantId}
       AND late.response->>'refundId' = r.id::text
       AND (${sql.join(
         LATE_PAYMENT_REFUND_KEY_PREFIXES.map(
           (prefix) =>
             sql`late.key = ${prefix}::text || r.payment_intent_id::text
              OR late.key LIKE ${prefix}::text || r.payment_intent_id::text || ':%'`,
         ),
         sql` OR `,
       )})
    )`;
}

/** Bill keys and related intents of the persisted intent or native order. */
function refundScope(refund: RefundApprovalSubject, includeDeposit = true) {
  return "paymentIntentId" in refund
    ? relatedIntents(refund.tenantId, refund.paymentIntentId)
    : nativeRefundScope(
        refund.tenantId,
        nativeOrderUuid(refund),
        includeDeposit,
      );
}

/**
 * Count commitments once per refund, including a fully approved chain whose
 * settlement event has not yet changed the refund from pending to approved.
 * Other pending requests have no approval yet; they cannot consume authority
 * before the first valid decision. Native POS refunds count their full value
 * once; their gateway payout mirrors do not add a second refund. A final
 * provider decline releases a standalone payment refund's commitment. Durable
 * edge refund facts also count until materialized, deduplicated by refund ID;
 * conflicting native and edge facts fail closed. The
 * current POS source always counts, even if legacy fact clocks put its
 * refunded_at after the recorded gateway approval.
 */
export async function refundCommittedAmount(
  tx: Tx,
  refund: RefundApprovalSubject,
  options: {
    readonly approvedBefore?: Date;
    readonly includePendingReservations?: boolean;
    /**
     * Only the "<= paid" cap leaves overpayment and late-payment refunds out
     * (they pay no tender of this bill). The approver ceiling counts them.
     */
    readonly paidCapScope?: boolean;
  } = {},
): Promise<bigint> {
  const { approvedBefore } = options;
  const paymentRefund = "paymentIntentId" in refund ? refund : null;
  const scope = await tx.execute<{ group_key: string }>(sql`
    WITH ${refundScope(refund, !options.paidCapScope)}
    SELECT DISTINCT 'order:' || ref::text AS group_key
      FROM intent_keys WHERE kind = 'order'
  `);
  const retainRefundIds: string[] = [];
  // Historical payout validation must retain the current gateway mirror's
  // entire native source, even when its legacy edge clock is later than the
  // recorded approval. Only the server's durable idempotency mapping may
  // establish this relationship; submitted event timestamps cannot remove it.
  if (
    approvedBefore !== undefined &&
    paymentRefund?.requestedBy === "system:pos"
  ) {
    const sources = await tx.execute<{ source_id: string }>(sql`
      SELECT split_part(key, ':', 2) AS source_id
        FROM payment_admin_idempotency
       WHERE tenant_id = ${refund.tenantId}
         AND key = 'pos-refund-gateway:' || split_part(key, ':', 2)
           || ':' || ${paymentRefund.paymentIntentId}
         AND response->>'refundId' = ${paymentRefund.id}
    `);
    for (const source of sources.rows) {
      const parsed = uuidSchema.safeParse(source.source_id);
      if (!parsed.success)
        throw new HttpError(
          409,
          "REFUND_HISTORY_UNVERIFIED",
          "Riwayat sumber refund tidak dapat diverifikasi.",
        );
      retainRefundIds.push(parsed.data.toLowerCase());
    }
  }
  const deferred = await loadDeferredRefundCommitments(tx, {
    tenantId: refund.tenantId,
    outletId: refund.outletId,
    orderIds: scope.rows.map(({ group_key }) => group_key.slice(6)),
    ...(approvedBefore === undefined ? {} : { approvedBefore }),
    retainRefundIds,
  });
  const deferredJson = JSON.stringify(deferred);
  const { rows } = await tx.execute<{
    total: string;
    history_conflict: boolean;
  }>(sql`
    WITH ${refundScope(refund, !options.paidCapScope)}, native_refunds AS (
      SELECT n.* FROM pos_order_refunds n
       WHERE n.tenant_id = ${refund.tenantId}
         AND n.order_id IN (SELECT ref FROM intent_keys WHERE kind = 'order')
         ${
           approvedBefore === undefined || paymentRefund === null
             ? sql``
             : sql`AND (
           n.refunded_at <= ${approvedBefore}
           OR (${paymentRefund.requestedBy} = 'system:pos' AND EXISTS (
             SELECT 1 FROM payment_admin_idempotency source
              WHERE source.tenant_id = n.tenant_id
                AND source.key = 'pos-refund-gateway:' || n.id::text || ':' || ${paymentRefund.paymentIntentId}
                AND source.response->>'refundId' = ${paymentRefund.id}
           ))
         )`
         }
    ), deferred_refunds AS (
      SELECT fact."refundId"::uuid AS id, fact."orderId"::uuid AS order_id,
             fact."amountIdr" AS amount_idr
        FROM jsonb_to_recordset(${deferredJson}::jsonb)
          AS fact("refundId" text, "orderId" text, "amountIdr" bigint)
    ), pos_refunds AS (
      SELECT facts.id, max(facts.amount_idr) + ${
        options.paidCapScope
          ? sql`0`
          : sql`coalesce((
        SELECT sum(d.amount_idr) FROM pos_deposit_refunds d
         WHERE d.tenant_id = ${refund.tenantId} AND d.pos_refund_id = facts.id
      ), 0)`
      } AS amount_idr
        FROM (
          SELECT id, amount_idr FROM native_refunds
          UNION ALL
          SELECT id, amount_idr FROM deferred_refunds
        ) facts GROUP BY facts.id
    ), voided_cash AS (
      -- Cash a cloud void already paid out of the drawer. The void being
      -- decided has no row yet, so it is only counted as the candidate amount.
      SELECT t.amount_idr FROM pos_order_tenders t
       WHERE t.tenant_id = ${refund.tenantId}
         AND t.method = 'cash' AND t.status = 'captured'
         AND t.order_id IN (SELECT ref FROM intent_keys WHERE kind = 'order')
         AND EXISTS (
           SELECT 1 FROM pos_order_voids v
            WHERE v.tenant_id = t.tenant_id AND v.order_id = t.order_id
              ${approvedBefore === undefined ? sql`` : sql`AND v.voided_at <= ${approvedBefore}`}
         )
    ), mirrors AS (
      SELECT r.id FROM payment_refunds r
        JOIN payment_admin_idempotency i
          ON i.tenant_id = r.tenant_id AND i.response->>'refundId' = r.id::text
        JOIN pos_refunds n
          ON i.key = 'pos-refund-gateway:' || n.id::text || ':' || r.payment_intent_id::text
       WHERE r.tenant_id = ${refund.tenantId} AND r.requested_by = 'system:pos'
    )
    SELECT (
      coalesce((SELECT sum(r.amount_idr) FROM payment_refunds r
       WHERE r.tenant_id = ${refund.tenantId}
         ${paymentRefund === null ? sql`` : sql`AND r.id <> ${paymentRefund.id}::uuid`}
         AND r.payment_intent_id IN (SELECT intent_id FROM related)
         AND r.id NOT IN (SELECT id FROM mirrors)
         ${paymentRefund === null && options.paidCapScope ? sql`AND ${notBillTenderRefund(refund.tenantId)}` : sql``}
         AND (
           r.status IN ('approved', 'completed')
           ${options.includePendingReservations ? sql`OR r.status = 'pending'` : sql``}
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
      + coalesce((SELECT sum(amount_idr) FROM pos_refunds), 0)
      + coalesce((SELECT sum(t.amount_idr) FROM voided_cash t), 0)
      + CASE WHEN EXISTS (SELECT 1 FROM mirrors WHERE id = ${paymentRefund?.id ?? null}::uuid)
          THEN 0 ELSE ${refund.amountIdr} END
    )::text AS total,
    EXISTS (
      SELECT 1 FROM deferred_refunds d
        JOIN pos_order_refunds n ON n.tenant_id = ${refund.tenantId} AND n.id = d.id
       WHERE n.order_id <> d.order_id OR n.amount_idr <> d.amount_idr
    ) AS history_conflict
  `);
  if (rows[0]?.history_conflict)
    throw new HttpError(
      409,
      "REFUND_HISTORY_UNVERIFIED",
      "Riwayat refund pesanan tidak konsisten; lakukan rekonsiliasi sebelum refund berikutnya.",
    );
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
  refund: RefundApprovalSubject,
  at: Date,
  options: {
    readonly approvedBefore?: Date;
    readonly historical?: boolean;
  } = {},
): Promise<boolean> {
  // Historical payout revalidation evaluates as of the recorded decision
  // (`at`), so expired roles still count: no DB-clock filtering (bead 1201).
  const data = await loadTenantAccessInTransaction(tx, context, actor, {
    includeInactive: options.historical === true,
  });
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
  return (
    (await refundCommittedAmount(tx, refund, {
      approvedBefore: options.approvedBefore,
    })) <= ceiling
  );
}

export const refundApprovalLimitRefused = () =>
  new HttpError(
    403,
    "REFUND_APPROVAL_LIMIT_EXCEEDED",
    "Total refund pesanan melebihi batas kewenangan penyetuju.",
  );
