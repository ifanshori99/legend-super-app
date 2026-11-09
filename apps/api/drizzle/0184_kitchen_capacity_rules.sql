CREATE TABLE "kitchen_capacity_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"window_minutes" integer NOT NULL,
	"capacity_points" integer NOT NULL,
	"near_capacity_bp" integer NOT NULL,
	"schedule" jsonb NOT NULL,
	"channel_priority" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_capacity_rules_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_capacity_rules_window_check" CHECK ("kitchen_capacity_rules"."window_minutes" BETWEEN 5 AND 60 AND "kitchen_capacity_rules"."window_minutes" % 5 = 0),
	CONSTRAINT "kitchen_capacity_rules_points_check" CHECK ("kitchen_capacity_rules"."capacity_points" > 0),
	CONSTRAINT "kitchen_capacity_rules_near_bp_check" CHECK ("kitchen_capacity_rules"."near_capacity_bp" > 0),
	CONSTRAINT "kitchen_capacity_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "kitchen_capacity_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "kitchen_capacity_rules_station_fk" FOREIGN KEY ("tenant_id","station_id") REFERENCES "public"."stations"("tenant_id","id"),
	CONSTRAINT "kitchen_capacity_rules_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "kitchen_capacity_rules_outlet_station_idx" ON "kitchen_capacity_rules" USING btree ("tenant_id","outlet_id","station_id","window_minutes");
--> statement-breakpoint
-- Tenant + outlet RLS (TEN-01/TEN-03). kitchen_capacity_rules has outlet_id NOT NULL.
-- Kitchen config replaces a station's list, so rows are inserted and deleted by the API.
SELECT app.enforce_tenant_rls('public.kitchen_capacity_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.kitchen_capacity_rules'::regclass);
