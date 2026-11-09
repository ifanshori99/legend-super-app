-- Custom SQL migration file, put your code below! ---
-- Numbers 0153-0158 are taken or reserved by other branches; this migration is
-- 0159. Merge it only after 0153-0158 are in the journal (drizzle skips an
-- older `when` applied after a newer one).
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (drizzle applies pending
-- migrations in one transaction; same pattern as 0065, 0068, 0120 and 0148).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Role rows are seeded once per tenant and the resolver reads the stored rows,
-- so existing tenants need the new permission appended to the templates that
-- hold it. New tenants get it from the template catalog.
-- org.notification_policy.manage (change the notification channel policy and
-- templates): owner, tenant_admin.
-- Idempotent: skips rows that already hold it. Custom roles are never touched.
UPDATE "roles"
SET "permissions" = "permissions" || '["org.notification_policy.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'tenant_admin')
  AND NOT ("permissions" @> '["org.notification_policy.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
