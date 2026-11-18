-- gate: legend-etov3
-- before: 0445_recurring_unresolved_start_key
-- requires: public.payment_recurring_subscriptions
-- mode: block
-- resolve: Check DOIT for each group, then cancel or reconcile extra subscriptions before migrating.
SELECT
  tenant_id,
  plan_id,
  customer_profile_id,
  count(*) AS subscription_count
FROM payment_recurring_subscriptions
WHERE status <> 'cancelled'
GROUP BY tenant_id, plan_id, customer_profile_id
HAVING count(*) > 1
  AND bool_or(status IN ('provisioning', 'needs_reconcile'))
ORDER BY tenant_id, plan_id, customer_profile_id;
