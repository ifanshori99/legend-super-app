-- Custom SQL migration file, put your code below! ---
-- HRIS edge replication (bead legend-hwn02, C1; design
-- docs/design/hris-edge-replication.md section 8). Folded into migration 0226
-- after the CREATE TABLEs. All four tables are tenant + outlet owned;
-- edge_received_selfies (cloud) is tenant + outlet owned too (outlet_id NOT NULL,
-- TEN-03, architect review) and append-only.
SELECT app.enforce_tenant_rls('public.edge_people_sync_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_people_sync_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_attendance_qr_keys'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_attendance_qr_keys'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_selfie_uploads'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_selfie_uploads'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_received_selfies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_received_selfies'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_received_selfies_append_only BEFORE UPDATE OR DELETE ON public.edge_received_selfies
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
