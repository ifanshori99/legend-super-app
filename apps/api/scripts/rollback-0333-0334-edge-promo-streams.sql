-- Rollback of 0333_edge_promo_streams.sql and 0334_edge_voucher_catalog.sql
-- (brief 533 B4). NOT a migration: the migrator does not run this file, and
-- `drizzle/` keeps both migrations untouched (AGENTS.md: never rewrite an
-- applied migration). Run it by hand with psql as the table owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rollback-0333-0334-edge-promo-streams.sql
--
-- ORDER (runbook docs/runbooks/edge-catalog-deploy-order.md, "Rollback 0333 and
-- 0334"): edge outlets first, then cloud code, THEN this script. Run it only
-- when no running code reads `promotions.sync_txid`, `vouchers.sync_txid`,
-- `promo_settings.sync_txid` or `edge_voucher_catalog`: the previous cloud
-- build does not use them, the current one fails on the missing columns.
--
-- DATA LOSS (intended): the three sync_txid stamps and every row of
-- edge_voucher_catalog (an edge-only table; on the cloud it is empty). Promotion
-- rules, vouchers, counters (uses_total, spent_idr) and settings are untouched.
-- On an EDGE database this drops the replicated voucher metadata; the next pull
-- after a re-roll-forward rebuilds it from the cloud.
--
-- Everything runs in one transaction: all of it applies or none of it.
BEGIN;

-- 0334: edge voucher catalog (the table's index, RLS policies and FK go with it).
DROP TABLE IF EXISTS public.edge_voucher_catalog;

-- 0333: triggers first (they call the functions), then the functions.
DROP TRIGGER IF EXISTS promo_settings_touch_sync_parents ON public.promo_settings;
DROP TRIGGER IF EXISTS promotion_outlets_touch_sync_parent ON public.promotion_outlets;
DROP TRIGGER IF EXISTS promo_settings_set_sync_txid ON public.promo_settings;
DROP TRIGGER IF EXISTS vouchers_set_sync_txid ON public.vouchers;
DROP TRIGGER IF EXISTS promotions_set_sync_txid ON public.promotions;

DROP FUNCTION IF EXISTS app.touch_promotion_settings_sync_parents();
DROP FUNCTION IF EXISTS app.touch_promotion_sync_parent();
DROP FUNCTION IF EXISTS app.set_promotion_sync_txid();
-- app.set_sync_txid() is shared with the other catalog tables: NOT dropped.

DROP INDEX IF EXISTS public.vouchers_sync_txid_idx;
DROP INDEX IF EXISTS public.promotions_sync_txid_idx;

ALTER TABLE public.vouchers DROP COLUMN IF EXISTS sync_txid;
ALTER TABLE public.promotions DROP COLUMN IF EXISTS sync_txid;
ALTER TABLE public.promo_settings DROP COLUMN IF EXISTS sync_txid;

-- Forget both migrations so a later roll-forward re-applies them. `created_at`
-- is the `when` of the entry in drizzle/meta/_journal.json.
DELETE FROM drizzle.__drizzle_migrations
 WHERE created_at IN (1794415455441, 1794415777888);

COMMIT;
