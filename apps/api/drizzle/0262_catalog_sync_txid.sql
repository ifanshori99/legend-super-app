SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "updated_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_variants" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "modifiers" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
CREATE INDEX "item_variants_sync_txid_idx" ON "item_variants" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "menu_categories_sync_txid_idx" ON "menu_categories" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_sync_txid_idx" ON "menu_item_modifier_groups" USING btree ("tenant_id","sync_txid","menu_item_id","group_id");--> statement-breakpoint
CREATE INDEX "menu_items_sync_txid_idx" ON "menu_items" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "modifier_groups_sync_txid_idx" ON "modifier_groups" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "modifiers_sync_txid_idx" ON "modifiers" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "price_lists_sync_txid_idx" ON "price_lists" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "stations_sync_txid_idx" ON "stations" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "inventory_items_sync_txid_idx" ON "inventory_items" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "recipes_sync_txid_idx" ON "recipes" USING btree ("tenant_id","sync_txid","id");
--> statement-breakpoint
-- legend-24318: sync_txid stamping for the catalog down-sync. The trigger
-- writes the id of the writing transaction into every inserted / updated row;
-- the edge apply sets legend.skip_sync_txid = 'on' (transaction local) so the
-- value it copies from the cloud is kept.
CREATE OR REPLACE FUNCTION app.set_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.sync_txid := pg_catalog.pg_current_xact_id()::text::bigint;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER menu_categories_set_sync_txid BEFORE INSERT OR UPDATE ON "menu_categories" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER modifier_groups_set_sync_txid BEFORE INSERT OR UPDATE ON "modifier_groups" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER modifiers_set_sync_txid BEFORE INSERT OR UPDATE ON "modifiers" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER menu_items_set_sync_txid BEFORE INSERT OR UPDATE ON "menu_items" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER item_variants_set_sync_txid BEFORE INSERT OR UPDATE ON "item_variants" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER menu_item_modifier_groups_set_sync_txid BEFORE INSERT OR UPDATE ON "menu_item_modifier_groups" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER price_lists_set_sync_txid BEFORE INSERT OR UPDATE ON "price_lists" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER recipes_set_sync_txid BEFORE INSERT OR UPDATE ON "recipes" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER stations_set_sync_txid BEFORE INSERT OR UPDATE ON "stations" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER inventory_items_set_sync_txid BEFORE INSERT OR UPDATE ON "inventory_items" FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();