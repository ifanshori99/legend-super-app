-- legend-bsw9: insertion sequence for the append-only stock ledger.
--
-- Why: recordStockMovementInTransaction applies each movement to
-- stock_balances in commit order (it holds the location advisory lock and the
-- balance row lock while it inserts), but rebuildStockBalances folded by
-- (occurred_at, id) and ledger ids are ULIDs minted from occurred_at. A caller
-- that posts a past occurred_at (EOD sale deduction, stock opname, import)
-- made the live moving average differ from a rebuild. `posting_seq` records
-- the insertion order, and the rebuild now folds by it, so the two agree.
-- Backdated postings stay allowed.
--
-- Existing rows: the true insertion order of rows written before this column
-- is not recorded anywhere. They are numbered by (occurred_at, id), which is
-- deterministic and is the order the old rebuild already used. RISK: for a
-- database that already holds a backdated posting, a rebuild after this
-- migration keeps matching the OLD rebuild for those rows (not the live
-- balance they once produced); new postings are exact from here on. The
-- stored stock_balances rows are not touched.
--
-- Mechanics: the table is append-only (trigger stock_ledger_append_only
-- rejects UPDATE/DELETE for every role) and FORCE ROW LEVEL SECURITY hides
-- every tenant from the migration role, so the one-off numbering lifts both
-- inside this migration's transaction and puts them back before it ends. A
-- failure rolls everything back, including the trigger and RLS state.
DO $backfill$
DECLARE
  next_seq bigint;
BEGIN
  ALTER TABLE "stock_ledger" ADD COLUMN "posting_seq" bigint;

  ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_append_only";
  ALTER TABLE "stock_ledger" NO FORCE ROW LEVEL SECURITY;

  UPDATE "stock_ledger" AS l
  SET "posting_seq" = n.seq
  FROM (
    SELECT "id", row_number() OVER (ORDER BY "occurred_at", "id") AS seq
    FROM "stock_ledger"
  ) AS n
  WHERE l."id" = n."id";

  -- Read the highest number while RLS is still off: with FORCE back on, a
  -- plain table owner sees no tenant and this read fails.
  SELECT coalesce(max("posting_seq"), 0) + 1 INTO next_seq FROM "stock_ledger";

  ALTER TABLE "stock_ledger" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_append_only";

  ALTER TABLE "stock_ledger" ALTER COLUMN "posting_seq" SET NOT NULL;
  ALTER TABLE "stock_ledger" ALTER COLUMN "posting_seq" ADD GENERATED ALWAYS AS IDENTITY (sequence name "stock_ledger_posting_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);
  EXECUTE format(
    'ALTER TABLE "stock_ledger" ALTER COLUMN "posting_seq" RESTART WITH %s',
    next_seq
  );
END
$backfill$;
--> statement-breakpoint
CREATE INDEX "stock_ledger_tenant_outlet_seq_idx" ON "stock_ledger" USING btree ("tenant_id","outlet_id","posting_seq");
