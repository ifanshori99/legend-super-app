-- legend-svwdz (1020): provider refunds already netted when the remainder was made.
-- Old rows get 0 (restrictive: the whole provider refund counts against them).
ALTER TABLE "reservation_deposit_remainders" ADD COLUMN "provider_refunded_snapshot_idr" bigint DEFAULT 0 NOT NULL;
