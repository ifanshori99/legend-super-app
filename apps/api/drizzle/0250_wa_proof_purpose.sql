-- WhatsApp proof purpose (bead legend-lgfru, design
-- docs/design/whatsapp-inbound-verification.md §5.1). Renumbered from temporary 0272 by the merge train.
-- login_challenges gains purpose / expected_sender_hash / consumed_at and three
-- CHECKs, so a payslip PIN reset proof can never carry a login result.
-- user_identities gains linked_at (existing rows: the migration time, design
-- D-WA3) and a trigger that resets it when the owner or verified_at changes.
-- wa_inbound_messages.kind accepts 'proof'.
ALTER TABLE "wa_inbound_messages" DROP CONSTRAINT "wa_inbound_messages_kind_check";--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "purpose" varchar(32) DEFAULT 'sign_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "expected_sender_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "linked_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "login_challenges_purpose_user_idx" ON "login_challenges" USING btree ("purpose","link_user_id","created_at");--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_purpose_check" CHECK ("login_challenges"."purpose" IN ('sign_in', 'payslip_pin_reset'));--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_proof_shape_check" CHECK ("login_challenges"."purpose" = 'sign_in' OR ("login_challenges"."channel" = 'whatsapp_inbound' AND "login_challenges"."tenant_id" IS NOT NULL AND "login_challenges"."link_user_id" IS NOT NULL AND "login_challenges"."link_session_id" IS NOT NULL AND "login_challenges"."expected_sender_hash" IS NOT NULL AND "login_challenges"."matched_user_id" IS NULL AND "login_challenges"."session_id" IS NULL AND "login_challenges"."session_issued_at" IS NULL));--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_consumed_check" CHECK ("login_challenges"."consumed_at" IS NULL OR ("login_challenges"."purpose" <> 'sign_in' AND "login_challenges"."status" = 'completed'));--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_kind_check" CHECK ("wa_inbound_messages"."kind" IN ('login', 'proof', 'unknown', 'rejected', 'rate_limited'));
--> statement-breakpoint
-- D-WA3: a merge moves an identity with UPDATE user_id and a late verification
-- sets verified_at; either way the link counts as new from now on. A trigger,
-- not application code, so no path can forget it.
CREATE OR REPLACE FUNCTION app.user_identities_linked_at_on_owner_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    NEW.linked_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_identities_linked_at_on_owner_change"
  BEFORE UPDATE OF user_id, verified_at ON public.user_identities
  FOR EACH ROW EXECUTE FUNCTION app.user_identities_linked_at_on_owner_change();
