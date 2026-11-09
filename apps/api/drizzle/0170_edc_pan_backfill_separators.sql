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
-- varchar limit holds. Everything is written as \uXXXX escapes: no invisible
-- character sits in this file.
--
-- Scope: edc_transactions.message ONLY, and only rows that hold such a run.
-- card_type, rrn, invoice_no, batch_no, dispatch_batch_no, masked_pan, amounts,
-- status and updated_at are not touched.
--
-- What a touched row becomes is what the JS read path (maskStoredMessage)
-- makes of it, so the stored value and the read value agree: the wide mask,
-- then the two leftover folds of 0141/0143 (digits left next to a mask by the
-- old single-separator scrub). A row whose ORIGINAL length is exactly 200
-- UTF-16 units (astral characters count twice, like JS `.length`) also gets
-- the two end-of-text rules of 0143 (legend-lg45) and is cut to 200 code
-- points. The read path applies those only to a stored message of exactly 200
-- units, and the wide mask always shortens a row (a run is 13+ characters), so
-- without them here a row would leave the 200 case and a cut card number at its
-- end would show on read. The two tail rules use the same wide class (legend-stetb):
-- a separator the old single-separator pattern could not cross is a run of two or
-- more separators, or one that is not a plain space or dash (tab, line break,
-- NBSP and the other \s characters, slash, underscore). So a card cut at 200 and
-- joined by those ('...4111/1111/11', '[disamarkan]_111') is masked too, and a
-- row of original length 200 is also picked when only such a tail matches (it
-- holds no 12-digit run). Accepted effect at exactly 200 units: a date such as
-- '2026/11/09' at the very end is masked. Rows that match neither are not touched.
--
-- Batches: rows are visited in id order, 1000 per round (keyset on the primary
-- key, every row read once), and only a row that matches is updated. A masked
-- row holds no digit run any more, so a second run updates nothing
-- (idempotent). The rounds share the migration transaction: batching bounds
-- the size of each statement, it does not shorten the lock below.
--
-- One statement on purpose: the NO FORCE, the loop and the FORCE run inside one
-- DO block, so they commit or fail together even when the file is run
-- statement by statement in autocommit. A failure can never leave FORCE ROW
-- LEVEL SECURITY off.
--
-- RLS: edc_transactions is FORCE RLS and the migration role is a non-super
-- table owner without tenant context, so FORCE is lifted for the UPDATE and
-- restored right after (precedent: 0096, 0135, 0143). Policies are not touched.
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock held until the transaction (the
-- whole migrator batch) commits; lock_timeout 5s makes it fail fast and roll
-- back instead of queueing POS/EDC traffic, the same as 0143. Runbook:
-- docs/runbooks/edc-pan-scrub.md.
DO $backfill$
DECLARE
  prior_lock_timeout text := current_setting('lock_timeout');
  last_id uuid := NULL;
  batch_last uuid;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;

  LOOP
    SELECT b."id" INTO batch_last FROM (
      SELECT "id" FROM "edc_transactions"
      WHERE last_id IS NULL OR "id" > last_id
      ORDER BY "id" LIMIT 1000) b
    ORDER BY b."id" DESC LIMIT 1;
    EXIT WHEN batch_last IS NULL;

    UPDATE "edc_transactions" SET
      "message" = CASE
        WHEN length("message")
            + length(regexp_replace("message", '[\u0001-\uffff]', '', 'g')) = 200
          THEN left(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace("message", '[0-9](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9]){11,}', '[disamarkan]', 'g'),
                    '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]', '[disamarkan]', 'g'),
                  '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}', '[disamarkan]', 'g'),
                '\[disamarkan\](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]{2,}|[\t\n\u000b\u000c\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_])[0-9](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9])*[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*$', '[disamarkan]'),
              '(?<![0-9]|[0-9][.,])[0-9](?=(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9]){6})(?=[0-9\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*?(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]{2,}|[\t\n\u000b\u000c\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_]))(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9])*[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$', '[disamarkan]'),
            200)
        ELSE regexp_replace(
          regexp_replace(
            regexp_replace("message", '[0-9](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9]){11,}', '[disamarkan]', 'g'),
            '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]', '[disamarkan]', 'g'),
          '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}', '[disamarkan]', 'g')
      END
    WHERE (last_id IS NULL OR "id" > last_id)
      AND "id" <= batch_last
      AND ("message" ~ '[0-9](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9]){11,}'
        OR (length("message")
              + length(regexp_replace("message", '[\u0001-\uffff]', '', 'g')) = 200
            AND ("message" ~ '\[disamarkan\](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]{2,}|[\t\n\u000b\u000c\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_])[0-9](?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9])*[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*$'
              OR "message" ~ '(?<![0-9]|[0-9][.,])[0-9](?=(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9]){6})(?=[0-9\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*?(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]{2,}|[\t\n\u000b\u000c\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_]))(?:[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*[0-9])*[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/_-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$')));

    last_id := batch_last;
  END LOOP;

  ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY;

  PERFORM set_config('lock_timeout', prior_lock_timeout, true);
END
$backfill$;
