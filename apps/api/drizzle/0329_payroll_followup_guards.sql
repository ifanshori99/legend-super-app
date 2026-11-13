-- legend-ele0u: the general run lock writes full v1 payslip seals for rapel
-- employees, with a same-transaction finalization receipt. Only the v2 header
-- check is skipped for a v1 envelope; every other check stays. Mirrors
-- payroll-rapel.custom.sql.
CREATE OR REPLACE FUNCTION app.payroll_rapel_payslip_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  employee_join date;
  employee_end date;
  employee_entity uuid;
  employee_outlet uuid;
  outlet_entity uuid;
  run_entity uuid;
  correction record;
BEGIN
  -- Check the reserved id before the no-allocation fast path: a different
  -- employee/run must not claim another allocation's real, decryptable seal.
  IF EXISTS (
    SELECT 1 FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
      AND h.reserved_payslip_id = NEW.id AND h.status = 'allocated'
      AND (h.employee_id IS DISTINCT FROM NEW.employee_id
        OR h.payroll_run_id IS DISTINCT FROM NEW.payroll_run_id)
  ) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: reserved payslip belongs to a different employee or run' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
      AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
      AND h.status = 'allocated'
  ) THEN
    RETURN NEW;
  END IF;
  -- Metadata is part of the AES-GCM AAD, not a caller's receipt label.
  -- A valid old seal keeps its old header even if a raw writer forges a new
  -- receipt. Changing the header makes the payload fail authentication.
  IF octet_length(NEW.calculation_encrypted) < 50 THEN
    RAISE EXCEPTION 'PAYR-RAPEL: final seal needs authenticated allocation metadata' USING ERRCODE = '23514';
  END IF;
  -- legend-ele0u (0329): the general run lock seals the full payslip as a v1
  -- envelope (no revision header). It skips only the v2 header check below;
  -- the same-transaction receipt (sha256, key version, revision count), the
  -- reserved id, eligibility and legal entity checks still apply.
  IF get_byte(NEW.calculation_encrypted, 0) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: unknown payslip seal envelope' USING ERRCODE = '23514';
  END IF;
  IF get_byte(NEW.calculation_encrypted, 0) = 2 AND (
    encode(substring(NEW.calculation_encrypted FROM 6 FOR 16), 'hex') <> replace(NEW.payroll_run_id::text, '-', '')
    OR (get_byte(NEW.calculation_encrypted, 1)::bigint * 16777216
      + get_byte(NEW.calculation_encrypted, 2)::bigint * 65536
      + get_byte(NEW.calculation_encrypted, 3)::bigint * 256
      + get_byte(NEW.calculation_encrypted, 4)::bigint) <> (
        SELECT count(*) FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
          AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
          AND h.status = 'allocated'
      )
  ) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: authenticated seal run or allocation revision is stale' USING ERRCODE = '23514';
  END IF;
  -- Preview is deliberately read-only. Only the trusted batch finalizer
  -- mints a proof for the freshly recomputed ciphertext in this transaction.
  -- A separate caller cannot pair an old seal with a new plaintext revision.
  PERFORM 1 FROM public.payroll_runs r WHERE r.tenant_id = NEW.tenant_id
    AND r.id = NEW.payroll_run_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_rapel_finalizations f
      WHERE f.tenant_id = NEW.tenant_id AND f.payslip_id = NEW.id
        AND f.employee_id = NEW.employee_id AND f.payroll_run_id = NEW.payroll_run_id
        AND f.transaction_id = txid_current()::text
        AND f.pii_key_version = NEW.pii_key_version
        AND f.calculation_sha256 = encode(sha256(NEW.calculation_encrypted), 'hex')
        AND f.allocation_revision = (
          SELECT count(*) FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
            AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
            AND h.status = 'allocated'
        )
  ) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: finalization proof or allocation revision is stale; payment held' USING ERRCODE = '23514';
  END IF;
  SELECT e.join_date, e.end_date, e.legal_entity_id, e.home_outlet_id
    INTO employee_join, employee_end, employee_entity, employee_outlet
    FROM public.employees e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.employee_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYR-RAPEL: employee is missing at finalization' USING ERRCODE = '23514';
  END IF;
  IF employee_outlet IS NOT NULL THEN
    SELECT o.legal_entity_id INTO outlet_entity FROM public.outlets o
      WHERE o.tenant_id = NEW.tenant_id AND o.id = employee_outlet FOR SHARE;
  END IF;
  employee_entity := COALESCE(employee_entity, outlet_entity);
  SELECT r.legal_entity_id INTO run_entity FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id FOR SHARE;
  FOR correction IN
    SELECT h.reserved_payslip_id, h.legal_entity_id, h.eligibility_join_date, h.eligibility_end_date
      FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
        AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
        AND h.status = 'allocated'
  LOOP
    IF correction.reserved_payslip_id IS DISTINCT FROM NEW.id
      OR correction.legal_entity_id IS DISTINCT FROM run_entity
      OR employee_entity IS DISTINCT FROM run_entity
      OR correction.eligibility_join_date IS DISTINCT FROM employee_join
      OR correction.eligibility_end_date IS DISTINCT FROM employee_end
    THEN
      RAISE EXCEPTION 'PAYR-RAPEL: stale eligibility or incorrect reserved payslip; payment held' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- legend-q5dx4: month-dependency edges may point to any earlier run of the same
-- legal entity and tax year (December annual recalculation over the year).
-- Mirrors payroll-run-month-priors.custom.sql.
CREATE OR REPLACE FUNCTION app.payroll_run_month_priors_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_entity uuid;
  run_pay_date date;
  prior_status text;
  prior_entity uuid;
  prior_pay_date date;
BEGIN
  SELECT r.status, r.legal_entity_id, r.pay_date
    INTO run_status, run_entity, run_pay_date
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id;
  IF run_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'PAYR-05: a month dependency needs a locked run (run % is %)', NEW.payroll_run_id, run_status
      USING ERRCODE = '23514';
  END IF;
  SELECT r.status, r.legal_entity_id, r.pay_date
    INTO prior_status, prior_entity, prior_pay_date
    FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.prior_payroll_run_id;
  IF prior_status IS NULL OR prior_status NOT IN ('locked', 'paid') THEN
    RAISE EXCEPTION 'PAYR-05: prior run % must be locked or paid (it is %)', NEW.prior_payroll_run_id, prior_status
      USING ERRCODE = '23514';
  END IF;
  -- legend-q5dx4 (0329): a December annual recalculation depends on every
  -- earlier run of the tax year, so the prior may be any earlier or same month
  -- of the same legal entity and tax year (before: the same month only).
  IF prior_entity IS DISTINCT FROM run_entity
    OR date_trunc('year', prior_pay_date::timestamp) IS DISTINCT FROM date_trunc('year', run_pay_date::timestamp)
    OR date_trunc('month', prior_pay_date::timestamp) > date_trunc('month', run_pay_date::timestamp)
  THEN
    RAISE EXCEPTION 'PAYR-05: prior run % is not in the same legal entity and tax year, on or before the month of run %', NEW.prior_payroll_run_id, NEW.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
