-- legend-tjwb: second pass of the EDC card number (PAN) scrub.
--
-- 0135_edc_pan_scrub.sql (legend-5gub) matched digits split by ONE space or
-- dash only, so "4111  1111  1111  1111" or "4111 - 1111-1111 1111" survived in
-- message, rrn, masked_pan and the other columns. 0135 may already be applied
-- on dev, staging and pilot databases and the migrator never re-runs an
-- applied file, so it is left as it was and this migration repeats the scrub
-- with the wider pattern. On a fresh database both run; 0135 masks what it
-- can and this one the rest.
--
-- Card-number-like = a run of digits with any number of spaces, tabs or dashes
-- between them (`[0-9](?:[ \t-]*[0-9]){N,}`), with the write path's thresholds
-- (packages/shared/src/edc): 13+ digits in rrn, invoice_no, batch_no and
-- dispatch_batch_no (a 12-digit RRN is legitimate), 12+ digits in card_type,
-- message and masked_pan. Per column:
--   card_type                         -> 'UNKNOWN'
--   rrn, invoice_no, batch_no,
--   dispatch_batch_no                 -> NULL
--   message                           -> each run replaced by '[disamarkan]';
--                                        then 0135 leftovers are folded in
--                                        (see below)
--   masked_pan                        -> a value that is only 13-19 digits
--                                        and separators becomes first 6 + '*'
--                                        + last 4; anything else card-like
--                                        -> NULL
--
-- 0135 leftovers: 0135 (and the write path before legend-tjwb) masked only
-- the part of a run split by single spaces or dashes, so
-- '411111111111 - 1111111' became '[disamarkan] - 1111111'. Such a leftover is
-- joined to the mask by a separator run the old pattern could not cross
-- (anything but exactly one space or one dash). It is folded into the mask
-- only when it would show more than the receipt rule allows: 7+ digits before
-- the mask (first 6 may show) or 5+ after it (last 4 may show). So
-- '[disamarkan] - 51' (a response code the old write path left after a
-- masked card) and '4111 - [disamarkan]' stay as they are. The fold cannot be
-- undone: a real number of that size joined that way, e.g.
-- '[disamarkan] - 123456' (approval code), is removed for good, since it
-- cannot be told apart from the end of a 17-19 digit card.
--
-- 200-char tail (legend-lg45): the write path before legend-tjwb masked
-- message with the single-separator pattern and THEN cut it to 200 UTF-16
-- units, so a message that was exactly 200 long can end in a cut card number
-- no pattern above sees: '...4111  1111  11' (10 digits), '...7777777  [disa' or
-- '...7777777  [disamarkan' (cut mask), '...[disamarkan] - 111' (3 digits).
-- For a message whose ORIGINAL length is exactly 200 UTF-16 units (astral
-- characters count twice, like JS `.length`) two more rules run after the
-- chain above, each once and anchored at the end of the message:
--   tail after a mask   '[disamarkan]' + a separator run the old pattern could
--                       not cross + digits (any count) up to the end
--   tail card run       7+ digits at the end (separators between them, not
--                       right after `digit.` or `digit,`, so a dotted amount
--                       stays) that contain such a wide separator, inside or
--                       trailing, optionally followed by a cut prefix of
--                       '[disamarkan]'
-- Both become '[disamarkan]', then the result is cut to 200 code points (the
-- replacement can be longer than the run it replaces). The length is checked
-- on the original message, before the chain: the chain can shorten a 200-char
-- row (an earlier '4111  1111  1111  1111' becomes '[disamarkan]'), which
-- would hide the signal. The old write path masked with 0135's exact pattern
-- before cutting, so 0135 never shortens such a row. Rows of any other length
-- are not touched by the tail rules: a 199-char row ending in '4111  1111  11'
-- is a real, uncut value. Accepted effect: a legitimate short code at the very
-- end of a 200-char message after a mask ('... [disamarkan] - 51') is
-- removed. Residual (cannot be told from a normal number): a cut before the
-- first wide separator ('...4111 1111', '...41111111'). The JS read path
-- (packages/shared/src/edc, maskStoredMessage) applies the same rule.
-- apps/api/scripts/edc-pan-scrub-tail.sql is only a fallback for a database
-- that applied this migration before the tail rule existed.
--
-- Only rows that hold a card-number-like run (or a 200-char tail) are
-- updated; every other column (amount, status, completed_at, updated_at, ...)
-- stays as it is. Replacements hold no matching run; outside the tail rule
-- they are never longer than the value they replace, and the tail rule cuts to
-- 200, so varchar limits hold and a second run updates no row.
--
-- One statement on purpose: the NO FORCE, the UPDATE and the FORCE run inside
-- one DO block, so they commit or fail together even when the file is run
-- statement by statement in autocommit (psql without -1). A failure can never
-- leave FORCE ROW LEVEL SECURITY off. Run by the migrator, the block is part of
-- the batch transaction like any other statement.
--
-- RLS: edc_transactions is FORCE RLS and the migration role is a non-super
-- table owner without tenant context, so FORCE is lifted for the UPDATE and
-- restored right after (precedent: 0096, 0135). Policies are not touched.
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock held until the transaction (the
-- whole migrator batch) commits; lock_timeout 5s makes it fail fast and roll
-- back instead of queueing POS/EDC traffic. Runbook:
-- docs/runbooks/edc-pan-scrub.md.
DO $scrub$
DECLARE
  prior_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;

  UPDATE "edc_transactions" SET
    "card_type" = CASE
      WHEN "card_type" ~ '[0-9](?:[ \t-]*[0-9]){11,}' THEN 'UNKNOWN'
      ELSE "card_type" END,
    "rrn" = CASE
      WHEN "rrn" ~ '[0-9](?:[ \t-]*[0-9]){12,}' THEN NULL
      ELSE "rrn" END,
    "invoice_no" = CASE
      WHEN "invoice_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}' THEN NULL
      ELSE "invoice_no" END,
    "batch_no" = CASE
      WHEN "batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}' THEN NULL
      ELSE "batch_no" END,
    "dispatch_batch_no" = CASE
      WHEN "dispatch_batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}' THEN NULL
      ELSE "dispatch_batch_no" END,
    "message" = CASE
      WHEN length("message")
          + length(regexp_replace("message", '[\u0001-\uffff]', '', 'g')) = 200
        AND ("message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
          OR "message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
          OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}'
          OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9])*[ \t-]*$'
          OR "message" ~ '(?<![0-9]|[0-9][.,])[0-9](?=(?:[ \t-]*[0-9]){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*[0-9])*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$')
        THEN left(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace("message", '[0-9](?:[ \t-]*[0-9]){11,}', '[disamarkan]', 'g'),
                  '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]', '[disamarkan]', 'g'),
                '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}', '[disamarkan]', 'g'),
              '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9])*[ \t-]*$', '[disamarkan]'),
            '(?<![0-9]|[0-9][.,])[0-9](?=(?:[ \t-]*[0-9]){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*[0-9])*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$', '[disamarkan]'),
          200)
      WHEN "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
        OR "message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
        OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}'
        THEN regexp_replace(
          regexp_replace(
            regexp_replace("message", '[0-9](?:[ \t-]*[0-9]){11,}', '[disamarkan]', 'g'),
            '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]', '[disamarkan]', 'g'),
          '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}', '[disamarkan]', 'g')
      ELSE "message" END,
    "masked_pan" = CASE
      WHEN "masked_pan" !~ '[0-9](?:[ \t-]*[0-9]){11,}' THEN "masked_pan"
      WHEN "masked_pan" ~ '^[0-9](?:[ \t-]*[0-9]){12,18}$'
        THEN left(regexp_replace("masked_pan", '[^0-9]', '', 'g'), 6)
          || repeat('*', length(regexp_replace("masked_pan", '[^0-9]', '', 'g')) - 10)
          || right(regexp_replace("masked_pan", '[^0-9]', '', 'g'), 4)
      ELSE NULL END
  WHERE "card_type" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
     OR "rrn" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
     OR "invoice_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
     OR "batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
     OR "dispatch_batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
     OR "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
     OR "message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
     OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}'
     OR (length("message")
          + length(regexp_replace("message", '[\u0001-\uffff]', '', 'g')) = 200
         AND ("message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9])*[ \t-]*$'
              OR "message" ~ '(?<![0-9]|[0-9][.,])[0-9](?=(?:[ \t-]*[0-9]){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*[0-9])*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$'))
     OR "masked_pan" ~ '[0-9](?:[ \t-]*[0-9]){11,}';

  ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY;

  PERFORM set_config('lock_timeout', prior_lock_timeout, true);
END
$scrub$;
