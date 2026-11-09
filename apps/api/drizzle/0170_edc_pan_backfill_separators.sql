-- legend-0lrkl: backfill for legend-deu7r. The write path (packages/shared/src/edc
-- `cardNumberLike`) now treats ANY whitespace, slash and underscore as a card
-- number separator, next to the dash it already took. 0135 and 0143 matched
-- digits split by spaces, tabs and dashes only, and the migrator never re-runs
-- an applied file, so 0143 stays as it was and this migration repeats its
-- `message` rule with the wider class.
--
-- Card-number-like = a run of 12+ digits with any number of the following
-- between them (JS `\s` written out, because the POSIX class depends on the
-- database locale): tab, newline, vertical tab, form feed, carriage return,
-- space, NBSP (U+00A0), U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F,
-- U+3000, U+FEFF, plus slash, underscore and dash. A colon, comma, dot or
-- letter ends a run, so '2026/11/09 12:30:45' (10 digits) and 'Rp 1.250.000'
-- stay. Same 12-digit threshold as the write path. Each run becomes
-- '[disamarkan]', which is never longer than the run (12+ characters), so the
-- varchar limit holds.
--
-- Scope: edc_transactions.message ONLY. card_type, rrn, invoice_no, batch_no,
-- dispatch_batch_no, masked_pan, amounts, status and updated_at are not
-- touched. The 200-character tail rules and the leftover folds of 0143 are
-- not repeated: they only repair what the old single-separator write path left
-- behind, and the JS read path (maskStoredMessage) still applies them on read.
--
-- Batches: rows are updated 1000 at a time (a statement per batch) until none
-- matches. A masked row holds no digit run any more, so the loop ends and a
-- second run updates nothing (idempotent). The batches share the migration
-- transaction, so this bounds statement size, not the lock; the lock is
-- short-lived like 0143's (lock_timeout 5s, fail fast and roll back).
--
-- One statement on purpose: the NO FORCE, the loop and the FORCE run inside one
-- DO block, so they commit or fail together even when the file is run
-- statement by statement in autocommit. A failure can never leave FORCE ROW
-- LEVEL SECURITY off.
--
-- RLS: edc_transactions is FORCE RLS and the migration role is a non-super
-- table owner without tenant context, so FORCE is lifted for the UPDATE and
-- restored right after (precedent: 0096, 0135, 0143). Policies are not touched.
-- Runbook: docs/runbooks/edc-pan-scrub.md.
DO $backfill$
DECLARE
  prior_lock_timeout text := current_setting('lock_timeout');
  batch_rows integer;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;

  LOOP
    UPDATE "edc_transactions" SET
      "message" = regexp_replace(
        "message",
        '[0-9](?:[\t\n\u000b\u000c\r    -     　﻿/_-]*[0-9]){11,}',
        '[disamarkan]',
        'g')
    WHERE "id" IN (
      SELECT "id" FROM "edc_transactions"
      WHERE "message" ~ '[0-9](?:[\t\n\u000b\u000c\r    -     　﻿/_-]*[0-9]){11,}'
      LIMIT 1000);
    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    EXIT WHEN batch_rows = 0;
  END LOOP;

  ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY;

  PERFORM set_config('lock_timeout', prior_lock_timeout, true);
END
$backfill$;
