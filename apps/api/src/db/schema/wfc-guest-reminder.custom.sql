-- Hand SQL for wfc_guest_reminders (bead legend-qr3sd; PRD v1.7 §3 F39).
-- Appended to the migration that creates the table. Foreign keys are inline in
-- the generated CREATE TABLE (the migrator is not a superuser).

-- TEN-01, TEN-03: tenant-owned and outlet-owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.wfc_guest_reminders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_guest_reminders'::regclass);
