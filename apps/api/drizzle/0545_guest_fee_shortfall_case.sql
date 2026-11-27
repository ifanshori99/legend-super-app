-- 1272 K2 (legend-osqou.57; design duitku-fee-passthrough §2, §6): a
-- reconciliation case says what it is about. 'amount' (every existing row) or
-- 'guest_fee_shortfall': the gateway fee on a matched line was above the
-- guest service fee collected. A constant default is metadata only in
-- PostgreSQL 11+ (no table rewrite); the CHECK scans the small cases table
-- once. No row is changed, no FK. After 0544.
ALTER TABLE "payment_reconciliation_cases" ADD COLUMN "kind" varchar(30) DEFAULT 'amount' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_kind_check" CHECK ("payment_reconciliation_cases"."kind" IN ('amount','guest_fee_shortfall'));