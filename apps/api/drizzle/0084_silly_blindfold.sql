CREATE TABLE "payroll_pph21_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"parameters" jsonb NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_pph21_policies_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "payroll_pph21_policies_tenant_effective_from_key" UNIQUE("tenant_id","effective_from"),
	CONSTRAINT "payroll_pph21_policies_version_check" CHECK ("payroll_pph21_policies"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payroll_pph21_policies" ADD CONSTRAINT "payroll_pph21_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;