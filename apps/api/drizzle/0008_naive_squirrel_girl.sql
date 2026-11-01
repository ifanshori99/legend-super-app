CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"threshold_idr" bigint,
	"approver_role_id" uuid NOT NULL,
	"levels" integer NOT NULL,
	"requires_distinct_actor" boolean DEFAULT true NOT NULL,
	CONSTRAINT "approval_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_policies_threshold_check" CHECK ("approval_policies"."threshold_idr" IS NULL OR ("approval_policies"."threshold_idr" >= 0 AND "approval_policies"."threshold_idr" <= 9007199254740991)),
	CONSTRAINT "approval_policies_level_check" CHECK ("approval_policies"."levels" BETWEEN 1 AND 3),
	CONSTRAINT "approval_policies_distinct_actor_check" CHECK ("approval_policies"."requires_distinct_actor")
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(20) NOT NULL,
	"scope_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "role_assignments_scope_check" CHECK (("role_assignments"."scope_type" = 'tenant' AND "role_assignments"."scope_id" IS NULL) OR ("role_assignments"."scope_type" IN ('brand', 'outlet', 'station') AND "role_assignments"."scope_id" IS NOT NULL)),
	CONSTRAINT "role_assignments_window_check" CHECK ("role_assignments"."valid_until" IS NULL OR "role_assignments"."valid_until" > "role_assignments"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_key" varchar(50),
	"permissions" jsonb NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"allowed_scope_types" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "roles_tenant_name_key" UNIQUE("tenant_id","name"),
	CONSTRAINT "roles_tenant_template_key" UNIQUE("tenant_id","template_key"),
	CONSTRAINT "roles_template_check" CHECK (("roles"."is_template" AND "roles"."template_key" IS NOT NULL AND "roles"."template_key" <> 'super_admin') OR (NOT "roles"."is_template" AND "roles"."template_key" IS NULL)),
	CONSTRAINT "roles_permissions_array_check" CHECK (jsonb_typeof("roles"."permissions") = 'array'),
	CONSTRAINT "roles_scope_array_check" CHECK (jsonb_typeof("roles"."allowed_scope_types") = 'array' AND jsonb_array_length("roles"."allowed_scope_types") > 0)
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_role_fk" FOREIGN KEY ("tenant_id","approver_role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_tier_role_key" ON "approval_policies" USING btree ("tenant_id","action_type",coalesce("threshold_idr", -1),"levels","approver_role_id");--> statement-breakpoint
CREATE INDEX "role_assignments_tenant_user_idx" ON "role_assignments" USING btree ("tenant_id","user_id");