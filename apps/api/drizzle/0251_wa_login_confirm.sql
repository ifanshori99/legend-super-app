-- Card w8dfz.1: a WhatsApp login may require the person to confirm the masked
-- sender number (or press "Bukan saya") before any session is issued.
-- Opt-in per challenge; existing rows keep confirm_required = false.
ALTER TABLE "login_challenges" ADD COLUMN "sender_masked" text;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "confirm_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "confirmed_at" timestamp with time zone;
