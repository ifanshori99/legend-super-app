-- legend-c9kbk (founder Q37/Q38, TEN-04): requests for a read_write support
-- session that a tenant owner must approve. Tenant-owned, so forced tenant RLS
-- (TEN-01/02). A decided row (approved, rejected, expired) is final; a pending
-- row may only be decided (status/decided_at/decided_by/grant_id) or have
-- owner_notified_at set once. Everything the request promised stays fixed.
SELECT app.enforce_tenant_rls('public.support_access_requests'::regclass);
--> statement-breakpoint
-- A request is never deleted (audit trail); the guard trigger covers UPDATE.
REVOKE DELETE, TRUNCATE ON TABLE public.support_access_requests FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.support_access_requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'TEN-04: support access request % is already decided', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.super_admin_user_id <> OLD.super_admin_user_id
    OR NEW.reason <> OLD.reason
    OR NEW.access_mode <> OLD.access_mode
    OR NEW.duration_minutes <> OLD.duration_minutes
    OR NEW.mfa_verified_at <> OLD.mfa_verified_at
    OR NEW.requested_at <> OLD.requested_at
    OR NEW.approval_expires_at <> OLD.approval_expires_at
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'TEN-04: support access request % cannot change what was requested', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.owner_notified_at IS NOT NULL
    AND NEW.owner_notified_at IS DISTINCT FROM OLD.owner_notified_at
  THEN
    RAISE EXCEPTION 'TEN-04: support access request % owner notification is final', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "support_access_requests_guard_trg"
  BEFORE UPDATE ON "support_access_requests"
  FOR EACH ROW EXECUTE FUNCTION app.support_access_requests_guard();

--> statement-breakpoint
-- legend-c9kbk (Q37): new permission `org.support_access.approve` (answer a
-- support read_write request), owner template only (packages/shared/src/access
-- roles.ts takes every non-platform, non-self code). Template roles already
-- copied into existing tenants keep their old list (seedTenantRoleTemplates
-- inserts once), so add the code to their owner rows here. Additive and
-- idempotent. `roles` has FORCE RLS, so each tenant is named (precedent:
-- 0104_edc_standalone_permission.sql).
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions || '["org.support_access.approve"]'::jsonb,
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key = 'owner'
      AND NOT (permissions ? 'org.support_access.approve');
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
