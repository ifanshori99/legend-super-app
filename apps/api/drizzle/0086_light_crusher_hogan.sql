CREATE TABLE "inventory_gl_blocked" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" text NOT NULL,
	"error_code" varchar(60) NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_gl_blocked_tenant_source_key" UNIQUE("tenant_id","source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_gl_postings" (
	"tenant_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" text NOT NULL,
	"journal_entry_id" uuid,
	"value_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_gl_postings_tenant_ledger_entry_key" UNIQUE("tenant_id","ledger_entry_id")
);
--> statement-breakpoint
ALTER TABLE "inventory_gl_blocked" ADD CONSTRAINT "inventory_gl_blocked_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_gl_postings" ADD CONSTRAINT "inventory_gl_postings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_gl_blocked_retry_idx" ON "inventory_gl_blocked" USING btree ("tenant_id","first_failed_at");--> statement-breakpoint
CREATE INDEX "inventory_gl_postings_source_idx" ON "inventory_gl_postings" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_tenant_source_idx" ON "stock_ledger" USING btree ("tenant_id","source_type","source_id");