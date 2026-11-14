-- legend-2uqcd: every edge now receives ALL recipes of its tenant (not only the
-- recipes of its own brand), and recipe_id links on menu items, variants and
-- modifiers must point at a recipe the edge holds. An edge that synced before
-- this change lacks the recipes of other brands and may have lost recipe_id
-- links (migration 0374 on an edge database). Re-stamp the cloud rows so the
-- next pull sends them again.
--
-- Data only. Cloud branch: the sync_txid trigger from 0262 (BEFORE INSERT OR
-- UPDATE, FOR EACH ROW) writes the id of the current transaction into every row
-- an UPDATE touches, so each row gets a fresh stamp above every edge checkpoint
-- taken before this migration. SET updated_at = updated_at changes no value (the
-- real last-modified time stays), but PostgreSQL still writes a new row version
-- and fires the trigger: no suppress_redundant_updates_trigger is installed on
-- these tables, so the update is not skipped as a no-op. No price, tax, amount
-- or recipe_id value is edited. Idempotent: running it again only stamps again.
--
-- Edge branch (session setting legend.edge_mode = on, set by the migrator when
-- EDGE_MODE=true): a fresh stamp is meaningless there. Migration 0374 on the
-- edge set recipe_id of menu items and variants to NULL when the recipe was not
-- local (a recipe of another brand), and the 0262 trigger gave those rows a
-- LOCAL sync_txid, a different cluster than the cloud's. The catalog apply skips
-- a record whose stored sync_txid is >= the record's, so a cloud re-stamp alone
-- would not restore the link. So the edge branch (1) sets sync_txid = 0 on
-- recipes, menu_items and item_variants (legend.skip_sync_txid = on keeps the
-- 0 instead of the trigger re-stamping it; the setting is switched off again
-- because drizzle runs every pending migration in one transaction), and (2)
-- clears the watermark of the three catalog checkpoints so the next pull reads
-- those streams from the start. Modifiers are not touched: their recipe_id was
-- never nulled on an edge (0374 skips them there, and an edge has no
-- modifiers_recipe_fk).
--
-- Money safety. The catalog tables on an edge hold no local price or menu
-- override: the cloud always wins on them (apply rule: a record replaces the
-- row when its sync_txid is higher; a full pull zeroes the stamps anyway, see
-- resetCatalogSyncTxid in catalog-puller.ts). The edge_catalog_sale_overrides
-- table is the owner's 24 h stale-catalog sales hold, a separate table that
-- this migration does not touch. No price, tax, amount or recipe_id value is
-- written here. The checkpoint rows are kept (only watermark becomes NULL), so
-- last_success_at survives and the 24 h freshness gate does not start counting
-- from tracking start (deleting the rows would block sales on an edge that is
-- offline right after the upgrade).
--
-- The three tables are FORCE RLS and the migrator is a table owner with no tenant
-- context, so the UPDATE would raise "tenant context is required". Lift FORCE for
-- this transaction only and restore it before commit (drizzle applies pending
-- migrations in one transaction, so no other session sees the lifted state), as
-- in 0127, 0364 and 0374.
ALTER TABLE public.recipes NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.menu_items NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.item_variants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.edge_pull_checkpoints NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF pg_catalog.current_setting('legend.edge_mode', true) IS DISTINCT FROM 'on' THEN
    UPDATE public.recipes SET updated_at = updated_at;
    UPDATE public.menu_items SET updated_at = updated_at;
    UPDATE public.item_variants SET updated_at = updated_at;
  ELSE
    PERFORM pg_catalog.set_config('legend.skip_sync_txid', 'on', true);
    UPDATE public.recipes SET sync_txid = 0 WHERE sync_txid <> 0;
    UPDATE public.menu_items SET sync_txid = 0 WHERE sync_txid <> 0;
    UPDATE public.item_variants SET sync_txid = 0 WHERE sync_txid <> 0;
    PERFORM pg_catalog.set_config('legend.skip_sync_txid', 'off', true);
    UPDATE public.edge_pull_checkpoints SET watermark = NULL
      WHERE stream IN ('catalog:recipes', 'catalog:menu_items', 'catalog:item_variants');
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE public.edge_pull_checkpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.item_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.menu_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.recipes FORCE ROW LEVEL SECURITY;
