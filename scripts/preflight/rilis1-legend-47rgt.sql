-- gate: legend-47rgt
-- before: 0446_promotion_ai_action_request_key
-- requires: public.promotions
-- mode: block
-- resolve: Deactivate the second and subsequent active promotions with the same tenant and AI marker before migrating.
WITH marked AS (
  SELECT
    tenant_id,
    lower(substring(description from '\[ai:([0-9a-fA-F-]{36})\]\s*$'))::uuid AS ai_action_request_id
  FROM promotions
  WHERE status = 'active'
    AND description ~ '\[ai:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]\s*$'
)
SELECT
  tenant_id,
  ai_action_request_id,
  count(*) AS promotion_count
FROM marked
GROUP BY tenant_id, ai_action_request_id
HAVING count(*) > 1
ORDER BY tenant_id, ai_action_request_id;
