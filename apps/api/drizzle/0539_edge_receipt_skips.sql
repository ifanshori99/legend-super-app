CREATE TABLE "edge_receipt_skips" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_number" varchar(64) NOT NULL,
	"reason" varchar(40) NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_receipt_skips_tenant_id_outlet_id_order_id_receipt_number_reason_pk" PRIMARY KEY("tenant_id","outlet_id","order_id","receipt_number","reason")
);
--> statement-breakpoint
ALTER TABLE "edge_receipt_skips" ADD CONSTRAINT "edge_receipt_skips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_receipt_skips" ADD CONSTRAINT "edge_receipt_skips_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_receipt_skips_event_idx" ON "edge_receipt_skips" USING btree ("tenant_id","event_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_receipt_skips'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_receipt_skips'::regclass);
--> statement-breakpoint
-- legend-n1fzg: skipped receipts are evidence, append-only like the receipts.
CREATE TRIGGER edge_receipt_skips_append_only BEFORE UPDATE OR DELETE ON public.edge_receipt_skips
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
