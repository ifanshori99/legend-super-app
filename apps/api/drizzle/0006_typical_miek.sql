CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(150) NOT NULL,
	"logo_media_id" uuid,
	"theme_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_tenant_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "brands_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"npwp_encrypted" text,
	"npwp_last4" varchar(4),
	"npwp_hash" varchar(64),
	"is_pkp" boolean DEFAULT false NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_entities_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legal_entities_npwp_last4_check" CHECK ("legal_entities"."npwp_last4" IS NULL OR "legal_entities"."npwp_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "legal_entities_npwp_pair_check" CHECK (("legal_entities"."npwp_encrypted" IS NULL) = ("legal_entities"."npwp_last4" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(150) NOT NULL,
	"address" text NOT NULL,
	"region_id" uuid,
	"geofence" jsonb,
	"timezone" varchar(40) DEFAULT 'Asia/Jakarta' NOT NULL,
	"opening_hours" jsonb NOT NULL,
	"edge_node_id" uuid,
	"status" varchar(20) DEFAULT 'preopening' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlets_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "outlets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "outlets_code_check" CHECK ("outlets"."code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
	CONSTRAINT "outlets_status_check" CHECK ("outlets"."status" IN ('preopening', 'active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"is_break_glass" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(13) NOT NULL,
	"name" varchar(150) NOT NULL,
	"type" varchar(20) NOT NULL,
	"parent_id" uuid,
	CONSTRAINT "regions_code_unique" UNIQUE("code"),
	CONSTRAINT "regions_type_check" CHECK ("regions"."type" IN ('province', 'regency', 'city', 'district', 'village')),
	CONSTRAINT "regions_code_check" CHECK ("regions"."code" ~ '^[0-9.]{2,13}$')
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(150) NOT NULL,
	"plan" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"deployment_mode" varchar(20) NOT NULL,
	"feature_flags" jsonb DEFAULT '{"modules":[],"integrationProviders":[]}'::jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" IN ('active', 'suspended', 'archived')),
	CONSTRAINT "tenants_deployment_mode_check" CHECK ("tenants"."deployment_mode" IN ('dedicated', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"tls_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "tenant_domains_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_domains_kind_check" CHECK ("tenant_domains"."kind" IN ('platform_subdomain', 'custom')),
	CONSTRAINT "tenant_domains_tls_status_check" CHECK ("tenant_domains"."tls_status" IN ('pending', 'active', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "platform_packages" (
	"key" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"modules" jsonb NOT NULL,
	"default_limits" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_packages_status_check" CHECK ("platform_packages"."status" IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "tenant_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"provider" varchar(30) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"credential_secret_ref" varchar(80),
	"credential_fields" text[],
	"credentials_set_at" timestamp with time zone,
	"credentials_set_by" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_integrations_status_check" CHECK ("tenant_integrations"."status" IN ('draft', 'active', 'disabled')),
	CONSTRAINT "tenant_integrations_active_credentials_check" CHECK ("tenant_integrations"."status" <> 'active' OR "tenant_integrations"."credentials_encrypted" IS NOT NULL),
	CONSTRAINT "tenant_integrations_secret_ref_check" CHECK ("tenant_integrations"."credential_secret_ref" IS NULL OR "tenant_integrations"."credential_secret_ref" ~ '^sec_[A-Za-z0-9_-]{16,64}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"tokens" jsonb NOT NULL,
	"logo_media_id" uuid,
	"font_family" varchar(40) NOT NULL,
	"corners" varchar(20) NOT NULL,
	"contrast_check_passed" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "tenant_themes_brand_version_key" UNIQUE("tenant_id","brand_id","version"),
	CONSTRAINT "tenant_themes_status_check" CHECK ("tenant_themes"."status" IN ('draft', 'archived', 'active')),
	CONSTRAINT "tenant_themes_version_check" CHECK ("tenant_themes"."version" > 0),
	CONSTRAINT "tenant_themes_active_contrast_check" CHECK ("tenant_themes"."status" <> 'active' OR "tenant_themes"."contrast_check_passed"),
	CONSTRAINT "tenant_themes_activated_at_check" CHECK (("tenant_themes"."status" = 'draft') = ("tenant_themes"."activated_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"super_admin_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"access_mode" varchar(20) DEFAULT 'read_only' NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mfa_verified_at" timestamp with time zone NOT NULL,
	"tenant_admin_notified_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_mode_check" CHECK ("support_access_grants"."access_mode" IN ('read_only', 'read_write')),
	CONSTRAINT "support_access_duration_check" CHECK ("support_access_grants"."duration_minutes" IN (15, 30, 60, 120)),
	CONSTRAINT "support_access_window_check" CHECK ("support_access_grants"."expires_at" = "support_access_grants"."started_at" + make_interval(mins => "support_access_grants"."duration_minutes")),
	CONSTRAINT "support_access_mfa_check" CHECK ("support_access_grants"."mfa_verified_at" <= "support_access_grants"."started_at"),
	CONSTRAINT "support_access_ended_pair_check" CHECK (("support_access_grants"."ended_at" IS NULL) = ("support_access_grants"."ended_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_parent_id_regions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_themes" ADD CONSTRAINT "tenant_themes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_themes" ADD CONSTRAINT "tenant_themes_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_tenant_npwp_key" ON "legal_entities" USING btree ("tenant_id","npwp_hash") WHERE "legal_entities"."npwp_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outlets_brand_idx" ON "outlets" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE INDEX "outlets_status_idx" ON "outlets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_active_user_key" ON "platform_admins" USING btree ("user_id") WHERE "platform_admins"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_break_glass_key" ON "platform_admins" USING btree ("is_break_glass") WHERE "platform_admins"."is_break_glass" AND "platform_admins"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenants_created_id_idx" ON "tenants" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenant_domains_brand_idx" ON "tenant_domains" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_integrations_tenant_provider_key" ON "tenant_integrations" USING btree ("tenant_id","provider") WHERE "tenant_integrations"."outlet_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_integrations_outlet_provider_key" ON "tenant_integrations" USING btree ("tenant_id","outlet_id","provider") WHERE "tenant_integrations"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_integrations_tenant_idx" ON "tenant_integrations" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_themes_active_brand_key" ON "tenant_themes" USING btree ("tenant_id","brand_id") WHERE "tenant_themes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "support_access_tenant_started_idx" ON "support_access_grants" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_access_admin_open_idx" ON "support_access_grants" USING btree ("tenant_id","super_admin_user_id","expires_at");