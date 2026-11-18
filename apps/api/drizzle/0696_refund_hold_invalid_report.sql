-- 1090 P1-2 (refund round 9): a hold of an unreadable signed success carries an
-- id we make up (`invalid:<id>`, or `invalid-h:<sha256>` for a long id). It had
-- kind 'provider', so a real provider refund id equal to that made-up id met
-- the same unique key and was taken for the same evidence. The new kind
-- 'invalid_report' keeps the two domains apart.
-- Existing holds: this migration relabels only a conflict hold whose id carries
-- one of the two made-up prefixes (the only holds the code ever filed under
-- them), so a report of the same unreadable event is still found by the new
-- code and no provider id can match them. A provider id that really starts
-- with `invalid:` would be relabelled too; that only makes later reports of it
-- open a new hold (restrictive). The unique key carries the kind, so no row
-- can collide with another.
ALTER TABLE "refund_recon_holds" DROP CONSTRAINT "refund_recon_hold_provider_refund_id_kind_check";--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_provider_refund_id_kind_check" CHECK (("refund_recon_holds"."provider_refund_id" IS NULL) = ("refund_recon_holds"."provider_refund_id_kind" IS NULL) AND ("refund_recon_holds"."provider_refund_id_kind" IS NULL OR "refund_recon_holds"."provider_refund_id_kind" IN ('provider', 'synthetic_full', 'synthetic_hold', 'invalid_report')));--> statement-breakpoint
UPDATE "refund_recon_holds"
   SET "provider_refund_id_kind" = 'invalid_report'
 WHERE "provider_refund_id_kind" = 'provider'
   AND ("provider_refund_id" LIKE 'invalid:%' OR "provider_refund_id" LIKE 'invalid-h:%')
   AND "reason" = 'Nomor refund penyedia sudah tercatat di transaksi lain (HOLD_TRANSACTION_CONFLICT)';
