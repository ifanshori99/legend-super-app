-- legend-svwdz (1020): reservation_credit_recon_flags, insert-only recon flag
-- for credit moved to a session that was used beyond the source intent's net
-- value. The used value is never cut; the flag only tells finance to look.
-- Foreign keys into FORCE RLS tables are inline in the CREATE TABLE
-- (docs/plan/contracts.md, pattern 1); tenant-isolated like
-- payment_provider_refunds (0505). The migration writes no row.
ALTER TABLE "reservation_customer_credit_uses" ADD CONSTRAINT "reservation_credit_use_tenant_id_key" UNIQUE("tenant_id","id");
--> statement-breakpoint
CREATE TABLE "reservation_credit_recon_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_use_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"used_idr" bigint NOT NULL,
	"effective_idr" bigint NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_credit_recon_flag_use_key" UNIQUE("tenant_id","credit_use_id"),
	CONSTRAINT "reservation_credit_recon_flag_amount_check" CHECK ("reservation_credit_recon_flags"."used_idr" > 0 AND "reservation_credit_recon_flags"."effective_idr" >= 0 AND "reservation_credit_recon_flags"."effective_idr" < "reservation_credit_recon_flags"."used_idr"),
	CONSTRAINT "reservation_credit_recon_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_recon_flag_use_fk" FOREIGN KEY ("tenant_id","credit_use_id") REFERENCES "public"."reservation_customer_credit_uses"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_recon_flag_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_recon_flag_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "reservation_credit_recon_flag_intent_idx" ON "reservation_credit_recon_flags" USING btree ("tenant_id","payment_intent_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_credit_recon_flags'::regclass);
