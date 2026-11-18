-- weexf (legend-1059): the member QR used to redeem points at the POS is single
-- use and bound to an order and an amount. This table keeps the nonce of every
-- spent QR; redeem inserts the row in the same transaction as the points debit
-- (unique (tenant_id, nonce): the loser of a race is refused, a failed debit
-- rolls the nonce back). Foreign keys are inline (docs/plan/contracts.md
-- "Migrations: foreign keys into FORCE RLS tables", pattern 1); RLS as in 0203.
-- New table, nothing else locks it; the wrapper bounds the FK checks against
-- tenants, outlets, orders and customer_profiles (wait at most 5s, then restore
-- the migrator's value; contracts.md, bead legend-76azz; same as 0672).
SELECT set_config('legend.lock_timeout_before_0677', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
CREATE TABLE "member_qr_redeem_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"points" bigint NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_qr_redeem_nonces_nonce_key" UNIQUE("tenant_id","nonce"),
	CONSTRAINT "member_qr_redeem_nonces_points_check" CHECK ("member_qr_redeem_nonces"."points" > 0),
	CONSTRAINT "member_qr_redeem_nonces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_nonces_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_nonces_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_nonces_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/crm-member.custom.sql): tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.member_qr_redeem_nonces'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.member_qr_redeem_nonces'::regclass);
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0677', true), ''), current_setting('lock_timeout')), true);
