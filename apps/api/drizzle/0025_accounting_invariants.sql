-- Accounting core invariants (PRD v1.7 §3.19, §6 F; ACC-01/ACC-02; bead
-- legend-kwxj). Runs after the generated tables migration 0024.
--
-- ACC-01 "Setiap jurnal selalu seimbang; jurnal final tidak dapat dihapus dan
-- koreksi dilakukan melalui jurnal pembalik" is enforced here, not only in the
-- service:
--   * journal_entries / journal_lines reject UPDATE and DELETE;
--   * an entry is final as soon as its posting transaction commits: its lines
--     may only be written by the transaction that created the entry, so a
--     balanced pair cannot be appended afterwards (app.journal_entry_seals);
--   * every entry must have >= 2 lines with equal debit and credit totals, and
--     a non-zero total (deferred constraint triggers fire at COMMIT);
--   * a line's account must belong to the entry's legal entity, be active and
--     be a leaf;
--   * an entry is reversed at most once, only by an entry in the same legal
--     entity, and a reversal cannot be reversed.
-- ACC-02: an entry's fiscal period must be the period of its entry date.
--
-- (T) tables get the standard RESTRICTIVE tenant policy and DML grants to the
-- non-bypass application role. Every statement is idempotent so a re-run on an
-- existing database cannot diverge.

-- ---------------------------------------------------------------- tenant (T)
SELECT app.enforce_tenant_rls('public.chart_of_accounts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.account_mappings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fiscal_periods'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.journal_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.journal_lines'::regclass);
--> statement-breakpoint

-- ------------------------------------------------------- append-only tables
-- Posted journals are final; the only correction is a reversal entry (ACC-01).
CREATE OR REPLACE FUNCTION app.reject_journal_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'journal rows are append-only (ACC-01); post a reversal entry instead'
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_append_only ON public.journal_entries;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_journal_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_append_only ON public.journal_lines;
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.reject_journal_mutation();
--> statement-breakpoint

-- -------------------------------------------------- finalize posted entries
-- Pre-review finding (bead legend-kwxj): the balance trigger alone let a later
-- transaction append a balanced debit/credit pair to an already posted entry.
-- Each entry records the transaction that posted it; a line may only be
-- inserted while that transaction is still current. The posting transaction
-- writes the entry and all of its lines, and from COMMIT on the entry is final
-- (ACC-01). A concurrent transaction is refused too: an uncommitted seal is
-- invisible to it, so it never sees a seal it may write under.
CREATE TABLE IF NOT EXISTS app.journal_entry_seals (
  entry_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  sealed_xid xid8 NOT NULL,
  sealed_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Internal table, but it carries tenant_id: give it the same forged-proof
-- tenant policy as the business tables (TEN-01), so no schema is exempt.
SELECT app.enforce_tenant_rls('app.journal_entry_seals'::regclass);
--> statement-breakpoint
REVOKE ALL ON TABLE app.journal_entry_seals FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.seal_journal_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO app.journal_entry_seals (entry_id, tenant_id, sealed_xid)
  VALUES (NEW.id, NEW.tenant_id, pg_current_xact_id())
  ON CONFLICT (entry_id) DO NOTHING;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_seal ON public.journal_entries;
--> statement-breakpoint
CREATE TRIGGER journal_entries_seal
  AFTER INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.seal_journal_entry();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assert_journal_lines_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  posting_xid xid8;
BEGIN
  SELECT sealed_xid INTO posting_xid
    FROM app.journal_entry_seals
    WHERE entry_id = NEW.entry_id;
  IF posting_xid IS NULL THEN
    RAISE EXCEPTION 'journal entry % is not open for lines in this transaction (ACC-01)', NEW.entry_id
      USING ERRCODE = '42501';
  END IF;
  IF posting_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'journal entry % is posted and final; lines cannot be appended (ACC-01)', NEW.entry_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_open_check ON public.journal_lines;
--> statement-breakpoint
CREATE TRIGGER journal_lines_open_check
  BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_lines_open();
--> statement-breakpoint

-- ------------------------------------------------------------ entry balance
-- Deferred so the entry and its lines insert in either order inside one
-- transaction; a late second transaction touching the same entry is caught at
-- its own commit.
CREATE OR REPLACE FUNCTION app.assert_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_entry uuid;
  target_tenant uuid;
  line_count integer;
  total_debit numeric;
  total_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_entry := NEW.id;
  ELSE
    target_entry := NEW.entry_id;
  END IF;
  target_tenant := NEW.tenant_id;
  SELECT count(*), COALESCE(sum(debit_idr), 0), COALESCE(sum(credit_idr), 0)
    INTO line_count, total_debit, total_credit
    FROM public.journal_lines
    WHERE entry_id = target_entry AND tenant_id = target_tenant;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal entry % needs at least two lines (ACC-01)', target_entry
      USING ERRCODE = '23514';
  END IF;
  IF total_debit <> total_credit OR total_debit = 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debit % <> credit % (ACC-01)',
      target_entry, total_debit, total_credit
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_balanced ON public.journal_entries;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_entry_balanced();
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_balanced ON public.journal_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_entry_balanced();
--> statement-breakpoint

-- ---------------------------------------------------------- line account rule
-- Contract/coa.ts assertAccountPostable, at the database edge. A reversal only
-- mirrors an entry that already posted, so it may reuse an account the tenant
-- deactivated (or turned into a header) after the original posting; the entity
-- rule still applies to every line.
CREATE OR REPLACE FUNCTION app.assert_journal_line_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  entry_entity uuid;
  entry_source varchar(30);
  account_entity uuid;
  account_active boolean;
BEGIN
  SELECT legal_entity_id, source_type INTO entry_entity, entry_source
    FROM public.journal_entries
    WHERE id = NEW.entry_id AND tenant_id = NEW.tenant_id;
  IF entry_entity IS NULL THEN
    RAISE EXCEPTION 'journal line names an entry outside this tenant'
      USING ERRCODE = '23514';
  END IF;
  SELECT legal_entity_id, is_active INTO account_entity, account_active
    FROM public.chart_of_accounts
    WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id;
  IF account_entity IS NULL OR account_entity <> entry_entity THEN
    RAISE EXCEPTION 'account % does not belong to the entry legal entity (ACCOUNT_ENTITY_MISMATCH)', NEW.account_id
      USING ERRCODE = '23514';
  END IF;
  IF entry_source <> 'reversal' THEN
    IF NOT account_active THEN
      RAISE EXCEPTION 'account % is inactive (ACCOUNT_INACTIVE)', NEW.account_id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.chart_of_accounts
      WHERE parent_id = NEW.account_id AND tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'account % is a header account (ACCOUNT_NOT_POSTABLE)', NEW.account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_account_check ON public.journal_lines;
--> statement-breakpoint
CREATE TRIGGER journal_lines_account_check
  BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_line_account();
--> statement-breakpoint

-- --------------------------------------------------------- entry period check
-- ACC-02: the entry date must fall inside the fiscal period it names, and the
-- period belongs to the entry's legal entity. A reversal only ever reverses an
-- entry of the same legal entity and never a reversal (ACC-01).
CREATE OR REPLACE FUNCTION app.assert_journal_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  period_key varchar(7);
  period_entity uuid;
  target_type varchar(30);
  target_entity uuid;
BEGIN
  SELECT period, legal_entity_id INTO period_key, period_entity
    FROM public.fiscal_periods
    WHERE id = NEW.fiscal_period_id AND tenant_id = NEW.tenant_id;
  IF period_key IS NULL OR period_entity <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'fiscal period % does not belong to the entry legal entity (PERIOD_MISMATCH)', NEW.fiscal_period_id
      USING ERRCODE = '23514';
  END IF;
  IF period_key <> to_char(NEW.entry_date, 'YYYY-MM') THEN
    RAISE EXCEPTION 'entry date % is outside fiscal period % (PERIOD_MISMATCH)', NEW.entry_date, period_key
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reversal_of IS NOT NULL THEN
    SELECT source_type, legal_entity_id INTO target_type, target_entity
      FROM public.journal_entries
      WHERE id = NEW.reversal_of AND tenant_id = NEW.tenant_id;
    IF target_type IS NULL THEN
      RAISE EXCEPTION 'reversal target % not found', NEW.reversal_of
        USING ERRCODE = '23514';
    END IF;
    IF target_type = 'reversal' THEN
      RAISE EXCEPTION 'a reversal entry cannot be reversed again (ACC-01)'
        USING ERRCODE = '23514';
    END IF;
    IF target_entity <> NEW.legal_entity_id THEN
      RAISE EXCEPTION 'reversal must stay inside one legal entity'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_period_check ON public.journal_entries;
--> statement-breakpoint
CREATE TRIGGER journal_entries_period_check
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_entry();
--> statement-breakpoint

-- ----------------------------------------------------------- chart structure
-- Contract/coa.ts: a parent is in the same entity, has the same type, and the
-- tree has no cycles. The composite foreign key already stops a cross-entity
-- parent; this trigger adds the type and cycle rules.
CREATE OR REPLACE FUNCTION app.assert_account_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parent_type varchar(20);
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT type INTO parent_type
    FROM public.chart_of_accounts
    WHERE id = NEW.parent_id
      AND tenant_id = NEW.tenant_id
      AND legal_entity_id = NEW.legal_entity_id;
  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'parent % is not in this legal entity chart', NEW.parent_id
      USING ERRCODE = '23514';
  END IF;
  IF parent_type <> NEW.type THEN
    RAISE EXCEPTION 'account % needs a parent of type %, got %', NEW.code, NEW.type, parent_type
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE tree AS (
      SELECT id, parent_id
        FROM public.chart_of_accounts
        WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id
      UNION ALL
      SELECT child.id, child.parent_id
        FROM public.chart_of_accounts child
        JOIN tree ON child.id = tree.parent_id
        WHERE child.tenant_id = NEW.tenant_id
    )
    SELECT 1 FROM tree WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'account % would create a parent cycle', NEW.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chart_of_accounts_parent_trigger ON public.chart_of_accounts;
--> statement-breakpoint
CREATE TRIGGER chart_of_accounts_parent_trigger
  BEFORE INSERT OR UPDATE OF parent_id, type ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION app.assert_account_parent();
