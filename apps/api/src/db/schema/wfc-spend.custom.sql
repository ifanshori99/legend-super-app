-- Hand SQL for wfc_spend_windows (bead legend-bz9h; PRD v1.7 §3 F39, FAC-14).
-- To be appended to the generated `wfc_products` migration by the lead.
SELECT app.enforce_tenant_rls('public.wfc_spend_windows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_spend_windows'::regclass);
