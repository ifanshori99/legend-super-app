-- Tenant RLS for domain_event_gap_requests (core-events.ts). outlet_id is
-- nullable (a gap can belong to a tenant-wide aggregate), so only the tenant
-- policy applies, like domain_event_outbox.
SELECT app.enforce_tenant_rls('public.domain_event_gap_requests'::regclass);
