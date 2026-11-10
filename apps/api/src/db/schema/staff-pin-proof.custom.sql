-- Custom SQL migration file, put your code below! ---
-- Outlet-device attendance PIN proofs (bead legend-u7g9w). Folded into
-- migration 0241 after the CREATE TABLEs and after the
-- core_storage_objects.pin_proof_id FK (that FK must be validated before these
-- tables are RLS-forced). staff_pin_proofs is tenant + outlet owned (outlet_id
-- NOT NULL); device_pin_throttle is tenant owned only.
SELECT app.enforce_tenant_rls('public.device_pin_throttle'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.staff_pin_proofs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.staff_pin_proofs'::regclass);
