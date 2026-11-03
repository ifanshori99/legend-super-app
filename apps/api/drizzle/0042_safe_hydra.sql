ALTER TABLE "promotion_order_applications" ADD COLUMN "paid_idr" bigint;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD COLUMN "refunded_paid_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD COLUMN "rules_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "promotion_order_applications" ADD CONSTRAINT "promotion_order_applications_refunded_paid_check" CHECK ("promotion_order_applications"."refunded_paid_idr" >= 0 AND ("promotion_order_applications"."paid_idr" IS NULL OR "promotion_order_applications"."refunded_paid_idr" <= "promotion_order_applications"."paid_idr"));--> statement-breakpoint
-- legend-e5it review (owner Q41): rows written before this migration have no
-- paid ceiling; backfill best effort from the amounts they still hold.
UPDATE "promotion_order_applications" SET "paid_idr" = "subtotal_idr" - "total_discount_idr" WHERE "paid_idr" IS NULL;