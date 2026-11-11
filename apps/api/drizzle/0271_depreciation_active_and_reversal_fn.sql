-- 497 findings 5 and 6: a depreciation row is "active" until it is taken back,
-- and only the database may take it back.
--
-- 1. fixed_asset_depreciations.reversed_at marks a row that has a reversal. A
--    partial unique index over (tenant, asset, period) WHERE reversed_at IS NULL
--    is the concurrency guard: two writers can never both leave an active row
--    for one asset and month, even when both passed the 0269 generation
--    trigger on the same snapshot (the trigger stays as the early, readable
--    refusal DEPRECIATION_ALREADY_POSTED; the index is the last word).
-- 2. fixed_asset_depreciation_reversals is no longer insertable by legend_app.
--    app.record_depreciation_reversal(...) is the only way in: it checks that
--    the correcting journal really cancels the depreciation row, writes the
--    reversal row and stamps reversed_at in one step. A deferred constraint
--    trigger then checks, at COMMIT, that the rows taken back through one
--    journal add up exactly to that journal, and that per account the journal
--    mirrors the original lines of those rows (a journal takes back several
--    rows of one asset, one function call per row).
ALTER TABLE "fixed_asset_depreciations" ADD COLUMN "reversed_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill the rows that already have a reversal. The migrator may be a plain
-- table owner: FORCE ROW LEVEL SECURITY would apply the tenant policy to it and,
-- with no app.tenant_id set, raise 42501 (same as 0139). Lift FORCE on the two
-- tables for this transaction only and restore it right after the update.
ALTER TABLE public.fixed_asset_depreciations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fixed_asset_depreciation_reversals NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.fixed_asset_depreciations d
  SET reversed_at = r.created_at
  FROM public.fixed_asset_depreciation_reversals r
  WHERE r.tenant_id = d.tenant_id AND r.depreciation_id = d.id;
--> statement-breakpoint
-- Runs while FORCE is still lifted (the read would hit the tenant policy
-- otherwise). Fail with a readable list instead of a bare unique violation when the data
-- already holds two active rows for one asset and month. Fix those rows by hand
-- (reverse one) and rerun; the migration changes nothing until then.
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(
           format('(tenant %s, asset %s, period %s: %s rows)', tenant_id, fixed_asset_id, period, n),
           ', ')
    INTO dup
    FROM (
      SELECT tenant_id, fixed_asset_id, period, count(*) AS n
        FROM public.fixed_asset_depreciations
        WHERE reversed_at IS NULL
        GROUP BY tenant_id, fixed_asset_id, period
        HAVING count(*) > 1
    ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate active fixed_asset_depreciations rows block fixed_asset_depreciations_active_key: %', dup
      USING ERRCODE = '23505';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.fixed_asset_depreciation_reversals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fixed_asset_depreciations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_depreciations_active_key" ON "fixed_asset_depreciations" USING btree ("tenant_id","fixed_asset_id","period") WHERE "fixed_asset_depreciations"."reversed_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION app.record_depreciation_reversal(
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
BEGIN
  -- SECURITY DEFINER still runs under the caller's session: the tenant policy
  -- of the tables below applies, and the argument must name that same tenant.
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'depreciation reversal tenant does not match the session tenant'
      USING ERRCODE = '42501';
  END IF;

  -- The row lock serializes two reversals of one depreciation row.
  SELECT d.id, d.fixed_asset_id, d.journal_entry_id, d.reversed_at, a.legal_entity_id
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

  INSERT INTO public.fixed_asset_depreciation_reversals
    (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
  VALUES (p_tenant, p_depreciation_id, p_journal_entry_id, p_reason, p_actor)
  RETURNING id INTO reversal_id;
  UPDATE public.fixed_asset_depreciations
    SET reversed_at = now()
    WHERE tenant_id = p_tenant AND id = p_depreciation_id;
  RETURN reversal_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.record_depreciation_reversal(uuid, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.record_depreciation_reversal(uuid, uuid, uuid, text, text) TO legend_app;
--> statement-breakpoint
REVOKE INSERT ON TABLE public.fixed_asset_depreciation_reversals FROM legend_app;
--> statement-breakpoint
-- Exact amount, checked once the whole transaction has written its rows: the
-- depreciation taken back through one correcting journal equals what that
-- journal debits (it is balanced, so debit = credit), and per account the
-- correction is the mirror of the original lines of the rows taken back. One
-- original journal may cover several rows: it counts for the share of its rows
-- that this correction takes back (original line x taken amount / journal
-- amount; 1 IDR of tolerance for that division). Deferred because one journal
-- takes back several rows, one function call each.
CREATE FUNCTION app.assert_depreciation_reversal_total() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  reversed numeric;
  corrected numeric;
  drift_account uuid;
BEGIN
  SELECT COALESCE(sum(d.amount_idr), 0) INTO reversed
    FROM public.fixed_asset_depreciation_reversals r
    JOIN public.fixed_asset_depreciations d
      ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
    WHERE r.tenant_id = NEW.tenant_id AND r.journal_entry_id = NEW.journal_entry_id;
  SELECT COALESCE(sum(l.debit_idr), 0) INTO corrected
    FROM public.journal_lines l
    WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.journal_entry_id;
  IF reversed <> corrected THEN
    RAISE EXCEPTION 'journal % corrects % but the depreciation taken back through it is % (DEPRECIATION_REVERSAL_AMOUNT)',
      NEW.journal_entry_id, corrected, reversed
      USING ERRCODE = '23514';
  END IF;

  WITH taken AS (
    SELECT r.depreciation_id
      FROM public.fixed_asset_depreciation_reversals r
      WHERE r.tenant_id = NEW.tenant_id AND r.journal_entry_id = NEW.journal_entry_id
  ),
  orig AS (
    SELECT d.journal_entry_id AS entry_id,
           sum(d.amount_idr) AS total,
           sum(d.amount_idr) FILTER (WHERE d.id IN (SELECT depreciation_id FROM taken)) AS taken_amount
      FROM public.fixed_asset_depreciations d
      WHERE d.tenant_id = NEW.tenant_id
        AND d.journal_entry_id IN (
          SELECT x.journal_entry_id FROM public.fixed_asset_depreciations x
          WHERE x.tenant_id = NEW.tenant_id AND x.id IN (SELECT depreciation_id FROM taken)
        )
      GROUP BY d.journal_entry_id
  ),
  want AS (
    SELECT l.account_id, sum((l.credit_idr - l.debit_idr) * o.taken_amount / NULLIF(o.total, 0)) AS net
      FROM orig o
      JOIN public.journal_lines l ON l.tenant_id = NEW.tenant_id AND l.entry_id = o.entry_id
      GROUP BY l.account_id
  ),
  got AS (
    SELECT l.account_id, sum(l.debit_idr - l.credit_idr) AS net
      FROM public.journal_lines l
      WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.journal_entry_id
      GROUP BY l.account_id
  )
  SELECT COALESCE(w.account_id, g.account_id) INTO drift_account
    FROM want w
    FULL JOIN got g ON g.account_id = w.account_id
    WHERE abs(COALESCE(w.net, 0) - COALESCE(g.net, 0)) >= 1
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % does not mirror the original depreciation lines on account % (DEPRECIATION_REVERSAL_AMOUNT)',
      NEW.journal_entry_id, drift_account
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fixed_asset_depreciation_reversals_total
AFTER INSERT ON public.fixed_asset_depreciation_reversals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_depreciation_reversal_total();
