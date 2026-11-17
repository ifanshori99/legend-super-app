-- legend-ycb85 / legend-yqne1: one unresolved (provisioning or needs_reconcile)
-- DOIT subscription per customer and plan, with or without a provider id
-- (before, a PLAN_MISMATCH row holding a DOIT id let a second start through, so
-- DOIT could charge for both). `startSubscription` refuses a second start with
-- CONFLICT before DOIT is contacted; this index is the last line of defence.
--
-- Existing data: if a customer + plan already has more than one unresolved row
-- the index cannot be built. Instead of an opaque 23505 this stops with the
-- number of groups; the team decides per group (check DOIT, then cancel or
-- reconcile the extra row). Nothing is changed or deleted here.
-- The duplicate check reads a FORCE RLS table; a non-superuser owner migrator has no tenant
-- context and the read fails with "tenant context is required". RLS is un-forced for the
-- check and forced again right after (same pattern as 0266).
ALTER TABLE public.payment_recurring_subscriptions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1
      FROM "payment_recurring_subscriptions"
     WHERE "status" IN ('provisioning', 'needs_reconcile')
     GROUP BY "tenant_id", "plan_id", "customer_profile_id"
    HAVING count(*) > 1
  ) AS duplicated;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'payment_recurring_subscriptions: % customer+plan group(s) have more than one provisioning/needs_reconcile row; resolve them before migrating (see 0500 header)', dup_count;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE public.payment_recurring_subscriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_recurring_subscriptions_unresolved_customer_plan_key" ON "payment_recurring_subscriptions" USING btree ("tenant_id","plan_id","customer_profile_id") WHERE "payment_recurring_subscriptions"."status" IN ('provisioning', 'needs_reconcile');--> statement-breakpoint
-- Also: a start intent that DOIT confirmed it never created is `cancelled` without a
-- provider id (reconcile tool), so the provider-id CHECK allows null for it too.
ALTER TABLE "payment_recurring_subscriptions" DROP CONSTRAINT "payment_recurring_subscriptions_provider_sub_check";--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_provider_sub_check" CHECK ("payment_recurring_subscriptions"."provider_subscription_id" IS NOT NULL OR "payment_recurring_subscriptions"."status" IN ('provisioning', 'needs_reconcile', 'cancelled'));
