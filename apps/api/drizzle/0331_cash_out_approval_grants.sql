-- Cash-out approval (founder Q7, 13 Nov 2026). cash_bank_entries stays
-- append-only for the application role (0485 revoked UPDATE); only the
-- decision columns may change, and only while the entry waits: approve sets
-- status/approver/decided_at/journal link, reject sets status/approver/
-- decided_at/reason. Which transitions are legal is the service's job
-- (row lock, status = 'pending_approval'); the CHECK constraints from 0330
-- keep the combinations valid. RLS was enabled in 0485.
GRANT UPDATE (status, approver_id, decided_at, decision_reason, journal_entry_id) ON TABLE public.cash_bank_entries TO legend_app;
--> statement-breakpoint
-- Backfill for existing tenants. Template roles are copied into a tenant once
-- (seedTenantRoleTemplates, onConflictDoNothing) and never refreshed, so add
-- the cash/bank permissions to the owner and finance rows that already exist
-- (0324 missed `record`; 0330 adds `approve` and `limit.manage`). Tenant admin
-- does not receive them. Precedent: 0090_pos_day_close_permission.sql.
-- `roles` has FORCE RLS, so each tenant is named before its rows are touched.
-- Idempotent: a code the row already holds is not added twice.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
  code text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    FOREACH code IN ARRAY ARRAY[
      'accounting.cash_bank.record',
      'accounting.cash_bank.approve',
      'accounting.cash_bank.limit.manage'
    ] LOOP
      UPDATE public.roles
      SET permissions = permissions || to_jsonb(code),
          updated_at = now()
      WHERE tenant_id = target
        AND is_template
        AND template_key IN ('owner', 'finance')
        AND NOT (permissions ? code);
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
