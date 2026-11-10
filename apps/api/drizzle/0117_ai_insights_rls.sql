-- Custom SQL migration file, put your code below! ---
-- AI insights (beads legend-hkd4, legend-lely; PRD v1.7 §3 Fitur 38, AI-07,
-- AI-09, AI-10): every table is tenant-owned AND outlet-owned (outlet_id NOT
-- NULL), so each gets the RESTRICTIVE tenant policy and, right after it, the
-- outlet policy (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.forecasts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.forecasts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_anomaly_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.ai_anomaly_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.ai_daily_summaries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.ai_daily_summaries'::regclass);
