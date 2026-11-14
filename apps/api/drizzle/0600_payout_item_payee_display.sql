-- Payout item payee display (bead legend-2bl54). Each bank item carries the
-- payee's name and the masked account number (`****1234`, the output of
-- maskAccountNumber) copied from its sealed bank snapshot when the item is
-- created, so a batch view shows who is paid without opening the snapshot. The
-- full account number is never stored here. Cash items and items created before
-- this migration stay null; no existing row is rewritten (no backfill).
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "account_holder_name" varchar(150);--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "masked_account_number" varchar(20);--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD CONSTRAINT "payroll_disbursement_items_payee_display_check" CHECK (("payroll_disbursement_items"."channel" = 'cash' AND "payroll_disbursement_items"."account_holder_name" IS NULL AND "payroll_disbursement_items"."masked_account_number" IS NULL) OR ("payroll_disbursement_items"."channel" <> 'cash' AND ("payroll_disbursement_items"."masked_account_number" IS NULL OR "payroll_disbursement_items"."masked_account_number" ~ '^\*{4}[0-9]{4}$')));--> statement-breakpoint
-- After INSERT neither column can change. No code path replaces
-- bank_snapshot_id on an existing item, so the freeze is absolute (own function
-- and trigger; payroll_disbursement_items_guard from 0351 is not touched).
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_payee_display_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name
    OR NEW.masked_account_number IS DISTINCT FROM OLD.masked_account_number THEN
    RAISE EXCEPTION 'PAYOUT-24: the payee display data of item % is frozen', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_payee_display_freeze_trg ON public.payroll_disbursement_items;--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_payee_display_freeze_trg
  BEFORE UPDATE OF account_holder_name, masked_account_number ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_payee_display_freeze();
