-- legend-7uqbs (958 recon): the provider answered `refunded` for money we had
-- already recorded (a payment parked as unallocated funds, or a bill settled
-- paid). That money went back to the payer, so it must not be refunded a second
-- time. Two nullable columns carry the fact, each set once by a conditional
-- write (first answer wins, a replay changes nothing):
--   payment_unallocated_funds.provider_refunded_at: a parked fund can no longer
--     be resolved into a refund.
--   payment_intents.provider_refunded_after_paid_at: a settled (paid) intent.
--     Kept apart from provider_refunded_at on purpose: that column makes a late
--     `paid` message for the code a rejected one, and a paid intent must keep
--     treating the replay of its own paid message as a replay.
-- No backfill: an old row stays null, i.e. "never answered refunded", the
-- behavior it had before. ADD COLUMN touches no row, so FORCE ROW LEVEL
-- SECURITY is left as it is.
ALTER TABLE "payment_unallocated_funds" ADD COLUMN "provider_refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "provider_refunded_after_paid_at" timestamp with time zone;
