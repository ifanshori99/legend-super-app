ALTER TABLE "pos_order_discounts" DROP CONSTRAINT "pos_order_discounts_approval_pair_check";--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ALTER COLUMN "approval_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ALTER COLUMN "approval_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD COLUMN "override_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD COLUMN "void_override_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD COLUMN "override_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD COLUMN "override_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD COLUMN "void_override_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_approval_pair_check" CHECK (("pos_order_discounts"."approved_by" IS NULL) = ("pos_order_discounts"."approval_request_id" IS NULL AND "pos_order_discounts"."override_id" IS NULL));