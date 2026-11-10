-- Custom SQL migration fragment for legend-0hzqw (audited write-off of a lost
-- receipt number). Append AFTER the drizzle-generated CREATE TABLE statement
-- for receipt_number_writeoffs. The service checks the same rules first
-- (pos-receipt-writeoff.service.ts); these triggers are the database backstop.

-- 1. TEN-01/TEN-03: tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.receipt_number_writeoffs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.receipt_number_writeoffs'::regclass);
--> statement-breakpoint

-- 2. A write-off is a record: never rewritten or deleted.
CREATE OR REPLACE FUNCTION app.receipt_number_writeoffs_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: % rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "receipt_number_writeoffs_append_only_trg"
  BEFORE UPDATE OR DELETE ON "receipt_number_writeoffs"
  FOR EACH ROW EXECUTE FUNCTION app.receipt_number_writeoffs_append_only();
--> statement-breakpoint

-- 3. Backstop: only a number the run already issued and that has no receipt
--    can be written off, under the run's own prefix and outlet.
--    legend-drzaf (0166): "issued" is GREATEST(last_number,
--    edge_reported_number); an edge-bound run's cloud last_number stays 0 and
--    its high-water is the counter its edge reported. 0 on unbound runs and on
--    every row of an edge database.
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
--> statement-breakpoint
CREATE TRIGGER "receipt_number_writeoffs_check_insert_trg"
  BEFORE INSERT ON "receipt_number_writeoffs"
  FOR EACH ROW EXECUTE FUNCTION app.receipt_number_writeoffs_check_insert();
