-- legend-3wpf: "the provider answered" gets its own column instead of being read
-- from `updated_at < expires_at` (any unrelated touch of the row moves
-- `updated_at`). Backfill only the rows the old rules already proved answered:
-- `provider_final_at` is set only by a provider answer (or reconciled money).
-- Every other old row stays null, i.e. "no answer yet", the side that keeps
-- asking the provider inside the 24 hour window and never pays or releases more.
--
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS; see
-- 0065). The backfill UPDATE would run under the tenant and outlet policies of
-- FORCE ROW LEVEL SECURITY, which raise 42501 or touch no rows without
-- app.tenant_id. Lift FORCE on payment_intents for this transaction only; it is
-- restored at the end of this migration (drizzle applies pending migrations in
-- one transaction).
ALTER TABLE public.payment_intents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "provider_answered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payment_intents" SET "provider_answered_at" = "provider_final_at" WHERE "provider_final_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.payment_intents FORCE ROW LEVEL SECURITY;
