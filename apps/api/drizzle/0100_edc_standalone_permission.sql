-- legend-m4fv, EDC-04: new permission `pos.edc_standalone.approve` (approve a
-- standalone EDC payment), granted by the general_manager, outlet_manager and
-- supervisor templates (packages/shared/src/access/roles.ts). Template roles
-- already copied into existing tenants keep their old permission list
-- (seedTenantRoleTemplates inserts once), so add the code to those rows here.
-- Additive and idempotent: rows that already hold it are skipped.
--
-- `roles` has FORCE RLS whose policy calls app.require_tenant_id(), so a
-- migration role without BYPASSRLS must name each tenant (precedent:
-- 0090_pos_day_close_permission.sql). `tenants` itself has no RLS.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions || '["pos.edc_standalone.approve"]'::jsonb,
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key IN ('general_manager', 'outlet_manager', 'supervisor')
      AND NOT (permissions ? 'pos.edc_standalone.approve');
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
