CREATE TABLE "stock_negative_revaluations" (
	"tenant_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"prior_quantity" numeric(14,4) NOT NULL,
	"prior_avg_cost_idr" numeric(14,4) NOT NULL,
	"unit_cost_idr" numeric(14,4) NOT NULL,
	"value_idr" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_negative_revaluations_tenant_ledger_entry_key" UNIQUE("tenant_id","ledger_entry_id")
);
--> statement-breakpoint
ALTER TABLE "stock_negative_revaluations" ADD CONSTRAINT "stock_negative_revaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_negative_revaluations_source_idx" ON "stock_negative_revaluations" USING btree ("tenant_id","source_id");