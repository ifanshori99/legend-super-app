-- Custom SQL migration file, put your code below! ---
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (drizzle applies pending
-- migrations in one transaction; same pattern as 0065, 0068 and 0120).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Role rows are seeded once per tenant and the resolver reads the stored rows,
-- so existing tenants need the open bill permissions appended to the templates
-- that hold them. New tenants get them from the template catalog.
-- floor.session.open_bill (approve a table session conversion to open bill):
-- owner, general_manager, outlet_manager, supervisor. Not tenant_admin.
-- Idempotent: skips rows that already hold it. Custom roles are never touched.
UPDATE "roles"
SET "permissions" = "permissions" || '["floor.session.open_bill"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager', 'supervisor')
  AND NOT ("permissions" @> '["floor.session.open_bill"]'::jsonb);
--> statement-breakpoint
-- floor.open_bill_policy.manage (change the outlet open bill policy):
-- owner, general_manager, outlet_manager. Same idempotent rules.
UPDATE "roles"
SET "permissions" = "permissions" || '["floor.open_bill_policy.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'outlet_manager')
  AND NOT ("permissions" @> '["floor.open_bill_policy.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
