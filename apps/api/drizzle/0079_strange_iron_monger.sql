ALTER TABLE "payment_unallocated_funds" ADD COLUMN "evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "approval_chain_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "failure_reason" varchar(40);--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "payout_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "payout_pending_polls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "payout_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "payout_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "last_payout_error" varchar(100);--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_approval_chain_uq" ON "payment_refunds" USING btree ("tenant_id","approval_chain_id") WHERE "payment_refunds"."approval_chain_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_provider_ref_idx" ON "payment_refunds" USING btree ("tenant_id","provider_ref") WHERE "payment_refunds"."provider_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_failure_reason_check" CHECK ("payment_refunds"."failure_reason" IS NULL OR "payment_refunds"."failure_reason" IN ('rejected','approval_expired','provider_declined','cap_exceeded','source_document','approver_unauthorized'));--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_failure_reason_status_check" CHECK ("payment_refunds"."failure_reason" IS NULL OR "payment_refunds"."status" = 'failed');--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payout_attempts_check" CHECK ("payment_refunds"."payout_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payout_pending_polls_check" CHECK ("payment_refunds"."payout_pending_polls" >= 0);