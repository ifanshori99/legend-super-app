-- Second-opinion findings 2 and 3 on 0313/0314: a correcting journal is a claim.
--
-- Finding 2: app.record_depreciation_reversal locked only the depreciation row.
-- Two transactions that took back different rows with the same correcting
-- journal each saw only their own reversal row, both passed the deferred total
-- check on their own snapshot, and the journal took back its amount twice.
-- Finding 3: a correcting journal that already had a manual reversal journal
-- (reversal_of -> correction) was still accepted, and a linked correction could
-- still be reversed by a race.
--
-- fixed_asset_correction_claims has one row per correcting journal: claimed_idr
-- is what the linked rows took back through it, reversed says a manual reversal
-- journal exists. Both writers (the link function and the reversal trigger) go
-- through app.claim_correction_journal, an INSERT .. ON CONFLICT DO UPDATE of
-- that one row. In REPEATABLE READ a concurrent writer of the same row gets
-- 40001 instead of a stale snapshot, so one side always loses, and the winner
-- sees the other side's mark in the same row: claimed > 0 and reversed never
-- coexist, and claimed never exceeds what the journal debits.
CREATE TABLE "fixed_asset_correction_claims" (
	"tenant_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"claimed_idr" bigint DEFAULT 0 NOT NULL,
	"reversed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_correction_claims_tenant_id_journal_entry_id_pk" PRIMARY KEY("tenant_id","journal_entry_id"),
	CONSTRAINT "fixed_asset_correction_claims_claimed_check" CHECK ("fixed_asset_correction_claims"."claimed_idr" >= 0),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1).
	CONSTRAINT "fixed_asset_correction_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "fixed_asset_correction_claims_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- Backfill before RLS is enforced (the migrator has no tenant context): what
-- the existing reversal rows took back per journal, and the journals that
-- already have a reversal journal.
INSERT INTO public.fixed_asset_correction_claims (tenant_id, journal_entry_id, claimed_idr, reversed)
SELECT r.tenant_id, r.journal_entry_id, COALESCE(sum(d.amount_idr), 0),
       EXISTS (
         SELECT 1 FROM public.journal_entries x
         WHERE x.tenant_id = r.tenant_id AND x.reversal_of = r.journal_entry_id
       )
  FROM public.fixed_asset_depreciation_reversals r
  JOIN public.fixed_asset_depreciations d ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
  GROUP BY r.tenant_id, r.journal_entry_id;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_correction_claims'::regclass);
--> statement-breakpoint
-- Only the SECURITY DEFINER functions below write here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_correction_claims FROM legend_app;
--> statement-breakpoint
-- Internal: not granted to legend_app (called by definer functions only). p_amount adds to the claim (0 for a mark
-- only); p_reversed marks a manual reversal journal. Raises when the journal is
-- both claimed and reversed. Returns the claim after the update.
CREATE FUNCTION app.claim_correction_journal(
  p_tenant uuid,
  p_journal_entry_id uuid,
  p_amount bigint,
  p_reversed boolean
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  claim_total bigint;
  is_reversed boolean;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'claim amount must not be negative (DEPRECIATION_CORRECTION_CLAIM)'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.fixed_asset_correction_claims AS c
    (tenant_id, journal_entry_id, claimed_idr, reversed)
  VALUES (p_tenant, p_journal_entry_id, p_amount, p_reversed)
  ON CONFLICT (tenant_id, journal_entry_id) DO UPDATE
    SET claimed_idr = c.claimed_idr + EXCLUDED.claimed_idr,
        reversed = c.reversed OR EXCLUDED.reversed
  RETURNING c.claimed_idr, c.reversed INTO claim_total, is_reversed;
  IF is_reversed AND claim_total > 0 THEN
    RAISE EXCEPTION 'journal % is both taken into the depreciation ledger and reversed (DEPRECIATION_CORRECTION_REVERSED)', p_journal_entry_id
      USING ERRCODE = '23514';
  END IF;
  RETURN claim_total;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_correction_journal(uuid, uuid, bigint, boolean) FROM PUBLIC;
--> statement-breakpoint
-- Marks the correcting journal as reversed when a depreciation journal is
-- reversed by hand. A trigger, so no role has to be granted EXECUTE: legend_app
-- cannot call it with a tenant or journal of its choice. SECURITY DEFINER runs
-- as the migrator, which is BYPASSRLS in production (provision-roles.sh), so the
-- tenant policy does NOT apply inside it. The tenant comes from NEW, the row
-- legend_app just inserted and that its own WITH CHECK policy already tied to
-- the session tenant; the target journal is looked up in that same tenant.
CREATE FUNCTION app.mark_correction_journal_reversed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.reversal_of IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.reversal_of
      AND t.source_type = 'depreciation'
  ) THEN
    PERFORM app.claim_correction_journal(NEW.tenant_id, NEW.reversal_of, 0, true);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mark_correction_journal_reversed() FROM PUBLIC;
--> statement-breakpoint
-- AFTER INSERT: the reversal row exists when the claim row is written. The row
-- write is what excludes a concurrent link (the link function fails on it, or
-- this insert fails with 40001); a link that committed first makes it fail.
CREATE TRIGGER journal_entries_mark_correction_reversed
AFTER INSERT ON public.journal_entries
FOR EACH ROW WHEN (NEW.reversal_of IS NOT NULL)
EXECUTE FUNCTION app.mark_correction_journal_reversed();
--> statement-breakpoint
-- app.record_depreciation_reversal as in 0313 plus the claim: the correcting
-- journal is refused when it has a reversal journal, and its claim may not
-- exceed what the journal debits. The claim write is the serialization point
-- between two rows taken back through one journal.
CREATE OR REPLACE FUNCTION app.record_depreciation_reversal(
  p_tenant uuid,
  p_depreciation_id uuid,
  p_journal_entry_id uuid,
  p_reason text,
  p_actor text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  dep record;
  orig_period uuid;
  corr record;
  reversal_id uuid;
  claim_total bigint;
  corr_total numeric;
BEGIN
  -- The argument must name the session tenant. Do not rely on RLS here: the
  -- migrator that owns this function is BYPASSRLS in production.
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'depreciation reversal tenant does not match the session tenant'
      USING ERRCODE = '42501';
  END IF;

  -- The row lock serializes two reversals of one depreciation row.
  SELECT d.id, d.fixed_asset_id, d.journal_entry_id, d.reversed_at, d.amount_idr, a.legal_entity_id
    INTO dep
    FROM public.fixed_asset_depreciations d
    JOIN public.fixed_assets a ON a.tenant_id = d.tenant_id AND a.id = d.fixed_asset_id
    WHERE d.tenant_id = p_tenant AND d.id = p_depreciation_id
    FOR UPDATE OF d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'depreciation % not found (DEPRECIATION_REVERSAL_INVALID)', p_depreciation_id
      USING ERRCODE = '23514';
  END IF;
  IF dep.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'depreciation % is already taken back (DEPRECIATION_ALREADY_REVERSED)', p_depreciation_id
      USING ERRCODE = '23505';
  END IF;

  SELECT fiscal_period_id INTO orig_period
    FROM public.journal_entries
    WHERE tenant_id = p_tenant AND id = dep.journal_entry_id;
  SELECT j.id, j.legal_entity_id, j.fiscal_period_id, j.source_type, j.source_id, j.reversal_of
    INTO corr
    FROM public.journal_entries j
    WHERE j.tenant_id = p_tenant AND j.id = p_journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correcting journal % not found (DEPRECIATION_REVERSAL_INVALID)', p_journal_entry_id
      USING ERRCODE = '23514';
  END IF;
  -- Same asset, same entity, and the month of the journal being corrected:
  -- the correction is never booked into another month than the expense.
  IF corr.source_type <> 'depreciation'
    OR lower(corr.source_id) IS DISTINCT FROM dep.fixed_asset_id::text
    OR corr.reversal_of IS NOT NULL
    OR corr.legal_entity_id <> dep.legal_entity_id
    OR corr.fiscal_period_id <> orig_period
    OR corr.id = dep.journal_entry_id
    OR EXISTS (
      SELECT 1 FROM public.fixed_asset_depreciations x
      WHERE x.tenant_id = p_tenant AND x.journal_entry_id = corr.id
    ) THEN
    RAISE EXCEPTION 'journal % does not correct depreciation % (DEPRECIATION_REVERSAL_INVALID)', p_journal_entry_id, p_depreciation_id
      USING ERRCODE = '23514';
  END IF;
  -- A correction that was reversed by hand is void (finding 3). Committed
  -- reversals are seen here; a concurrent one is caught by the claim below.
  IF EXISTS (
    SELECT 1 FROM public.journal_entries r
    WHERE r.tenant_id = p_tenant AND r.reversal_of = corr.id
  ) THEN
    RAISE EXCEPTION 'journal % has been reversed and cannot correct depreciation % (DEPRECIATION_CORRECTION_REVERSED)', p_journal_entry_id, p_depreciation_id
      USING ERRCODE = '23514';
  END IF;
  -- Debit and credit swapped per account: every line of the correction hits an
  -- account of the depreciation journal on the opposite side.
  IF NOT EXISTS (
    SELECT 1 FROM public.journal_lines
    WHERE tenant_id = p_tenant AND entry_id = corr.id
  ) OR EXISTS (
    SELECT 1 FROM public.journal_lines cl
    WHERE cl.tenant_id = p_tenant AND cl.entry_id = corr.id
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_lines ol
        WHERE ol.tenant_id = p_tenant AND ol.entry_id = dep.journal_entry_id
          AND ol.account_id = cl.account_id
          AND ((cl.debit_idr > 0 AND ol.credit_idr > 0)
            OR (cl.credit_idr > 0 AND ol.debit_idr > 0))
      )
  ) THEN
    RAISE EXCEPTION 'journal % does not mirror the depreciation journal (DEPRECIATION_REVERSAL_INVALID)', p_journal_entry_id
      USING ERRCODE = '23514';
  END IF;

  -- Claim this row's amount on the correcting journal (finding 2). A concurrent
  -- claim of the same journal makes this statement wait and then fail with
  -- 40001 in REPEATABLE READ; a sequential one is seen in the total below.
  claim_total := app.claim_correction_journal(p_tenant, corr.id, dep.amount_idr, false);
  SELECT COALESCE(sum(l.debit_idr), 0) INTO corr_total
    FROM public.journal_lines l
    WHERE l.tenant_id = p_tenant AND l.entry_id = corr.id;
  IF claim_total > corr_total THEN
    RAISE EXCEPTION 'journal % corrects % but % would be taken back through it (DEPRECIATION_REVERSAL_AMOUNT)',
      p_journal_entry_id, corr_total, claim_total
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.fixed_asset_depreciation_reversals
    (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
  VALUES (p_tenant, p_depreciation_id, p_journal_entry_id, p_reason, p_actor)
  RETURNING id INTO reversal_id;
  UPDATE public.fixed_asset_depreciations
    SET reversed_at = now()
    WHERE tenant_id = p_tenant AND id = p_depreciation_id;
  RETURN reversal_id;
END $$;
