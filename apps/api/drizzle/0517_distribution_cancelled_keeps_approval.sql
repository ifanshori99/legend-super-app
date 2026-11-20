-- SO 1216 F-P1a review (card 1217): a run cancelled after approval
-- (cancel_approved, 0516) keeps approved_by/approved_at for the audit. The
-- 0217 check allowed an approval on approved/paid only; it now also allows
-- it on a cancelled run. Draft and pending runs still carry none.
ALTER TABLE "distribution_runs" DROP CONSTRAINT "distribution_runs_approved_check";--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD CONSTRAINT "distribution_runs_approved_check" CHECK (("distribution_runs"."status" IN ('approved', 'paid')) = ("distribution_runs"."approved_by" IS NOT NULL AND "distribution_runs"."approved_at" IS NOT NULL) OR ("distribution_runs"."status" = 'cancelled' AND "distribution_runs"."approved_by" IS NOT NULL AND "distribution_runs"."approved_at" IS NOT NULL));