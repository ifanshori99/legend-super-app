-- legend-5vb7y: the kind flip to `settle` (from `settle_pending` or
-- `settle_skipped`) also checks the CONTENT of the settle journal, not only its
-- header (tenant, key, legal entity, source type `payroll`, run as source id,
-- as in 0384). The journal must:
--   (a) have lines with total debit = total credit > 0;
--   (b) debit only the salaries payable account (role `salaries_payable`,
--       2103) mapped for the entity: a reversed journal (debit on the source)
--       or a debit on any other account is refused;
--   (c) credit only the source account of the money: the GL account of the
--       bank account frozen on the batch (bank channel), else the
--       `source_gl_account_id` of the posting (cash). Without a known source
--       nothing matches and the flip is refused (fail closed).
-- Limits, on purpose: the principal amount is sealed in `total_encrypted`, so
-- SQL cannot compare it with the journal total; a journal of the right shape
-- for a wrong AMOUNT is still accepted here and is covered by the service,
-- which derives the amount from the sealed items. `journal_entries` has no
-- column telling the `payroll.paid` rule apart from other payroll journals
-- (`posting_account_snapshot` is writable by the caller and proves nothing),
-- so that part of the check is skipped. The 2103 check follows the mapping of
-- the moment of the flip, which is the posting transaction itself in the
-- service. Everything else about a posting stays frozen (PAYOUT-30). The
-- checks run as the caller under the same tenant row level security.
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
         -- Lines: something is debited, debits equal credits.
         AND (SELECT pg_catalog.sum(l.debit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id) > 0
         AND (SELECT pg_catalog.sum(l.debit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
           = (SELECT pg_catalog.sum(l.credit_idr)
                FROM public.journal_lines l
               WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id)
         -- Every debit line is on the salaries payable account (2103) the
         -- entity maps today; a reversed journal (debit on the source) fails.
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_lines l
            WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
              AND l.debit_idr > 0
              AND l.account_id IS DISTINCT FROM (
                SELECT m.account_id
                  FROM public.account_mappings m
                 WHERE m.tenant_id = b.tenant_id
                   AND m.legal_entity_id = b.legal_entity_id
                   AND m.role = 'salaries_payable')
         )
         -- Every credit line is on the source account of the money: the GL
         -- account of the bank account frozen on the batch (bank), else the
         -- one recorded on the posting (cash). No known source: no credit
         -- line can match, so the flip is refused (fail closed).
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_lines l
            WHERE l.tenant_id = j.tenant_id AND l.entry_id = j.id
              AND l.credit_idr > 0
              AND l.account_id IS DISTINCT FROM (
                CASE
                  WHEN b.channel <> 'cash' AND b.source_bank_account_id IS NOT NULL
                  THEN (SELECT ba.gl_account_id
                          FROM public.bank_accounts ba
                         WHERE ba.tenant_id = b.tenant_id
                           AND ba.legal_entity_id = b.legal_entity_id
                           AND ba.id = b.source_bank_account_id)
                  ELSE NEW.source_gl_account_id
                END)
         )
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
