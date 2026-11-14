-- Payout SO fixes (bead legend-hkh57). The company bank account a batch pays
-- from is frozen on the batch at approve (or at export for a batch approved
-- before this column existed). A later change of the payout config never moves
-- an old batch: its settle, fee re-post and overpaid journals keep crediting
-- this account. Null: a cash batch or a batch from before this migration.
ALTER TABLE "payroll_disbursement_batches" ADD COLUMN "source_bank_account_id" uuid;--> statement-breakpoint
-- Both tables FORCE tenant RLS: lift it for this one statement and restore it
-- (pattern 2 of migration-fk-force-rls.test.ts).
ALTER TABLE public.bank_accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payroll_disbursement_batches NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_disbursement_batches" ADD CONSTRAINT "payroll_disbursement_batches_source_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","source_bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.payroll_disbursement_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bank_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Once set, the frozen account never changes, and it is only set while the
-- batch is being approved or exported.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_batches_source_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.source_bank_account_id IS NOT DISTINCT FROM OLD.source_bank_account_id THEN
    RETURN NEW;
  END IF;
  IF OLD.source_bank_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-07: the source bank account of batch % is frozen', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'PAYOUT-07: the source bank account of batch % can only be frozen at approve or export', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_batches_source_freeze_trg ON public.payroll_disbursement_batches;--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_batches_source_freeze_trg
  BEFORE UPDATE ON public.payroll_disbursement_batches
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_batches_source_freeze();
