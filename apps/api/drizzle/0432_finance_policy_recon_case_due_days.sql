-- legend-fnxl.9: reconciliation case due-days become tenant finance policy.
-- NOT NULL DEFAULT 7 fills existing rows (no row = the shared default of 7);
-- CHECK 1..60 mirrors reconciliationPolicySchema.caseDueDays.
ALTER TABLE "finance_policies" ADD COLUMN "recon_case_due_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_policies" ADD CONSTRAINT "finance_policies_recon_case_due_days_check" CHECK ("finance_policies"."recon_case_due_days" BETWEEN 1 AND 60);
