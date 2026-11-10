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
