SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "edge_printer_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edge_printers" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "edge_printer_tombstones" ADD CONSTRAINT "edge_printer_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_printer_tombstones" ADD CONSTRAINT "edge_printer_tombstones_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_printer_tombstones" ADD CONSTRAINT "edge_printer_tombstones_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_printer_tombstones_sync_txid_idx" ON "edge_printer_tombstones" USING btree ("tenant_id","outlet_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "edge_printers_sync_txid_idx" ON "edge_printers" USING btree ("tenant_id","outlet_id","sync_txid","id");
