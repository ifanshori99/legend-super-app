CREATE TABLE "hris_leave_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"collective_leave_deducts_annual" boolean DEFAULT true NOT NULL,
	"annual_leave_type_id" uuid,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_accruals" DROP CONSTRAINT "leave_accruals_kind_check";--> statement-breakpoint
ALTER TABLE "leave_accruals" DROP CONSTRAINT "leave_accruals_period_check";--> statement-breakpoint
ALTER TABLE "leave_accruals" ALTER COLUMN "period" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "hris_leave_settings" ADD CONSTRAINT "hris_leave_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hris_leave_settings" ADD CONSTRAINT "hris_leave_settings_annual_leave_type_fk" FOREIGN KEY ("tenant_id","annual_leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_kind_check" CHECK ("leave_accruals"."kind" IN ('grant', 'carry_over', 'carry_over_expiry', 'collective_leave'));--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_period_check" CHECK ("leave_accruals"."period" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$');