-- legend-3wpf (952 P1): "the provider answered `refunded`" gets its own column.
-- A refunded answer is mapped to `failed` with no amount, so the status alone
-- cannot tell a refunded code (its money went back to the payer; a late `paid`
-- message must never settle the bill) from a plain failed one (which still
-- reconciles once when paid late). Nullable, no backfill: an old row stays
-- null, i.e. "never answered refunded", which is the behavior it had before.
-- ADD COLUMN touches no row, so FORCE ROW LEVEL SECURITY is left as it is.
ALTER TABLE "payment_intents" ADD COLUMN "provider_refunded_at" timestamp with time zone;
