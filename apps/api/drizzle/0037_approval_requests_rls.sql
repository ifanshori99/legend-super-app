-- Generic approval requests (bead legend-y5q; PRD v1.7 §3 F7, §6 B, TEN-01..03).
-- Tenant RLS through the shared helper (catalog guard in src/db/rls.test.ts).
SELECT app.enforce_tenant_rls('public.approval_requests'::regclass);
--> statement-breakpoint
-- TEN-03 outlet isolation. outlet_id is nullable here (tenant-wide actions such
-- as payroll or dividend distribution have no outlet), so app.enforce_outlet_rls
-- (NOT NULL only) cannot be used. This RESTRICTIVE policy keeps its semantics
-- for outlet rows and is stricter for tenant-wide rows: a NULL outlet is visible
-- and writable only under the tenant-wide scope ('*'). A missing or malformed
-- app.outlet_ids raises, exactly like the shared helper (fail closed).
CREATE POLICY outlet_isolation ON public.approval_requests AS RESTRICTIVE FOR ALL
  USING ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]))
  WITH CHECK ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]));
