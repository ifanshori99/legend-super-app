CREATE TABLE "cash_movement_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_refusals_idempotency_key" UNIQUE("tenant_id","shift_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_reason_check";--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK (char_length(btrim("cash_movements"."reason_note", E' \t\r\n')) >= 4) NOT VALID;--> statement-breakpoint
-- NOT VALID: new rows must pass btrim (spaces, tabs, newlines; code points); rows written before this migration are
-- not re-checked (a whitespace-only reason may already exist and movements are
-- append-only history, so it cannot be fixed by an UPDATE).

-- Tenant + outlet RLS (TEN-01/TEN-03) for the refusal idempotency record.
SELECT app.enforce_tenant_rls('public.cash_movement_refusals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movement_refusals'::regclass);
--> statement-breakpoint

-- A refusal record is append-only history (enforce_tenant_rls grants the app
-- role UPDATE/DELETE, so the trigger and the REVOKE below close that) and only
-- lands on an open shift of the same outlet, like cash_movements.
CREATE OR REPLACE FUNCTION app.cash_movement_refusals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  shift_status text;
  shift_outlet uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'POS-03: cash movement refusal % is history and cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  SELECT s.status, s.outlet_id INTO shift_status, shift_outlet
  FROM public.pos_shifts s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shift_id;
  IF shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'POS-03: shift % is not open', NEW.shift_id
      USING ERRCODE = '23514';
  END IF;
  IF shift_outlet <> NEW.outlet_id THEN
    RAISE EXCEPTION 'TEN-03: cash movement refusal outlet differs from its shift'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "cash_movement_refusals_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_movement_refusals"
  FOR EACH ROW EXECUTE FUNCTION app.cash_movement_refusals_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.cash_movement_refusals FROM legend_app;
