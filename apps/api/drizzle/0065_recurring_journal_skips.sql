ALTER TABLE "recurring_journal_runs" ALTER COLUMN "journal_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD COLUMN "skipped_by" text;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD COLUMN "skip_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_posted_or_skipped_check" CHECK (("recurring_journal_runs"."journal_entry_id" IS NOT NULL) <> ("recurring_journal_runs"."skipped_by" IS NOT NULL));