-- legend-7ui6v: maker-checker for payroll runs at the database level (PRD
-- "Matriks Approval"). Besides hr approver <> final approver (0167), neither
-- approver may be the person who created the run, so a direct write from any
-- role or code path is refused with 23514. created_by is NOT NULL; the approver
-- columns stay NULL-guarded so a run with no approver yet is still accepted.
-- CTO decision for the upgrade path (549): do not validate historical rows.
-- This historical migration is amended intentionally: a later migration cannot
-- repair an upgrade that already aborts here on legacy creator = approver rows.
-- NOT VALID preserves them unchanged while enforcing every new INSERT/UPDATE.
ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_distinct_approvers_check";--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_distinct_approvers_check" CHECK (("payroll_runs"."approved_by_finance" IS NULL OR "payroll_runs"."approved_by_hr" IS NULL OR "payroll_runs"."approved_by_finance" <> "payroll_runs"."approved_by_hr") AND ("payroll_runs"."approved_by_finance" IS NULL OR "payroll_runs"."approved_by_finance" <> "payroll_runs"."created_by") AND ("payroll_runs"."approved_by_hr" IS NULL OR "payroll_runs"."approved_by_hr" <> "payroll_runs"."created_by")) NOT VALID;
