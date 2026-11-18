-- legend-yn1of + legend-uvjqq (1035 B): what a provider refund id is, kept in
-- its own column instead of a prefix of the id. A provider may send any id
-- (`payment:...`, `hold:...`, `h:...`), so the id alone no longer decides
-- whether a row is the provider's refund, the payment's own `refunded` status
-- (`synthetic_full`, keyed by the raw provider payment id) or a refund finance
-- counted from a hold that names no refund id (`synthetic_hold`, keyed by the
-- hold id). The unique keys carry the kind, so ids of two kinds never collide.
-- This migration does not guess. An id that already exists could be the
-- provider's own (a provider may send `payment:...` or `hold:...`), so every
-- existing row keeps its id as is and becomes kind 'provider'. The provider's
-- fact is deducted from the remainder when the payment's own `refunded` status
-- arrives, so nothing is counted twice, and the old 3-column keys were unique,
-- so the 4-column keys cannot collide.
ALTER TABLE "payment_provider_refunds" DROP CONSTRAINT "payment_provider_refunds_provider_refund_key";--> statement-breakpoint
DROP INDEX "refund_recon_hold_provider_refund_key";--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD COLUMN "refund_id_kind" varchar(20) DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD COLUMN "provider_refund_id_kind" varchar(20);--> statement-breakpoint
-- Every hold that already names a refund id: the provider's own, id as is.
UPDATE "refund_recon_holds"
   SET "provider_refund_id_kind" = 'provider'
 WHERE "provider_refund_id" IS NOT NULL
   AND "provider_refund_id_kind" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_recon_hold_provider_refund_key" ON "refund_recon_holds" USING btree ("tenant_id","payment_intent_id","provider_refund_id_kind","provider_refund_id") WHERE "refund_recon_holds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD CONSTRAINT "payment_provider_refunds_provider_refund_key" UNIQUE("tenant_id","provider","refund_id_kind","provider_refund_id");--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD CONSTRAINT "payment_provider_refunds_refund_id_kind_check" CHECK ("payment_provider_refunds"."refund_id_kind" IN ('provider', 'synthetic_full', 'synthetic_hold'));--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_provider_refund_id_kind_check" CHECK (("refund_recon_holds"."provider_refund_id" IS NULL) = ("refund_recon_holds"."provider_refund_id_kind" IS NULL) AND ("refund_recon_holds"."provider_refund_id_kind" IS NULL OR "refund_recon_holds"."provider_refund_id_kind" IN ('provider', 'synthetic_full', 'synthetic_hold')));
