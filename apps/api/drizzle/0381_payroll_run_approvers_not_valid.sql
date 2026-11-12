-- Payroll 549: installations which already applied 0350 must use the same
-- NOT VALID constraint as the amended upgrade path. No payroll data is changed.
-- Existing violating rows are retained; every new INSERT or UPDATE must satisfy
-- maker-checker. Do not VALIDATE without a separate, reviewed historical plan.
ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_distinct_approvers_check";--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_distinct_approvers_check" CHECK (("payroll_runs"."approved_by_finance" IS NULL OR "payroll_runs"."approved_by_hr" IS NULL OR "payroll_runs"."approved_by_finance" <> "payroll_runs"."approved_by_hr") AND ("payroll_runs"."approved_by_finance" IS NULL OR "payroll_runs"."approved_by_finance" <> "payroll_runs"."created_by") AND ("payroll_runs"."approved_by_hr" IS NULL OR "payroll_runs"."approved_by_hr" <> "payroll_runs"."created_by")) NOT VALID;
