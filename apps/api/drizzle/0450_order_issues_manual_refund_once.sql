-- legend-uyw0v (980): a line is manually refunded at most once, whatever the
-- issue type (a remake or complaint report can carry `manual_refund` too, not
-- only `unfulfillable`, which `order_issues_resolved_item_once_idx` covers).
-- A cancelled issue and a refund the finance side rejected (refund_rejected_at,
-- legend-wumm8) gave nothing back and are not counted, the same rule as that
-- index. No backfill: the old stop-gap refused every manual refund from the
-- report route, so a live duplicate cannot exist.
CREATE UNIQUE INDEX "order_issues_manual_refund_once_idx" ON "order_issues" USING btree ("tenant_id","order_item_id") WHERE "order_issues"."resolution" = 'manual_refund' AND "order_issues"."status" <> 'cancelled' AND "order_issues"."refund_rejected_at" IS NULL;
