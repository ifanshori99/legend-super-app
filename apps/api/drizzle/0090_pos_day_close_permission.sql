-- legend-6c0, founder Q9 (2026-11-08): the business day is closed by the
-- outlet manager. New permission `pos.day.close` is granted by the owner,
-- general_manager and outlet_manager templates (packages/shared/src/access/
-- roles.ts). Template roles already copied into existing tenants keep their
-- old permission list (seedTenantRoleTemplates inserts once), so add the code
-- to those rows here. Idempotent: rows that already hold it are skipped.
--
-- `roles` has FORCE RLS whose policy calls app.require_tenant_id(), so a
-- migration role without BYPASSRLS must name each tenant (precedent:
-- 0008_wealthy_killraven.sql). `tenants` itself has no RLS.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions || '["pos.day.close"]'::jsonb,
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key IN ('owner', 'general_manager', 'outlet_manager')
      AND NOT (permissions ? 'pos.day.close');
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
