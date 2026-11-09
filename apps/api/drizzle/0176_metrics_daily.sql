CREATE TABLE "metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"metric_code" varchar(64) NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"dimension_key" varchar(40),
	"dimension_value" varchar(200),
	"unit" varchar(10) NOT NULL,
	"value_int" bigint,
	"value_decimal" numeric(14, 4),
	"finality" varchar(10) NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_daily_key" UNIQUE NULLS NOT DISTINCT("tenant_id","outlet_id","metric_date","metric_code","dimension_key","dimension_value"),
	CONSTRAINT "metrics_daily_definition_version_check" CHECK ("metrics_daily"."definition_version" > 0),
	CONSTRAINT "metrics_daily_dimension_key_check" CHECK ("metrics_daily"."dimension_key" <> 'outlet'),
	CONSTRAINT "metrics_daily_dimension_pair_check" CHECK (("metrics_daily"."dimension_key" IS NULL) = ("metrics_daily"."dimension_value" IS NULL)),
	CONSTRAINT "metrics_daily_unit_check" CHECK ("metrics_daily"."unit" IN ('idr', 'count', 'percent', 'decimal', 'seconds')),
	CONSTRAINT "metrics_daily_value_check" CHECK (("metrics_daily"."unit" IN ('idr', 'count', 'seconds') AND "metrics_daily"."value_int" IS NOT NULL AND "metrics_daily"."value_decimal" IS NULL) OR ("metrics_daily"."unit" IN ('percent', 'decimal') AND "metrics_daily"."value_decimal" IS NOT NULL AND "metrics_daily"."value_int" IS NULL)),
	CONSTRAINT "metrics_daily_finality_check" CHECK ("metrics_daily"."finality" IN ('estimate', 'final')),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): an ALTER TABLE ... ADD FOREIGN KEY
	-- validates under the FORCE RLS parent's policy and aborts the migration
	-- without app.tenant_id. Inside CREATE TABLE no validation scan runs.
	CONSTRAINT "metrics_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "metrics_daily_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "metrics_daily_code_date_idx" ON "metrics_daily" USING btree ("tenant_id","metric_code","metric_date","outlet_id");
--> statement-breakpoint
-- WS-11 metrics_daily: tenant-owned AND outlet-owned (outlet_id NOT NULL), so it
-- gets the RESTRICTIVE tenant policy and, right after it, the outlet policy
-- (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.metrics_daily'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.metrics_daily'::regclass);
