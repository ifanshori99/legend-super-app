-- Custom SQL migration file, put your code below! ---
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (drizzle applies pending
-- migrations in one transaction; same pattern as 0065 and 0068).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Role rows are seeded once per tenant and the resolver reads the stored rows,
-- so existing tenants need the new permission (service_request.zone.manage,
-- zone waiter management) appended to the templates that run an outlet floor.
-- New tenants get it from the template catalog. Idempotent: skips rows that
-- already hold it. Custom roles are never touched.
UPDATE "roles"
SET "permissions" = "permissions" || '["service_request.zone.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('tenant_admin', 'general_manager', 'outlet_manager')
  AND NOT ("permissions" @> '["service_request.zone.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
