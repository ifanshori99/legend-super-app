-- legend-fnxl.10: a bank recon match turns stale when its journal is reversed.
-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS; see
-- 0065). The foreign key below is validated by a query that FORCE ROW LEVEL
-- SECURITY would run under the tenant policies, which raise 42501 without
-- app.tenant_id. Lift FORCE on both tables for this transaction only; it is
-- restored at the end of this migration (drizzle applies pending migrations in
-- one transaction). Lift the referenced parent (journal_entries) before the
-- child (bank_statement_line_matches), the same order the restore at the end
-- of this file uses.
ALTER TABLE public.journal_entries NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bank_statement_line_matches NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD COLUMN "stale_by_reversal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD CONSTRAINT "bank_statement_line_matches_stale_reversal_fk" FOREIGN KEY ("tenant_id","stale_by_reversal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD CONSTRAINT "bank_statement_line_matches_stale_check" CHECK (("bank_statement_line_matches"."stale_at" IS NULL) = ("bank_statement_line_matches"."stale_by_reversal_entry_id" IS NULL));
--> statement-breakpoint
ALTER TABLE public.journal_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bank_statement_line_matches FORCE ROW LEVEL SECURITY;
