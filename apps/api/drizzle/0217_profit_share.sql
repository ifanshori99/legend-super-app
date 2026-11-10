CREATE TABLE "profit_entities" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"legal_entity_id" uuid,
	"outlet_id" uuid,
	"basis" text DEFAULT 'closed_period_net_profit' NOT NULL,
	"reserve_bp" integer NOT NULL,
	"frequency" text NOT NULL,
	"tax_withholding_bp" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_entities_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "profit_entities_type_check" CHECK (("profit_entities"."type" = 'legal_entity' AND "profit_entities"."legal_entity_id" IS NOT NULL AND "profit_entities"."outlet_id" IS NULL) OR ("profit_entities"."type" = 'outlet' AND "profit_entities"."outlet_id" IS NOT NULL AND "profit_entities"."legal_entity_id" IS NULL)),
	CONSTRAINT "profit_entities_basis_check" CHECK ("profit_entities"."basis" = 'closed_period_net_profit'),
	CONSTRAINT "profit_entities_frequency_check" CHECK ("profit_entities"."frequency" IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
	CONSTRAINT "profit_entities_bp_check" CHECK ("profit_entities"."reserve_bp" BETWEEN 0 AND 10000 AND "profit_entities"."tax_withholding_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "profit_entities_name_check" CHECK (length(btrim("profit_entities"."name")) BETWEEN 1 AND 150),
	CONSTRAINT "profit_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "profit_entities_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "profit_entities_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "shareholders" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"npwp_sealed" text,
	"npwp_last4" varchar(4),
	"payout_bank" text,
	"payout_account_sealed" text,
	"payout_account_last4" varchar(4),
	"payout_account_holder" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shareholders_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "shareholders_type_check" CHECK ("shareholders"."type" IN ('person', 'company')),
	CONSTRAINT "shareholders_status_check" CHECK ("shareholders"."status" IN ('active', 'inactive')),
	CONSTRAINT "shareholders_name_check" CHECK (length(btrim("shareholders"."name")) BETWEEN 1 AND 150),
	CONSTRAINT "shareholders_npwp_check" CHECK (("shareholders"."npwp_sealed" IS NULL) = ("shareholders"."npwp_last4" IS NULL) AND ("shareholders"."npwp_last4" IS NULL OR "shareholders"."npwp_last4" ~ '^[0-9]{4}$')),
	CONSTRAINT "shareholders_payout_check" CHECK ((("shareholders"."payout_bank" IS NULL AND "shareholders"."payout_account_sealed" IS NULL AND "shareholders"."payout_account_last4" IS NULL AND "shareholders"."payout_account_holder" IS NULL) OR ("shareholders"."payout_bank" IS NOT NULL AND "shareholders"."payout_account_sealed" IS NOT NULL AND "shareholders"."payout_account_last4" ~ '^[0-9]{4}$' AND "shareholders"."payout_account_holder" IS NOT NULL))),
	CONSTRAINT "shareholders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "profit_share_commands" (
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"target_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_share_commands_tenant_id_idempotency_key_pk" PRIMARY KEY("tenant_id","idempotency_key"),
	CONSTRAINT "profit_share_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "share_allocation_versions" (
	"tenant_id" uuid NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"idempotency_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_allocation_versions_tenant_id_profit_entity_id_version_pk" PRIMARY KEY("tenant_id","profit_entity_id","version"),
	CONSTRAINT "share_allocation_versions_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "share_allocation_versions_version_check" CHECK ("share_allocation_versions"."version" >= 1),
	CONSTRAINT "share_allocation_versions_status_check" CHECK ("share_allocation_versions"."status" IN ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "share_allocation_versions_decided_check" CHECK (("share_allocation_versions"."status" IN ('approved', 'rejected')) = ("share_allocation_versions"."decided_by" IS NOT NULL AND "share_allocation_versions"."decided_at" IS NOT NULL)),
	CONSTRAINT "share_allocation_versions_note_check" CHECK (("share_allocation_versions"."status" <> 'rejected' OR "share_allocation_versions"."decision_note" IS NOT NULL) AND ("share_allocation_versions"."status" IN ('approved', 'rejected') OR "share_allocation_versions"."decision_note" IS NULL)),
	CONSTRAINT "share_allocation_versions_four_eyes_check" CHECK ("share_allocation_versions"."decided_by" IS NULL OR "share_allocation_versions"."decided_by" <> "share_allocation_versions"."requested_by"),
	CONSTRAINT "share_allocation_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "share_allocation_versions_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "share_allocations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"shareholder_id" uuid NOT NULL,
	"share_bp" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "share_allocations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "share_allocations_version_shareholder_key" UNIQUE("tenant_id","profit_entity_id","version","shareholder_id"),
	CONSTRAINT "share_allocations_share_bp_check" CHECK ("share_allocations"."share_bp" > 0 AND "share_allocations"."share_bp" <= 10000),
	CONSTRAINT "share_allocations_position_check" CHECK ("share_allocations"."position" >= 0),
	CONSTRAINT "share_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "share_allocations_version_fk" FOREIGN KEY ("tenant_id","profit_entity_id","version") REFERENCES "public"."share_allocation_versions"("tenant_id","profit_entity_id","version") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "share_allocations_shareholder_fk" FOREIGN KEY ("tenant_id","shareholder_id") REFERENCES "public"."shareholders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "distribution_runs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"fiscal_period_version" integer NOT NULL,
	"period" varchar(7) NOT NULL,
	"type" text NOT NULL,
	"basis" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"share_version" integer NOT NULL,
	"period_net_profit_idr" bigint,
	"reserve_idr" bigint NOT NULL,
	"distributable_idr" bigint NOT NULL,
	"total_gross_idr" bigint NOT NULL,
	"total_tax_withheld_idr" bigint NOT NULL,
	"total_net_idr" bigint NOT NULL,
	"tax_withholding_bp" integer NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"adjusts_run_id" uuid,
	"adjustment_reason" text,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "distribution_runs_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "distribution_runs_status_check" CHECK ("distribution_runs"."status" IN ('draft', 'pending_approval', 'approved', 'paid', 'cancelled')),
	CONSTRAINT "distribution_runs_type_basis_check" CHECK (("distribution_runs"."type" = 'regular' AND "distribution_runs"."basis" = 'closed_period_net_profit') OR ("distribution_runs"."type" = 'adjustment' AND "distribution_runs"."basis" = 'approved_run_adjustment')),
	CONSTRAINT "distribution_runs_period_check" CHECK ("distribution_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "distribution_runs_regular_check" CHECK ("distribution_runs"."type" <> 'regular' OR ("distribution_runs"."period_net_profit_idr" IS NOT NULL AND "distribution_runs"."period_net_profit_idr" > 0 AND "distribution_runs"."reserve_idr" >= 0 AND "distribution_runs"."distributable_idr" > 0 AND "distribution_runs"."period_net_profit_idr" - "distribution_runs"."reserve_idr" = "distribution_runs"."distributable_idr" AND "distribution_runs"."adjusts_run_id" IS NULL AND "distribution_runs"."adjustment_reason" IS NULL)),
	CONSTRAINT "distribution_runs_adjustment_check" CHECK ("distribution_runs"."type" <> 'adjustment' OR ("distribution_runs"."period_net_profit_idr" IS NULL AND "distribution_runs"."reserve_idr" = 0 AND "distribution_runs"."distributable_idr" <> 0 AND "distribution_runs"."adjusts_run_id" IS NOT NULL AND "distribution_runs"."adjusts_run_id" <> "distribution_runs"."id" AND "distribution_runs"."adjustment_reason" IS NOT NULL)),
	CONSTRAINT "distribution_runs_totals_check" CHECK ("distribution_runs"."distributable_idr" = "distribution_runs"."total_gross_idr" AND "distribution_runs"."total_gross_idr" - "distribution_runs"."total_tax_withheld_idr" = "distribution_runs"."total_net_idr"),
	CONSTRAINT "distribution_runs_fiscal_period_version_check" CHECK ("distribution_runs"."fiscal_period_version" >= 1),
	CONSTRAINT "distribution_runs_tax_bp_check" CHECK ("distribution_runs"."tax_withholding_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "distribution_runs_approved_check" CHECK (("distribution_runs"."status" IN ('approved', 'paid')) = ("distribution_runs"."approved_by" IS NOT NULL AND "distribution_runs"."approved_at" IS NOT NULL)),
	CONSTRAINT "distribution_runs_four_eyes_check" CHECK ("distribution_runs"."approved_by" IS NULL OR "distribution_runs"."approved_by" <> "distribution_runs"."requested_by"),
	CONSTRAINT "distribution_runs_paid_check" CHECK (("distribution_runs"."status" = 'paid') = ("distribution_runs"."paid_at" IS NOT NULL)),
	CONSTRAINT "distribution_runs_cancelled_check" CHECK (("distribution_runs"."status" = 'cancelled') = ("distribution_runs"."cancelled_by" IS NOT NULL AND "distribution_runs"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "distribution_runs_journal_check" CHECK (("distribution_runs"."status" <> 'paid' AND "distribution_runs"."journal_entry_id" IS NULL AND "distribution_runs"."reversal_journal_entry_id" IS NULL) OR ("distribution_runs"."status" = 'paid' AND "distribution_runs"."total_gross_idr" > 0 AND "distribution_runs"."journal_entry_id" IS NOT NULL AND "distribution_runs"."reversal_journal_entry_id" IS NULL) OR ("distribution_runs"."status" = 'paid' AND "distribution_runs"."total_gross_idr" < 0 AND "distribution_runs"."reversal_journal_entry_id" IS NOT NULL AND "distribution_runs"."journal_entry_id" IS NULL)),
	CONSTRAINT "distribution_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_version_fk" FOREIGN KEY ("tenant_id","profit_entity_id","share_version") REFERENCES "public"."share_allocation_versions"("tenant_id","profit_entity_id","version") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_fiscal_period_fk" FOREIGN KEY ("tenant_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_adjusts_fk" FOREIGN KEY ("tenant_id","adjusts_run_id") REFERENCES "public"."distribution_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_runs_reversal_journal_fk" FOREIGN KEY ("tenant_id","reversal_journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "distribution_lines" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"distribution_run_id" uuid NOT NULL,
	"shareholder_id" uuid NOT NULL,
	"share_bp" integer NOT NULL,
	"gross_idr" bigint NOT NULL,
	"tax_withheld_idr" bigint NOT NULL,
	"net_idr" bigint NOT NULL,
	"payment_status" text DEFAULT 'pending' NOT NULL,
	"payment_ref" text,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"statement_file_key" text,
	"position" integer NOT NULL,
	CONSTRAINT "distribution_lines_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "distribution_lines_run_shareholder_key" UNIQUE("tenant_id","distribution_run_id","shareholder_id"),
	CONSTRAINT "distribution_lines_statement_key" UNIQUE("tenant_id","statement_file_key"),
	CONSTRAINT "distribution_lines_share_bp_check" CHECK ("distribution_lines"."share_bp" > 0 AND "distribution_lines"."share_bp" <= 10000),
	CONSTRAINT "distribution_lines_amounts_check" CHECK ("distribution_lines"."gross_idr" <> 0 AND "distribution_lines"."gross_idr" - "distribution_lines"."tax_withheld_idr" = "distribution_lines"."net_idr" AND sign("distribution_lines"."tax_withheld_idr") * sign("distribution_lines"."gross_idr") >= 0 AND abs("distribution_lines"."tax_withheld_idr") <= abs("distribution_lines"."gross_idr")),
	CONSTRAINT "distribution_lines_payment_status_check" CHECK ("distribution_lines"."payment_status" IN ('pending', 'paid')),
	CONSTRAINT "distribution_lines_paid_check" CHECK (("distribution_lines"."payment_status" = 'paid') = ("distribution_lines"."payment_ref" IS NOT NULL AND "distribution_lines"."paid_at" IS NOT NULL AND "distribution_lines"."paid_by" IS NOT NULL)),
	CONSTRAINT "distribution_lines_statement_check" CHECK ("distribution_lines"."statement_file_key" IS NULL OR "distribution_lines"."payment_status" = 'paid'),
	CONSTRAINT "distribution_lines_position_check" CHECK ("distribution_lines"."position" >= 0),
	CONSTRAINT "distribution_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_lines_run_fk" FOREIGN KEY ("tenant_id","distribution_run_id") REFERENCES "public"."distribution_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_lines_shareholder_fk" FOREIGN KEY ("tenant_id","shareholder_id") REFERENCES "public"."shareholders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "distribution_lines_shareholder_idx" ON "distribution_lines" USING btree ("tenant_id","shareholder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_runs_regular_period_key" ON "distribution_runs" USING btree ("tenant_id","profit_entity_id","fiscal_period_id") WHERE "distribution_runs"."type" = 'regular' AND "distribution_runs"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "distribution_runs_entity_requested_idx" ON "distribution_runs" USING btree ("tenant_id","profit_entity_id","requested_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_entities_tenant_legal_entity_key" ON "profit_entities" USING btree ("tenant_id","legal_entity_id") WHERE "profit_entities"."type" = 'legal_entity';--> statement-breakpoint
CREATE UNIQUE INDEX "profit_entities_tenant_outlet_key" ON "profit_entities" USING btree ("tenant_id","outlet_id") WHERE "profit_entities"."type" = 'outlet';--> statement-breakpoint
CREATE UNIQUE INDEX "share_allocation_versions_approved_effective_key" ON "share_allocation_versions" USING btree ("tenant_id","profit_entity_id","effective_from") WHERE "share_allocation_versions"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "share_allocations_shareholder_idx" ON "share_allocations" USING btree ("tenant_id","shareholder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shareholders_tenant_user_key" ON "shareholders" USING btree ("tenant_id","user_id") WHERE "shareholders"."user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.shareholder_document_files NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shareholder_documents NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- profit_entities is new and empty, so any existing row would orphan.
DO $$
DECLARE
  files_n bigint;
  docs_n bigint;
BEGIN
  SELECT count(*) INTO files_n FROM public.shareholder_document_files;
  SELECT count(*) INTO docs_n FROM public.shareholder_documents;
  IF files_n > 0 OR docs_n > 0 THEN
    RAISE EXCEPTION '0217: shareholder_document_files has % rows and shareholder_documents has % rows; both must be empty before the profit_entity_id foreign keys can be added (profit_entities starts empty). Remove or migrate them first.', files_n, docs_n;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "shareholder_document_files" ADD CONSTRAINT "shareholder_document_files_profit_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shareholder_documents" ADD CONSTRAINT "shareholder_documents_profit_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.shareholder_document_files FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shareholder_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Custom SQL migration file, put your code below! ---
-- Profit share & dividends (WS-07, bead legend-2ljb; PRD v1.7 §3.37, §4 P,
-- §6 I; SH-03, SH-04). Appended to drizzle/0217_profit_share.sql.
--
-- 1. Tenant RLS on every table (TEN-01/02). None is outlet-owned (an outlet
--    profit entity is still tenant data managed by finance), so tenant RLS only.
-- 2. SH-03 in the database: shares change only while their version is a draft,
--    a version moves only along the contract state machine, and it can only be
--    pending_approval/approved when its shares sum to exactly 10,000 bp
--    (deferred constraint trigger, checked at commit).
-- 3. §3.37 / SH-02: a run can only be inserted for a CLOSED fiscal period of
--    the entity's legal entity and an APPROVED share version.
-- 4. SH-04: a run is frozen from pending_approval on. After approval only
--    approved -> paid (+ paid_at, journal ids) is allowed, a line can be paid
--    once and a paid line's statement key set once. Totals always equal the
--    lines (deferred). Nothing is deleted; a correction is a new adjustment run.

SELECT app.enforce_tenant_rls('public.profit_entities'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.shareholders'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.share_allocation_versions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.share_allocations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.distribution_runs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.distribution_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.profit_share_commands'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.profit_entities FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.shareholders FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.share_allocation_versions FROM legend_app;
--> statement-breakpoint
REVOKE TRUNCATE ON public.share_allocations FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.distribution_runs FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.distribution_lines FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.profit_share_commands FROM legend_app;
--> statement-breakpoint

-- 2a. Version state machine and freeze.
CREATE OR REPLACE FUNCTION app.share_allocation_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-03: share version % is not a draft and cannot be deleted', OLD.version
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-03: a share version starts as a draft'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.profit_entity_id, NEW.version, NEW.requested_by, NEW.idempotency_key)
     IS DISTINCT FROM (OLD.tenant_id, OLD.profit_entity_id, OLD.version, OLD.requested_by, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'SH-03: share version identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status = 'draft'
       OR (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SH-03: share version % is frozen once submitted', OLD.version
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'rejected' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'SH-03: share version cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.effective_from <> OLD.effective_from THEN
    RAISE EXCEPTION 'SH-03: effective date is frozen once submitted'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "share_allocation_versions_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "share_allocation_versions"
  FOR EACH ROW EXECUTE FUNCTION app.share_allocation_versions_guard();
--> statement-breakpoint

-- 2b. Exactly 10,000 bp for a submitted or approved version, at commit.
CREATE OR REPLACE FUNCTION app.share_allocation_versions_sum_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  current_status text;
  total bigint;
BEGIN
  SELECT v.status INTO current_status FROM public.share_allocation_versions v
  WHERE v.tenant_id = NEW.tenant_id AND v.profit_entity_id = NEW.profit_entity_id
    AND v.version = NEW.version;
  IF current_status IN ('pending_approval', 'approved') THEN
    SELECT coalesce(sum(a.share_bp), 0) INTO total FROM public.share_allocations a
    WHERE a.tenant_id = NEW.tenant_id AND a.profit_entity_id = NEW.profit_entity_id
      AND a.version = NEW.version;
    IF total <> 10000 THEN
      RAISE EXCEPTION 'SH-03: shares of version % must sum to exactly 10000 bp, got %', NEW.version, total
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "share_allocation_versions_sum_trg"
  AFTER INSERT OR UPDATE ON "share_allocation_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.share_allocation_versions_sum_check();
--> statement-breakpoint

-- 2c. Shares change only while their version is a draft.
CREATE OR REPLACE FUNCTION app.share_allocations_draft_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v.status INTO old_status FROM public.share_allocation_versions v
    WHERE v.tenant_id = OLD.tenant_id AND v.profit_entity_id = OLD.profit_entity_id
      AND v.version = OLD.version
    FOR SHARE;
    IF old_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'SH-03: shares of version % are frozen (status %)', OLD.version, old_status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT v.status INTO new_status FROM public.share_allocation_versions v
    WHERE v.tenant_id = NEW.tenant_id AND v.profit_entity_id = NEW.profit_entity_id
      AND v.version = NEW.version
    FOR SHARE;
    IF new_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'SH-03: shares of version % are frozen (status %)', NEW.version, new_status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "share_allocations_draft_only_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "share_allocations"
  FOR EACH ROW EXECUTE FUNCTION app.share_allocations_draft_only();
--> statement-breakpoint

-- 3 + 4a. Run insert preconditions and the run freeze.
CREATE OR REPLACE FUNCTION app.distribution_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  entity_legal_entity uuid;
  period_row record;
  version_status text;
  target record;
  frozen_cols text[] := ARRAY['status', 'approved_by', 'approved_at', 'paid_at',
    'cancelled_by', 'cancelled_at', 'cancel_reason', 'journal_entry_id',
    'reversal_journal_entry_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SH-04: distribution run % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-04: a distribution run starts as a draft'
        USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(pe.legal_entity_id, o.legal_entity_id) INTO entity_legal_entity
    FROM public.profit_entities pe
    LEFT JOIN public.outlets o ON o.tenant_id = pe.tenant_id AND o.id = pe.outlet_id
    WHERE pe.tenant_id = NEW.tenant_id AND pe.id = NEW.profit_entity_id;
    SELECT fp.status, fp.legal_entity_id, fp.period, fp.version INTO period_row
    FROM public.fiscal_periods fp
    WHERE fp.tenant_id = NEW.tenant_id AND fp.id = NEW.fiscal_period_id;
    IF period_row.status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'SH-02: distribution needs a closed fiscal period'
        USING ERRCODE = '23514';
    END IF;
    IF period_row.legal_entity_id IS DISTINCT FROM entity_legal_entity THEN
      RAISE EXCEPTION 'SH-02: fiscal period belongs to another legal entity'
        USING ERRCODE = '23514';
    END IF;
    IF period_row.period IS DISTINCT FROM NEW.period
       OR period_row.version IS DISTINCT FROM NEW.fiscal_period_version THEN
      RAISE EXCEPTION 'SH-02: run period and period version must match its fiscal period'
        USING ERRCODE = '23514';
    END IF;
    SELECT v.status INTO version_status FROM public.share_allocation_versions v
    WHERE v.tenant_id = NEW.tenant_id AND v.profit_entity_id = NEW.profit_entity_id
      AND v.version = NEW.share_version;
    IF version_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'SH-03: distribution needs an approved share version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.type = 'adjustment' THEN
      SELECT r.status, r.profit_entity_id, r.share_version INTO target
      FROM public.distribution_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.adjusts_run_id;
      IF target.status IS NULL OR target.status NOT IN ('approved', 'paid')
         OR target.profit_entity_id <> NEW.profit_entity_id
         OR target.share_version <> NEW.share_version THEN
        RAISE EXCEPTION 'SH-04: an adjustment corrects an approved run with its split'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  -- The period, its version and the share version were checked at INSERT;
  -- they can never change afterwards, not even on a draft.
  IF (NEW.tenant_id, NEW.id, NEW.profit_entity_id, NEW.type, NEW.basis,
      NEW.requested_by, NEW.idempotency_key, NEW.adjusts_run_id,
      NEW.fiscal_period_id, NEW.fiscal_period_version, NEW.period, NEW.share_version)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.profit_entity_id, OLD.type,
      OLD.basis, OLD.requested_by, OLD.idempotency_key, OLD.adjusts_run_id,
      OLD.fiscal_period_id, OLD.fiscal_period_version, OLD.period, OLD.share_version) THEN
    RAISE EXCEPTION 'SH-04: distribution run identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'pending_approval', 'cancelled') THEN
      RAISE EXCEPTION 'SH-04: distribution run cannot move from draft to %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'draft' THEN
      RETURN NEW;
    END IF;
    -- Submit or cancel: amounts stay as calculated.
    IF (to_jsonb(NEW) - frozen_cols) <> (to_jsonb(OLD) - frozen_cols) THEN
      RAISE EXCEPTION 'SH-04: amounts cannot change on submit or cancel'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - frozen_cols) <> (to_jsonb(OLD) - frozen_cols) THEN
    RAISE EXCEPTION 'SH-04: distribution run % is frozen (status %)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SH-04: distribution run % is frozen (status %)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'cancelled') THEN
    IF NEW.journal_entry_id IS NOT NULL OR NEW.reversal_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SH-04: journals are posted on completion only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' THEN
      -- A reopen (or a reopen + re-close) bumps the period version: the profit
      -- figure the run was calculated from may have changed (PERIOD_CHANGED).
      SELECT fp.status, fp.version INTO period_row FROM public.fiscal_periods fp
      WHERE fp.tenant_id = NEW.tenant_id AND fp.id = NEW.fiscal_period_id
      FOR SHARE;
      IF period_row.status IS DISTINCT FROM 'closed'
         OR period_row.version IS DISTINCT FROM NEW.fiscal_period_version THEN
        RAISE EXCEPTION 'SH-02: fiscal period changed since run % was calculated', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF (OLD.approved_by, OLD.approved_at) IS DISTINCT FROM (NEW.approved_by, NEW.approved_at)
       OR OLD.journal_entry_id IS NOT NULL OR OLD.reversal_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SH-04: distribution run % approval is frozen', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.distribution_lines l
      WHERE l.tenant_id = NEW.tenant_id AND l.distribution_run_id = NEW.id
        AND l.payment_status <> 'paid'
    ) THEN
      RAISE EXCEPTION 'SH-04: run % is paid only when every line is paid', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SH-04: distribution run cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "distribution_runs_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "distribution_runs"
  FOR EACH ROW EXECUTE FUNCTION app.distribution_runs_guard();
--> statement-breakpoint

-- 4b. Lines: free while the run is a draft; afterwards only pay once and
--     attach the statement once.
CREATE OR REPLACE FUNCTION app.distribution_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  payment_cols text[] := ARRAY['payment_status', 'payment_ref', 'paid_at', 'paid_by'];
BEGIN
  SELECT r.status INTO run_status FROM public.distribution_runs r
  WHERE r.tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
    AND r.id = coalesce(NEW.distribution_run_id, OLD.distribution_run_id)
  FOR SHARE;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.id, NEW.distribution_run_id)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.distribution_run_id) THEN
    RAISE EXCEPTION 'SH-04: distribution line identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF run_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Pay once, on an approved run, nothing else changing.
    IF run_status = 'approved' AND OLD.payment_status = 'pending'
       AND NEW.payment_status = 'paid'
       AND (to_jsonb(NEW) - payment_cols) = (to_jsonb(OLD) - payment_cols) THEN
      RETURN NEW;
    END IF;
    -- Attach a paid line's statement once.
    IF run_status IN ('approved', 'paid') AND OLD.payment_status = 'paid'
       AND OLD.statement_file_key IS NULL AND NEW.statement_file_key IS NOT NULL
       AND (to_jsonb(NEW) - 'statement_file_key') = (to_jsonb(OLD) - 'statement_file_key') THEN
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SH-04: lines of distribution run % are frozen (status %)',
    coalesce(NEW.distribution_run_id, OLD.distribution_run_id), run_status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "distribution_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "distribution_lines"
  FOR EACH ROW EXECUTE FUNCTION app.distribution_lines_guard();
--> statement-breakpoint

-- 4c. Totals equal the lines and the lines cover exactly 10,000 bp, at commit.
--     Rounding can therefore never lose or add a rupiah between run and lines.
CREATE OR REPLACE FUNCTION app.distribution_run_totals_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_tenant uuid;
  run_id uuid;
  run_row record;
  sums record;
BEGIN
  IF TG_TABLE_NAME = 'distribution_runs' THEN
    run_tenant := NEW.tenant_id;
    run_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    run_tenant := OLD.tenant_id;
    run_id := OLD.distribution_run_id;
  ELSE
    run_tenant := NEW.tenant_id;
    run_id := NEW.distribution_run_id;
  END IF;
  SELECT r.total_gross_idr, r.total_tax_withheld_idr, r.total_net_idr INTO run_row
  FROM public.distribution_runs r
  WHERE r.tenant_id = run_tenant AND r.id = run_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, coalesce(sum(l.gross_idr), 0) AS gross,
         coalesce(sum(l.tax_withheld_idr), 0) AS tax,
         coalesce(sum(l.net_idr), 0) AS net,
         coalesce(sum(l.share_bp), 0) AS bp
  INTO sums
  FROM public.distribution_lines l
  WHERE l.tenant_id = run_tenant AND l.distribution_run_id = run_id;
  IF sums.n = 0 OR sums.gross <> run_row.total_gross_idr
     OR sums.tax <> run_row.total_tax_withheld_idr
     OR sums.net <> run_row.total_net_idr OR sums.bp <> 10000 THEN
    RAISE EXCEPTION 'SH-04: lines of distribution run % do not match its totals', run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_runs_totals_trg"
  AFTER INSERT OR UPDATE ON "distribution_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_run_totals_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_lines_totals_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "distribution_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_run_totals_check();
