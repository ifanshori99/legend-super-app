-- legend-rat9r: what the guest paid for a swapped item, read at a cheaper swap.
-- Nullable, no backfill: older rows carry no cap.
ALTER TABLE "order_issues" ADD COLUMN "paid_value_idr" bigint;
