-- legend-pti5r: READ-ONLY check for recovery refunds (ORD-09, requested_by
-- 'system:recovery') that ended in a FINAL failure before the fix, so the
-- settlement the live code does now never ran for them. NOT a migration: the
-- migrator does not run this file. It writes nothing (BEGIN READ ONLY ...
-- ROLLBACK). Runbook: docs/runbooks/recovery-refund-final-failure-backfill.md.
--
-- Run with an admin connection that sees every tenant (BYPASSRLS or owner
-- role), e.g. psql "$ADMIN_DATABASE_URL" -f this-file. Without that role RLS
-- hides the rows and both queries return nothing.
--
-- A recovery refund issue is in a FINAL failure state when the issue is a
-- resolved manual_refund, it has a failed recovery refund, no refund that is
-- not failed (nothing live), and one of:
--   - a failed recovery refund with a reason other than approval_expired or
--     approver_unauthorized (rejected, provider_declined, cap_exceeded,
--     source_document, unknown or empty);
--   - 3 or more failed refunds (refile_limit);
--   - no first filing row (payment_admin_idempotency key
--     'order-recovery-refund:<issue id>'), so the refund cannot be re-filed.
--
-- Query 1: final-failure issues the live settlement missed:
--   missing_stamp    order_issues.refund_rejected_at is still null (the line
--                    cannot be reported again);
--   missing_reversal an 'order.refunded' event of the issue exists (payload
--                    refundId = issue id) but no
--                    'order_issue.refund_reversal_requested' event does (the
--                    journal is not reversed). An open bill refund has no
--                    'order.refunded': nothing to reverse, not flagged.
-- Query 2: final failures that are NOT 'rejected' (a rejected refund keeps its
--   promo payout on purpose, legend-h1dyy) on a promo order whose first filing
--   recorded a promo payout (response.promoRecordedIdr > 0) and that have no
--   promo_command_idempotency row with key
--   'order-recovery-refund:<issue id>:promo-return' (payout not given back).
-- Both list tenant_id, issue id, order id and amounts, oldest tenant first.
-- The same final-failure rule is repeated in each query on purpose: no temp
-- table, so the transaction can stay read-only.
BEGIN READ ONLY;

-- Query 1: final failure without stamp or journal reversal request.
WITH failed AS (
  SELECT
    r.tenant_id,
    r.order_issue_id AS issue_id,
    count(*) AS failed_count,
    (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_refund_id,
    (array_agg(r.amount_idr ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_amount_idr,
    (array_agg(coalesce(r.failure_reason, 'unknown') ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_reason,
    coalesce(bool_or(coalesce(r.failure_reason, 'unknown')
        NOT IN ('approval_expired', 'approver_unauthorized'))
      FILTER (WHERE r.requested_by = 'system:recovery'), false) AS has_final_reason
  FROM payment_refunds r
  WHERE r.order_issue_id IS NOT NULL
    AND r.status = 'failed'
  GROUP BY r.tenant_id, r.order_issue_id
  HAVING count(*) FILTER (WHERE r.requested_by = 'system:recovery') > 0
),
final_failure AS (
  SELECT f.*, i.order_id, i.refund_rejected_at
  FROM failed f
  JOIN order_issues i ON i.tenant_id = f.tenant_id AND i.id = f.issue_id
  WHERE i.resolution = 'manual_refund'
    AND NOT EXISTS (
      SELECT 1 FROM payment_refunds l
      WHERE l.tenant_id = f.tenant_id
        AND l.order_issue_id = f.issue_id
        AND l.status <> 'failed'
    )
    AND (
      f.has_final_reason
      OR f.failed_count >= 3
      OR NOT EXISTS (
        SELECT 1 FROM payment_admin_idempotency p
        WHERE p.tenant_id = f.tenant_id
          AND p.key = 'order-recovery-refund:' || f.issue_id::text
      )
    )
)
SELECT
  ff.tenant_id,
  ff.issue_id,
  ff.order_id,
  ff.last_refund_id,
  ff.last_amount_idr,
  ff.last_reason,
  ff.failed_count,
  (ff.refund_rejected_at IS NULL) AS missing_stamp,
  (refunded.has_event AND NOT reversal.has_event) AS missing_reversal
FROM final_failure ff
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM domain_event_outbox o
    WHERE o.tenant_id = ff.tenant_id
      AND o.aggregate_type = 'order'
      AND o.event->>'name' = 'order.refunded'
      AND o.event->'payload'->>'refundId' = ff.issue_id::text
  ) AS has_event
) refunded
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM domain_event_outbox o
    WHERE o.tenant_id = ff.tenant_id
      AND o.aggregate_type = 'order_issue'
      AND o.aggregate_id = ff.issue_id
      AND o.event->>'name' = 'order_issue.refund_reversal_requested'
  ) AS has_event
) reversal
WHERE ff.refund_rejected_at IS NULL
   OR (refunded.has_event AND NOT reversal.has_event)
ORDER BY ff.tenant_id, ff.issue_id;

-- Query 2: final failure (not 'rejected') whose promo payout was not given back.
WITH failed AS (
  SELECT
    r.tenant_id,
    r.order_issue_id AS issue_id,
    count(*) AS failed_count,
    (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_refund_id,
    (array_agg(r.amount_idr ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_amount_idr,
    (array_agg(coalesce(r.failure_reason, 'unknown') ORDER BY r.created_at DESC, r.id DESC)
       FILTER (WHERE r.requested_by = 'system:recovery'))[1] AS last_reason,
    coalesce(bool_or(coalesce(r.failure_reason, 'unknown')
        NOT IN ('approval_expired', 'approver_unauthorized'))
      FILTER (WHERE r.requested_by = 'system:recovery'), false) AS has_final_reason
  FROM payment_refunds r
  WHERE r.order_issue_id IS NOT NULL
    AND r.status = 'failed'
  GROUP BY r.tenant_id, r.order_issue_id
  HAVING count(*) FILTER (WHERE r.requested_by = 'system:recovery') > 0
),
final_failure AS (
  SELECT f.*, i.order_id
  FROM failed f
  JOIN order_issues i ON i.tenant_id = f.tenant_id AND i.id = f.issue_id
  WHERE i.resolution = 'manual_refund'
    AND NOT EXISTS (
      SELECT 1 FROM payment_refunds l
      WHERE l.tenant_id = f.tenant_id
        AND l.order_issue_id = f.issue_id
        AND l.status <> 'failed'
    )
    AND (
      f.has_final_reason
      OR f.failed_count >= 3
      OR NOT EXISTS (
        SELECT 1 FROM payment_admin_idempotency p
        WHERE p.tenant_id = f.tenant_id
          AND p.key = 'order-recovery-refund:' || f.issue_id::text
      )
    )
)
SELECT
  ff.tenant_id,
  ff.issue_id,
  ff.order_id,
  ff.last_refund_id,
  ff.last_amount_idr,
  ff.last_reason,
  first_filing.promo_recorded_idr,
  a.refunded_paid_idr,
  a.status AS application_status
FROM final_failure ff
JOIN promotion_order_applications a
  ON a.tenant_id = ff.tenant_id AND a.order_id = ff.order_id
JOIN LATERAL (
  SELECT CASE
           WHEN jsonb_typeof(p.response->'promoRecordedIdr') = 'number'
           THEN (p.response->>'promoRecordedIdr')::numeric
           ELSE 0
         END AS promo_recorded_idr
  FROM payment_admin_idempotency p
  WHERE p.tenant_id = ff.tenant_id
    AND p.key = 'order-recovery-refund:' || ff.issue_id::text
) first_filing ON first_filing.promo_recorded_idr > 0
WHERE ff.last_reason <> 'rejected'
  AND NOT EXISTS (
    SELECT 1 FROM promo_command_idempotency c
    WHERE c.tenant_id = ff.tenant_id
      AND c.key = 'order-recovery-refund:' || ff.issue_id::text || ':promo-return'
  )
ORDER BY ff.tenant_id, ff.issue_id;

ROLLBACK;
