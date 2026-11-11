-- legend-7o3hd (founder W8): a leave is APPROVED after the employee already
-- clocked in on a day it covers. The clock-in must go to HR review (reason
-- leave_approved) so the day is not paid twice (leave and work). The log can
-- belong to any outlet of the employee, but attendance_logs FORCES outlet RLS
-- and the caller is scoped to the leave's home outlet, so a plain UPDATE would
-- miss logs made elsewhere. This function flags only: `in` logs of one
-- employee whose business date is inside [p_start, p_end] (inclusive, the same
-- rule as the leave overlap checks), still countable (valid) or waiting for
-- review (flagged), and not rejected (review_status none, pending or
-- accepted). A log HR accepted is REOPENED: an earlier acceptance (for example
-- keep after cancel_leave) does not cover a leave approved later, and leaving
-- it would pay the day twice (leave and work). Reopening clears reviewed_by
-- and reviewed_at (check attendance_logs_review_check: a pending review has no
-- reviewer). A rejected log is never touched. Result: validity flagged,
-- review_status pending, reason leave_approved appended once. Calling it again
-- changes nothing (idempotent).
-- Pattern of app.approved_leaves_on (0276): tied to the tenant (nothing happens
-- unless the caller's own app.tenant_id is p_tenant), SECURITY DEFINER, pinned
-- search_path, the caller's app.outlet_ids restored before returning, EXECUTE
-- for legend_app only. Returns the log and outlet of every row it changed.
CREATE OR REPLACE FUNCTION app.flag_attendance_for_leave(
  p_tenant uuid, p_employee uuid, p_start date, p_end date
) RETURNS TABLE (log_id uuid, outlet_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_tenant text := coalesce(current_setting('app.tenant_id', true), '');
  previous_scope text := coalesce(current_setting('app.outlet_ids', true), '');
BEGIN
  IF current_tenant = '' OR current_tenant <> p_tenant::text THEN
    RETURN;
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RETURN;
  END IF;
  PERFORM set_config('app.outlet_ids', '*', true);
  RETURN QUERY
    UPDATE public.attendance_logs al
       SET validity = 'flagged',
           review_status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL,
           flag_reasons = CASE
             WHEN al.flag_reasons @> '["leave_approved"]'::jsonb THEN al.flag_reasons
             ELSE al.flag_reasons || '["leave_approved"]'::jsonb
           END
     WHERE al.tenant_id = p_tenant
       AND al.employee_id = p_employee
       AND al.type = 'in'
       AND al.business_date >= p_start
       AND al.business_date <= p_end
       AND al.validity IN ('valid', 'flagged')
       AND al.review_status IN ('none', 'pending', 'accepted')
       AND NOT (
         al.validity = 'flagged'
         AND al.review_status = 'pending'
         AND al.flag_reasons @> '["leave_approved"]'::jsonb
       )
    RETURNING al.id, al.outlet_id;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) TO legend_app;
