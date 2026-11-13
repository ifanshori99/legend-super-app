-- Payroll disbursement batches and items (bead legend-wnkep.1, design
-- docs/design/payroll-disbursement.md 4.2-4.3, 5, 6). Foreign keys are inline
-- while the tables are empty (docs/plan/contracts.md, pattern 1).
CREATE TABLE "payroll_disbursement_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"channel" varchar(12) NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"halt_reason" varchar(24),
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_expires_at" timestamp with time zone,
	"content_hash" varchar(64),
	"item_count" integer DEFAULT 0 NOT NULL,
	"totals_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"bank_format" varchar(12),
	"export_checksum_sha256" varchar(64),
	"exported_by" text,
	"exported_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" varchar(500),
	"worker_lease_until" timestamp with time zone,
	"worker_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_disbursement_batches_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_disbursement_batches_tenant_run_channel_id_key" UNIQUE("tenant_id","id","payroll_run_id","channel"),
	CONSTRAINT "payroll_disbursement_batches_channel_check" CHECK ("payroll_disbursement_batches"."channel" IN ('duitku', 'manual_bank', 'cash')),
	CONSTRAINT "payroll_disbursement_batches_status_check" CHECK ("payroll_disbursement_batches"."status" IN ('draft', 'pending_approval', 'approved', 'sending', 'exported', 'completed', 'partially_failed', 'halted', 'cancelled')),
	CONSTRAINT "payroll_disbursement_batches_halt_reason_check" CHECK (("payroll_disbursement_batches"."status" = 'halted') = ("payroll_disbursement_batches"."halt_reason" IS NOT NULL) AND ("payroll_disbursement_batches"."halt_reason" IS NULL OR "payroll_disbursement_batches"."halt_reason" IN ('insufficient_balance', 'daily_cap', 'provider_down', 'kill_switch', 'config_disabled'))),
	CONSTRAINT "payroll_disbursement_batches_approver_check" CHECK ("payroll_disbursement_batches"."approved_by" IS NULL OR "payroll_disbursement_batches"."approved_by" <> "payroll_disbursement_batches"."requested_by"),
	CONSTRAINT "payroll_disbursement_batches_approval_state_check" CHECK (("payroll_disbursement_batches"."approved_by" IS NULL) = ("payroll_disbursement_batches"."approved_at" IS NULL) AND ("payroll_disbursement_batches"."approved_by" IS NULL) = ("payroll_disbursement_batches"."approval_expires_at" IS NULL)),
	CONSTRAINT "payroll_disbursement_batches_approved_state_check" CHECK ("payroll_disbursement_batches"."status" NOT IN ('approved', 'sending', 'exported', 'completed', 'partially_failed') OR ("payroll_disbursement_batches"."approved_by" IS NOT NULL AND "payroll_disbursement_batches"."content_hash" IS NOT NULL)),
	CONSTRAINT "payroll_disbursement_batches_submitted_hash_check" CHECK ("payroll_disbursement_batches"."status" IN ('draft', 'cancelled') OR "payroll_disbursement_batches"."content_hash" IS NOT NULL),
	CONSTRAINT "payroll_disbursement_batches_content_hash_check" CHECK ("payroll_disbursement_batches"."content_hash" IS NULL OR "payroll_disbursement_batches"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_disbursement_batches_item_count_check" CHECK ("payroll_disbursement_batches"."item_count" >= 0),
	CONSTRAINT "payroll_disbursement_batches_key_version_check" CHECK ("payroll_disbursement_batches"."pii_key_version" >= 1),
	CONSTRAINT "payroll_disbursement_batches_bank_format_check" CHECK ("payroll_disbursement_batches"."bank_format" IS NULL OR ("payroll_disbursement_batches"."channel" = 'manual_bank' AND "payroll_disbursement_batches"."bank_format" IN ('generic_csv', 'bca', 'mandiri', 'bni', 'bjb'))),
	CONSTRAINT "payroll_disbursement_batches_export_state_check" CHECK ((("payroll_disbursement_batches"."export_checksum_sha256" IS NULL) = ("payroll_disbursement_batches"."exported_at" IS NULL)) AND (("payroll_disbursement_batches"."exported_by" IS NULL) = ("payroll_disbursement_batches"."exported_at" IS NULL)) AND ("payroll_disbursement_batches"."export_checksum_sha256" IS NULL OR ("payroll_disbursement_batches"."channel" = 'manual_bank' AND "payroll_disbursement_batches"."export_checksum_sha256" ~ '^[a-f0-9]{64}$')) AND ("payroll_disbursement_batches"."status" <> 'exported' OR "payroll_disbursement_batches"."exported_at" IS NOT NULL)),
	CONSTRAINT "payroll_disbursement_batches_cancel_state_check" CHECK (("payroll_disbursement_batches"."status" = 'cancelled') = ("payroll_disbursement_batches"."cancelled_at" IS NOT NULL) AND ("payroll_disbursement_batches"."cancelled_by" IS NULL) = ("payroll_disbursement_batches"."cancelled_at" IS NULL) AND ("payroll_disbursement_batches"."cancelled_reason" IS NULL OR "payroll_disbursement_batches"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "payroll_disbursement_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_batches_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_batches_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "payroll_disbursement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"channel" varchar(12) NOT NULL,
	"attempt_no" integer NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"amount_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"fee_idr_encrypted" "bytea" NOT NULL,
	"bank_snapshot_id" uuid,
	"bank_code" varchar(3),
	"inquiry_account_name_encrypted" "bytea",
	"name_match" varchar(10),
	"status" varchar(12) DEFAULT 'prepared' NOT NULL,
	"excluded_reason" varchar(24),
	"provider_ref" varchar(100),
	"cust_ref_number" varchar(9),
	"last_response_code" varchar(16),
	"failure_class" varchar(20),
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmation_ref" varchar(100),
	"confirmation_evidence_key" varchar(500),
	"resolved_by" text,
	"resolved_by_2" text,
	"resolution_note" varchar(500),
	"resolution_outcome" text,
	"resolution_evidence_key" varchar(500),
	"gl_posting_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_disbursement_items_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_disbursement_items_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "payroll_disbursement_items_payslip_attempt_key" UNIQUE("tenant_id","payslip_id","attempt_no"),
	CONSTRAINT "payroll_disbursement_items_channel_check" CHECK ("payroll_disbursement_items"."channel" IN ('duitku', 'manual_bank', 'cash')),
	CONSTRAINT "payroll_disbursement_items_status_check" CHECK ("payroll_disbursement_items"."status" IN ('prepared', 'blocked', 'approved', 'sending', 'exported', 'unknown', 'succeeded', 'failed', 'not_sent', 'cancelled', 'returned', 'overpaid')),
	CONSTRAINT "payroll_disbursement_items_excluded_reason_check" CHECK ("payroll_disbursement_items"."excluded_reason" IS NULL OR ("payroll_disbursement_items"."excluded_reason" IN ('inquiry_failed', 'name_mismatch', 'bank_code_missing', 'bank_format_unsupported', 'over_cap') AND "payroll_disbursement_items"."status" IN ('blocked', 'cancelled'))),
	CONSTRAINT "payroll_disbursement_items_blocked_reason_check" CHECK ("payroll_disbursement_items"."status" <> 'blocked' OR "payroll_disbursement_items"."excluded_reason" IS NOT NULL),
	CONSTRAINT "payroll_disbursement_items_name_match_check" CHECK ("payroll_disbursement_items"."name_match" IS NULL OR "payroll_disbursement_items"."name_match" IN ('exact', 'mismatch')),
	CONSTRAINT "payroll_disbursement_items_failure_class_check" CHECK ("payroll_disbursement_items"."failure_class" IS NULL OR "payroll_disbursement_items"."failure_class" IN ('definitive', 'unknown_resolved')),
	CONSTRAINT "payroll_disbursement_items_attempt_check" CHECK ("payroll_disbursement_items"."attempt_no" >= 1 AND "payroll_disbursement_items"."idempotency_key" = 'payslip:' || "payroll_disbursement_items"."payslip_id"::text || ':attempt:' || "payroll_disbursement_items"."attempt_no"::text),
	CONSTRAINT "payroll_disbursement_items_key_version_check" CHECK ("payroll_disbursement_items"."pii_key_version" >= 1),
	CONSTRAINT "payroll_disbursement_items_bank_code_check" CHECK ("payroll_disbursement_items"."bank_code" IS NULL OR "payroll_disbursement_items"."bank_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "payroll_disbursement_items_channel_bank_check" CHECK (("payroll_disbursement_items"."channel" = 'cash' AND "payroll_disbursement_items"."bank_snapshot_id" IS NULL AND "payroll_disbursement_items"."bank_code" IS NULL) OR ("payroll_disbursement_items"."channel" <> 'cash' AND "payroll_disbursement_items"."bank_snapshot_id" IS NOT NULL AND ("payroll_disbursement_items"."bank_code" IS NOT NULL OR "payroll_disbursement_items"."status" IN ('prepared', 'blocked', 'cancelled')))),
	CONSTRAINT "payroll_disbursement_items_succeeded_check" CHECK ("payroll_disbursement_items"."status" <> 'succeeded' OR ("payroll_disbursement_items"."settled_at" IS NOT NULL AND ("payroll_disbursement_items"."channel" <> 'duitku' OR "payroll_disbursement_items"."provider_ref" IS NOT NULL) AND ("payroll_disbursement_items"."channel" <> 'manual_bank' OR ("payroll_disbursement_items"."confirmed_by" IS NOT NULL AND "payroll_disbursement_items"."confirmation_ref" IS NOT NULL)) AND ("payroll_disbursement_items"."channel" <> 'cash' OR "payroll_disbursement_items"."confirmed_by" IS NOT NULL))),
	CONSTRAINT "payroll_disbursement_items_resolvers_check" CHECK ("payroll_disbursement_items"."resolved_by_2" IS NULL OR ("payroll_disbursement_items"."resolved_by" IS NOT NULL AND "payroll_disbursement_items"."resolved_by_2" <> "payroll_disbursement_items"."resolved_by" AND "payroll_disbursement_items"."resolution_outcome" IS NOT NULL AND "payroll_disbursement_items"."resolution_evidence_key" IS NOT NULL)),
	CONSTRAINT "payroll_disbursement_items_resolution_outcome_check" CHECK ("payroll_disbursement_items"."resolution_outcome" IS NULL OR ("payroll_disbursement_items"."resolution_outcome" IN ('failed', 'not_sent') AND "payroll_disbursement_items"."resolved_by" IS NOT NULL)),
	CONSTRAINT "payroll_disbursement_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_items_batch_fk" FOREIGN KEY ("tenant_id","batch_id","payroll_run_id","channel") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id","payroll_run_id","channel") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_items_payslip_fk" FOREIGN KEY ("tenant_id","payslip_id") REFERENCES "public"."payslips"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_items_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_disbursement_items_bank_snapshot_fk" FOREIGN KEY ("tenant_id","bank_snapshot_id") REFERENCES "public"."payslip_bank_snapshots"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_disbursement_batches_one_open_per_run_channel" ON "payroll_disbursement_batches" USING btree ("tenant_id","payroll_run_id","channel") WHERE "payroll_disbursement_batches"."status" NOT IN ('completed', 'partially_failed', 'cancelled');
--> statement-breakpoint
CREATE INDEX "payroll_disbursement_batches_tenant_run_idx" ON "payroll_disbursement_batches" USING btree ("tenant_id","payroll_run_id");
--> statement-breakpoint
CREATE INDEX "payroll_disbursement_batches_tenant_entity_status_idx" ON "payroll_disbursement_batches" USING btree ("tenant_id","legal_entity_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_disbursement_items_one_live_per_payslip" ON "payroll_disbursement_items" USING btree ("tenant_id","payslip_id") WHERE "payroll_disbursement_items"."status" IN ('prepared', 'blocked', 'approved', 'sending', 'exported', 'unknown', 'succeeded');
--> statement-breakpoint
CREATE INDEX "payroll_disbursement_items_tenant_batch_idx" ON "payroll_disbursement_items" USING btree ("tenant_id","batch_id");
--> statement-breakpoint
CREATE INDEX "payroll_disbursement_items_tenant_run_idx" ON "payroll_disbursement_items" USING btree ("tenant_id","payroll_run_id");
--> statement-breakpoint
CREATE INDEX "payroll_disbursement_items_tenant_status_idx" ON "payroll_disbursement_items" USING btree ("tenant_id","status");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_disbursement_batches'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_disbursement_items'::regclass);
--> statement-breakpoint
-- A disbursement row is never erased: it is the evidence of who was paid.
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_disbursement_batches FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_disbursement_items FROM legend_app;
--> statement-breakpoint
-- PAYR-KEY (as 0248): the reseal job moves the sealed values and the key
-- version. The write guards below keep every other change frozen.
GRANT UPDATE (totals_encrypted, pii_key_version) ON TABLE public.payroll_disbursement_batches TO legend_app;
--> statement-breakpoint
GRANT UPDATE (amount_encrypted, fee_idr_encrypted, inquiry_account_name_encrypted, pii_key_version) ON TABLE public.payroll_disbursement_items TO legend_app;
--> statement-breakpoint
-- Batch write guard. Insert: only a draft, only for a locked (or paid, for a
-- follow-up batch) run of the same legal entity; the run row is read FOR SHARE
-- so a reversal of the run cannot interleave (R11). Update: identity never
-- moves, only the status transitions of design 5.1 are legal, the approver is
-- set only by the approval step, the export fields are set once and only by
-- approved -> exported (R14), and a finished batch is frozen.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_batches_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  run_entity uuid;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'PAYOUT-01: a disbursement batch starts as a draft (got %)', NEW.status
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status, r.legal_entity_id INTO run_status, run_entity
      FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('locked', 'paid') THEN
      RAISE EXCEPTION 'PAYOUT-01: a disbursement batch needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    IF run_entity IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'PAYOUT-01: batch legal entity differs from the entity of run %', NEW.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    -- H1 (double pay): a bank or provider batch and the legacy bank file of the
    -- same run are mutually exclusive. The run row lock above serialises this
    -- with the bank file trigger below.
    IF NEW.channel <> 'cash' AND EXISTS (
      SELECT 1 FROM public.bank_transfer_files f
        WHERE f.tenant_id = NEW.tenant_id AND f.payroll_run_id = NEW.payroll_run_id
    ) THEN
      RAISE EXCEPTION 'PAYOUT-06: payroll run % already has a legacy bank transfer file and cannot also be paid by a payout batch', NEW.payroll_run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYOUT-02: the identity of disbursement batch % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.totals_encrypted IS DISTINCT FROM OLD.totals_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version
  THEN
    -- Reseal bypass (PAYR-KEY, as 0248): the sealed totals and the key version
    -- move together, only inside the reseal job's transaction, only upward and
    -- never above the active version, with no other column changed. Valid for
    -- any status, including a final batch.
    IF current_setting('app.payroll_reseal', true) IS DISTINCT FROM 'on' THEN
      IF OLD.status NOT IN ('draft', 'pending_approval') THEN
        RAISE EXCEPTION 'PAYOUT-04: the sealed totals of batch % are frozen after submission', OLD.id
          USING ERRCODE = '23514';
      END IF;
    ELSE
      target_text := current_setting('app.payroll_reseal_target_version', true);
      IF NEW.totals_encrypted IS NOT DISTINCT FROM OLD.totals_encrypted
        OR NEW.pii_key_version IS NOT DISTINCT FROM OLD.pii_key_version
        OR NEW.pii_key_version IS NULL
        OR NEW.pii_key_version <= OLD.pii_key_version
      THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % reseal must change the sealed totals and raise the key version together', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % key version is above the active key version', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF (to_jsonb(NEW) - 'updated_at' - 'totals_encrypted' - 'pii_key_version')
        IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'totals_encrypted' - 'pii_key_version') THEN
        RAISE EXCEPTION 'PAYR-KEY: batch % reseal must not change any other column', OLD.id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF OLD.status IN ('completed', 'partially_failed', 'cancelled') THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'PAYOUT-02: disbursement batch % is final (%) and cannot change', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sending', 'exported', 'completed', 'partially_failed', 'cancelled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('completed', 'partially_failed', 'halted'))
    OR (OLD.status = 'exported' AND NEW.status IN ('completed', 'partially_failed'))
    OR (OLD.status = 'halted' AND NEW.status IN ('sending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'PAYOUT-03: disbursement batch % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('draft', 'pending_approval', 'halted')
    AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'PAYOUT-04: the content hash of approved batch % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('pending_approval', 'halted')
    AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_expires_at IS DISTINCT FROM OLD.approval_expires_at) THEN
    RAISE EXCEPTION 'PAYOUT-04: batch % approval can only be recorded by the approval step', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.exported_at IS NOT NULL AND (
       NEW.exported_at IS DISTINCT FROM OLD.exported_at
    OR NEW.exported_by IS DISTINCT FROM OLD.exported_by
    OR NEW.export_checksum_sha256 IS DISTINCT FROM OLD.export_checksum_sha256) THEN
    RAISE EXCEPTION 'PAYOUT-05: the file of batch % was already exported', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
    AND NOT (OLD.status = 'approved' AND NEW.status = 'exported') THEN
    RAISE EXCEPTION 'PAYOUT-05: batch % can be exported only once, from approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_batches_guard_trg ON public.payroll_disbursement_batches;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_batches_guard_trg
  BEFORE INSERT OR UPDATE ON public.payroll_disbursement_batches
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_batches_guard();
--> statement-breakpoint
-- Item write guard. Insert: only prepared/blocked, only into a draft batch,
-- for a payslip of that run and employee whose payment method matches the
-- channel, while the run is locked or paid (read FOR SHARE, R11). Update:
-- identity never moves; amount, fee, bank snapshot and bank code are frozen
-- once the item left prepared/blocked (only the reseal job re-keys the sealed
-- values); only the transitions of design 5.2 used by the manual and cash
-- channels are legal; a prepared item becomes approved only while its batch
-- carries a different approver (R5); the person who confirmed a payment is
-- never the batch requester; an exported item moves to failed or not_sent only
-- after two different people, both other than the requester, resolved it with
-- evidence (H2); a succeeded item keeps its confirmation; a finished item is
-- frozen.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  slip_run uuid;
  slip_employee uuid;
  slip_method text;
  batch_status text;
  batch_requester text;
  batch_approver text;
  sealed_changed boolean;
  target_text text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('prepared', 'blocked') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item starts prepared or blocked (got %)', NEW.status
        USING ERRCODE = '23514';
    END IF;
    SELECT b.status INTO batch_status FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'PAYOUT-11: items can only be added to a draft batch (batch % is %)', NEW.batch_id, batch_status
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status INTO run_status FROM public.payroll_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
      FOR SHARE;
    IF run_status IS NULL OR run_status NOT IN ('locked', 'paid') THEN
      RAISE EXCEPTION 'PAYOUT-11: a disbursement item needs a locked or paid run (run % is %)', NEW.payroll_run_id, run_status
        USING ERRCODE = '23514';
    END IF;
    SELECT s.payroll_run_id, s.employee_id, s.payment_method
      INTO slip_run, slip_employee, slip_method
      FROM public.payslips s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.payslip_id;
    IF slip_run IS DISTINCT FROM NEW.payroll_run_id
      OR slip_employee IS DISTINCT FROM NEW.employee_id
      OR slip_method IS DISTINCT FROM (CASE WHEN NEW.channel = 'cash' THEN 'cash' ELSE 'bank_transfer' END)
    THEN
      RAISE EXCEPTION 'PAYOUT-11: item % does not match the run, employee and payment method of its payslip', NEW.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
    OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PAYOUT-12: the identity of disbursement item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND (NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
      OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
      OR NEW.inquiry_account_name_encrypted IS DISTINCT FROM OLD.inquiry_account_name_encrypted
      OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version)
  THEN
    -- Reseal bypass (PAYR-KEY, as 0248): the sealed amount, fee and inquiry
    -- name move together with a higher key version, only inside the reseal
    -- job's transaction, never above the active version, with no other column
    -- changed. Valid for any status, including a final item.
    target_text := current_setting('app.payroll_reseal_target_version', true);
    IF NEW.pii_key_version IS NULL
      OR NEW.pii_key_version <= OLD.pii_key_version
      OR NEW.amount_encrypted IS NOT DISTINCT FROM OLD.amount_encrypted
    THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must change the sealed amount and raise the key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF target_text IS NULL OR target_text !~ '^[0-9]{1,5}$' OR NEW.pii_key_version > target_text::integer THEN
      RAISE EXCEPTION 'PAYR-KEY: item % key version is above the active key version', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(NEW) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version')
      IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'amount_encrypted' - 'fee_idr_encrypted' - 'inquiry_account_name_encrypted' - 'pii_key_version') THEN
      RAISE EXCEPTION 'PAYR-KEY: item % reseal must not change any other column', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('failed', 'not_sent', 'cancelled', 'returned', 'overpaid')
    AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'PAYOUT-12: disbursement item % is final (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('prepared', 'blocked')
    AND (NEW.bank_snapshot_id IS DISTINCT FROM OLD.bank_snapshot_id
      OR NEW.bank_code IS DISTINCT FROM OLD.bank_code) THEN
    RAISE EXCEPTION 'PAYOUT-13: the payee of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  sealed_changed := NEW.amount_encrypted IS DISTINCT FROM OLD.amount_encrypted
    OR NEW.fee_idr_encrypted IS DISTINCT FROM OLD.fee_idr_encrypted
    OR NEW.pii_key_version IS DISTINCT FROM OLD.pii_key_version;
  IF sealed_changed AND OLD.status NOT IN ('prepared', 'blocked') THEN
    RAISE EXCEPTION 'PAYOUT-13: the amount of item % is frozen once approved', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'prepared' AND NEW.status IN ('blocked', 'approved', 'cancelled'))
      OR (OLD.status = 'blocked' AND NEW.status = 'cancelled')
      OR (OLD.status = 'approved' AND NEW.status IN ('not_sent', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status = 'exported' AND NEW.channel = 'manual_bank')
      OR (OLD.status = 'approved' AND NEW.status = 'succeeded' AND NEW.channel = 'cash')
      OR (OLD.status = 'exported' AND NEW.status IN ('succeeded', 'failed', 'not_sent'))
      OR (OLD.status = 'succeeded' AND NEW.status = 'returned')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-14: item % cannot move from % to % on channel %', OLD.id, OLD.status, NEW.status, NEW.channel
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' THEN
      SELECT b.status, b.approved_by, b.requested_by
        INTO batch_status, batch_approver, batch_requester
        FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
      IF batch_status IS DISTINCT FROM 'approved'
        OR batch_approver IS NULL
        OR batch_approver = batch_requester THEN
        RAISE EXCEPTION 'PAYOUT-15: item % can be approved only by an approved batch with a second person', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'succeeded' AND (
       NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmation_evidence_key IS DISTINCT FROM OLD.confirmation_evidence_key
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
    -- L4: the record of a payment is evidence; only returned_at and the
    -- succeeded -> returned status move after it.
    RAISE EXCEPTION 'PAYOUT-19: the payment record of succeeded item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.confirmed_by = batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-16: the requester of the batch cannot confirm payment of item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- H2: a manual resolution (failed / not_sent) frees the payslip for a new
  -- payment, so it takes two different people, both other than the batch
  -- requester, plus evidence. The first one records the proposal and the item
  -- stays exported; once recorded, the proposal cannot be rewritten.
  IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    OR NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2
    OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
    OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
    IF OLD.status NOT IN ('exported', 'unknown') THEN
      RAISE EXCEPTION 'PAYOUT-18: item % can be resolved only while exported or unknown (is %)', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.resolved_by IS NOT NULL AND (
           NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
        OR NEW.resolution_outcome IS DISTINCT FROM OLD.resolution_outcome
        OR NEW.resolution_evidence_key IS DISTINCT FROM OLD.resolution_evidence_key
        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note))
      OR (OLD.resolved_by_2 IS NOT NULL AND NEW.resolved_by_2 IS DISTINCT FROM OLD.resolved_by_2) THEN
      RAISE EXCEPTION 'PAYOUT-18: the recorded resolution of item % cannot be rewritten', OLD.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NOT DISTINCT FROM batch_requester
      OR NEW.resolved_by_2 IS NOT DISTINCT FROM batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-18: the requester of the batch cannot resolve item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('failed', 'not_sent') AND NEW.status IS DISTINCT FROM OLD.status AND OLD.status = 'exported' THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.resolved_by IS NULL
      OR NEW.resolved_by_2 IS NULL
      OR NEW.resolved_by = NEW.resolved_by_2
      OR NEW.resolved_by = batch_requester
      OR NEW.resolved_by_2 = batch_requester
      OR NEW.resolution_evidence_key IS NULL
      OR NEW.resolution_outcome IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'PAYOUT-18: exported item % can become % only after two different people (not the requester) resolved it with evidence', OLD.id, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_guard_trg ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_guard_trg
  BEFORE INSERT OR UPDATE ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_guard();
--> statement-breakpoint
-- Run guards (R10, R11, D-08). A run cannot be reversed while a batch of it is
-- open or an item of it is sending/exported/unknown/succeeded; a run becomes
-- `paid` only through the payout settle code (app.payout_settle = 'on', set
-- with set_config(..., true)) once it has any batch that is not cancelled, so
-- the old "mark as paid" path cannot bypass the per-item payment record.
CREATE OR REPLACE FUNCTION app.payroll_runs_payout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'reversed' THEN
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status NOT IN ('completed', 'partially_failed', 'cancelled')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('sending', 'exported', 'unknown', 'succeeded')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-21: payroll run % has a payout in progress or paid items and cannot be reversed', NEW.id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'paid' THEN
    IF current_setting('app.payout_settle', true) IS DISTINCT FROM 'on' AND EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'PAYOUT-22: payroll run % has disbursement batches and becomes paid only when its items are paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
    -- L3: even the payout settle code cannot mark a run paid while a payment
    -- of it is still open. (That every net pay slip has a succeeded item is not
    -- checkable here: the net amount is sealed; the settle code checks it.)
    IF EXISTS (
      SELECT 1 FROM public.payroll_disbursement_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.id
          AND b.status IN ('pending_approval', 'approved', 'sending', 'exported')
    ) OR EXISTS (
      SELECT 1 FROM public.payroll_disbursement_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.payroll_run_id = NEW.id
          AND i.status IN ('approved', 'sending', 'exported', 'unknown')
    ) THEN
      RAISE EXCEPTION 'PAYOUT-23: payroll run % has a payout that is still open and cannot become paid', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_runs_payout_guard_trg ON public.payroll_runs;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_payout_guard_trg
  BEFORE UPDATE OF status ON public.payroll_runs
  FOR EACH ROW
  WHEN (NEW.status IN ('reversed', 'paid') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.payroll_runs_payout_guard();
--> statement-breakpoint
-- H1 (double pay), the other side: the legacy bank transfer file cannot be
-- created for a run that has a bank or provider batch that is not cancelled.
-- The run row is locked FOR UPDATE so it serialises with the batch insert
-- (which reads the run FOR SHARE) and the check below sees its committed row.
CREATE OR REPLACE FUNCTION app.bank_transfer_files_payout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.payroll_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payroll_run_id
    FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.payroll_run_id = NEW.payroll_run_id
        AND b.channel <> 'cash' AND b.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-07: payroll run % has a payout batch and cannot also get a legacy bank transfer file', NEW.payroll_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bank_transfer_files_payout_guard_trg ON public.bank_transfer_files;
--> statement-breakpoint
CREATE TRIGGER bank_transfer_files_payout_guard_trg
  BEFORE INSERT ON public.bank_transfer_files
  FOR EACH ROW EXECUTE FUNCTION app.bank_transfer_files_payout_guard();
