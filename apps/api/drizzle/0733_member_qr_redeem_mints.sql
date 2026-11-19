-- legend-0ne0z (1203): every redeem QR the member PWA mints is recorded, so the
-- mint can refuse a second token while one for the same bill is still live
-- (unexpired, unspent, minted at the member's current point-ledger version).
-- The mint writes the row under the member's profile lock. Redeem still trusts
-- only the signed token and the spent nonce (member_qr_redeem_nonces, 0490).
-- Foreign keys are inline (docs/plan/contracts.md "Migrations: foreign keys
-- into FORCE RLS tables", pattern 1); RLS as in 0490. New table, nothing else
-- locks it; the wrapper bounds the FK checks against tenants, outlets, orders
-- and customer_profiles (wait at most 5s, then restore the migrator's value;
-- contracts.md, bead legend-76azz; same as 0490).
SELECT set_config('legend.lock_timeout_before_0733', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
CREATE TABLE "member_qr_redeem_mints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"points" bigint NOT NULL,
	"ledger_version" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"minted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_qr_redeem_mints_nonce_key" UNIQUE("tenant_id","nonce"),
	CONSTRAINT "member_qr_redeem_mints_points_check" CHECK ("member_qr_redeem_mints"."points" > 0),
	CONSTRAINT "member_qr_redeem_mints_version_check" CHECK ("member_qr_redeem_mints"."ledger_version" >= 0),
	CONSTRAINT "member_qr_redeem_mints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_mints_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_mints_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "member_qr_redeem_mints_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "member_qr_redeem_mints_order_idx" ON "member_qr_redeem_mints" USING btree ("tenant_id","order_id","expires_at");
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/crm-member.custom.sql): tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.member_qr_redeem_mints'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.member_qr_redeem_mints'::regclass);
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0733', true), ''), current_setting('lock_timeout')), true);
