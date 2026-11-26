-- Review O3 P2 1 (bead legend-wasr7.7, CTO 27 Nov): a shift with an offline
-- kit force-closed without the kit device's queue count is marked; finance is
-- alerted. Additive column with a constant default: no rewrite, no backfill.
ALTER TABLE "pos_shifts" ADD COLUMN "offline_queue_unverified" boolean DEFAULT false NOT NULL;