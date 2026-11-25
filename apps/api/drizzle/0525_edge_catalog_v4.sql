SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "edge_catalog_tombstones" (
	"tenant_id" uuid NOT NULL,
	"stream" varchar(40) NOT NULL,
	"id" uuid NOT NULL,
	"received" boolean DEFAULT false NOT NULL,
	"outlet_id" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL,
	CONSTRAINT "edge_catalog_tombstones_tenant_id_stream_id_received_pk" PRIMARY KEY("tenant_id","stream","id","received")
);
--> statement-breakpoint
ALTER TABLE "item_availability" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_zones" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "service_charge_rules" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_cashier_defaults" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_edc_terminals" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_approval_policies" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_capacity_rules" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_menu_loads" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "edge_catalog_tombstones" ADD CONSTRAINT "edge_catalog_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_catalog_tombstones_sync_txid_idx" ON "edge_catalog_tombstones" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "item_availability_sync_txid_idx" ON "item_availability" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "approval_policies_sync_txid_idx" ON "approval_policies" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "floor_zones_sync_txid_idx" ON "floor_zones" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "tables_sync_txid_idx" ON "tables" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "service_charge_rules_sync_txid_idx" ON "service_charge_rules" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "tax_rules_sync_txid_idx" ON "tax_rules" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "tax_settings_sync_txid_idx" ON "tax_settings" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "payment_cashier_defaults_sync_txid_idx" ON "payment_cashier_defaults" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "payment_edc_terminals_sync_txid_idx" ON "payment_edc_terminals" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "pos_approval_policies_sync_txid_idx" ON "pos_approval_policies" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "kitchen_capacity_rules_sync_txid_idx" ON "kitchen_capacity_rules" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "kitchen_menu_loads_sync_txid_idx" ON "kitchen_menu_loads" USING btree ("tenant_id","sync_txid","id");
--> statement-breakpoint
-- legend-osqou.22: catalog stream v4 (tax, floor, EDC, approval, kitchen and
-- availability config travel cloud -> edge). Same migration on the cloud and on
-- every edge node; no existing row changes besides the new column's default.

-- Tenant RLS only: a marker of a tenant-wide row has no outlet. The export
-- narrows to the credential's outlet in SQL.
SELECT app.enforce_tenant_rls('public.edge_catalog_tombstones'::regclass);
--> statement-breakpoint
-- A marker is evidence of a deletion: it may move to a newer version (the same
-- id deleted again), never disappear.
REVOKE DELETE, TRUNCATE ON TABLE public.edge_catalog_tombstones FROM legend_app;
--> statement-breakpoint

-- tables: the cloud's status, QR credential and updated_at are not part of the
-- record, so a change of only those keeps the stamp (a guest sitting down must
-- not re-send the table, and an edge-local seating must keep the cloud's stamp:
-- a local transaction id is not comparable with a cloud one). Switching the
-- table on or off is.
CREATE FUNCTION app.set_floor_table_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.status = 'inactive') = (OLD.status = 'inactive')
     AND (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) ARRAY['status', 'qr_token_hash', 'qr_token_sealed', 'updated_at', 'sync_txid']::pg_catalog.text[])
       = (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) ARRAY['status', 'qr_token_hash', 'qr_token_sealed', 'updated_at', 'sync_txid']::pg_catalog.text[]) THEN
    NEW.sync_txid := OLD.sync_txid;
    RETURN NEW;
  END IF;
  NEW.sync_txid := pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- item_availability: the expiry sweep runs on the cloud and on the edge and
-- reaches the same result on both, so the end of a timed 86 keeps the stamp
-- (an edge-local sweep must not write a local id over the cloud's). Every other
-- change, a manual restore included, gets a new stamp.
CREATE FUNCTION app.set_item_availability_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'sold_out' AND NEW.status = 'available'
     AND OLD.sold_out_until <= pg_catalog.now() AND NEW.sold_out_until IS NULL
     AND (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) ARRAY['status', 'sold_out_until', 'source', 'updated_at', 'sync_txid']::pg_catalog.text[])
       = (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) ARRAY['status', 'sold_out_until', 'source', 'updated_at', 'sync_txid']::pg_catalog.text[]) THEN
    NEW.sync_txid := OLD.sync_txid;
    RETURN NEW;
  END IF;
  NEW.sync_txid := pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tax_rules_set_sync_txid BEFORE INSERT OR UPDATE ON public.tax_rules
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER service_charge_rules_set_sync_txid BEFORE INSERT OR UPDATE ON public.service_charge_rules
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER tax_settings_set_sync_txid BEFORE INSERT OR UPDATE ON public.tax_settings
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER floor_zones_set_sync_txid BEFORE INSERT OR UPDATE ON public.floor_zones
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER payment_edc_terminals_set_sync_txid BEFORE INSERT OR UPDATE ON public.payment_edc_terminals
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER payment_cashier_defaults_set_sync_txid BEFORE INSERT OR UPDATE ON public.payment_cashier_defaults
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER pos_approval_policies_set_sync_txid BEFORE INSERT OR UPDATE ON public.pos_approval_policies
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER approval_policies_set_sync_txid BEFORE INSERT OR UPDATE ON public.approval_policies
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER kitchen_capacity_rules_set_sync_txid BEFORE INSERT OR UPDATE ON public.kitchen_capacity_rules
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER kitchen_menu_loads_set_sync_txid BEFORE INSERT OR UPDATE ON public.kitchen_menu_loads
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER edge_catalog_tombstones_set_sync_txid BEFORE INSERT OR UPDATE ON public.edge_catalog_tombstones
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER tables_set_sync_txid BEFORE INSERT OR UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION app.set_floor_table_sync_txid();
--> statement-breakpoint
CREATE TRIGGER item_availability_set_sync_txid BEFORE INSERT OR UPDATE ON public.item_availability
FOR EACH ROW EXECUTE FUNCTION app.set_item_availability_sync_txid();
--> statement-breakpoint

-- Deletion marker of a hard-deleted row: TG_ARGV[0] is the stream. The edge
-- apply (legend.skip_sync_txid = 'on') removes rows the cloud already deleted
-- and writes no marker of its own here. Stamped by the deleting transaction, so
-- it sorts after every earlier write of the row.
CREATE FUNCTION app.record_catalog_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN OLD;
  END IF;
  INSERT INTO public.edge_catalog_tombstones (tenant_id, stream, id, received, outlet_id)
  VALUES (OLD.tenant_id, TG_ARGV[0], OLD.id, false, (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.->>) 'outlet_id')::pg_catalog.uuid)
  ON CONFLICT (tenant_id, stream, id, received)
    DO UPDATE SET deleted_at = pg_catalog.now(), outlet_id = EXCLUDED.outlet_id;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER floor_zones_catalog_tombstone AFTER DELETE ON public.floor_zones
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('floor_zones');
--> statement-breakpoint
CREATE TRIGGER tables_catalog_tombstone AFTER DELETE ON public.tables
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('tables');
--> statement-breakpoint
CREATE TRIGGER payment_cashier_defaults_catalog_tombstone AFTER DELETE ON public.payment_cashier_defaults
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('payment_cashier_defaults');
--> statement-breakpoint
CREATE TRIGGER approval_policies_catalog_tombstone AFTER DELETE ON public.approval_policies
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('approval_policies');
--> statement-breakpoint
CREATE TRIGGER kitchen_capacity_rules_catalog_tombstone AFTER DELETE ON public.kitchen_capacity_rules
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('kitchen_capacity_rules');
--> statement-breakpoint
CREATE TRIGGER kitchen_menu_loads_catalog_tombstone AFTER DELETE ON public.kitchen_menu_loads
FOR EACH ROW EXECUTE FUNCTION app.record_catalog_tombstone('kitchen_menu_loads');
