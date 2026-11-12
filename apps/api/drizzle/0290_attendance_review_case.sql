ALTER TABLE "attendance_logs" ADD COLUMN "decision_action" varchar(20);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "case_kind" varchar(30);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "leave_snapshot" jsonb;

--> statement-breakpoint
-- legend-eps6t: the leave behind a leave case, for one employee and day, across
-- outlets. Same pattern as app.approved_leaves_on (0256): leave_requests is
-- outlet-owned and FORCES outlet RLS, so HR scoped to the outlet of the
-- clock-in cannot read a leave filed at the employee's home outlet. Tenant
-- bound (nothing returned unless app.tenant_id is p_tenant), SECURITY DEFINER,
-- pinned search_path, caller's app.outlet_ids restored, EXECUTE for legend_app.
CREATE OR REPLACE FUNCTION app.leave_case_on(
  p_tenant uuid, p_employee uuid, p_date date
) RETURNS TABLE (
  leave_request_id uuid, outlet_id uuid, leave_type_id uuid, leave_type_name text,
  start_date date, end_date date, decided_at timestamptz
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
    SELECT lr.id, lr.outlet_id, lr.leave_type_id, lt.name::text,
           lr.start_date, lr.end_date, lr.decided_at
      FROM public.leave_requests lr
      JOIN public.leave_types lt
        ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
     WHERE lr.tenant_id = p_tenant
       AND lr.employee_id = p_employee
       AND lr.status = 'approved'
       AND lr.start_date <= p_date
       AND lr.end_date >= p_date
     ORDER BY lr.start_date, lr.id
     LIMIT 1;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.leave_case_on(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.leave_case_on(uuid, uuid, date) TO legend_app;
