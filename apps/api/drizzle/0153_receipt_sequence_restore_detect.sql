ALTER TABLE "receipt_sequences" ADD COLUMN "edge_reported_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "edge_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "retired_reason" varchar(30);--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_edge_reported_number_check" CHECK ("receipt_sequences"."edge_reported_number" BETWEEN 0 AND 999999999);--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_retired_reason_check" CHECK ("receipt_sequences"."retired_reason" IS NULL OR ("receipt_sequences"."retired_at" IS NOT NULL AND "receipt_sequences"."retired_reason" IN ('claim_rotated','cloud_takeover','edge_replaced','edge_regressed')));--> statement-breakpoint
-- legend-yd0h8: trigger gains the edge_reported_number / edge_reported_at / retired_reason rules (same body as pos-receipt.custom.sql).
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
