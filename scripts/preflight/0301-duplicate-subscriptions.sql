-- Read-only release gate for 0301_recurring_live_customer_plan_key.sql.
-- On milestone/m1 this migration was rechained as 0266 with the same index.
-- Run with a maintenance/migrator login that sees every tenant despite RLS.
-- Zero rows means no duplicates at this snapshot; any row blocks migration.
-- Match the index key and partial predicate exactly, including tenant_id.
SELECT
  tenant_id,
  plan_id,
  customer_profile_id,
  count(*) AS live_subscription_count,
  array_agg(id ORDER BY id) AS subscription_ids,
  array_agg(provider_subscription_id ORDER BY id) AS provider_subscription_ids
FROM payment_recurring_subscriptions
WHERE status IN ('pending_first_payment', 'active')
GROUP BY tenant_id, plan_id, customer_profile_id
HAVING count(*) > 1
ORDER BY tenant_id, plan_id, customer_profile_id;
