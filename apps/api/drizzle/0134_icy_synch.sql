ALTER TABLE "cash_movements" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD COLUMN "held_cash_out_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_needs_approval_type_check" CHECK (NOT "cash_movements"."needs_approval" OR "cash_movements"."type" <> 'cash_in');--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_held_cash_out_check" CHECK ("pos_shift_counts"."held_cash_out_idr" >= 0);