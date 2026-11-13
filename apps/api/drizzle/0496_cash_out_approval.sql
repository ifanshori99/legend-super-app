ALTER TABLE "cash_bank_entries" ALTER COLUMN "journal_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_policies" ADD COLUMN "cash_out_approval_limit_idr" bigint;--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD COLUMN "status" varchar(20) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD COLUMN "approver_id" text;--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD COLUMN "decision_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "finance_policies" ADD CONSTRAINT "finance_policies_cash_out_limit_check" CHECK ("finance_policies"."cash_out_approval_limit_idr" IS NULL OR "finance_policies"."cash_out_approval_limit_idr" BETWEEN 1 AND 100000000000);--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD CONSTRAINT "cash_bank_entries_status_check" CHECK ("cash_bank_entries"."status" IN ('pending_approval','approved','rejected'));--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD CONSTRAINT "cash_bank_entries_status_journal_check" CHECK (("cash_bank_entries"."status" = 'approved') = ("cash_bank_entries"."journal_entry_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD CONSTRAINT "cash_bank_entries_status_kind_check" CHECK ("cash_bank_entries"."status" = 'approved' OR "cash_bank_entries"."kind" = 'cash_out');--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD CONSTRAINT "cash_bank_entries_decision_check" CHECK (("cash_bank_entries"."status" <> 'pending_approval' OR ("cash_bank_entries"."approver_id" IS NULL AND "cash_bank_entries"."decided_at" IS NULL)) AND ("cash_bank_entries"."status" <> 'rejected' OR ("cash_bank_entries"."approver_id" IS NOT NULL AND "cash_bank_entries"."decided_at" IS NOT NULL AND "cash_bank_entries"."decision_reason" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "cash_bank_entries" ADD CONSTRAINT "cash_bank_entries_distinct_decider_check" CHECK ("cash_bank_entries"."approver_id" IS NULL OR "cash_bank_entries"."approver_id" <> "cash_bank_entries"."created_by");