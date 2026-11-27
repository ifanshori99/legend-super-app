-- B2 (legend-wasr7.21): EDC bridge tablets, terminal leases and commands for
-- the cloud EDC agent; terminal connection kind (bridge | bca_cloud) and link;
-- BRI in every EDC bank CHECK. After 0540.
CREATE TABLE "edc_bridge_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "edc_bridge_devices_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "edc_bridge_devices_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "edc_bridge_devices_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "edc_bridge_devices_token_hash_check" CHECK ("edc_bridge_devices"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "edc_bridge_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"op" varchar(10) NOT NULL,
	"trace" varchar(32) NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"result_outcome" varchar(20),
	"result_at" timestamp with time zone,
	"result_evidence" jsonb,
	"release_sent_at" timestamp with time zone,
	CONSTRAINT "edc_bridge_commands_op_check" CHECK ("edc_bridge_commands"."op" IN ('sale','cancel','inquiry','void')),
	CONSTRAINT "edc_bridge_commands_outcome_check" CHECK ("edc_bridge_commands"."result_outcome" IS NULL OR "edc_bridge_commands"."result_outcome" IN ('response','transport_error','refused')),
	CONSTRAINT "edc_bridge_commands_result_check" CHECK (("edc_bridge_commands"."result_outcome" IS NULL) = ("edc_bridge_commands"."result_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "edc_bridge_terminal_leases" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"terminal_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"ttl_ms" integer NOT NULL,
	CONSTRAINT "edc_bridge_terminal_leases_ttl_check" CHECK ("edc_bridge_terminal_leases"."ttl_ms" BETWEEN 10000 AND 600000)
);
--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" DROP CONSTRAINT "payment_edc_terminals_bank_check";--> statement-breakpoint
ALTER TABLE "edc_transactions" DROP CONSTRAINT "edc_transactions_bank_check";--> statement-breakpoint
ALTER TABLE "edc_settlement_files" DROP CONSTRAINT "edc_settlement_files_bank_check";--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD COLUMN "connection_kind" varchar(20) DEFAULT 'bridge' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD COLUMN "bridge_device_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD COLUMN "link_port" integer;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD COLUMN "link_baud_rate" integer;--> statement-breakpoint
ALTER TABLE "edc_bridge_devices" ADD CONSTRAINT "edc_bridge_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_devices" ADD CONSTRAINT "edc_bridge_devices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_devices" ADD CONSTRAINT "edc_bridge_devices_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_commands" ADD CONSTRAINT "edc_bridge_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_commands" ADD CONSTRAINT "edc_bridge_commands_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_commands" ADD CONSTRAINT "edc_bridge_commands_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."edc_bridge_devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_commands" ADD CONSTRAINT "edc_bridge_commands_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_id") REFERENCES "public"."payment_edc_terminals"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_commands" ADD CONSTRAINT "edc_bridge_commands_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_terminal_leases" ADD CONSTRAINT "edc_bridge_terminal_leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_terminal_leases" ADD CONSTRAINT "edc_bridge_terminal_leases_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_terminal_leases" ADD CONSTRAINT "edc_bridge_terminal_leases_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."edc_bridge_devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_terminal_leases" ADD CONSTRAINT "edc_bridge_terminal_leases_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_id") REFERENCES "public"."payment_edc_terminals"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edc_bridge_terminal_leases" ADD CONSTRAINT "edc_bridge_terminal_leases_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edc_bridge_commands_trace_idx" ON "edc_bridge_commands" USING btree ("tenant_id","terminal_id","trace");--> statement-breakpoint
CREATE INDEX "edc_bridge_commands_device_release_idx" ON "edc_bridge_commands" USING btree ("tenant_id","device_id","release_sent_at");--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_bridge_device_fk" FOREIGN KEY ("tenant_id","outlet_id","bridge_device_id") REFERENCES "public"."edc_bridge_devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_connection_kind_check" CHECK ("payment_edc_terminals"."connection_kind" IN ('bridge','bca_cloud'));--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_link_port_check" CHECK ("payment_edc_terminals"."link_port" IS NULL OR "payment_edc_terminals"."link_port" BETWEEN 1 AND 65535);--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_link_baud_check" CHECK ("payment_edc_terminals"."link_baud_rate" IS NULL OR "payment_edc_terminals"."link_baud_rate" IN (9600,19200,38400,57600,115200));--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD CONSTRAINT "payment_edc_terminals_bank_check" CHECK ("payment_edc_terminals"."bank_code" IN ('bca','mandiri','bni','bjb','bri'));--> statement-breakpoint
ALTER TABLE "edc_transactions" ADD CONSTRAINT "edc_transactions_bank_check" CHECK ("edc_transactions"."bank" IN ('bca','mandiri','bni','bjb','bri'));--> statement-breakpoint
ALTER TABLE "edc_settlement_files" ADD CONSTRAINT "edc_settlement_files_bank_check" CHECK ("edc_settlement_files"."bank" IN ('bca','mandiri','bni','bjb','bri'));
--> statement-breakpoint
-- EDC bridge (B2, legend-wasr7.21), as in drizzle/0541_edc_bridge.sql. Tenant
-- RLS (TEN-01/02) plus the outlet backstop (TEN-03). Nothing is ever deleted
-- by the app role: a device is revoked, a lease expires, a command is history.
SELECT app.enforce_tenant_rls('public.edc_bridge_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_devices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_bridge_terminal_leases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_terminal_leases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edc_bridge_commands'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edc_bridge_commands'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_devices FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_terminal_leases FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.edc_bridge_commands FROM legend_app;
--> statement-breakpoint
-- Pre-auth lookup (as app.mcp_resolve_token, 0114): a WSS upgrade carries only
-- the device token, no tenant. Returns at most the row id and tenant id of the
-- token's SHA-256 hash (a 256-bit secret: naming it means holding the token).
-- The caller re-reads the row under tenant RLS and compares the hash in
-- constant time, so revocation is checked there.
CREATE FUNCTION app.edc_bridge_resolve_token(p_token_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id, d.tenant_id FROM public.edc_bridge_devices d WHERE d.token_hash = p_token_hash LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.edc_bridge_resolve_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.edc_bridge_resolve_token(text) TO legend_app;
