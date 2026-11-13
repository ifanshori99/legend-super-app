-- legend-fbf4v: printer registry down-sync (catalog stream "printers").
-- Hand-written companion of 0500_edge_printer_sync (RLS, sync_txid triggers,
-- deletion marker). Same migration on the cloud and on every edge node.

-- TEN-01/TEN-03: the tombstone table is tenant + outlet owned like
-- edge_printers (0245).
SELECT app.enforce_tenant_rls('public.edge_printer_tombstones'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_printer_tombstones'::regclass);
--> statement-breakpoint
-- A deletion marker is evidence of a deletion: insert and read only.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.edge_printer_tombstones FROM legend_app;
--> statement-breakpoint

-- Version stamp. Same rule as the other catalog tables (0262): the edge apply
-- sets legend.skip_sync_txid = 'on' so the cloud's value is kept. Own function
-- because the edge print agent also updates this table (status, last_seen_at,
-- offline_since) without that setting: such a heartbeat is not a registry
-- change and must keep the cloud's stamp. An edge-local transaction id is not
-- comparable with a cloud one, and would make the apply skip later cloud
-- updates and deletions of the printer. INSERT and any other change get a new
-- stamp.
CREATE FUNCTION app.set_edge_printer_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) ARRAY['status', 'last_seen_at', 'offline_since', 'updated_at', 'sync_txid']::pg_catalog.text[])
     = (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) ARRAY['status', 'last_seen_at', 'offline_since', 'updated_at', 'sync_txid']::pg_catalog.text[]) THEN
    NEW.sync_txid := OLD.sync_txid;
    RETURN NEW;
  END IF;
  NEW.sync_txid := pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER edge_printers_set_sync_txid BEFORE INSERT OR UPDATE ON public.edge_printers
FOR EACH ROW EXECUTE FUNCTION app.set_edge_printer_sync_txid();
--> statement-breakpoint
CREATE TRIGGER edge_printer_tombstones_set_sync_txid BEFORE INSERT OR UPDATE ON public.edge_printer_tombstones
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint

-- The cloud CRUD hard-deletes a printer; the stream announces it through this
-- marker. The edge apply (legend.skip_sync_txid = 'on') removes rows the cloud
-- already deleted and must not write markers of its own. A marker row is
-- stamped by its own transaction (the delete's), so it sorts after every
-- earlier write of the printer.
CREATE FUNCTION app.record_edge_printer_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN OLD;
  END IF;
  INSERT INTO public.edge_printer_tombstones (id, tenant_id, outlet_id)
  VALUES (OLD.id, OLD.tenant_id, OLD.outlet_id)
  ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_printers_tombstone AFTER DELETE ON public.edge_printers
FOR EACH ROW EXECUTE FUNCTION app.record_edge_printer_tombstone();
