CREATE TABLE "sales_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"target_idr" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_targets_key" UNIQUE("tenant_id","outlet_id","target_date"),
	CONSTRAINT "sales_targets_target_idr_check" CHECK ("sales_targets"."target_idr" >= 0),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): an ALTER TABLE ... ADD FOREIGN KEY
	-- validates under the FORCE RLS parent's policy and aborts the migration
	-- without app.tenant_id. Inside CREATE TABLE no validation scan runs.
	CONSTRAINT "sales_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "sales_targets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- WS-11 sales_targets: tenant-owned AND outlet-owned (outlet_id NOT NULL), so it
-- gets the RESTRICTIVE tenant policy and, right after it, the outlet policy
-- (TEN-03, guard test src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.sales_targets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.sales_targets'::regclass);
