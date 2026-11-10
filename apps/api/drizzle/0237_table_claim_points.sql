-- legend-n1mp: guest point claim. `earn` ledger rows may now come from a
-- table claim (source_type 'table_claim'), and a paid order without a bill
-- split gets its own claim token columns (same shape as bill_splits).
-- Keep this file and the schema (crm-ledger.ts, qr-order.ts) in step.
-- orders is hot (POS): wait at most 5s for its ACCESS EXCLUSIVE lock, then
-- restore the migrator's value (contracts.md, bead legend-76azz).
SELECT set_config('legend.lock_timeout_before_0237', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
ALTER TABLE "point_ledger" DROP CONSTRAINT "point_ledger_source_type_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claim_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claim_token_sealed" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claim_redeemed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_claim_token_hash_key" ON "orders" USING btree ("claim_token_hash") WHERE "orders"."claim_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_claim_paid_check" CHECK ("orders"."claim_token_hash" IS NULL OR "orders"."status" IN ('sent', 'completed', 'voided')) NOT VALID;--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_claim_paid_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_claim_redeemed_check" CHECK ("orders"."claim_redeemed_at" IS NULL OR "orders"."claim_token_hash" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_claim_redeemed_check";--> statement-breakpoint
ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_source_type_check" CHECK (CASE "point_ledger"."type"
            WHEN 'earn' THEN "point_ledger"."source_type" IN ('order', 'table_claim')
            WHEN 'bonus' THEN "point_ledger"."source_type" IN ('mission', 'referral', 'birthday', 'adjustment')
            WHEN 'redeem' THEN "point_ledger"."source_type" = 'reward_redemption'
            WHEN 'expire' THEN "point_ledger"."source_type" = 'expiry'
            WHEN 'reverse' THEN "point_ledger"."source_type" IN ('refund', 'void')
            ELSE "point_ledger"."source_type" = 'adjustment' END) NOT VALID;--> statement-breakpoint
ALTER TABLE "point_ledger" VALIDATE CONSTRAINT "point_ledger_source_type_check";
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0237', true), ''), current_setting('lock_timeout')), true);
