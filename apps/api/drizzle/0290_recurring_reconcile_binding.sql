-- Recurring billing round 3 (bead 6c6): additive only. A start intent is stored
-- before the DOIT call (`provisioning`), an unconfirmed gateway outcome is kept
-- as `needs_reconcile`, a paid future period waits in next_period_*, and the
-- webhook inbox remembers which integrations verified a recurring invoice event.
ALTER TABLE "payment_recurring_subscriptions" ALTER COLUMN "provider_subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD COLUMN "start_idempotency_key" varchar(200);--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD COLUMN "reconcile_reason" varchar(100);--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD COLUMN "next_period_start" date;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD COLUMN "next_period_end" date;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" DROP CONSTRAINT "payment_recurring_subscriptions_status_check";--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_status_check" CHECK ("payment_recurring_subscriptions"."status" IN ('pending_first_payment', 'active', 'past_due', 'paused', 'cancelled', 'provisioning', 'needs_reconcile'));--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_provider_sub_check" CHECK ("payment_recurring_subscriptions"."provider_subscription_id" IS NOT NULL OR "payment_recurring_subscriptions"."status" IN ('provisioning', 'needs_reconcile'));--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_next_period_check" CHECK (("payment_recurring_subscriptions"."next_period_start" IS NULL) = ("payment_recurring_subscriptions"."next_period_end" IS NULL) AND ("payment_recurring_subscriptions"."next_period_start" IS NULL OR "payment_recurring_subscriptions"."next_period_end" > "payment_recurring_subscriptions"."next_period_start"));--> statement-breakpoint
CREATE UNIQUE INDEX "payment_recurring_subscriptions_start_key" ON "payment_recurring_subscriptions" USING btree ("tenant_id","start_idempotency_key") WHERE "payment_recurring_subscriptions"."start_idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_webhook_events" ADD COLUMN "verified_integration_ids" uuid[];
