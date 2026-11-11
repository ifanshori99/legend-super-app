-- legend-9y6ri (founder W8 Q21): approved leave covering one day, for one
-- employee, across outlets. leave_requests is outlet-owned (outlet_id = the
-- employee's home outlet) and FORCES outlet RLS, so a clock-in at another
-- outlet, or HR with a partial outlet scope, cannot see the leave and would
-- treat the day as an ordinary workday (paid leave plus a valid attendance
-- log). This function answers only "which approved leaves contain this date"
-- for one employee, with the outlet scope widened inside the function only.
-- It stays tied to the tenant: it returns nothing unless the caller's own
-- app.tenant_id is p_tenant (fail closed on a missing or different tenant), and
-- the tenant policy of leave_requests still applies. SECURITY DEFINER with a
-- pinned search_path (pattern app.user_has_role_assignment, 0221); the caller's
-- app.outlet_ids is restored before returning. EXECUTE for legend_app only.
-- Dates are inclusive on both ends, the same rule as the leave overlap checks.
CREATE OR REPLACE FUNCTION app.approved_leaves_on(
  p_tenant uuid, p_employee uuid, p_date date
) RETURNS TABLE (
  leave_request_id uuid, outlet_id uuid, start_date date, end_date date, days numeric
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_tenant text := coalesce(current_setting('app.tenant_id', true), '');
  previous_scope text := coalesce(current_setting('app.outlet_ids', true), '');
BEGIN
  IF current_tenant = '' OR current_tenant <> p_tenant::text THEN
    RETURN;
  END IF;
  PERFORM set_config('app.outlet_ids', '*', true);
  RETURN QUERY
    SELECT lr.id, lr.outlet_id, lr.start_date, lr.end_date, lr.days
      FROM public.leave_requests lr
     WHERE lr.tenant_id = p_tenant
       AND lr.employee_id = p_employee
       AND lr.status = 'approved'
       AND lr.start_date <= p_date
       AND lr.end_date >= p_date
     ORDER BY lr.start_date, lr.id;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.approved_leaves_on(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approved_leaves_on(uuid, uuid, date) TO legend_app;
