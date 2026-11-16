-- SO-885 (legend-05pjx): a failed refund that keeps an awaiting_payment guest
-- QR order held is escalated at once with its own reason.
ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_escalation_reason_check";--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_escalation_reason_check" CHECK ("payment_refunds"."escalation_reason" IS NULL OR "payment_refunds"."escalation_reason" IN ('pending_unapproved','provider_pending','payout_stalled','failed_holds_order'));
