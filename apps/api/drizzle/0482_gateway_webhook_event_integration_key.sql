-- Dedupe verified webhook events per integration, not per tenant: the old key
-- let the first sender own an event id. The new key only allows more rows
-- (never fewer), so existing data cannot violate it. Drop first: same name.
DROP INDEX "gateway_webhook_events_event_key";--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_webhook_events_event_key" ON "gateway_webhook_events" USING btree ("tenant_id","provider","integration_id","event_id") WHERE "gateway_webhook_events"."signature_valid" AND "gateway_webhook_events"."event_id" IS NOT NULL;--> statement-breakpoint
-- A verified row must name its integration (NULLs never conflict in a unique
-- index). NOT VALID: legacy rows are not rechecked, every new write is.
ALTER TABLE "gateway_webhook_events" ADD CONSTRAINT "gateway_webhook_events_verified_integration_check" CHECK (NOT "signature_valid" OR "integration_id" IS NOT NULL) NOT VALID;
