ALTER TABLE "service_requests" ADD COLUMN "resolved_by" uuid;
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
