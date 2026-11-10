CREATE TABLE "payslip_pin_reset_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"pepper_version" smallint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslip_pin_reset_challenges_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payslip_pin_reset_challenges_attempts_check" CHECK ("payslip_pin_reset_challenges"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "payslip_pin_reset_challenges_pepper_version_check" CHECK ("payslip_pin_reset_challenges"."pepper_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payslip_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"pin_salt" varchar(24) NOT NULL,
	"pin_hash" varchar(64) NOT NULL,
	"kdf_n" integer NOT NULL,
	"kdf_r" integer NOT NULL,
	"kdf_p" integer NOT NULL,
	"pepper_version" smallint DEFAULT 1 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslip_pins_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payslip_pins_tenant_employee_key" UNIQUE("tenant_id","employee_id"),
	CONSTRAINT "payslip_pins_failed_attempts_check" CHECK ("payslip_pins"."failed_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "payslip_pins_pepper_version_check" CHECK ("payslip_pins"."pepper_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payslip_pin_reset_challenges" ADD CONSTRAINT "payslip_pin_reset_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_pin_reset_challenges" ADD CONSTRAINT "payslip_pin_reset_challenges_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_pins" ADD CONSTRAINT "payslip_pins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_pins" ADD CONSTRAINT "payslip_pins_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payslip_pin_reset_challenges_employee_idx" ON "payslip_pin_reset_challenges" USING btree ("tenant_id","employee_id","created_at");
--> statement-breakpoint
-- Payslip PIN (bead legend-2ap3): tenant-owned, forced restrictive tenant RLS
-- (TEN-01/02). No outlet column, so no outlet backstop. Same pattern as 0167.
SELECT app.enforce_tenant_rls('public.payslip_pins'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payslip_pin_reset_challenges'::regclass);
--> statement-breakpoint
-- A PIN row is deleted by an HR reset; a challenge is kept as history (single
-- use is the consumed_at stamp). Nothing is ever truncated by the app role.
REVOKE TRUNCATE ON TABLE public.payslip_pins FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payslip_pin_reset_challenges FROM legend_app;
