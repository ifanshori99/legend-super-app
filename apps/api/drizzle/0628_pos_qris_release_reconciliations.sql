-- SO-885 (legend-adiov): durable reconciliation queue for a QRIS hold that a
-- manager force released without provider proof (founder Q93). One row per
-- hold; the worker asks the provider until it answers for good. FKs are inline
-- on this empty new table (no ALTER TABLE ... ADD CONSTRAINT, no NOT VALID)
-- so a plain migration owner does not validate them against FORCE-RLS parents.
CREATE TABLE "pos_qris_release_reconciliations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_provider_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "pos_qris_release_reconciliations_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "pos_qris_release_reconciliations_hold_key" UNIQUE("tenant_id","hold_id"),
	CONSTRAINT "pos_qris_release_reconciliations_status_check" CHECK ("pos_qris_release_reconciliations"."status" IN ('open', 'resolved')),
	CONSTRAINT "pos_qris_release_reconciliations_attempts_check" CHECK ("pos_qris_release_reconciliations"."attempts" >= 0),
	CONSTRAINT "pos_qris_release_reconciliations_resolved_check" CHECK (("pos_qris_release_reconciliations"."status" = 'resolved') = ("pos_qris_release_reconciliations"."resolved_at" IS NOT NULL AND "pos_qris_release_reconciliations"."resolution" IS NOT NULL)),
	CONSTRAINT "pos_qris_release_reconciliations_resolution_check" CHECK ("pos_qris_release_reconciliations"."resolution" IS NULL OR "pos_qris_release_reconciliations"."resolution" IN ('paid_recorded', 'provider_expired', 'provider_failed')),
	CONSTRAINT "pos_qris_release_reconciliations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_release_reconciliations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_release_reconciliations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_release_reconciliations_hold_fk" FOREIGN KEY ("tenant_id","hold_id") REFERENCES "public"."pos_qris_holds"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_release_reconciliations_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_qris_release_reconciliations_due_idx" ON "pos_qris_release_reconciliations" USING btree ("status","next_check_at") WHERE "pos_qris_release_reconciliations"."status" = 'open';
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_qris_release_reconciliations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_qris_release_reconciliations'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.pos_qris_release_reconciliations FROM legend_app;
