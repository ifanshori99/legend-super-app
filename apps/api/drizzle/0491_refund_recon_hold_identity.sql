-- legend-818ap (brief 1055 G1, architect AP1): what finance said a counted
-- hold is when its transaction has a refund counted from a hold without a
-- refund id that may be the same money. NULL for every existing hold (none was
-- resolved with this choice).
-- 1055 AV-P2: one hold per provider refund id is now per intent AND provider
-- transaction (a missing payment id counts as one value), so a closed hold of
-- the id on one transaction never stops the hold of another. Existing rows
-- stay unique under the wider key. The migration writes no row.
DROP INDEX "refund_recon_hold_provider_refund_key";--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD COLUMN "resolution_identity" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX "refund_recon_hold_provider_refund_key" ON "refund_recon_holds" USING btree ("tenant_id","payment_intent_id","provider_refund_id_kind","provider_refund_id",coalesce("provider_payment_ref", '')) WHERE "refund_recon_holds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_resolution_identity_check" CHECK ("refund_recon_holds"."resolution_identity" IS NULL OR "refund_recon_holds"."resolution_identity" IN ('same_as_counted', 'separate'));