ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_open_check";--> statement-breakpoint
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_closed_check";--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "held_cash_out_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD CONSTRAINT "pos_order_refunds_needs_approval_shift_check" CHECK (NOT "pos_order_refunds"."needs_approval" OR "pos_order_refunds"."shift_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD CONSTRAINT "pos_order_voids_needs_approval_shift_check" CHECK (NOT "pos_order_voids"."needs_approval" OR "pos_order_voids"."shift_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_held_cash_out_check" CHECK ("pos_shifts"."held_cash_out_idr" >= 0);--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_open_check" CHECK ("pos_shifts"."status" <> 'open' OR ("pos_shifts"."expected_idr" IS NULL
        AND "pos_shifts"."counted_idr" IS NULL AND "pos_shifts"."variance_idr" IS NULL
        AND "pos_shifts"."variance_note" IS NULL AND "pos_shifts"."counts" IS NULL
        AND "pos_shifts"."approved_by" IS NULL AND "pos_shifts"."approval_request_id" IS NULL
        AND "pos_shifts"."approval_override_id" IS NULL AND "pos_shifts"."approved_at" IS NULL
        AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closed_by" IS NULL
        AND "pos_shifts"."close_key" IS NULL AND "pos_shifts"."close_fingerprint" IS NULL
        AND "pos_shifts"."count_id" IS NULL AND "pos_shifts"."held_cash_out_idr" = 0));--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_check" CHECK ("pos_shifts"."status" <> 'closed' OR ("pos_shifts"."expected_idr" IS NOT NULL
        AND "pos_shifts"."counted_idr" IS NOT NULL AND "pos_shifts"."variance_idr" IS NOT NULL
        AND "pos_shifts"."counts" IS NOT NULL
        AND "pos_shifts"."approved_by" IS NOT NULL AND "pos_shifts"."approval_request_id" IS NOT NULL
        AND "pos_shifts"."approval_override_id" IS NOT NULL AND "pos_shifts"."approved_at" IS NOT NULL
        AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closed_by" IS NOT NULL
        AND "pos_shifts"."close_key" IS NOT NULL AND "pos_shifts"."close_fingerprint" IS NOT NULL
        AND "pos_shifts"."expected_idr" = "pos_shifts"."opening_float_idr" + "pos_shifts"."cash_sales_idr"
          - "pos_shifts"."cash_refunds_idr" + "pos_shifts"."cash_in_idr" - "pos_shifts"."cash_out_idr"
          - "pos_shifts"."cash_drop_idr"
        AND "pos_shifts"."variance_idr" = "pos_shifts"."counted_idr" - "pos_shifts"."expected_idr"
        AND ("pos_shifts"."variance_idr" + "pos_shifts"."held_cash_out_idr" = 0
          OR "pos_shifts"."variance_note" IS NOT NULL)));