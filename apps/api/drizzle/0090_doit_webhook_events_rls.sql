-- Tenant RLS for gateway_webhook_events (payment-gateway-webhook.ts).
-- outlet_id is nullable (set once the intent is known), so only the tenant
-- policy applies, like domain_event_outbox.
SELECT app.enforce_tenant_rls('public.gateway_webhook_events'::regclass);
