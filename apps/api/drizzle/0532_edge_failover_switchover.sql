-- 1271 F3 (docs/briefs/1271-edge-failover-cards.md D2, CTO decision 27 Nov):
-- the switchover count C1 of each device's first failover shift, kept in the
-- cloud until the window-closing event carries it to the edge. New table only:
-- no existing row changes. Foreign keys are inline in CREATE TABLE
-- (contracts.md legend-m007 pattern 1: no validation scan, so a plain-owner
-- migrator passes FORCE RLS on the referenced tables). Append-only, tenant +
-- outlet RLS.
CREATE TABLE "outlet_failover_switchover_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"cashier_id" text NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"counts" jsonb NOT NULL,
	"total_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlet_failover_switchover_counts_device_key" UNIQUE("tenant_id","window_id","device_id"),
	CONSTRAINT "outlet_failover_switchover_counts_shift_key" UNIQUE("tenant_id","shift_id"),
	CONSTRAINT "outlet_failover_switchover_counts_total_check" CHECK ("outlet_failover_switchover_counts"."total_idr" >= 0),
	CONSTRAINT "outlet_failover_switchover_counts_counts_check" CHECK (jsonb_typeof("outlet_failover_switchover_counts"."counts") = 'array' AND jsonb_array_length("outlet_failover_switchover_counts"."counts") >= 1),
	CONSTRAINT "outlet_failover_switchover_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_switchover_counts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_switchover_counts_cashier_id_user_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_switchover_counts_window_fk" FOREIGN KEY ("tenant_id","outlet_id","window_id") REFERENCES "public"."outlet_failover_windows"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_switchover_counts_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_switchover_counts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- 1271 F3 switchover counts (0532). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other edge tables.
SELECT app.enforce_tenant_rls('public.outlet_failover_switchover_counts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_failover_switchover_counts'::regclass);
--> statement-breakpoint
-- The switchover count C1 closes the interrupted edge shift (D2): once
-- written it never changes and is never deleted.
CREATE FUNCTION app.guard_outlet_failover_switchover_count() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'failover switchover counts are append-only' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER outlet_failover_switchover_counts_guard BEFORE UPDATE OR DELETE ON public.outlet_failover_switchover_counts
FOR EACH ROW EXECUTE FUNCTION app.guard_outlet_failover_switchover_count();
