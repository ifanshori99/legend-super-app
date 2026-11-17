-- Custom SQL migration file, put your code below! ---
-- AP/AR open items, fixed assets + depreciation, budgets (bead legend-hpgo;
-- PRD v1.7 §3.19 Utang & Piutang, Aset Tetap, Anggaran; §6 F). Tenant RLS on
-- every table (TEN-01/02). None of these tables is outlet-owned: outlet_id is
-- nullable everywhere (null = whole legal entity, contract payables/assets/
-- budgets), so outlet reach is enforced in services/accounting-*.ts
-- (contracts.md "TEN-03 outlet isolation layers"), like the accounting core
-- tables. Every CHECK / unique key is expressed in schema/accounting-ap-fa.ts.
SELECT app.enforce_tenant_rls('public.accounting_open_items'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.accounting_open_item_settlements'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_assets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.depreciation_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_depreciations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_revaluations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.budgets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.asset_categories'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.finance_policies'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.accounting_command_idempotency'::regclass);
--> statement-breakpoint
-- Ledgers are append-only for the application role: depreciation postings and
-- revaluation history are corrected by new rows + reversing journals, never
-- edited (ACC-01 spirit for the sub-ledgers).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_depreciations FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_revaluations FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.accounting_open_item_settlements FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.accounting_command_idempotency FROM legend_app;
--> statement-breakpoint
-- legend-2ln9t: a settlement is undone by an appended `reversal` row (never
-- DELETE). The row must match the payment it cancels: same item, kind, source
-- and amount, and that payment is not itself a reversal.
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
