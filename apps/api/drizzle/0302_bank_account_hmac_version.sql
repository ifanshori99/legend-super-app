-- legend-baxdx: bank_accounts records the blind-index key version of its
-- account_number_hmac (1 = legacy HMAC under the raw data key, 2 = HKDF
-- subkey; lib/blind-index.ts). Every existing row was written by the legacy
-- digest, so the default 1 is correct and nothing is rewritten here. Additive,
-- constant-default column: no table rewrite.
ALTER TABLE "bank_accounts" ADD COLUMN "account_number_hmac_version" smallint DEFAULT 1 NOT NULL;
