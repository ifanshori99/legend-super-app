-- legend-k048r: a depreciation journal cannot be reversed by hand. The asset
-- ledger (fixed_asset_depreciations / fixed_asset_depreciation_reversals) is the
-- only record of which month is depreciated; a manual reversal entry would take
-- the expense out of the books while the asset keeps its accumulated
-- depreciation, so the month could be posted again and counted twice. The
-- correcting journals of the fixed-asset service are plain `depreciation`
-- entries without reversal_of, so that path is untouched; payroll and the other
-- auto-journal consumers never reverse a depreciation journal.
-- Body of app.assert_journal_entry as in 0310 (the legal entity lock, which
-- 0312 makes effective against REPEATABLE READ writers, stays first) plus the
-- check below.
CREATE OR REPLACE FUNCTION app.assert_journal_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  period_key varchar(7);
  period_entity uuid;
  period_status varchar(10);
  target_type varchar(30);
  target_entity uuid;
BEGIN
  -- Same lock order as accounting-period.service (legal entity row first):
  -- a raw INSERT waits for an in-flight close, and a close waits for it.
  PERFORM 1 FROM public.legal_entities
    WHERE tenant_id = NEW.tenant_id AND id = NEW.legal_entity_id FOR SHARE;
  SELECT period, legal_entity_id, status INTO period_key, period_entity, period_status
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
  IF period_status = 'closed' THEN
    RAISE EXCEPTION 'fiscal period % is closed (PERIOD_CLOSED)', period_key
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods
    WHERE tenant_id = NEW.tenant_id
      AND legal_entity_id = NEW.legal_entity_id
      AND period > period_key
      AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'a later fiscal period of this legal entity is closed (PERIOD_CLOSED)'
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
    -- Depreciation journals (and their corrections) are only ever taken back
    -- through app.record_depreciation_reversal: a manual reversal would cancel
    -- the expense while the asset still counts it as depreciated, and the month
    -- could then be depreciated twice (legend-k048r).
    IF EXISTS (
      SELECT 1 FROM public.fixed_asset_depreciations
      WHERE tenant_id = NEW.tenant_id AND journal_entry_id = NEW.reversal_of
    ) OR EXISTS (
      SELECT 1 FROM public.fixed_asset_depreciation_reversals
      WHERE tenant_id = NEW.tenant_id AND journal_entry_id = NEW.reversal_of
    ) THEN
      RAISE EXCEPTION 'journal % belongs to the fixed asset depreciation ledger (DEPRECIATION_JOURNAL_LOCKED)', NEW.reversal_of
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
