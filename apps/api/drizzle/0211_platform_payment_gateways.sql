-- sub-302 D7/D27: global payment gateway registry for Super Admin, plus its
-- append-only change history (a platform change belongs to no tenant, so it
-- cannot use audit_logs). Number 0211 and its `when` were assigned by the
-- coordinator. Both tables are global, non-secret and carry no tenant column,
-- so there is no RLS (same as platform_packages). legend_app reads and updates
-- the registry (rows are seeded here, never inserted or deleted by the API) and
-- may only append to the history.
CREATE TABLE "platform_payment_gateway_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) NOT NULL,
	"actor_user_id" text NOT NULL,
	"reason" varchar(500) NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_payment_gateways" (
	"provider" varchar(20) PRIMARY KEY NOT NULL,
	"display_name" varchar(60) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"webhook_tolerance_past_sec" integer DEFAULT 90000 NOT NULL,
	"webhook_tolerance_future_sec" integer DEFAULT 300 NOT NULL,
	"secret_grace_hours" integer DEFAULT 72 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_payment_gateways_provider_check" CHECK ("platform_payment_gateways"."provider" IN ('doit', 'duitku')),
	CONSTRAINT "platform_payment_gateways_default_enabled_check" CHECK (NOT "platform_payment_gateways"."is_default" OR "platform_payment_gateways"."enabled")
);
--> statement-breakpoint
CREATE INDEX "platform_payment_gateway_changes_provider_idx" ON "platform_payment_gateway_changes" USING btree ("provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_payment_gateways_one_default" ON "platform_payment_gateways" USING btree ("is_default") WHERE "platform_payment_gateways"."is_default";
--> statement-breakpoint
INSERT INTO "platform_payment_gateways" ("provider", "display_name", "enabled", "is_default") VALUES ('doit', 'DOIT', true, true), ('duitku', 'Duitku', false, false);
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE public.platform_payment_gateways TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.platform_payment_gateway_changes TO legend_app;
