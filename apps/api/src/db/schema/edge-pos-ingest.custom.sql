-- Custom SQL migration file, put your code below! ---
-- Edge shift and business day ledger (1269 E3). Tenant RLS (TEN-01/02) plus the
-- outlet backstop (TEN-03), like edge_order_ingests.
SELECT app.enforce_tenant_rls('public.edge_pos_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_pos_ingests'::regclass);
--> statement-breakpoint
-- The ledger is the replay guard of drawer money: a row is never deleted, its
-- identity never changes and an ingested one is final.
CREATE FUNCTION app.guard_edge_pos_ingest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge pos ingests are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'ingested' OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.kind <> OLD.kind OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.event_id <> OLD.event_id THEN
    RAISE EXCEPTION 'an edge pos ingest is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_pos_ingests_guard BEFORE UPDATE OR DELETE ON public.edge_pos_ingests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_pos_ingest();
