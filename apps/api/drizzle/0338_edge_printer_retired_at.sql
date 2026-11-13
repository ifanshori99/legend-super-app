-- legend-fbf4v follow-up: a printer deleted in the cloud but still referenced by
-- print jobs on the edge is retired there, not deleted (edge-catalog-apply).
-- `retired_at` is edge-owned state like status/last_seen_at: never part of the
-- cloud record, so setting or clearing it by itself must keep the cloud's
-- sync_txid. Same migration on the cloud and on every edge node.
ALTER TABLE "edge_printers" ADD COLUMN "retired_at" timestamp with time zone;
--> statement-breakpoint
-- 0337's function with `retired_at` added to the edge-owned columns.
CREATE OR REPLACE FUNCTION app.set_edge_printer_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) ARRAY['status', 'last_seen_at', 'offline_since', 'retired_at', 'updated_at', 'sync_txid']::pg_catalog.text[])
     = (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) ARRAY['status', 'last_seen_at', 'offline_since', 'retired_at', 'updated_at', 'sync_txid']::pg_catalog.text[]) THEN
    NEW.sync_txid := OLD.sync_txid;
    RETURN NEW;
  END IF;
  NEW.sync_txid := pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8;
  RETURN NEW;
END
$$;
