-- legend-rfiof: poller lease so two workers never poll the same intent.
ALTER TABLE "payment_intents" ADD COLUMN "gateway_poll_lease_until" timestamp with time zone;
