-- SO-896 (legend-5wn1e): staff release of a virtual account code that has no
-- provider-final answer (founder Q93 rule, as the QRIS release). One row per
-- released intent: the audit of the release and the durable queue that keeps
-- asking the provider until it answers for good. FKs are inline on this empty
-- new table (no ALTER TABLE ... ADD CONSTRAINT, no NOT VALID) so a plain
-- migration owner does not validate them against FORCE-RLS parents.
CREATE TABLE "payment_va_releases" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"released_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"override_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_provider_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "payment_va_releases_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "payment_va_releases_intent_key" UNIQUE("tenant_id","payment_intent_id"),
	CONSTRAINT "payment_va_releases_override_key" UNIQUE("tenant_id","override_id"),
	CONSTRAINT "payment_va_releases_status_check" CHECK ("payment_va_releases"."status" IN ('open', 'resolved')),
	CONSTRAINT "payment_va_releases_attempts_check" CHECK ("payment_va_releases"."attempts" >= 0),
	CONSTRAINT "payment_va_releases_reason_check" CHECK (char_length("payment_va_releases"."reason") BETWEEN 3 AND 300 AND "payment_va_releases"."reason" = btrim("payment_va_releases"."reason")),
	CONSTRAINT "payment_va_releases_resolved_check" CHECK (("payment_va_releases"."status" = 'resolved') = ("payment_va_releases"."resolved_at" IS NOT NULL AND "payment_va_releases"."resolution" IS NOT NULL)),
	CONSTRAINT "payment_va_releases_resolution_check" CHECK ("payment_va_releases"."resolution" IS NULL OR "payment_va_releases"."resolution" IN ('paid_recorded', 'provider_expired', 'provider_failed')),
	CONSTRAINT "payment_va_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_va_releases_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_va_releases_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_va_releases_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payment_va_releases_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payment_va_releases_due_idx" ON "payment_va_releases" USING btree ("status","next_check_at") WHERE "payment_va_releases"."status" = 'open';
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_va_releases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_va_releases'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payment_va_releases FROM legend_app;
--> statement-breakpoint
