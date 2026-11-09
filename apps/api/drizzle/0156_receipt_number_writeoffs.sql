CREATE TABLE "receipt_number_writeoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"sequence_number" integer NOT NULL,
	"reason" text NOT NULL,
	"written_off_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_number_writeoffs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "receipt_number_writeoffs_ordinal_key" UNIQUE("tenant_id","sequence_id","sequence_number"),
	CONSTRAINT "receipt_number_writeoffs_sequence_number_check" CHECK ("receipt_number_writeoffs"."sequence_number" > 0),
	CONSTRAINT "receipt_number_writeoffs_reason_check" CHECK (char_length("receipt_number_writeoffs"."reason") BETWEEN 10 AND 500)
);
--> statement-breakpoint
ALTER TABLE "receipt_number_writeoffs" ADD CONSTRAINT "receipt_number_writeoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_number_writeoffs" ADD CONSTRAINT "receipt_number_writeoffs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_number_writeoffs" ADD CONSTRAINT "receipt_number_writeoffs_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."receipt_sequences"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_number_writeoffs" ADD CONSTRAINT "receipt_number_writeoffs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

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
CREATE OR REPLACE FUNCTION app.receipt_number_writeoffs_check_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE seq record;
BEGIN
  SELECT s.outlet_id, s.prefix, s.last_number INTO seq
  FROM public.receipt_sequences s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sequence_id;
  IF NOT FOUND
    OR seq.outlet_id <> NEW.outlet_id
    OR seq.prefix <> NEW.prefix
    OR NEW.sequence_number > seq.last_number
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
--> statement-breakpoint

-- legend-0hzqw: new permission `pos.receipt.writeoff` (write off a lost receipt
-- number), owner only (packages/shared/src/access/permissions.ts). Template
-- roles already copied into existing tenants keep their old permission list
-- (seedTenantRoleTemplates inserts once), so add the code to the owner row
-- here. Additive and idempotent: rows that already hold it are skipped.
--
-- `roles` has FORCE RLS whose policy calls app.require_tenant_id(), so a
-- migration role without BYPASSRLS must name each tenant (precedent:
-- 0090_pos_day_close_permission.sql, 0104_edc_standalone_permission.sql).
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions || '["pos.receipt.writeoff"]'::jsonb,
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key = 'owner'
      AND NOT (permissions ? 'pos.receipt.writeoff');
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
