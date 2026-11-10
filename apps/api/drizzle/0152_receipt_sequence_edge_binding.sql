ALTER TABLE "receipt_sequences" DROP CONSTRAINT "receipt_sequences_device_key";--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "edge_node_id" uuid;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "edge_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_sequences_device_current_key" ON "receipt_sequences" USING btree ("tenant_id","outlet_id","device_id") WHERE "receipt_sequences"."retired_at" IS NULL;--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_edge_binding_check" CHECK (("receipt_sequences"."edge_node_id" IS NULL) = ("receipt_sequences"."edge_instance_id" IS NULL));--> statement-breakpoint
-- legend-zsdd: trigger gains retired_at / edge binding rules (same body as pos-receipt.custom.sql).
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
  RETURN NEW;
END $$;
