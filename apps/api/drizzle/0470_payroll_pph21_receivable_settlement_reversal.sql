-- legend-2ln9t (SO 971): a reversed payroll run gave its PPh 21 receivable
-- settlements back with DELETE, but legend_app has no DELETE on
-- accounting_open_item_settlements (ledger is append-only, 0058). The run
-- reversal therefore failed. A settlement is now undone by an appended
-- `reversal` row that names the payment it cancels (reversal_of). The row is
-- never edited or deleted, one payment is cancelled at most once, and the
-- trigger below ties the reversal to its payment (same item, kind, source and
-- amount). Readers count a reversal as negative. The trigger reads the payment
-- without FOR SHARE: that needs UPDATE, which legend_app lacks, and the ledger
-- is append-only for it, so the payment cannot change under the check.
ALTER TABLE "accounting_open_item_settlements" ADD COLUMN "reversal_of" uuid;
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" DROP CONSTRAINT "accounting_open_item_settlements_method_check";
--> statement-breakpoint
-- The FK validation scan reads the old table under FORCE ROW LEVEL SECURITY, which
-- fails for a migration owner without a tenant context (0438 pattern): lift FORCE
-- for this one statement and restore it right after.
ALTER TABLE public.accounting_open_item_settlements NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_reversal_of_fk" FOREIGN KEY ("tenant_id","reversal_of") REFERENCES "public"."accounting_open_item_settlements"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.accounting_open_item_settlements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_open_item_settlements_reversal_key" ON "accounting_open_item_settlements" USING btree ("tenant_id","reversal_of") WHERE "accounting_open_item_settlements"."reversal_of" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_method_check" CHECK ("accounting_open_item_settlements"."method" IN ('payment', 'write_off', 'debit_note', 'reversal'));
--> statement-breakpoint
ALTER TABLE "accounting_open_item_settlements" ADD CONSTRAINT "accounting_open_item_settlements_reversal_check" CHECK (("accounting_open_item_settlements"."method" = 'reversal') = ("accounting_open_item_settlements"."reversal_of" IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.accounting_open_item_settlements_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target public.accounting_open_item_settlements%ROWTYPE;
BEGIN
  SELECT * INTO target
    FROM public.accounting_open_item_settlements s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.reversal_of;
  IF NOT FOUND
    OR target.method <> 'payment'
    OR target.reversal_of IS NOT NULL
    OR target.kind <> NEW.kind
    OR target.open_item_id <> NEW.open_item_id
    OR target.source_id IS DISTINCT FROM NEW.source_id
    OR target.amount_idr <> NEW.amount_idr
    OR target.kind <> 'receivable'
    OR target.journal_entry_id IS NOT NULL
    OR NEW.journal_entry_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'ACC-01: settlement reversal % does not match the payment it cancels', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER accounting_open_item_settlements_reversal_trg BEFORE INSERT ON public.accounting_open_item_settlements FOR EACH ROW WHEN (NEW.method = 'reversal') EXECUTE FUNCTION app.accounting_open_item_settlements_reversal_guard();
