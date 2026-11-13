-- Payroll disbursement (bead legend-wnkep.1): the Bank Indonesia bank code
-- (3 digits, not secret) of the payee account. HR fills employees.bank_code;
-- the run lock copies it into payslip_bank_snapshots.bank_code, and the bank
-- file and the disbursement items read only the snapshot. Existing rows stay
-- NULL: an employee without a code is never paid by bank file (the batch
-- blocks the item as bank_code_missing).
ALTER TABLE "employees" ADD COLUMN "bank_code" text;
--> statement-breakpoint
ALTER TABLE "payslip_bank_snapshots" ADD COLUMN "bank_code" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_bank_code_check" CHECK ("employees"."bank_code" IS NULL OR "employees"."bank_code" ~ '^[0-9]{3}$');
--> statement-breakpoint
ALTER TABLE "payslip_bank_snapshots" ADD CONSTRAINT "payslip_bank_snapshots_bank_code_check" CHECK ("payslip_bank_snapshots"."bank_code" IS NULL OR "payslip_bank_snapshots"."bank_code" ~ '^[0-9]{3}$');
--> statement-breakpoint
-- Snapshot rows stay immutable: the 0326 app-role grant lists only the sealed
-- value and key version, so bank_code is written at INSERT and never updated.
-- A disbursement item must carry exactly the bank code and payslip of the
-- snapshot it points at (never a typed-in code). The guard also runs when a
-- prepared or blocked item is re-pointed to another snapshot or bank code (L2);
-- later the payee is frozen by the item guard (PAYOUT-13).
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  snapshot_slip uuid;
  snapshot_code text;
BEGIN
  IF NEW.bank_snapshot_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.payslip_id, s.bank_code INTO snapshot_slip, snapshot_code
    FROM public.payslip_bank_snapshots s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.bank_snapshot_id;
  IF snapshot_slip IS DISTINCT FROM NEW.payslip_id
    OR NEW.bank_code IS DISTINCT FROM snapshot_code THEN
    RAISE EXCEPTION 'PAYOUT-17: item % must carry the payslip and bank code of its bank snapshot', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_snapshot_guard_trg ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_snapshot_guard_trg
  BEFORE INSERT OR UPDATE OF payslip_id, bank_snapshot_id, bank_code ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_snapshot_guard();
