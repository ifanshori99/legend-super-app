-- legend-vp4ta (brief 1025b): the provider payment id a held refund names, so
-- finance counts the refund against that transaction (an extra transaction's
-- money stays blocked) and not against the intent's own payment. Existing
-- holds keep NULL: the resolve then falls back to the intent's only
-- transaction, or refuses when that is in doubt. The migration writes no row.
ALTER TABLE "refund_recon_holds" ADD COLUMN "provider_payment_ref" varchar(100);
