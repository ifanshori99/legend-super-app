-- Custom SQL migration fragment for legend-93a (WS-04 receipts, POS-06/POS-07).
-- Append AFTER the drizzle-generated CREATE TABLE statements for
-- receipt_sequences, pos_receipts, pos_receipt_links, pos_receipt_deliveries
-- and pos_invoices. The service checks the same rules first
-- (pos-receipt.service.ts); these triggers are the database backstop.

-- 1. TEN-01/TEN-03: every table is tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.receipt_sequences'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.receipt_sequences'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_receipts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_receipts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_receipt_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_receipt_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_receipt_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_receipt_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_invoices'::regclass);
--> statement-breakpoint

-- 2. POS-06: a device run only moves forward. The row is never deleted, its
--    device/outlet never change, and the prefix is fixed once a number exists.
CREATE OR REPLACE FUNCTION app.receipt_sequences_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
    OR NEW.device_id <> OLD.device_id
  THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % cannot move to another device', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.last_number < OLD.last_number THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % cannot go backwards', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.prefix <> OLD.prefix AND OLD.last_number > 0 THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % already issued numbers under its prefix', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- legend-zsdd: retirement is final (NULL -> value, then never changes).
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at
  THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % is retired and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- legend-zsdd: the binding pair goes from both NULL to both set, once.
  IF (NEW.edge_node_id IS DISTINCT FROM OLD.edge_node_id
      OR NEW.edge_instance_id IS DISTINCT FROM OLD.edge_instance_id)
  THEN
    IF OLD.edge_node_id IS NOT NULL OR OLD.edge_instance_id IS NOT NULL THEN
      RAISE EXCEPTION 'POS-06: receipt sequence % is already bound to an edge database', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF OLD.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'POS-06: retired receipt sequence % cannot be bound', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.edge_node_id IS NULL OR NEW.edge_instance_id IS NULL THEN
      RAISE EXCEPTION 'POS-06: receipt sequence % binding needs node and instance', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- legend-yd0h8: the reported high-water never decreases, and a retired run
  -- keeps its high-water and its retire reason for good.
  IF NEW.edge_reported_number < OLD.edge_reported_number THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % reported high-water cannot go backwards', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.retired_at IS NOT NULL AND (
    NEW.edge_reported_number IS DISTINCT FROM OLD.edge_reported_number
    OR NEW.retired_reason IS DISTINCT FROM OLD.retired_reason)
  THEN
    RAISE EXCEPTION 'POS-06: retired receipt sequence % cannot change its audit fields', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- legend-yd0h8: the retire reason is set only by the update that retires.
  IF NEW.retired_reason IS DISTINCT FROM OLD.retired_reason
    AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at
  THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % retire reason is set only when retiring', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- legend-yd0h8: the update that retires a run must say why.
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
    AND NEW.retired_reason IS NULL
  THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % must be retired with a reason', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- legend-yd0h8: the report time never goes backwards nor back to NULL, and
  -- a retired run keeps it for good.
  IF OLD.edge_reported_at IS NOT NULL AND (
    NEW.edge_reported_at IS NULL OR NEW.edge_reported_at < OLD.edge_reported_at)
  THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % report time cannot go backwards', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.retired_at IS NOT NULL
    AND NEW.edge_reported_at IS DISTINCT FROM OLD.edge_reported_at
  THEN
    RAISE EXCEPTION 'POS-06: retired receipt sequence % cannot change its report time', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "receipt_sequences_forward_only_trg"
  BEFORE UPDATE OR DELETE ON "receipt_sequences"
  FOR EACH ROW EXECUTE FUNCTION app.receipt_sequences_forward_only();
--> statement-breakpoint

-- 3. POS-06: a receipt only names a number its device run already issued, in
--    the device's own prefix and outlet.
CREATE OR REPLACE FUNCTION app.pos_receipts_match_sequence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE seq record;
BEGIN
  SELECT s.outlet_id, s.device_id, s.prefix, s.last_number INTO seq
  FROM public.receipt_sequences s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sequence_id;
  IF NOT FOUND
    OR seq.outlet_id <> NEW.outlet_id
    OR seq.device_id <> NEW.device_id
    OR NEW.sequence_number > seq.last_number
    -- Pad to at least six digits; a plain lpad(…, 6) truncates past 999999.
    OR NEW.number <> seq.prefix || '-' || lpad(NEW.sequence_number::text,
      greatest(6, length(NEW.sequence_number::text)), '0')
  THEN
    RAISE EXCEPTION 'POS-06: receipt % does not match its device sequence', NEW.number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_receipts_match_sequence_trg"
  BEFORE INSERT ON "pos_receipts"
  FOR EACH ROW EXECUTE FUNCTION app.pos_receipts_match_sequence();
--> statement-breakpoint

-- 4. POS-06: a receipt is never deleted and its number never changes. The
--    only changes are issued -> voided (once) and a growing reprint count.
CREATE OR REPLACE FUNCTION app.pos_receipts_retained() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS-06: receipt % is retained and cannot be deleted', OLD.number
      USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'voided_at' - 'void_reason' - 'voided_by'
        - 'reprint_count' - 'updated_at')
     <> (to_jsonb(OLD) - 'status' - 'voided_at' - 'void_reason' - 'voided_by'
        - 'reprint_count' - 'updated_at')
    OR NEW.reprint_count < OLD.reprint_count
    OR (OLD.status = 'voided' AND (
      NEW.status <> 'voided' OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
      OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
      OR NEW.voided_by IS DISTINCT FROM OLD.voided_by))
  THEN
    RAISE EXCEPTION 'POS-06: receipt % can only be voided or reprinted', OLD.number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_receipts_retained_trg"
  BEFORE UPDATE OR DELETE ON "pos_receipts"
  FOR EACH ROW EXECUTE FUNCTION app.pos_receipts_retained();
--> statement-breakpoint

-- 5. Issued links and invoices are records: never rewritten or deleted.
CREATE OR REPLACE FUNCTION app.pos_receipt_records_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-07: % rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_receipt_links_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pos_receipt_links"
  FOR EACH ROW EXECUTE FUNCTION app.pos_receipt_records_append_only();
--> statement-breakpoint
CREATE TRIGGER "pos_invoices_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pos_invoices"
  FOR EACH ROW EXECUTE FUNCTION app.pos_receipt_records_append_only();
--> statement-breakpoint

-- 6. 1271 F1 (0529): a run's series never changes (one allocator per series).
CREATE FUNCTION app.receipt_sequences_series_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.series IS DISTINCT FROM OLD.series THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % cannot change its series', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "receipt_sequences_series_fixed_trg"
  BEFORE UPDATE OF series ON "receipt_sequences"
  FOR EACH ROW EXECUTE FUNCTION app.receipt_sequences_series_fixed();
