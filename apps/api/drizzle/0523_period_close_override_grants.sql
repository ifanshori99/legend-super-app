-- Period close override permission (card 1263, founder no. 19).
-- Template roles are copied into a tenant once (seedTenantRoleTemplates,
-- onConflictDoNothing) and never refreshed, so add the code to the template
-- rows that already exist. Same grants as the templates in
-- packages/shared/src/access/roles.ts:
--   accounting.period.close_override  owner, finance
-- Every other template and custom roles receive nothing. `roles` has FORCE RLS,
-- so each tenant is named before its rows are touched. Idempotent: a code the
-- row already holds is not added twice. Pattern: 0505_payout_gl_resolve_grants.sql.
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
        ('owner', 'accounting.period.close_override'),
        ('finance', 'accounting.period.close_override')
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
