-- legend-9s33i (1025 C): refund_recon_holds, a provider refund.succeeded whose
-- reference names another intent than the one owning the payment id. An open
-- hold (resolved_at NULL) blocks refunds and payouts of that intent until
-- finance matches it; nothing is refunded or stamped automatically. One hold
-- per provider refund id of an intent (partial unique index).
-- Foreign keys into FORCE RLS tables are inline in the CREATE TABLE
-- (docs/plan/contracts.md, pattern 1); tenant-isolated like
-- payment_provider_refunds (0505). The migration writes no row.
CREATE TABLE "refund_recon_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"provider_refund_id" varchar(100),
	"amount_idr" bigint NOT NULL,
	"reason" varchar(200) NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "refund_recon_hold_event_key" UNIQUE("tenant_id","webhook_event_id"),
	CONSTRAINT "refund_recon_hold_amount_check" CHECK ("refund_recon_holds"."amount_idr" >= 0),
	CONSTRAINT "refund_recon_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "refund_recon_hold_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "refund_recon_hold_intent_idx" ON "refund_recon_holds" USING btree ("tenant_id","payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "refund_recon_hold_provider_refund_key" ON "refund_recon_holds" USING btree ("tenant_id","payment_intent_id","provider_refund_id") WHERE "refund_recon_holds"."provider_refund_id" IS NOT NULL;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.refund_recon_holds'::regclass);
