ALTER TABLE "distribution_runs" ADD COLUMN "unabsorbed_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD CONSTRAINT "distribution_runs_unabsorbed_check" CHECK ("distribution_runs"."unabsorbed_idr" >= 0 AND ("distribution_runs"."unabsorbed_idr" = 0 OR ("distribution_runs"."type" = 'adjustment' AND "distribution_runs"."distributable_idr" < 0)));
--> statement-breakpoint
-- Founder rule Q83: a claw-back may leave out a shareholder with nothing left to give back,
-- so an adjustment run carries 1..10000 bp; a regular run still carries all 10000.
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
  SELECT r.type, r.total_gross_idr, r.total_tax_withheld_idr, r.total_net_idr INTO run_row
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
     OR sums.net <> run_row.total_net_idr
     -- A regular run carries every share (10000 bp). A claw-back (founder rule
     -- Q83) leaves out a shareholder with nothing left to give back.
     OR (run_row.type = 'regular' AND sums.bp <> 10000)
     OR (run_row.type = 'adjustment' AND (sums.bp < 1 OR sums.bp > 10000)) THEN
    RAISE EXCEPTION 'SH-04: lines of distribution run % do not match its totals', run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- An adjustment corrects a regular run only (see distribution_runs_guard).
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
      SELECT r.status, r.type, r.profit_entity_id, r.share_version INTO target
      FROM public.distribution_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.adjusts_run_id;
      -- One correction tree per regular run: the claw-back room is counted
      -- against the regular run, never against another adjustment.
      IF target.status IS NULL OR target.status NOT IN ('approved', 'paid')
         OR target.type <> 'regular'
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
-- The migrator may be a plain table owner (no BYPASSRLS): lift FORCE on roles for
-- this transaction and restore it right after (same pattern as 0171).
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- legend-8s992, founder Q84: changing share percentages is its own permission,
-- `profit_share.share_allocation.change`. Role rows are seeded once per tenant
-- and the resolver reads the stored rows, so existing tenants get it appended to
-- the templates that held `profit_share.registry.manage` (owner, finance), which
-- is what used to guard version create/update/submit. Never cashier, never
-- shareholder, never a custom role. Idempotent.
UPDATE "roles"
SET "permissions" = "permissions" || '["profit_share.share_allocation.change"]'::jsonb,
    "updated_at" = now()
WHERE "is_template"
  AND "template_key" IN ('owner', 'finance')
  AND NOT ("permissions" @> '["profit_share.share_allocation.change"]'::jsonb);
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
