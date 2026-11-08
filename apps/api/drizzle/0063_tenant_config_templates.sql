CREATE TABLE "config_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid,
	"status" varchar(20) NOT NULL,
	"applied_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "config_imports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "config_imports_status_check" CHECK ("config_imports"."status" IN ('validating', 'applying', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "config_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"version" integer NOT NULL,
	"source_tenant_id" uuid,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_templates_name_version_key" UNIQUE("name","version"),
	CONSTRAINT "config_templates_version_check" CHECK ("config_templates"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "config_imports" ADD CONSTRAINT "config_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_imports" ADD CONSTRAINT "config_imports_template_id_config_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."config_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_templates" ADD CONSTRAINT "config_templates_source_tenant_id_tenants_id_fk" FOREIGN KEY ("source_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_imports_tenant_started_idx" ON "config_imports" USING btree ("tenant_id","started_at");