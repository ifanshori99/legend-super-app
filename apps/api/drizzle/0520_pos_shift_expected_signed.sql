-- legend-4wu4: expected_idr may be negative. Cash out / drop / refund no longer
-- answer "the drawer is short", so the drawer figure must be able to go below
-- zero; the gap goes to the close variance approval (the supervisor), where it
-- stays on record. Only the expected_idr bound is dropped; every other amount
-- keeps its non-negative rule.
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_amounts_check";--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_amounts_check" CHECK ("pos_shifts"."opening_float_idr" >= 0 AND "pos_shifts"."cash_sales_idr" >= 0
        AND "pos_shifts"."cash_refunds_idr" >= 0 AND "pos_shifts"."cash_in_idr" >= 0
        AND "pos_shifts"."cash_out_idr" >= 0 AND "pos_shifts"."cash_drop_idr" >= 0
        AND ("pos_shifts"."counted_idr" IS NULL OR "pos_shifts"."counted_idr" >= 0));
