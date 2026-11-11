CREATE TABLE "payment_recurring_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"provider" varchar(20) DEFAULT 'doit' NOT NULL,
	"provider_plan_id" varchar(100) NOT NULL,
	"gateway_integration_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"interval" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_recurring_plans_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_recurring_plans_provider_plan_key" UNIQUE("tenant_id","provider","provider_plan_id"),
	CONSTRAINT "payment_recurring_plans_provider_check" CHECK ("payment_recurring_plans"."provider" IN ('doit')),
	CONSTRAINT "payment_recurring_plans_amount_check" CHECK ("payment_recurring_plans"."amount_idr" > 0),
	CONSTRAINT "payment_recurring_plans_interval_check" CHECK ("payment_recurring_plans"."interval" IN ('month', 'week')),
	CONSTRAINT "payment_recurring_plans_status_check" CHECK ("payment_recurring_plans"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "payment_recurring_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"gateway_integration_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"provider_subscription_id" varchar(100) NOT NULL,
	"status" varchar(30) DEFAULT 'pending_first_payment' NOT NULL,
	"current_period_start" date,
	"current_period_end" date,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_recurring_subscriptions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_recurring_subscriptions_provider_sub_key" UNIQUE("tenant_id","provider_subscription_id"),
	CONSTRAINT "payment_recurring_subscriptions_status_check" CHECK ("payment_recurring_subscriptions"."status" IN ('pending_first_payment', 'active', 'past_due', 'paused', 'cancelled')),
	CONSTRAINT "payment_recurring_subscriptions_period_check" CHECK (("payment_recurring_subscriptions"."current_period_start" IS NULL) = ("payment_recurring_subscriptions"."current_period_end" IS NULL) AND ("payment_recurring_subscriptions"."current_period_start" IS NULL OR "payment_recurring_subscriptions"."current_period_end" > "payment_recurring_subscriptions"."current_period_start"))
);
--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"provider_invoice_id" varchar(100) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"hosted_url" text NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"review_reason" varchar(64),
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscription_invoices_provider_invoice_key" UNIQUE("tenant_id","provider_invoice_id"),
	CONSTRAINT "subscription_invoices_amount_check" CHECK ("subscription_invoices"."amount_idr" > 0),
	CONSTRAINT "subscription_invoices_period_check" CHECK ("subscription_invoices"."period_end" > "subscription_invoices"."period_start"),
	CONSTRAINT "subscription_invoices_status_check" CHECK ("subscription_invoices"."status" IN ('open', 'paid', 'void', 'expired', 'needs_review')),
	CONSTRAINT "subscription_invoices_hosted_url_check" CHECK ("subscription_invoices"."hosted_url" ~ '^https://'),
	CONSTRAINT "subscription_invoices_review_reason_check" CHECK ("subscription_invoices"."status" <> 'needs_review' OR "subscription_invoices"."review_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "payment_recurring_plans" ADD CONSTRAINT "payment_recurring_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_plans" ADD CONSTRAINT "payment_recurring_plans_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_plans" ADD CONSTRAINT "payment_recurring_plans_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."payment_recurring_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_plans" ADD CONSTRAINT "payment_recurring_plans_gateway_integration_fk" FOREIGN KEY ("gateway_integration_id") REFERENCES "public"."tenant_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_recurring_subscriptions" ADD CONSTRAINT "payment_recurring_subscriptions_gateway_integration_fk" FOREIGN KEY ("gateway_integration_id") REFERENCES "public"."tenant_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."payment_recurring_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_recurring_plans_outlet_idx" ON "payment_recurring_plans" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "payment_recurring_subscriptions_outlet_idx" ON "payment_recurring_subscriptions" USING btree ("tenant_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "payment_recurring_subscriptions_customer_idx" ON "payment_recurring_subscriptions" USING btree ("tenant_id","customer_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoices_sub_period_key" ON "subscription_invoices" USING btree ("tenant_id","subscription_id","period_start") WHERE "subscription_invoices"."status" IN ('open', 'paid');--> statement-breakpoint
CREATE INDEX "subscription_invoices_outlet_idx" ON "subscription_invoices" USING btree ("tenant_id","outlet_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- TEN-01/TEN-03: every table is tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.payment_recurring_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_recurring_plans'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_recurring_subscriptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_recurring_subscriptions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.subscription_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.subscription_invoices'::regclass);
