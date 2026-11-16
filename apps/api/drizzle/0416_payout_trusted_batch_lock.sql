-- legend-kjht5 (905 test round 2): the payout-role functions lock the batch row
-- (SELECT ... FOR UPDATE) to serialise the money steps of one batch. PostgreSQL
-- requires UPDATE on at least one column for any row lock, and the payout role
-- only had SELECT on payroll_disbursement_batches (permission denied, 42501).
-- One inert column is enough: updated_at. The role still cannot change the batch
-- status, totals, hash or any other column; no function updates the batch, and no
-- row is edited by this migration.
GRANT UPDATE (updated_at) ON TABLE public.payroll_disbursement_batches TO legend_payout;
--> statement-breakpoint
-- (test round 2) 0409 re-ran the fee journal check of app.payout_fee_journal_ok
-- on every INSERTed posting with fee_posted = true and fee_idr > 0. That helper
-- looks for the settlement fee journal ('payroll-payout-fee:' || item_set_hash),
-- which only a settle / settle_pending / settle_skipped posting has: the fee of
-- an overpaid record has its own journal key ('payroll-payout-overpaid-fee:...',
-- NOT checked at commit: app.payout_item_journal_ok does not cover it; follow-up
-- bead legend-d9pxr) and return / correction postings carry the default fee_posted = true without a
-- settlement fee journal. Their INSERT therefore failed at COMMIT (PAYOUT-37).
-- The fee branch now applies to the settlement kinds only; the settle branch
-- (kind = 'settle') is unchanged. Function body only, no row edited.
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_insert_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  ok boolean := true;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_id', NEW.tenant_id::text, true);
  IF NEW.kind = 'settle' THEN
    ok := app.payout_settle_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  IF ok AND NEW.kind IN ('settle', 'settle_pending', 'settle_skipped')
    AND NEW.fee_posted = true AND NEW.fee_idr > 0 THEN
    ok := app.payout_fee_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF NOT ok THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
