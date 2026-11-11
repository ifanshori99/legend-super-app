-- brief 488 item 1: one pending or active DOIT subscription per customer and
-- plan, whatever the idempotency key (two parallel starts with different keys
-- used to create two subscriptions). `startSubscription` also takes a per
-- customer + plan lock before the gateway call, so the loser is refused with
-- CONFLICT before DOIT is contacted; this index is the last line of defence.
--
-- Existing data: the billing tables are new (0263) and the old start path
-- refused an unresolved second start, so duplicates are not expected. If any
-- exist the index cannot be built; instead of an opaque 23505 this stops with
-- the rows to resolve by hand (cancel the extra DOIT subscription at the
-- gateway first, then mark the local row `cancelled`). Nothing is changed here.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1
      FROM "payment_recurring_subscriptions"
     WHERE "status" IN ('pending_first_payment', 'active')
     GROUP BY "tenant_id", "plan_id", "customer_profile_id"
    HAVING count(*) > 1
  ) AS duplicated;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'payment_recurring_subscriptions: % customer+plan pair(s) have more than one pending_first_payment/active row; resolve them before migrating (see 0266 header)', dup_count;
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_recurring_subscriptions_live_customer_plan_key" ON "payment_recurring_subscriptions" USING btree ("tenant_id","plan_id","customer_profile_id") WHERE "payment_recurring_subscriptions"."status" IN ('pending_first_payment', 'active');
