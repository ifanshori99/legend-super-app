-- Custom SQL migration file, put your code below! ---
-- legend-drzaf: a run bound to an edge is numbered by the edge, so its cloud
-- last_number stays 0 (legend-ol6v not built) and no write-off could be made
-- for it. The bound becomes the highest number the cloud knows was issued:
-- GREATEST(last_number, edge_reported_number). edge_reported_number is the
-- never-decreasing high-water the bound edge reports on its pulls (legend-yd0h8);
-- every number up to it was committed on the edge and cannot be issued again
-- (a lower report retires the run). It is 0 on unbound runs and on every row of
-- an edge database, so those keep the old last_number bound. Body is the same
-- as schema/pos-receipt-writeoff.custom.sql.
CREATE OR REPLACE FUNCTION app.receipt_number_writeoffs_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE seq record;
BEGIN
  SELECT s.outlet_id, s.prefix, s.last_number, s.edge_reported_number INTO seq
  FROM public.receipt_sequences s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sequence_id;
  IF NOT FOUND
    OR seq.outlet_id <> NEW.outlet_id
    OR seq.prefix <> NEW.prefix
    OR NEW.sequence_number > GREATEST(seq.last_number, seq.edge_reported_number)
  THEN
    RAISE EXCEPTION 'POS-06: write-off of % does not match its device sequence',
      NEW.sequence_number
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pos_receipts r
    WHERE r.tenant_id = NEW.tenant_id
      AND r.sequence_id = NEW.sequence_id
      AND r.sequence_number = NEW.sequence_number
  ) THEN
    RAISE EXCEPTION 'POS-06: receipt number % already has a receipt',
      NEW.sequence_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
