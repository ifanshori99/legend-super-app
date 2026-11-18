-- legend-vp4ta (brief 1025b): finance closes a refund_recon_hold. Who closed it
-- (resolved_by), what they decided (resolution) and why (resolution_note) are
-- written together with resolved_at by the resolve endpoint. Existing rows keep
-- NULL: an open hold stays open. The migration writes no row.
ALTER TABLE "refund_recon_holds" ADD COLUMN "resolved_by" uuid;
--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD COLUMN "resolution" text;
--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD COLUMN "resolution_note" text;
--> statement-breakpoint
ALTER TABLE "refund_recon_holds" ADD CONSTRAINT "refund_recon_hold_resolution_check" CHECK ("refund_recon_holds"."resolution" IS NULL OR "refund_recon_holds"."resolution" IN ('not_this_intent', 'counted_against_intent'));
