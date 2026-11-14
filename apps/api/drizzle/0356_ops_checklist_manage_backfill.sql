-- legend-wg0g: ops.checklist.manage (create and edit checklist templates, apart
-- from ops.checklist.complete, which only runs and signs off a checklist).
-- Numbering: 0356 in this branch (was 0550, window 0550-0552 of of the WS-11/WS-14
-- batch); merge it only after every older migration is in the journal (drizzle
-- skips an older `when` applied after a newer one). No new table, so no
-- data-import-registry entry; the snapshot is the 0347 schema unchanged.
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (same pattern as 0171).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Role rows are seeded once per tenant and the resolver reads the stored rows,
-- so existing tenants need the new permission appended to the template rows
-- that hold it (the catalog only seeds new tenants): owner, outlet_manager,
-- kitchen_lead. Idempotent: skips rows that already hold it. Custom roles
-- (is_template = false) are never touched.
UPDATE "roles"
SET "permissions" = "permissions" || '["ops.checklist.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'outlet_manager', 'kitchen_lead')
  AND NOT ("permissions" @> '["ops.checklist.manage"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
