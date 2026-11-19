ALTER TABLE "refund_recon_holds" ADD COLUMN "matched_fact_id" uuid;--> statement-breakpoint
-- ADD CONSTRAINT FOREIGN KEY validates existing rows with a scan of both
-- tables as the owner. They are FORCE RLS and the migration role is a non-super
-- table owner with no tenant context, so FORCE is lifted for this statement
-- only (same pattern as 0141) and restored in the same migration transaction.
ALTER TABLE "refund_recon_holds" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_matched_fact_fk" FOREIGN KEY ("matched_fact_id") REFERENCES "public"."payment_provider_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_recon_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_recon_hold_matched_fact_key" ON "refund_recon_holds" USING btree ("tenant_id","matched_fact_id") WHERE "refund_recon_holds"."matched_fact_id" IS NOT NULL;