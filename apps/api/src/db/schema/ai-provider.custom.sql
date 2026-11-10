-- Custom SQL migration fragment for legend-dwrr (ai_provider_configs).
-- Append AFTER the drizzle-generated CREATE TABLE statement.
--
-- Tenant RLS (TEN-01). ai_provider_configs is tenant-level (no outlet_id), so
-- there is no outlet RLS. No SECURITY DEFINER: every reader has a tenant from
-- withTenant.
SELECT app.enforce_tenant_rls('public.ai_provider_configs'::regclass);
