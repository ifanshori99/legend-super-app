-- legend-baxdx: bank_accounts records the blind-index key version of its
-- account_number_hmac (1 = legacy HMAC under the raw data key, 2 = HKDF
-- subkey; lib/blind-index.ts). Every existing row was written by the legacy
-- digest, so the default 1 is correct and nothing is rewritten here. Additive,
-- constant-default column: no table rewrite. The CHECK limits the version to the
-- known key versions (1, 2); the table is scanned once, no row can fail it.
ALTER TABLE "bank_accounts" ADD COLUMN "account_number_hmac_version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_account_number_hmac_version_check" CHECK ("bank_accounts"."account_number_hmac_version" IN (1, 2));
