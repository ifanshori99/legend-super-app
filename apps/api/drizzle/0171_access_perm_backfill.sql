-- Custom SQL migration file, put your code below! ---
-- legend-9yb5u. Numbering: 0171 is assigned by the merge train; merge it only
-- after every older migration is in the journal (drizzle skips an older `when`
-- applied after a newer one).
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (drizzle applies pending
-- migrations in one transaction; same pattern as 0065, 0068, 0120, 0148 and
-- 0159).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Role rows are seeded once per tenant and the resolver reads the stored rows,
-- so existing tenants need the new permissions appended to the templates that
-- hold them. New tenants get them from the template catalog.
-- hr.announcement.manage (manage internal announcements and their read
-- receipts, apart from hr.sop.manage): owner, general_manager, hr. Not
-- kitchen_lead (the reason for the split) and not tenant_admin.
-- Idempotent: skips rows that already hold it. Custom roles are never touched.
UPDATE "roles"
SET "permissions" = "permissions" || '["hr.announcement.manage"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'general_manager', 'hr')
  AND NOT ("permissions" @> '["hr.announcement.manage"]'::jsonb);
--> statement-breakpoint
-- self.loan.request (employee asks for a kasbon, POST /api/hris/me/loans):
-- the employee template only. Owner and tenant_admin never hold self.* codes.
UPDATE "roles"
SET "permissions" = "permissions" || '["self.loan.request"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" = 'employee'
  AND NOT ("permissions" @> '["self.loan.request"]'::jsonb);
--> statement-breakpoint
-- self.sop.read (read the announcement feed and confirm receipts): kitchen_lead.
-- Announcements were managed with hr.sop.manage, which kitchen_lead holds, so
-- it read the feed; the split to hr.announcement.manage would otherwise cut
-- that off (legend-poxk, CTO decision: no regression).
UPDATE "roles"
SET "permissions" = "permissions" || '["self.sop.read"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" = 'kitchen_lead'
  AND NOT ("permissions" @> '["self.sop.read"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
