-- legend-pti5r: READ-ONLY check for recovery refunds (ORD-09, requested_by
-- 'system:recovery') that ended in a FINAL failure before the fix, so the
-- settlement the live code does now never ran for them. NOT a migration: the
-- migrator does not run this file. It writes nothing (BEGIN READ ONLY ...
-- ROLLBACK). Runbook: docs/runbooks/recovery-refund-final-failure-backfill.md.
--
-- Run with an admin connection that sees every tenant: a superuser or a role
-- with BYPASSRLS, e.g. psql -v ON_ERROR_STOP=1 "$ADMIN_DATABASE_URL" -f
-- this-file. Being the table owner is NOT enough: the tables use FORCE ROW
-- LEVEL SECURITY, which applies to the owner too, so an owner connection
-- without BYPASSRLS would silently get an empty result. The first statement
-- therefore fails the script (RAISE EXCEPTION, SQLSTATE 42501) when
-- current_user is neither superuser nor BYPASSRLS.
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
-- Lists tenant_id, issue id, order id and amounts, oldest tenant first.
-- The promo ledger is not checked: a final failure leaves it untouched on
-- purpose (the payout stays reserved for the line) and a re-report of the same
-- item replays the failed refund (legend-pti5r), so nothing to backfill there.
BEGIN READ ONLY;

-- Guard: fail loudly instead of returning an empty (misleading) result.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'recovery refund check needs a superuser or BYPASSRLS role: % cannot see rows of every tenant (FORCE RLS also applies to table owners)',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$guard$;

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

ROLLBACK;
