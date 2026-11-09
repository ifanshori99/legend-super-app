-- Hand-copied from src/db/schema/delivery.custom.sql (legend-5bn3).
-- Custom SQL migration fragment for legend-5bn3 (WS-08 delivery channel
-- framework). Append AFTER the drizzle-generated CREATE TABLE statements for
-- delivery_channels, delivery_channel_orders and delivery_settlement_lines.
--
-- Tenant + outlet RLS (TEN-01/TEN-03). Platform orders and statement lines are
-- financial history: the app role never deletes them. A channel row is
-- configuration and may be removed.
SELECT app.enforce_tenant_rls('public.delivery_channels'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.delivery_channels'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.delivery_channel_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.delivery_channel_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.delivery_settlement_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.delivery_settlement_lines'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_channel_orders FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_settlement_lines FROM legend_app;
