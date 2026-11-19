-- Custom SQL migration fragment for legend-4qu (apology_vouchers, migration
-- 0212). Append AFTER the drizzle-generated statements. Keep this file and the
-- migration in step.
--
-- The generated CREATE TABLE carries every foreign key inline (pattern 1: the
-- new table is empty, so FORCE RLS needs no lift).
--
-- Tenant + outlet RLS (TEN-01/TEN-03). apology_vouchers has outlet_id NOT
-- NULL. Append-only for the application role: a voucher is voided on
-- `vouchers`, never by changing or deleting this row.
SELECT app.enforce_tenant_rls('public.apology_vouchers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.apology_vouchers'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.apology_vouchers FROM legend_app;

-- Migration 0720 (legend-4vfmn): the sealed-secret reseal job may rewrite
-- code_sealed (and only that column) through app.reseal_frozen_sealed, which
-- runs as the table owner (sealed-reseal-frozen.custom.sql). legend_app keeps no
-- UPDATE/DELETE. This guard makes the owner path unable to touch any other
-- column; it only fires for a role that can UPDATE the table (the owner).
-- DELETE stays refused by the REVOKE above.
CREATE OR REPLACE FUNCTION app.apology_vouchers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.sealed_reseal_column', true) = 'apology_vouchers.code_sealed'
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = 'app.reseal_frozen_sealed(text,text,uuid,uuid,text,text)'::pg_catalog.regprocedure
        AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
    )
    AND (to_jsonb(NEW) - 'code_sealed') = (to_jsonb(OLD) - 'code_sealed')
    AND NEW.code_sealed IS DISTINCT FROM OLD.code_sealed
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'apology_vouchers % is append-only; only the sealed-secret reseal may rewrite code_sealed', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "apology_vouchers_guard_trg"
  BEFORE UPDATE ON "apology_vouchers"
  FOR EACH ROW EXECUTE FUNCTION app.apology_vouchers_guard();
