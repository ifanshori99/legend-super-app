-- 1272 K1 (legend-osqou.56; design duitku-fee-passthrough §3): guest service
-- fee on Duitku va/ewallet/card intents. charged_idr is what the gateway
-- charges; amount_idr stays the bill. New columns only, no FK. The STORED
-- generated column rewrites payment_intents under an exclusive lock for the
-- time of the ALTER (existing rows get guest_fee_idr 0, so charged_idr =
-- amount_idr): run it at a quiet hour (docs/deploy/runbook-founder.md). After 0543.
ALTER TABLE "payment_intents" ADD COLUMN "guest_fee_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "gateway_fee_quote_idr" bigint;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "charged_idr" bigint GENERATED ALWAYS AS (amount_idr + guest_fee_idr) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_guest_fee_check" CHECK ("payment_intents"."guest_fee_idr" >= 0 AND ("payment_intents"."guest_fee_idr" = 0 OR ("payment_intents"."provider" = 'duitku' AND "payment_intents"."method" IN ('va', 'ewallet', 'card'))));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_gateway_fee_quote_check" CHECK ("payment_intents"."gateway_fee_quote_idr" IS NULL OR "payment_intents"."gateway_fee_quote_idr" >= 0);