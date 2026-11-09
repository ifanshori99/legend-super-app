ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_open_check";--> statement-breakpoint
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_closed_check";--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "held_cash_out_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_held_cash_out_check" CHECK ("pos_shifts"."held_cash_out_idr" >= 0);--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_open_check" CHECK ("pos_shifts"."status" <> 'open' OR ("pos_shifts"."expected_idr" IS NULL
        AND "pos_shifts"."counted_idr" IS NULL AND "pos_shifts"."variance_idr" IS NULL
        AND "pos_shifts"."variance_note" IS NULL AND "pos_shifts"."counts" IS NULL
        AND "pos_shifts"."approved_by" IS NULL AND "pos_shifts"."approval_request_id" IS NULL
        AND "pos_shifts"."approval_override_id" IS NULL AND "pos_shifts"."approved_at" IS NULL
        AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closed_by" IS NULL
        AND "pos_shifts"."close_key" IS NULL AND "pos_shifts"."close_fingerprint" IS NULL
        AND "pos_shifts"."count_id" IS NULL AND "pos_shifts"."held_cash_out_idr" = 0));--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_check" CHECK ("pos_shifts"."status" <> 'closed' OR ("pos_shifts"."expected_idr" IS NOT NULL
        AND "pos_shifts"."counted_idr" IS NOT NULL AND "pos_shifts"."variance_idr" IS NOT NULL
        AND "pos_shifts"."counts" IS NOT NULL
        AND "pos_shifts"."approved_by" IS NOT NULL AND "pos_shifts"."approval_request_id" IS NOT NULL
        AND "pos_shifts"."approval_override_id" IS NOT NULL AND "pos_shifts"."approved_at" IS NOT NULL
        AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closed_by" IS NOT NULL
        AND "pos_shifts"."close_key" IS NOT NULL AND "pos_shifts"."close_fingerprint" IS NOT NULL
        AND "pos_shifts"."expected_idr" = "pos_shifts"."opening_float_idr" + "pos_shifts"."cash_sales_idr"
          - "pos_shifts"."cash_refunds_idr" + "pos_shifts"."cash_in_idr" - "pos_shifts"."cash_out_idr"
          - "pos_shifts"."cash_drop_idr"
        AND "pos_shifts"."variance_idr" = "pos_shifts"."counted_idr" - "pos_shifts"."expected_idr"
        AND ("pos_shifts"."variance_idr" + "pos_shifts"."held_cash_out_idr" = 0
          OR "pos_shifts"."variance_note" IS NOT NULL)));--> statement-breakpoint
-- legend-utqr: the close must also carry the held cash of the count it uses.
CREATE OR REPLACE FUNCTION app.pos_shifts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  count_shift uuid;
  count_counted bigint;
  count_held bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS-03: shift % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'POS-03: shift % is closed; its count and variance are locked', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.outlet_id <> OLD.outlet_id
    OR NEW.device_id <> OLD.device_id
    OR NEW.cashier_id <> OLD.cashier_id
    OR NEW.business_date <> OLD.business_date
    OR NEW.opened_at <> OLD.opened_at
    OR NEW.opening_float_idr <> OLD.opening_float_idr
    OR NEW.open_key <> OLD.open_key
    OR NEW.open_fingerprint <> OLD.open_fingerprint
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'POS-03: shift % identity and opening float cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  -- The close must use a count of this very shift with the same counted cash
  -- and the same held cash (legend-utqr: the note rule trusts held_cash_out_idr).
  IF NEW.status = 'closed' THEN
    SELECT c.shift_id, c.counted_idr, c.held_cash_out_idr
      INTO count_shift, count_counted, count_held
    FROM public.pos_shift_counts c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.count_id;
    IF count_shift IS DISTINCT FROM NEW.id
      OR count_counted IS DISTINCT FROM NEW.counted_idr
      OR count_held IS DISTINCT FROM NEW.held_cash_out_idr
    THEN
      RAISE EXCEPTION 'POS-03: shift % must close with its own count', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
