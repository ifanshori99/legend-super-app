-- legend-lt0v4 / 497 findings 1 and 2: the close of a fiscal month must be seen
-- by every concurrent journal writer, and a period row may only change through
-- a real close or reopen.
--
-- 1. legal_entities.ledger_version: a counter that moves on every close and
--    reopen of one of the entity's periods. A close already holds the legal
--    entity row (FOR NO KEY UPDATE) and a journal INSERT takes it FOR SHARE
--    (app.assert_journal_entry, 0310). A bare row lock leaves no new row
--    version, so a REPEATABLE READ writer whose snapshot predates the close
--    would still lock the row and read the old, open period. Bumping the
--    counter writes a new version of the entity row: that writer's FOR SHARE
--    now fails with 40001 (could not serialize access due to concurrent
--    update) instead of posting into a closed month. A READ COMMITTED writer
--    waits for the close, then re-reads the period (assert_journal_entry reads
--    the period only after it holds the lock).
-- 2. A BEFORE UPDATE trigger on fiscal_periods: tenant, entity and period never
--    change; status moves only open <-> closed and only together with
--    version = old version + 1 (the contract of accounting-period-close
--    service); any other update leaves version alone. The counter also moves
--    when a period row is inserted already closed.
ALTER TABLE "legal_entities" ADD COLUMN "ledger_version" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION app.assert_fiscal_period_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.legal_entity_id <> OLD.legal_entity_id
    OR NEW.period <> OLD.period THEN
    RAISE EXCEPTION 'fiscal period tenant, legal entity and period are immutable (FISCAL_PERIOD_IMMUTABLE)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'fiscal period % changes status % -> % only with version % (FISCAL_PERIOD_TRANSITION)',
        OLD.period, OLD.status, NEW.status, OLD.version + 1
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'fiscal period % version changes only with a close or reopen (FISCAL_PERIOD_TRANSITION)', OLD.period
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_transition_guard
BEFORE UPDATE ON public.fiscal_periods
FOR EACH ROW EXECUTE FUNCTION app.assert_fiscal_period_update();
--> statement-breakpoint
-- SECURITY DEFINER so the counter moves for every caller that changes a status,
-- without giving legend_app a new way to write legal_entities. It runs only as
-- the AFTER trigger below and touches one column of one entity.
CREATE FUNCTION app.bump_ledger_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.legal_entities
    SET ledger_version = ledger_version + 1
    WHERE tenant_id = NEW.tenant_id AND id = NEW.legal_entity_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bump_ledger_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_ledger_version_bump
AFTER UPDATE ON public.fiscal_periods
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION app.bump_ledger_version();
--> statement-breakpoint
-- A period row born closed (a backfill, or a manual insert) is a close too: a
-- writer whose snapshot predates it must fail with 40001 the same way.
CREATE TRIGGER fiscal_periods_ledger_version_bump_insert
AFTER INSERT ON public.fiscal_periods
FOR EACH ROW WHEN (NEW.status = 'closed')
EXECUTE FUNCTION app.bump_ledger_version();
--> statement-breakpoint
-- A period row is never deleted or truncated by the app: a close or reopen is
-- an UPDATE, and a deleted closed period would reopen its month silently
-- (assert_journal_entry reads a missing period as open).
REVOKE DELETE, TRUNCATE ON public.fiscal_periods FROM legend_app;
