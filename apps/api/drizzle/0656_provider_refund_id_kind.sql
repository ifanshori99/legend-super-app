-- legend-yn1of + legend-uvjqq (1035 B): what a provider refund id is, kept in
-- its own column instead of a prefix of the id. A provider may send any id
-- (`payment:...`, `hold:...`, `h:...`), so the id alone no longer decides
-- whether a row is the provider's refund, the payment's own `refunded` status
-- (`synthetic_full`, keyed by the raw provider payment id) or a refund finance
-- counted from a hold that names no refund id (`synthetic_hold`, keyed by the
-- hold id). The unique keys carry the kind, so ids of two kinds never collide.
-- Existing rows are classified from the id forms the code wrote; everything
-- else is the provider's own id.
ALTER TABLE "payment_provider_refunds" DROP CONSTRAINT "payment_provider_refunds_provider_refund_key";--> statement-breakpoint
DROP INDEX "refund_recon_hold_provider_refund_key";--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD COLUMN "refund_id_kind" varchar(20) DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD COLUMN "provider_refund_id_kind" varchar(20);--> statement-breakpoint
-- The payment's own `refunded` status: `payment:<ref>`, or `payment:h:<sha256
-- hex of ref>` for a ref too long for the prefix (1025d).
UPDATE "payment_provider_refunds"
   SET "refund_id_kind" = 'synthetic_full',
       "provider_refund_id" = "provider_payment_ref"
 WHERE "provider_refund_id" = 'payment:' || "provider_payment_ref"
    OR "provider_refund_id" = 'payment:h:' || encode(sha256(convert_to("provider_payment_ref", 'UTF8')), 'hex');--> statement-breakpoint
-- A top-up finance counted from a hold: `hold:<uuid of a hold of the same
-- tenant and intent>`.
UPDATE "payment_provider_refunds" p
   SET "refund_id_kind" = 'synthetic_hold',
       "provider_refund_id" = h."id"::text
  FROM "refund_recon_holds" h
 WHERE p."refund_id_kind" = 'provider'
   AND p."provider_refund_id" ~ '^hold:[0-9a-fA-F-]{36}$'
   AND h."tenant_id" = p."tenant_id"
   AND h."payment_intent_id" = p."payment_intent_id"
   AND h."id"::text = lower(substring(p."provider_refund_id" from 6));--> statement-breakpoint
-- Holds naming the payment's own `refunded` status. A hold with no stored
-- payment id: the plain form names it after the prefix; the hashed form is
-- matched against the intent's own payment id or one of its transactions.
UPDATE "refund_recon_holds"
   SET "provider_refund_id_kind" = 'synthetic_full',
       "provider_refund_id" = "provider_payment_ref"
 WHERE "provider_payment_ref" IS NOT NULL
   AND ("provider_refund_id" = 'payment:' || "provider_payment_ref"
     OR "provider_refund_id" = 'payment:h:' || encode(sha256(convert_to("provider_payment_ref", 'UTF8')), 'hex'));--> statement-breakpoint
UPDATE "refund_recon_holds" h
   SET "provider_refund_id_kind" = 'synthetic_full',
       "provider_refund_id" = m."ref",
       "provider_payment_ref" = m."ref"
  FROM (
    SELECT h2."id", min(c."ref") AS "ref", count(DISTINCT c."ref") AS "n"
      FROM "refund_recon_holds" h2
      JOIN (
        SELECT i."tenant_id", i."id" AS "intent_id", i."provider_ref" AS "ref"
          FROM "payment_intents" i WHERE i."provider_ref" IS NOT NULL
        UNION
        SELECT e."tenant_id", e."payment_intent_id", e."provider_ref"
          FROM "payment_evidence" e
      ) c ON c."tenant_id" = h2."tenant_id" AND c."intent_id" = h2."payment_intent_id"
     WHERE h2."provider_payment_ref" IS NULL
       AND h2."provider_refund_id_kind" IS NULL
       AND h2."provider_refund_id" = 'payment:h:' || encode(sha256(convert_to(c."ref", 'UTF8')), 'hex')
     GROUP BY h2."id"
  ) m
 WHERE h."id" = m."id" AND m."n" = 1;--> statement-breakpoint
UPDATE "refund_recon_holds"
   SET "provider_refund_id_kind" = 'synthetic_full',
       "provider_refund_id" = substring("provider_refund_id" from 9)
 WHERE "provider_payment_ref" IS NULL
   AND "provider_refund_id_kind" IS NULL
   AND "provider_refund_id" LIKE 'payment:%'
   AND "provider_refund_id" !~ '^payment:h:[0-9a-f]{64}$'
   AND length("provider_refund_id") > 8;--> statement-breakpoint
UPDATE "refund_recon_holds" h
   SET "provider_refund_id_kind" = 'synthetic_hold',
       "provider_refund_id" = o."id"::text
  FROM "refund_recon_holds" o
 WHERE h."provider_refund_id_kind" IS NULL
   AND h."provider_refund_id" ~ '^hold:[0-9a-fA-F-]{36}$'
   AND o."tenant_id" = h."tenant_id"
   AND o."payment_intent_id" = h."payment_intent_id"
   AND o."id"::text = lower(substring(h."provider_refund_id" from 6));--> statement-breakpoint
UPDATE "refund_recon_holds"
   SET "provider_refund_id_kind" = 'provider'
 WHERE "provider_refund_id" IS NOT NULL
   AND "provider_refund_id_kind" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_recon_hold_provider_refund_key" ON "refund_recon_holds" USING btree ("tenant_id","payment_intent_id","provider_refund_id_kind","provider_refund_id") WHERE "refund_recon_holds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD CONSTRAINT "payment_provider_refunds_provider_refund_key" UNIQUE("tenant_id","provider","refund_id_kind","provider_refund_id");--> statement-breakpoint
ALTER TABLE "payment_provider_refunds" ADD CONSTRAINT "payment_provider_refunds_refund_id_kind_check" CHECK ("payment_provider_refunds"."refund_id_kind" IN ('provider', 'synthetic_full', 'synthetic_hold'));--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_provider_refund_id_kind_check" CHECK (("refund_recon_holds"."provider_refund_id" IS NULL) = ("refund_recon_holds"."provider_refund_id_kind" IS NULL) AND ("refund_recon_holds"."provider_refund_id_kind" IS NULL OR "refund_recon_holds"."provider_refund_id_kind" IN ('provider', 'synthetic_full', 'synthetic_hold')));
