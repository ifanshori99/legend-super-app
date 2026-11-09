-- Custom SQL migration fragment for legend-w4nq4 (kitchen_capacity_rules).
-- Append AFTER the drizzle-generated CREATE TABLE statement.
--
-- Tenant + outlet RLS (TEN-01/TEN-03). kitchen_capacity_rules has outlet_id
-- NOT NULL. Kitchen config replaces a station's list, so rows are inserted and
-- deleted by the API; there is no history to protect.
SELECT app.enforce_tenant_rls('public.kitchen_capacity_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_capacity_rules'::regclass);
