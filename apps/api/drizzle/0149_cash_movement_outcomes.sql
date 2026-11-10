-- legend-y9bf: held manual cash outs expire at the shift close (Codex 146 F2).
-- cash_movement_outcomes is a new, empty table: its foreign keys sit inside
-- CREATE TABLE (docs/plan/contracts.md pattern 1), so no validation scan reads
-- a FORCE RLS parent. The check constraints on pos_shifts and
-- pos_shift_counts read only their own row.
CREATE TABLE "cash_movement_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_outcomes_movement_key" UNIQUE("tenant_id","movement_id"),
	CONSTRAINT "cash_movement_outcomes_outcome_check" CHECK ("cash_movement_outcomes"."outcome" IN ('expired', 'approved', 'rejected')),
	CONSTRAINT "cash_movement_outcomes_decided_by_check" CHECK ("cash_movement_outcomes"."outcome" = 'expired' OR "cash_movement_outcomes"."decided_by" IS NOT NULL),
	CONSTRAINT "cash_movement_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_movement_outcomes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_movement_outcomes_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_movement_outcomes_movement_fk" FOREIGN KEY ("tenant_id","movement_id") REFERENCES "public"."cash_movements"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_movement_outcomes_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_movement_outcomes_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_open_check";--> statement-breakpoint
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_closed_check";--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD COLUMN "held_correction_idr" bigint;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "difference_idr" bigint;--> statement-breakpoint
CREATE INDEX "cash_movement_outcomes_shift_idx" ON "cash_movement_outcomes" USING btree ("tenant_id","shift_id");--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_held_correction_check" CHECK ("pos_shift_counts"."held_correction_idr" IS NULL
        OR "pos_shift_counts"."held_correction_idr" BETWEEN 0 AND "pos_shift_counts"."held_cash_out_idr");--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_difference_check" CHECK ("pos_shifts"."difference_idr" IS NULL
        OR ("pos_shifts"."variance_idr" IS NOT NULL
          AND "pos_shifts"."difference_idr" - "pos_shifts"."variance_idr"
            BETWEEN 0 AND "pos_shifts"."held_cash_out_idr"));--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_open_check" CHECK ("pos_shifts"."status" <> 'open' OR ("pos_shifts"."expected_idr" IS NULL
        AND "pos_shifts"."counted_idr" IS NULL AND "pos_shifts"."variance_idr" IS NULL
        AND "pos_shifts"."variance_note" IS NULL AND "pos_shifts"."counts" IS NULL
        AND "pos_shifts"."approved_by" IS NULL AND "pos_shifts"."approval_request_id" IS NULL
        AND "pos_shifts"."approval_override_id" IS NULL AND "pos_shifts"."approved_at" IS NULL
        AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closed_by" IS NULL
        AND "pos_shifts"."close_key" IS NULL AND "pos_shifts"."close_fingerprint" IS NULL
        AND "pos_shifts"."count_id" IS NULL AND "pos_shifts"."held_cash_out_idr" = 0
        AND "pos_shifts"."difference_idr" IS NULL));--> statement-breakpoint
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
        AND (coalesce("pos_shifts"."difference_idr",
            "pos_shifts"."variance_idr" + "pos_shifts"."held_cash_out_idr") = 0
          OR "pos_shifts"."variance_note" IS NOT NULL)));
--> statement-breakpoint

-- legend-y9bf: Tenant + outlet RLS (TEN-01/TEN-03) for the decisions on held
-- cash movements.
SELECT app.enforce_tenant_rls('public.cash_movement_outcomes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movement_outcomes'::regclass);
--> statement-breakpoint

-- A decision on a held cash movement is append-only history (enforce_tenant_rls
-- grants the app role UPDATE/DELETE, so the trigger and the REVOKE below close
-- that). It names a held movement (needs_approval) of the same shift and
-- outlet. 'approved' is refused outright: no approval flow puts a held cash
-- movement into the drawer figures yet (legend-3l4q). 'rejected' (not booked,
-- like 'expired') lands only while that shift is open: the close expires every
-- undecided held movement. The shift row is read FOR SHARE so a decision waits
-- for an in-flight close holding it FOR UPDATE. The unique movement key
-- refuses a second decision on the same movement, including one on an expired
-- movement.
CREATE OR REPLACE FUNCTION app.cash_movement_outcomes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  movement_shift uuid;
  movement_outlet uuid;
  movement_held boolean;
  shift_status text;
  shift_outlet uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: cash movement outcome % is history and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'approved' THEN
    RAISE EXCEPTION 'POS-03: no approval flow updates the drawer for a held cash movement yet (legend-3l4q)'
      USING ERRCODE = '23514';
  END IF;
  SELECT m.shift_id, m.outlet_id, m.needs_approval
  INTO movement_shift, movement_outlet, movement_held
  FROM public.cash_movements m
  WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.movement_id;
  IF movement_held IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POS-03: cash movement % is not held for review', NEW.movement_id
      USING ERRCODE = '23514';
  END IF;
  IF movement_shift <> NEW.shift_id OR movement_outlet <> NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement outcome differs from its movement'
      USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.outlet_id INTO shift_status, shift_outlet
  FROM public.pos_shifts s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id
  FOR SHARE;
  IF shift_outlet IS DISTINCT FROM NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement outcome outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome <> 'expired' AND shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'POS-03: shift % is closed; its held cash movements expired', NEW.shift_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "cash_movement_outcomes_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_movement_outcomes"
  FOR EACH ROW EXECUTE FUNCTION app.cash_movement_outcomes_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.cash_movement_outcomes FROM legend_app;
--> statement-breakpoint

-- legend-y9bf: 0137's guard with every rule kept, plus the booked difference.
-- A close using a count that stored its held correction (held refund and void
-- cash) must book difference_idr = variance_idr + that correction, so the
-- note rule and the ledger read the figure the count was approved with.
CREATE OR REPLACE FUNCTION app.pos_shifts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  count_shift uuid;
  count_counted bigint;
  count_held bigint;
  count_correction bigint;
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
    SELECT c.shift_id, c.counted_idr, c.held_cash_out_idr, c.held_correction_idr
      INTO count_shift, count_counted, count_held, count_correction
    FROM public.pos_shift_counts c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.count_id;
    IF count_shift IS DISTINCT FROM NEW.id
      OR count_counted IS DISTINCT FROM NEW.counted_idr
      OR count_held IS DISTINCT FROM NEW.held_cash_out_idr
    THEN
      RAISE EXCEPTION 'POS-03: shift % must close with its own count', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF count_correction IS NOT NULL
      AND (NEW.difference_idr IS NULL
        OR NEW.variance_idr IS NULL
        OR NEW.difference_idr <> NEW.variance_idr + count_correction)
    THEN
      RAISE EXCEPTION 'POS-03: shift % must book its count''s difference', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
