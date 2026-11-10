-- Fold in by hand after the generated CREATE TABLE statements (migration 0216).
SELECT app.enforce_tenant_rls('public.kitchen_menu_loads'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_menu_loads'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_channel_pauses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_channel_pauses'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.kitchen_pacing_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_pacing_state'::regclass);
