-- legend-xhlbz (follow-up of legend-7wzy). Numbering: 0331 is assigned by the
-- coordinator; merge it only after every older migration is in the journal
-- (drizzle skips an older `when` applied after a newer one).
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS).
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set the backfill below raises 42501. Lift FORCE for this
-- transaction only and restore it right after (same pattern as 0171 and 0172).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- crm.customer.identity.unlink (staff detaches a customer's WhatsApp number,
-- audited): Owner and Admin Tenant only. Role rows are seeded once per tenant
-- and the resolver reads the stored rows, so existing tenants need the code
-- appended to those two templates; new tenants get it from the template
-- catalog. Custom roles are never touched: a tenant grants it deliberately.
-- Idempotent: skips rows that already hold it.
UPDATE "roles"
SET "permissions" = "permissions" || '["crm.customer.identity.unlink"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'tenant_admin')
  AND NOT ("permissions" @> '["crm.customer.identity.unlink"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
