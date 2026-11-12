CREATE TABLE "payroll_rapel_finalizations" (
	"payslip_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"allocation_revision" integer NOT NULL,
	"calculation_sha256" varchar(64) NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"transaction_id" text DEFAULT txid_current()::text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_rapel_finalizations_tenant_id_key" UNIQUE("tenant_id","payslip_id"),
	CONSTRAINT "payroll_rapel_finalizations_run_employee_key" UNIQUE("tenant_id","payroll_run_id","employee_id"),
	CONSTRAINT "payroll_rapel_finalizations_revision_check" CHECK ("payroll_rapel_finalizations"."allocation_revision" >= 0),
	CONSTRAINT "payroll_rapel_finalizations_key_version_check" CHECK ("payroll_rapel_finalizations"."pii_key_version" >= 1),
	CONSTRAINT "payroll_rapel_finalizations_hash_check" CHECK ("payroll_rapel_finalizations"."calculation_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payroll_rapel_finalizations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_rapel_finalizations_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_rapel_finalizations_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
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
  IF get_byte(NEW.calculation_encrypted, 0) <> 2
    OR encode(substring(NEW.calculation_encrypted FROM 6 FOR 16), 'hex') <> replace(NEW.payroll_run_id::text, '-', '')
    OR (get_byte(NEW.calculation_encrypted, 1)::bigint * 16777216
      + get_byte(NEW.calculation_encrypted, 2)::bigint * 65536
      + get_byte(NEW.calculation_encrypted, 3)::bigint * 256
      + get_byte(NEW.calculation_encrypted, 4)::bigint) <> (
        SELECT count(*) FROM public.payroll_rapels h WHERE h.tenant_id = NEW.tenant_id
          AND h.employee_id = NEW.employee_id AND h.payroll_run_id = NEW.payroll_run_id
          AND h.status = 'allocated'
      )
  THEN
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
