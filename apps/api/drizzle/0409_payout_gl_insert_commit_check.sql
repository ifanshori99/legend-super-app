-- legend-kjht5 (second opinion 900, P2 insert): a payout GL posting written
-- straight to the table (INSERT right of 0348) was never checked against its
-- journals: the commit checks of 0642 fire on UPDATE of a posting and on lines
-- added to a journal, so a posting inserted as `kind = 'settle'` or with
-- `fee_posted = true` and no journal at all fired nothing. A deferred
-- constraint trigger now re-runs the same two helpers on the INSERTed row at
-- COMMIT (PAYOUT-37):
-- - kind = 'settle': app.payout_settle_journal_ok (principal journal).
-- - fee_posted = true AND fee_idr > 0: app.payout_fee_journal_ok (fee journal).
-- - fee_posted = true AND fee_idr = 0: the one explicit exception, no fee
--   journal exists for a zero fee (the settle check above still applies).
-- Held (settle_pending, settle_skipped) and return postings with fee_posted
-- false stay legal at insert, as the service stores them. Same tenant handling
-- as app.payroll_payout_gl_postings_commit_check (0642).
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
  IF ok AND NEW.fee_posted = true AND NEW.fee_idr > 0 THEN
    ok := app.payout_fee_journal_ok(NEW.tenant_id, NEW.id);
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  IF NOT ok THEN
    RAISE EXCEPTION 'PAYOUT-37: payout GL posting % does not match its journal at commit', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payroll_payout_gl_postings_insert_commit_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_gl_postings_insert_commit_check ON public.payroll_payout_gl_postings;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_payout_gl_postings_insert_commit_check
  AFTER INSERT ON public.payroll_payout_gl_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind = 'settle' OR NEW.fee_posted = true)
  EXECUTE FUNCTION app.payroll_payout_gl_postings_insert_commit_check();
