-- Append after the generated pos_parked_orders table/index DDL.
SELECT app.enforce_tenant_rls('public.pos_parked_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_parked_orders'::regclass);
--> statement-breakpoint
-- Raw snapshots and replay keys are immutable; resume only sets consumed_at.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.pos_parked_orders FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (consumed_at) ON TABLE public.pos_parked_orders TO legend_app;
