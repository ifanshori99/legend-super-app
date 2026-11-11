-- legend-n039: dedicated blind-index key. Each row records the key version of
-- its blind-index digests (1 = legacy HMAC under the raw data key, 2 = HKDF
-- subkey). Every existing row was written by the legacy digest, so the default
-- 1 is correct and no data is rewritten here; worker/blind-index-rebuild.job.ts
-- moves rows to the active version. Additive, constant-default columns: no
-- table rewrite.
ALTER TABLE "employees" ADD COLUMN "blind_index_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "npwp_hash_version" smallint DEFAULT 1 NOT NULL;
