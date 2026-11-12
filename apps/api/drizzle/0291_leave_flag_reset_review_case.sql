-- 538-G4b: reopening an attendance log for an approved leave starts a new
-- review case. Clear the previous decision metadata along with its reviewer.
-- Preserve the tenant, approved leave, date and closed payroll guards of 0276.
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
           decision_action = NULL,
           leave_snapshot = NULL,
           case_kind = NULL,
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
    RETURNING al.id, al.outlet_id;
  PERFORM set_config('app.outlet_ids', previous_scope, true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.flag_attendance_for_leave(uuid, uuid, date, date) TO legend_app;
