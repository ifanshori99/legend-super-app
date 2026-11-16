-- legend-3wpf: "the provider answered" gets its own column instead of being read
-- from `updated_at < expires_at` (any unrelated touch of the row moves
-- `updated_at`). Backfill only the rows the old rules already proved answered:
-- `provider_final_at` is set only by a provider answer (or reconciled money).
-- Every other old row stays null, i.e. "no answer yet", the side that keeps
-- asking the provider inside the 24 hour window and never pays or releases more.
ALTER TABLE "payment_intents" ADD COLUMN "provider_answered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payment_intents" SET "provider_answered_at" = "provider_final_at" WHERE "provider_final_at" IS NOT NULL;
