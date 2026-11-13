-- Payout hardening (bead legend-8codi; brief docs/briefs/661-payroll-payout-hardening.md).
-- A posting records whether the bank fee of its item group was journaled. A
-- skipped fee (bank charges mapping or source account missing at settle) is
-- fee_posted = false until finance re-posts it once. Existing rows stay true.
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "fee_posted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- The only change a posting accepts besides the reseal job: fee_posted false -> true.
GRANT UPDATE (fee_posted) ON TABLE public.payroll_payout_gl_postings TO legend_app;
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
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
