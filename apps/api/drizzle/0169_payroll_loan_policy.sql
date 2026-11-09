CREATE TABLE "payroll_loan_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"max_principal_idr" bigint,
	"max_principal_of_base_salary_bp" integer,
	"max_total_open_idr" bigint NOT NULL,
	"max_installments" integer NOT NULL,
	"max_deduction_of_net_pay_bp" integer NOT NULL,
	"single_open_loan" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_loan_policies_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "payroll_loan_policies_ceiling_check" CHECK ("payroll_loan_policies"."max_principal_idr" IS NOT NULL OR "payroll_loan_policies"."max_principal_of_base_salary_bp" IS NOT NULL),
	CONSTRAINT "payroll_loan_policies_values_check" CHECK (("payroll_loan_policies"."max_principal_idr" IS NULL OR "payroll_loan_policies"."max_principal_idr" > 0)
        AND ("payroll_loan_policies"."max_principal_of_base_salary_bp" IS NULL OR "payroll_loan_policies"."max_principal_of_base_salary_bp" BETWEEN 1 AND 120000)
        AND "payroll_loan_policies"."max_total_open_idr" > 0
        AND ("payroll_loan_policies"."max_principal_idr" IS NULL OR "payroll_loan_policies"."max_total_open_idr" >= "payroll_loan_policies"."max_principal_idr")
        AND "payroll_loan_policies"."max_installments" BETWEEN 1 AND 36
        AND "payroll_loan_policies"."max_deduction_of_net_pay_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "payroll_loan_policies" ADD CONSTRAINT "payroll_loan_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reimbursements_receipt_upload_ref_key" ON "reimbursements" USING btree ("tenant_id",lower("receipt_upload_ref")) WHERE "reimbursements"."receipt_upload_ref" IS NOT NULL;
--> statement-breakpoint
-- Kasbon policy (bead legend-fij0l): tenant-owned, forced restrictive tenant RLS
-- (TEN-01/02). One row per tenant; the service fails closed without it.
SELECT app.enforce_tenant_rls('public.payroll_loan_policies'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_loan_policies FROM legend_app;
