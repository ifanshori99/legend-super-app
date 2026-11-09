-- legend-5gub: mask card numbers (PAN) left in old edc_transactions rows.
--
-- Since the provider response boundary filter (packages/shared/src/edc,
-- ecrResultDetailsSchema) new writes never store a card number. Rows written
-- before it may still hold one in card_type, rrn, invoice_no, batch_no,
-- dispatch_batch_no (copied from batch_no), message or masked_pan.
--
-- Card-number-like = a run of digits, optionally split by single spaces or
-- dashes ("4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"),
-- with the same thresholds as the write path: 13+ digits in the reference
-- columns (a 12-digit RRN is legitimate there), 12+ digits in card_type,
-- message and masked_pan (no legitimate value holds 12 digits in a row).
-- Per column, mirroring the write path:
--   card_type                         -> 'UNKNOWN' (allowlist fallback)
--   rrn, invoice_no, batch_no,
--   dispatch_batch_no                 -> NULL (referenceField drops PAN-like)
--   message                           -> each run replaced by '[disamarkan]'
--   masked_pan                        -> a bare 13-19 digit number becomes
--                                        first 6 + '*' + last 4 (receipt rule);
--                                        anything else card-like -> NULL
--
-- Invariants: only rows that hold a card-number-like run are updated; amount,
-- status, completed_at, updated_at and every other column stay as they are.
-- Every replacement is free of digit runs that match and never longer than the
-- value it replaces, so a second run matches no row (idempotent) and varchar limits
-- hold.
--
-- RLS: edc_transactions is FORCE RLS (tenant + outlet policies) and the
-- migration role is a non-super table owner with no tenant context, so FORCE is
-- lifted for this statement only and restored in the same migration
-- transaction (precedent: 0096_menu_station_type_backfill.sql). Policies are
-- not touched. ALTER TABLE holds an ACCESS EXCLUSIVE lock on edc_transactions
-- until the migration transaction commits: on a large table run the deploy
-- outside outlet operating hours (docs/runbooks/edc-pan-scrub.md). The drizzle
-- migrator runs every pending migration in one transaction, so the lock lasts
-- until the whole batch commits. lock_timeout makes the ALTER give up (and the
-- whole batch roll back, safe to retry) instead of queueing POS/EDC traffic
-- behind it while an open transaction holds the table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "edc_transactions" SET
  "card_type" = CASE
    WHEN "card_type" ~ '[0-9]([ -]?[0-9]){11,}' THEN 'UNKNOWN'
    ELSE "card_type" END,
  "rrn" = CASE
    WHEN "rrn" ~ '[0-9]([ -]?[0-9]){12,}' THEN NULL
    ELSE "rrn" END,
  "invoice_no" = CASE
    WHEN "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}' THEN NULL
    ELSE "invoice_no" END,
  "batch_no" = CASE
    WHEN "batch_no" ~ '[0-9]([ -]?[0-9]){12,}' THEN NULL
    ELSE "batch_no" END,
  "dispatch_batch_no" = CASE
    WHEN "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}' THEN NULL
    ELSE "dispatch_batch_no" END,
  "message" = CASE
    WHEN "message" ~ '[0-9]([ -]?[0-9]){11,}'
      THEN regexp_replace("message", '[0-9]([ -]?[0-9]){11,}', '[disamarkan]', 'g')
    ELSE "message" END,
  "masked_pan" = CASE
    WHEN "masked_pan" !~ '[0-9]([ -]?[0-9]){11,}' THEN "masked_pan"
    WHEN "masked_pan" ~ '^[0-9]([ -]?[0-9]){12,18}$'
      THEN left(regexp_replace("masked_pan", '[^0-9]', '', 'g'), 6)
        || repeat('*', length(regexp_replace("masked_pan", '[^0-9]', '', 'g')) - 10)
        || right(regexp_replace("masked_pan", '[^0-9]', '', 'g'), 4)
    ELSE NULL END
WHERE "card_type" ~ '[0-9]([ -]?[0-9]){11,}'
   OR "rrn" ~ '[0-9]([ -]?[0-9]){12,}'
   OR "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}'
   OR "batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
   OR "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
   OR "message" ~ '[0-9]([ -]?[0-9]){11,}'
   OR "masked_pan" ~ '[0-9]([ -]?[0-9]){11,}';
--> statement-breakpoint
ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
