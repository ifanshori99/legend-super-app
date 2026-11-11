-- legend-x0avw (Codex findings 2 and 4).
-- F4: a day listed in leave_requests.excluded_holiday_dates (an outlet holiday
-- inside the leave range) is NOT a leave day. app.approved_leaves_on no longer
-- returns it and app.flag_attendance_for_leave no longer flags a log made on
-- it, so the day is paid as work and never sits in HR review as a clash. Same
-- bodies as 0256 and 0257 plus that one condition; grants are unchanged.
-- F2: backfill, last statement. Clock-ins that clashed with an approved leave
-- before 0257 existed were never flagged. The final UPDATE flags them with the
-- same rule as app.flag_attendance_for_leave: `in` log, validity valid or
-- flagged, review_status none, pending or accepted (an old acceptance is
-- reopened, reviewed_by and reviewed_at cleared), business date inside an
-- approved leave of the same employee and not one of its excluded holiday
-- dates; leave_approved is added once. A rejected log is never touched. A log
-- whose business date falls in a closed payroll run (locked, paid, reversed or
-- lock stamp set; the employee's legal entity only when it has one, as
-- isPayrollClosed does) is never touched by the backfill, and
-- app.flag_attendance_for_leave never reopens an accepted log there. Running
-- it again changes nothing.
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
       AND NOT (p_date = ANY (lr.excluded_holiday_dates))
     ORDER BY lr.start_date, lr.id;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.approved_leaves_on(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approved_leaves_on(uuid, uuid, date) TO legend_app;
--> statement-breakpoint
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
       AND EXISTS (
         SELECT 1
           FROM public.leave_requests lr
          WHERE lr.tenant_id = p_tenant
            AND lr.employee_id = p_employee
            AND lr.status = 'approved'
            AND lr.start_date <= al.business_date
            AND lr.end_date >= al.business_date
            AND NOT (al.business_date = ANY (lr.excluded_holiday_dates))
       )
       AND al.validity IN ('valid', 'flagged')
       AND al.review_status IN ('none', 'pending', 'accepted')
       AND NOT (
         al.validity = 'flagged'
         AND al.review_status = 'pending'
         AND al.flag_reasons @> '["leave_approved"]'::jsonb
       )
       AND NOT (
         al.review_status = 'accepted'
         AND EXISTS (
           SELECT 1
             FROM public.payroll_runs pr
            WHERE pr.tenant_id = al.tenant_id
              AND (pr.status IN ('locked', 'paid', 'reversed') OR pr.locked_at IS NOT NULL)
              AND pr.period_start <= al.business_date
              AND pr.period_end >= al.business_date
              AND NOT EXISTS (
                SELECT 1
                  FROM public.employees pe
                 WHERE pe.tenant_id = al.tenant_id
                   AND pe.id = al.employee_id
                   AND pe.legal_entity_id IS NOT NULL
                   AND pe.legal_entity_id <> pr.legal_entity_id
              )
         )
       )
    RETURNING al.id, al.outlet_id;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) TO legend_app;
--> statement-breakpoint
-- attendance_logs and leave_requests are FORCE RLS and the migrator is a plain
-- table owner without a tenant context (see 0234, 0139): the backfill would
-- raise "tenant context is required". FORCE is lifted for this migration only
-- (drizzle applies pending migrations in one transaction, so no other session
-- sees the lifted state) and restored by the ALTERs that follow the backfill
-- UPDATE. payroll_runs and employees are lifted too: the closed-period check
-- of the backfill reads them.
ALTER TABLE public.attendance_logs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.leave_requests NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_runs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.attendance_logs al
   SET validity = 'flagged',
       review_status = 'pending',
       reviewed_by = NULL,
       reviewed_at = NULL,
       flag_reasons = CASE
         WHEN al.flag_reasons @> '["leave_approved"]'::jsonb THEN al.flag_reasons
         ELSE al.flag_reasons || '["leave_approved"]'::jsonb
       END
 WHERE al.type = 'in'
   AND al.validity IN ('valid', 'flagged')
   AND al.review_status IN ('none', 'pending', 'accepted')
   AND NOT (
     al.validity = 'flagged'
     AND al.review_status = 'pending'
     AND al.flag_reasons @> '["leave_approved"]'::jsonb
   )
   AND NOT EXISTS (
     SELECT 1
       FROM public.payroll_runs pr
      WHERE pr.tenant_id = al.tenant_id
        AND (pr.status IN ('locked', 'paid', 'reversed') OR pr.locked_at IS NOT NULL)
        AND pr.period_start <= al.business_date
        AND pr.period_end >= al.business_date
        AND NOT EXISTS (
          SELECT 1
      FROM public.employees pe
     WHERE pe.tenant_id = al.tenant_id
       AND pe.id = al.employee_id
       AND pe.legal_entity_id IS NOT NULL
       AND pe.legal_entity_id <> pr.legal_entity_id
        )
   )
   AND EXISTS (
     SELECT 1
       FROM public.leave_requests lr
      WHERE lr.tenant_id = al.tenant_id
        AND lr.employee_id = al.employee_id
        AND lr.status = 'approved'
        AND lr.start_date <= al.business_date
        AND lr.end_date >= al.business_date
        AND NOT (al.business_date = ANY (lr.excluded_holiday_dates))
   );
--> statement-breakpoint
ALTER TABLE public.attendance_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.leave_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
