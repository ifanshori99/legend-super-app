-- Payroll disbursement permissions (bead legend-wnkep.1, founder Q16: two
-- people on the first release). Template roles are copied into a tenant once
-- (seedTenantRoleTemplates, onConflictDoNothing) and never refreshed, so add
-- the codes to the template rows that already exist. Same grants as the
-- templates in packages/shared/src/access/roles.ts:
--   payroll.payout.configure  owner, finance
--   payroll.disburse.request  owner, hr           (mirrors payroll.run)
--   payroll.disburse.approve  owner, finance, hr  (mirrors payroll.approve)
-- Tenant admin and custom roles receive nothing. `roles` has FORCE RLS, so each
-- tenant is named before its rows are touched. Idempotent: a code the row
-- already holds is not added twice. Pattern: 0331_cash_out_approval_grants.sql.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
  grant_row record;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    FOR grant_row IN
      SELECT * FROM (VALUES
        ('owner', 'payroll.payout.configure'),
        ('finance', 'payroll.payout.configure'),
        ('owner', 'payroll.disburse.request'),
        ('hr', 'payroll.disburse.request'),
        ('owner', 'payroll.disburse.approve'),
        ('finance', 'payroll.disburse.approve'),
        ('hr', 'payroll.disburse.approve')
      ) AS g(template_key, code)
    LOOP
      UPDATE public.roles
      SET permissions = permissions || to_jsonb(grant_row.code),
          updated_at = now()
      WHERE tenant_id = target
        AND is_template
        AND template_key = grant_row.template_key
        AND NOT (permissions ? grant_row.code);
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
