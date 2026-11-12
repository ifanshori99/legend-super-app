CREATE TABLE "edge_voucher_catalog" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL,
	CONSTRAINT "edge_voucher_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "edge_voucher_catalog_sync_txid_idx" ON "edge_voucher_catalog" USING btree ("tenant_id","sync_txid","id");
--> statement-breakpoint
-- Read-only voucher metadata is tenant-owned even when referenced holders
-- and orders have not been replicated to this edge.
SELECT app.enforce_tenant_rls('public.edge_voucher_catalog'::regclass);
