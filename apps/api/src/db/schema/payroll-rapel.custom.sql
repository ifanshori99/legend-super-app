-- legend-svqew: tenant-only salary history, never deletable by the app.
SELECT app.enforce_tenant_rls('public.payroll_rapels'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_rapel_items'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, UPDATE ON TABLE public.payroll_rapels, public.payroll_rapel_items FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, approved_by_hr, approved_by_hr_at, approved_by_finance, approved_by_finance_at, payroll_run_id, reserved_payslip_id, updated_at, new_amount_encrypted, pii_key_version) ON TABLE public.payroll_rapels TO legend_app;
--> statement-breakpoint
GRANT UPDATE (amount_encrypted, pii_key_version) ON TABLE public.payroll_rapel_items TO legend_app;
--> statement-breakpoint
-- The salary target, source link and each delta are immutable. A key change
-- follows the existing payroll reseal contract (0248): version only goes up,
-- ciphertext and version change together, all logical columns stay identical.
CREATE OR REPLACE FUNCTION app.payroll_rapel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  cipher_name text;
  target_text text;
  allowed text[];
BEGIN
  IF TG_TABLE_NAME = 'payroll_rapels' THEN
    cipher_name := 'new_amount_encrypted';
  ELSE
    cipher_name := 'amount_encrypted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'payroll_rapels' THEN
      IF NEW.status <> 'pending' OR NEW.approved_by_hr IS NOT NULL OR NEW.approved_by_finance IS NOT NULL OR NEW.payroll_run_id IS NOT NULL THEN
        RAISE EXCEPTION 'PAYR-RAPEL: corrections start pending' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM public.payroll_rapels h JOIN public.payroll_runs r
          ON r.tenant_id = h.tenant_id AND r.id = NEW.source_run_id
        WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.rapel_id
          AND h.status = 'pending' AND r.status IN ('locked', 'paid')
          AND r.run_type = 'regular' AND r.legal_entity_id = h.legal_entity_id
          AND r.period_end < h.prospective_from
      ) THEN
        RAISE EXCEPTION 'PAYR-RAPEL: source must be a frozen regular run of the same legal entity' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)->cipher_name) IS DISTINCT FROM (to_jsonb(OLD)->cipher_name)
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version
  THEN
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on'
      OR target_text IS NULL OR target_text !~ '^[0-9]{1,5}$'
      OR NEW.pii_key_version <= OLD.pii_key_version
      OR NEW.pii_key_version > target_text::integer
      OR (to_jsonb(NEW)->cipher_name) IS NOT DISTINCT FROM (to_jsonb(OLD)->cipher_name)
      OR (to_jsonb(NEW) - cipher_name - 'pii_key_version') IS DISTINCT FROM (to_jsonb(OLD) - cipher_name - 'pii_key_version')
    THEN
      RAISE EXCEPTION 'PAYR-KEY: rapel reseal must preserve every logical value' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'payroll_rapel_items' THEN
    RAISE EXCEPTION 'PAYR-RAPEL: source deltas never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'hr_approved' THEN
    allowed := ARRAY['status', 'approved_by_hr', 'approved_by_hr_at', 'updated_at'];
  ELSIF OLD.status = 'hr_approved' AND NEW.status = 'approved' THEN
    allowed := ARRAY['status', 'approved_by_finance', 'approved_by_finance_at', 'updated_at'];
    IF NOT EXISTS (SELECT 1 FROM public.payroll_rapel_items i WHERE i.tenant_id = OLD.tenant_id AND i.rapel_id = OLD.id)
      OR EXISTS (
        SELECT 1 FROM public.payroll_rapel_items i JOIN public.payroll_runs r
          ON r.tenant_id = i.tenant_id AND r.id = i.source_run_id
        WHERE i.tenant_id = OLD.tenant_id AND i.rapel_id = OLD.id
          AND (r.status NOT IN ('locked', 'paid') OR r.run_type <> 'regular' OR r.legal_entity_id <> OLD.legal_entity_id)
      ) THEN
      RAISE EXCEPTION 'PAYR-RAPEL: approved correction needs valid frozen sources' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('pending', 'hr_approved') AND NEW.status = 'cancelled' THEN
    allowed := ARRAY['status', 'updated_at'];
  ELSIF OLD.status = 'approved' AND NEW.status = 'allocated' THEN
    allowed := ARRAY['status', 'payroll_run_id', 'reserved_payslip_id', 'updated_at'];
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_runs r WHERE r.tenant_id = OLD.tenant_id
        AND r.id = NEW.payroll_run_id AND r.status = 'draft'
        AND r.run_type = 'regular' AND r.legal_entity_id = OLD.legal_entity_id
        AND r.period_start >= OLD.prospective_from
    ) THEN
      RAISE EXCEPTION 'PAYR-RAPEL: allocation needs a later draft regular run' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'PAYR-RAPEL: invalid or repeated state mutation' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: immutable correction fields cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_rapels_guard_trg BEFORE INSERT OR UPDATE ON public.payroll_rapels FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_rapel_items_guard_trg BEFORE INSERT OR UPDATE ON public.payroll_rapel_items FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_guard();
--> statement-breakpoint
-- An approved correction must not outlive a voided source while a replacement
-- salary run pays the raised amount again. Hold reversal for explicit review.
CREATE OR REPLACE FUNCTION app.payroll_rapel_source_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'reversed' AND OLD.status <> 'reversed' AND EXISTS (
    SELECT 1 FROM public.payroll_rapel_items i JOIN public.payroll_rapels h
      ON h.tenant_id = i.tenant_id AND h.id = i.rapel_id
    WHERE i.tenant_id = OLD.tenant_id AND i.source_run_id = OLD.id
      AND h.status IN ('approved', 'allocated')
  ) THEN
    RAISE EXCEPTION 'PAYR-RAPEL: source with approved corrections needs manual reversal review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_rapel_source_reversal_guard_trg BEFORE UPDATE OF status ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_source_reversal_guard();
--> statement-breakpoint
-- Only a fresh calculation from the locked finalization transaction may be
-- persisted. Recheck its receipt, reserved identity and employment snapshot,
-- holding the employee/outlet rows until the payslip transaction commits.
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
CREATE TRIGGER payroll_rapel_payslip_insert_guard_trg BEFORE INSERT ON public.payslips FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_payslip_insert_guard();
--> statement-breakpoint
-- Allocation approves these exact target facts. A draft can otherwise move
-- dates/policy/entity after approval and replay the credit in another period.
-- Status-only lifecycle transitions remain governed by payroll_runs_guard.
CREATE OR REPLACE FUNCTION app.payroll_rapel_target_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.period_start, NEW.period_end, NEW.run_type, NEW.payroll_policy_id, NEW.legal_entity_id)
    IS DISTINCT FROM (OLD.period_start, OLD.period_end, OLD.run_type, OLD.payroll_policy_id, OLD.legal_entity_id)
    AND EXISTS (
      SELECT 1 FROM public.payroll_rapels h WHERE h.tenant_id = OLD.tenant_id
        AND h.payroll_run_id = OLD.id AND h.status = 'allocated'
    )
  THEN
    RAISE EXCEPTION 'PAYR-RAPEL: allocated target period, type, policy and legal entity cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_rapel_target_facts_guard_trg BEFORE UPDATE OF period_start, period_end, run_type, payroll_policy_id, legal_entity_id ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_target_facts_guard();

--> statement-breakpoint
-- This proof contains no salary payload and is immutable. It authenticates
-- the initial INSERT only; legitimate payslip key rotation keeps working.
SELECT app.enforce_tenant_rls('public.payroll_rapel_finalizations'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_rapel_finalizations FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_rapel_finalization_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  revision integer;
BEGIN
  SELECT r.status INTO run_status FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id FOR UPDATE;
  SELECT count(*) INTO revision FROM public.payroll_rapels h
    WHERE h.tenant_id = NEW.tenant_id AND h.employee_id = NEW.employee_id
      AND h.payroll_run_id = NEW.payroll_run_id AND h.status = 'allocated';
  IF run_status IS DISTINCT FROM 'locked'
    OR NEW.transaction_id IS DISTINCT FROM txid_current()::text
    OR NEW.allocation_revision IS DISTINCT FROM revision
    OR EXISTS (
      SELECT 1 FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
        AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
        AND h.status = 'allocated' AND h.reserved_payslip_id IS DISTINCT FROM NEW.payslip_id
    )
    OR EXISTS (
      SELECT 1 FROM public.payslips p WHERE p.tenant_id = NEW.tenant_id
        AND p.employee_id = NEW.employee_id AND p.payroll_run_id = NEW.payroll_run_id
    )
  THEN
    RAISE EXCEPTION 'PAYR-RAPEL: finalization proof must match the current locked allocation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_rapel_finalization_guard_trg BEFORE INSERT ON public.payroll_rapel_finalizations FOR EACH ROW EXECUTE FUNCTION app.payroll_rapel_finalization_guard();
