-- Custom SQL migration file, put your code below! ---
-- Per-outlet promotion switch (bead legend-e5it): tenant RLS (TEN-01/02) and
-- outlet RLS (TEN-03, legend-tjey) on the outlet-owned promotion_outlets.
SELECT app.enforce_tenant_rls('public.promotion_outlets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.promotion_outlets'::regclass);
