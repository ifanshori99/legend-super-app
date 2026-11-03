-- Daily operations (WS-14, bead legend-ptd8; PRD v1.7 §3 F41/F45, §6 L):
-- tenant + outlet RLS on every operations table (TEN-01..03). Every table is
-- outlet-owned, so the outlet policy follows the tenant policy. CHECK
-- constraints, partial indexes and composite foreign keys live in
-- schema/operations.ts; this file holds only what drizzle cannot express, plus
-- the RLS installation.
SELECT app.enforce_tenant_rls('public.equipment'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.equipment'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ops_checklist_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.ops_checklist_templates'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ops_checklist_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.ops_checklist_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.temperature_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.temperature_logs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.prep_labels'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.prep_labels'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.prep_lists'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.prep_lists'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.prep_list_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.prep_list_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.maintenance_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.maintenance_schedules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.maintenance_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.maintenance_tickets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shift_handovers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.shift_handovers'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.operations_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.operations_idempotency'::regclass);
