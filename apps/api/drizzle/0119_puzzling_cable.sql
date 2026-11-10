CREATE TABLE "outlet_open_bill_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"max_bill_value_idr" bigint NOT NULL,
	"inactivity_minutes" integer NOT NULL,
	"bill_request_slo_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlet_open_bill_policies_tenant_outlet_key" UNIQUE("tenant_id","outlet_id"),
	CONSTRAINT "outlet_open_bill_policies_max_value_check" CHECK ("outlet_open_bill_policies"."max_bill_value_idr" > 0),
	CONSTRAINT "outlet_open_bill_policies_inactivity_check" CHECK ("outlet_open_bill_policies"."inactivity_minutes" > 0),
	CONSTRAINT "outlet_open_bill_policies_slo_check" CHECK ("outlet_open_bill_policies"."bill_request_slo_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_total_check";--> statement-breakpoint
ALTER TABLE "table_sessions" ADD COLUMN "inactivity_alerted_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "prices_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets. Lift FORCE on outlets for this transaction
-- only; it is restored right after the last foreign key, before commit
-- (drizzle applies pending migrations in one transaction, so no other session
-- ever sees the lifted state). tenants never had FORCE, so it is left alone.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outlet_open_bill_policies" ADD CONSTRAINT "outlet_open_bill_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_open_bill_policies" ADD CONSTRAINT "outlet_open_bill_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_open_bill_policies" ADD CONSTRAINT "outlet_open_bill_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK (("orders"."prices_include_tax" = false AND "orders"."total_idr" = "orders"."subtotal_idr" - "orders"."discount_idr" + "orders"."service_charge_idr" + "orders"."tax_idr" + "orders"."rounding_idr") OR ("orders"."prices_include_tax" = true AND "orders"."total_idr" = "orders"."subtotal_idr" - "orders"."discount_idr" + "orders"."rounding_idr" AND "orders"."service_charge_idr" + "orders"."tax_idr" <= "orders"."subtotal_idr" - "orders"."discount_idr"));