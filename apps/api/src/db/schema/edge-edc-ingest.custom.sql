-- Custom SQL migration file, put your code below! ---
-- Edge EDC ledger mirror (1269 E4). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like edge_pos_ingests.
SELECT app.enforce_tenant_rls('public.edge_edc_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_edc_ingests'::regclass);
--> statement-breakpoint
-- The ledger is the replay guard of card money: a row is never deleted, its
-- identity never changes, its sequence never goes down and a refused one is
-- final.
CREATE FUNCTION app.guard_edge_edc_ingest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge edc ingests are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'refused' OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.transaction_id <> OLD.transaction_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.sequence < OLD.sequence THEN
    RAISE EXCEPTION 'an edge edc ingest is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_edc_ingests_guard BEFORE UPDATE OR DELETE ON public.edge_edc_ingests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_edc_ingest();
