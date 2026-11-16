-- SO-885 (legend-tqkbb): local time (expiry, the 24 hour poll window, the late
-- grace) is never proof that a payment code is dead. `provider_final_at` is set
-- only when the provider itself answered final (expired / failed / cancelled)
-- or the money was reconciled; until then an `expired` code with a provider
-- reference may still take money, and no replacement code or split change opens.
ALTER TABLE "payment_intents" ADD COLUMN "provider_final_at" timestamp with time zone;
