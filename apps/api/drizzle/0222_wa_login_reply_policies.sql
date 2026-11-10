-- legend-dn4 (PRD §3 F6, AUTH-03): WhatsApp login replies are off by default.
-- One row per tenant opts in and caps the replies per month. No row means
-- disabled. The table is new and empty, so FORCE RLS needs no lift. Additive
-- only: no data statement, no existing table is touched.
CREATE TABLE "wa_login_reply_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"free_monthly_quota" integer DEFAULT 1000 NOT NULL,
	"replies_month" char(7),
	"replies_this_month" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_login_reply_policies_quota_check" CHECK ("wa_login_reply_policies"."free_monthly_quota" >= 0 AND "wa_login_reply_policies"."free_monthly_quota" <= 1000),
	CONSTRAINT "wa_login_reply_policies_count_check" CHECK ("wa_login_reply_policies"."replies_this_month" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wa_login_reply_policies" ADD CONSTRAINT "wa_login_reply_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wa_login_reply_policies'::regclass);
--> statement-breakpoint
-- A policy is switched off, never deleted. enforce_tenant_rls grants DELETE;
-- take it back (and TRUNCATE) so legend_app keeps SELECT, INSERT, UPDATE.
REVOKE DELETE, TRUNCATE ON TABLE public.wa_login_reply_policies FROM legend_app;
