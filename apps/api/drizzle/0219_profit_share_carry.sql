-- Profit share carry-over of claw-back shortfalls (legend-lzvh0, founder rule
-- Q83; brief docs/briefs/lzvh0-carry.md section B). Appended to
-- drizzle/0217_profit_share.sql and 0218_profit_share_unabsorbed.sql.
--
-- A negative correction never pushes a shareholder below zero: the rest it
-- could not claw back (`distribution_runs.unabsorbed_idr`) is kept per
-- shareholder in `distribution_run_shortfalls` and cut from that SAME
-- shareholder's next regular split, recorded in `distribution_carry_deductions`.
-- A run's total then reads `distributable = total_gross + carry_deducted`.
-- The carry applies to a regular run and to a positive (top-up) adjustment. A
-- shareholder whose whole share the carry absorbs keeps a line with gross 0 and
-- `carry_deducted` = the share (the line is paid on approval, see below).
--
-- The new tables carry their foreign keys inline, so no FORCE toggling is needed.

CREATE TABLE "distribution_run_shortfalls" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"distribution_run_id" uuid NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"shareholder_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_run_shortfalls_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "distribution_run_shortfalls_run_shareholder_key" UNIQUE("tenant_id","distribution_run_id","shareholder_id"),
	CONSTRAINT "distribution_run_shortfalls_id_shareholder_key" UNIQUE("tenant_id","id","shareholder_id"),
	CONSTRAINT "distribution_run_shortfalls_amount_check" CHECK ("distribution_run_shortfalls"."amount_idr" > 0),
	CONSTRAINT "distribution_run_shortfalls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_run_shortfalls_run_fk" FOREIGN KEY ("tenant_id","distribution_run_id") REFERENCES "public"."distribution_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_run_shortfalls_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_run_shortfalls_shareholder_fk" FOREIGN KEY ("tenant_id","shareholder_id") REFERENCES "public"."shareholders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE "distribution_carry_deductions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"distribution_run_id" uuid NOT NULL,
	"shortfall_id" uuid NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"shareholder_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_carry_deductions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "distribution_carry_deductions_run_shortfall_key" UNIQUE("tenant_id","distribution_run_id","shortfall_id"),
	CONSTRAINT "distribution_carry_deductions_amount_check" CHECK ("distribution_carry_deductions"."amount_idr" > 0),
	CONSTRAINT "distribution_carry_deductions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_carry_deductions_run_fk" FOREIGN KEY ("tenant_id","distribution_run_id") REFERENCES "public"."distribution_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_carry_deductions_shortfall_fk" FOREIGN KEY ("tenant_id","shortfall_id","shareholder_id") REFERENCES "public"."distribution_run_shortfalls"("tenant_id","id","shareholder_id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_carry_deductions_entity_fk" FOREIGN KEY ("tenant_id","profit_entity_id") REFERENCES "public"."profit_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "distribution_carry_deductions_shareholder_fk" FOREIGN KEY ("tenant_id","shareholder_id") REFERENCES "public"."shareholders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
ALTER TABLE "distribution_runs" DROP CONSTRAINT "distribution_runs_totals_check";--> statement-breakpoint
ALTER TABLE "distribution_runs" DROP CONSTRAINT "distribution_runs_journal_check";--> statement-breakpoint
ALTER TABLE "distribution_lines" DROP CONSTRAINT "distribution_lines_amounts_check";--> statement-breakpoint
ALTER TABLE "distribution_lines" ADD COLUMN "carry_deducted_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD COLUMN "carry_deducted_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "distribution_carry_deductions_shortfall_idx" ON "distribution_carry_deductions" USING btree ("tenant_id","shortfall_id");--> statement-breakpoint
CREATE INDEX "distribution_run_shortfalls_fifo_idx" ON "distribution_run_shortfalls" USING btree ("tenant_id","shareholder_id","created_at","id");--> statement-breakpoint
ALTER TABLE "distribution_lines" ADD CONSTRAINT "distribution_lines_amounts_check" CHECK (("distribution_lines"."gross_idr" <> 0 OR "distribution_lines"."carry_deducted_idr" > 0) AND "distribution_lines"."gross_idr" - "distribution_lines"."tax_withheld_idr" = "distribution_lines"."net_idr" AND sign("distribution_lines"."tax_withheld_idr") * sign("distribution_lines"."gross_idr") >= 0 AND abs("distribution_lines"."tax_withheld_idr") <= abs("distribution_lines"."gross_idr"));--> statement-breakpoint
ALTER TABLE "distribution_lines" ADD CONSTRAINT "distribution_lines_carry_check" CHECK ("distribution_lines"."carry_deducted_idr" >= 0 AND ("distribution_lines"."carry_deducted_idr" = 0 OR "distribution_lines"."gross_idr" >= 0));--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD CONSTRAINT "distribution_runs_carry_check" CHECK ("distribution_runs"."carry_deducted_idr" >= 0 AND ("distribution_runs"."carry_deducted_idr" = 0 OR "distribution_runs"."type" = 'regular' OR ("distribution_runs"."type" = 'adjustment' AND "distribution_runs"."distributable_idr" > 0)));--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD CONSTRAINT "distribution_runs_journal_check" CHECK (("distribution_runs"."status" <> 'paid' AND "distribution_runs"."journal_entry_id" IS NULL AND "distribution_runs"."reversal_journal_entry_id" IS NULL) OR ("distribution_runs"."status" = 'paid' AND "distribution_runs"."total_gross_idr" > 0 AND "distribution_runs"."journal_entry_id" IS NOT NULL AND "distribution_runs"."reversal_journal_entry_id" IS NULL) OR ("distribution_runs"."status" = 'paid' AND "distribution_runs"."total_gross_idr" < 0 AND "distribution_runs"."reversal_journal_entry_id" IS NOT NULL AND "distribution_runs"."journal_entry_id" IS NULL) OR ("distribution_runs"."status" = 'paid' AND "distribution_runs"."total_gross_idr" = 0 AND "distribution_runs"."journal_entry_id" IS NULL AND "distribution_runs"."reversal_journal_entry_id" IS NULL));--> statement-breakpoint
ALTER TABLE "distribution_runs" ADD CONSTRAINT "distribution_runs_totals_check" CHECK ("distribution_runs"."distributable_idr" = "distribution_runs"."total_gross_idr" + "distribution_runs"."carry_deducted_idr" AND "distribution_runs"."total_gross_idr" - "distribution_runs"."total_tax_withheld_idr" = "distribution_runs"."total_net_idr");
--> statement-breakpoint
-- Tenant RLS like every profit-share table (TEN-01/02). Both tables are
-- append-only for the app: a shortfall is never edited and a rejected run
-- releases its deduction by status, not by deleting rows.
SELECT app.enforce_tenant_rls('public.distribution_run_shortfalls'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.distribution_carry_deductions'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.distribution_run_shortfalls FROM legend_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.distribution_carry_deductions FROM legend_app;
--> statement-breakpoint
-- A regular run writes a line for every shareholder (a share the carry absorbs
-- completely is a gross 0 line), so it carries all 10000 bp, and its lines carry
-- exactly its `carry_deducted_idr`. A claw-back still leaves out a shareholder
-- with nothing left to give back (1..10000 bp, no carry).
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
  SELECT r.type, r.carry_deducted_idr, r.total_gross_idr, r.total_tax_withheld_idr, r.total_net_idr INTO run_row
  FROM public.distribution_runs r
  WHERE r.tenant_id = run_tenant AND r.id = run_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, coalesce(sum(l.gross_idr), 0) AS gross,
         coalesce(sum(l.tax_withheld_idr), 0) AS tax,
         coalesce(sum(l.net_idr), 0) AS net,
         coalesce(sum(l.share_bp), 0) AS bp,
         coalesce(sum(l.carry_deducted_idr), 0) AS carry
  INTO sums
  FROM public.distribution_lines l
  WHERE l.tenant_id = run_tenant AND l.distribution_run_id = run_id;
  IF sums.n = 0 OR sums.gross <> run_row.total_gross_idr
     OR sums.tax <> run_row.total_tax_withheld_idr
     OR sums.net <> run_row.total_net_idr
     OR sums.carry <> run_row.carry_deducted_idr
     OR (run_row.type = 'regular' AND sums.bp <> 10000)
     OR (run_row.type = 'adjustment' AND (sums.bp < 1 OR sums.bp > 10000)) THEN
    RAISE EXCEPTION 'SH-04: lines of distribution run % do not match its totals', run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Guards for the carry tables (architect review). The service writes the rows
-- in the same transaction as their run; these checks keep any other writer
-- honest too. Mismatches use ERRCODE 23514 and the prefix SH-CARRY.

-- A shortfall exists only for a DRAFT adjustment run: once the run leaves draft
-- it is frozen, so no row can be added to a correction that is already decided.
CREATE OR REPLACE FUNCTION app.distribution_shortfall_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_row record;
BEGIN
  SELECT r.type, r.status INTO run_row
  FROM public.distribution_runs r
  WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.distribution_run_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF run_row.type <> 'adjustment' OR run_row.status <> 'draft' THEN
    RAISE EXCEPTION 'SH-CARRY: a shortfall belongs to a draft adjustment run (run %)', NEW.distribution_run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "distribution_run_shortfalls_guard_trg"
  BEFORE INSERT ON "distribution_run_shortfalls"
  FOR EACH ROW EXECUTE FUNCTION app.distribution_shortfall_guard();
--> statement-breakpoint
-- A deduction exists only for a DRAFT regular run or a DRAFT positive (top-up)
-- adjustment, in the entity of a shortfall whose correction is approved or paid
-- (a draft or pending one owes nothing yet).
CREATE OR REPLACE FUNCTION app.distribution_carry_deduction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_row record;
  shortfall_row record;
BEGIN
  SELECT r.type, r.status, r.profit_entity_id, r.distributable_idr INTO run_row
  FROM public.distribution_runs r
  WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.distribution_run_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF run_row.status <> 'draft'
     OR NOT (run_row.type = 'regular'
             OR (run_row.type = 'adjustment' AND run_row.distributable_idr > 0)) THEN
    RAISE EXCEPTION 'SH-CARRY: a deduction belongs to a draft regular or positive adjustment run (run %)', NEW.distribution_run_id
      USING ERRCODE = '23514';
  END IF;
  SELECT s.profit_entity_id, a.status AS adjustment_status INTO shortfall_row
  FROM public.distribution_run_shortfalls s
  JOIN public.distribution_runs a
    ON a.tenant_id = s.tenant_id AND a.id = s.distribution_run_id
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shortfall_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF shortfall_row.profit_entity_id <> NEW.profit_entity_id
     OR run_row.profit_entity_id <> shortfall_row.profit_entity_id THEN
    RAISE EXCEPTION 'SH-CARRY: a deduction stays inside the entity of its shortfall (shortfall %)', NEW.shortfall_id
      USING ERRCODE = '23514';
  END IF;
  IF shortfall_row.adjustment_status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'SH-CARRY: shortfall % is not effective until its correction is approved', NEW.shortfall_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "distribution_carry_deductions_guard_trg"
  BEFORE INSERT ON "distribution_carry_deductions"
  FOR EACH ROW EXECUTE FUNCTION app.distribution_carry_deduction_guard();
--> statement-breakpoint
-- Deferred (checked at commit, so the run, its rows and its lines can be written
-- in any order inside one transaction): the shortfall rows of an adjustment add
-- up to its `unabsorbed_idr`.
CREATE OR REPLACE FUNCTION app.distribution_shortfall_sum_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_tenant uuid;
  run_id uuid;
  expected bigint;
  actual bigint;
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
  SELECT r.unabsorbed_idr INTO expected
  FROM public.distribution_runs r
  WHERE r.tenant_id = run_tenant AND r.id = run_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(s.amount_idr), 0) INTO actual
  FROM public.distribution_run_shortfalls s
  WHERE s.tenant_id = run_tenant AND s.distribution_run_id = run_id;
  IF actual <> expected THEN
    RAISE EXCEPTION 'SH-CARRY: shortfalls of run % add up to %, not its unabsorbed %', run_id, actual, expected
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_runs_shortfall_sum_trg"
  AFTER INSERT OR UPDATE OF unabsorbed_idr ON "distribution_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_shortfall_sum_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_run_shortfalls_sum_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "distribution_run_shortfalls"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_shortfall_sum_check();
--> statement-breakpoint
-- Deferred: the deductions of a run add up to its `carry_deducted_idr`,
-- and the live deductions (runs that are not cancelled) of one shortfall never
-- exceed it. A cancelled run gives its share back by status.
CREATE OR REPLACE FUNCTION app.distribution_carry_sum_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_tenant uuid;
  run_id uuid;
  shortfall uuid;
  expected bigint;
  actual bigint;
  shortfall_amount bigint;
  used bigint;
BEGIN
  IF TG_TABLE_NAME = 'distribution_runs' THEN
    run_tenant := NEW.tenant_id;
    run_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    run_tenant := OLD.tenant_id;
    run_id := OLD.distribution_run_id;
    shortfall := OLD.shortfall_id;
  ELSE
    run_tenant := NEW.tenant_id;
    run_id := NEW.distribution_run_id;
    shortfall := NEW.shortfall_id;
  END IF;
  SELECT r.carry_deducted_idr INTO expected
  FROM public.distribution_runs r
  WHERE r.tenant_id = run_tenant AND r.id = run_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(d.amount_idr), 0) INTO actual
  FROM public.distribution_carry_deductions d
  WHERE d.tenant_id = run_tenant AND d.distribution_run_id = run_id;
  IF actual <> expected THEN
    RAISE EXCEPTION 'SH-CARRY: deductions of run % add up to %, not its carry_deducted %', run_id, actual, expected
      USING ERRCODE = '23514';
  END IF;
  IF shortfall IS NOT NULL THEN
    SELECT s.amount_idr INTO shortfall_amount
    FROM public.distribution_run_shortfalls s
    WHERE s.tenant_id = run_tenant AND s.id = shortfall;
    SELECT coalesce(sum(d.amount_idr), 0) INTO used
    FROM public.distribution_carry_deductions d
    JOIN public.distribution_runs r
      ON r.tenant_id = d.tenant_id AND r.id = d.distribution_run_id
    WHERE d.tenant_id = run_tenant AND d.shortfall_id = shortfall
      AND r.status <> 'cancelled';
    IF used > shortfall_amount THEN
      RAISE EXCEPTION 'SH-CARRY: shortfall % is deducted %, more than its %', shortfall, used, shortfall_amount
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_runs_carry_sum_trg"
  AFTER INSERT OR UPDATE OF carry_deducted_idr ON "distribution_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_carry_sum_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "distribution_carry_deductions_sum_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "distribution_carry_deductions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.distribution_carry_sum_check();
