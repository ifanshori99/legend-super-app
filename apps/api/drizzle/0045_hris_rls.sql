-- Custom SQL migration file, put your code below! ---
-- HRIS master data (bead legend-qe1z; PRD v1.7 §3 F26, §6 H; HR-01/03/04):
-- tenant RLS on every table (TEN-01/02). None of these tables is outlet-owned
-- (no `outlet_id NOT NULL`): `employees.home_outlet_id` is a placement, so the
-- outlet reach is enforced in services/hris-*.ts (contracts.md "TEN-03 outlet
-- isolation layers"), and contracts/documents inherit it from their employee.
-- Every CHECK / partial unique index is expressed in schema/hris.ts.
SELECT app.enforce_tenant_rls('public.org_units'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.position_grades'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.positions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employees'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employment_contracts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.employee_documents'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hris_idempotency'::regclass);
