-- Custom SQL migration for legend-o5gr (guest reservation self-service).
-- Append AFTER the drizzle-generated CREATE TABLE statements for
-- reservation_guest_links and reservation_reschedule_requests.
--
-- Tenant RLS (FORCE) on both tables: a guest link is looked up by
-- (tenant from the request host, token_hash), so another tenant's token is
-- invisible, never a hint that it exists.
SELECT app.enforce_tenant_rls('public.reservation_guest_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_reschedule_requests'::regclass);
--> statement-breakpoint
-- Outlet RLS too, like every reservation table (outlet_id is NOT NULL): an
-- outlet-scoped staff session sees only its outlets' links and requests; the
-- tenant-wide guest context passes through app.outlet_scope_is_tenant().
SELECT app.enforce_outlet_rls('public.reservation_guest_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_reschedule_requests'::regclass);
