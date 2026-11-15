-- legend-63qhw: the payout GL posting guard stops trusting the caller for two
-- recovery moves of an unresolved settle (`settle_pending` / `settle_skipped`).
--
-- 1. The kind flip to `settle` is only allowed when the settle journal of that
--    posting really exists: same tenant, idempotency key = journal_key, the
--    legal entity of the posting's batch, source type `payroll` and the payroll
--    run of that batch as source id. A posting can no longer be marked settled
--    without the money being booked for the right entity and run.
-- 2. The source GL account of an unresolved settle may be recorded once
--    (NULL -> account), by the finance step that supplies a missing source.
--    It can never be replaced, and no other kind may take it.
-- Everything else about a posting stays frozen (PAYOUT-30), as in 0348/0350/
-- 0381/0383. The journal check runs as the caller, under the same tenant row
-- level security context as the update itself.
GRANT UPDATE (source_gl_account_id) ON TABLE public.payroll_payout_gl_postings TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND NEW.pii_key_version > OLD.pii_key_version
    AND NEW.total_encrypted IS DISTINCT FROM OLD.total_encrypted
    AND (to_jsonb(NEW) - 'total_encrypted' - 'pii_key_version')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'total_encrypted' - 'pii_key_version') THEN
    RETURN NEW;
  END IF;
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted') THEN
    RETURN NEW;
  END IF;
  IF OLD.kind IN ('settle_pending', 'settle_skipped') AND NEW.kind = 'settle'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind')
    AND EXISTS (
      SELECT 1
        FROM public.journal_entries j
        JOIN public.payroll_disbursement_batches b
          ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
       WHERE j.tenant_id = NEW.tenant_id
         AND j.idempotency_key = NEW.journal_key
         AND j.legal_entity_id = b.legal_entity_id
         AND j.source_type = 'payroll'
         AND j.source_id = b.payroll_run_id::text
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD.source_gl_account_id IS NULL AND NEW.source_gl_account_id IS NOT NULL
    AND OLD.kind IN ('settle_pending', 'settle_skipped')
    AND (to_jsonb(NEW) - 'source_gl_account_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'source_gl_account_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
