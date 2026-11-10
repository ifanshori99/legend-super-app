-- legend-lg45: scrub the card number tail that the old write path left at the
-- end of 200-character EDC messages. NOT a migration: the migrator does not
-- run this file.
--
-- FALLBACK ONLY. The tail rule now runs inside 0143_edc_pan_scrub_separators.sql
-- (checked on the ORIGINAL message length, before the 0143 chain), so every
-- database and edge node that applies 0143 from this release gets it at boot.
-- Run this file ONLY on a database that applied 0143 BEFORE legend-lg45 (the
-- old 0143 had no tail rule): compare the 0143 hash/created_at in
-- drizzle.__drizzle_migrations with the release and ask the CTO first.
-- GAP: here "exactly 200" can only be checked on the stored value. A row that
-- the old 0143 already shortened (e.g. an earlier '4111  1111  1111  1111'
-- turned into '[disamarkan]') is no longer 200 long, so it cannot be
-- recognised and its tail stays. The edge node image has no apps/api/scripts,
-- so run this from an operator machine that has the repo (psql ... -f).
--
-- Why: before legend-tjwb the write path masked edc_transactions.message with
-- the single-separator pattern `[0-9]([ -]?[0-9]){11,}` and THEN cut it to 200
-- characters. On a message that was exactly 200 long the cut can leave a card
-- number remnant that neither 0143 nor the current write path catches:
--   1. a multi-separator card number cut at the end ('...4111  1111  11',
--      10 digits, under the 12 digit threshold);
--   2. a mask cut after 7+ digits ('...7777777  [disa', the marker is not whole);
--   3. digits 13-15 after a mask ('...[disamarkan] - 111', under the 5 digit
--      after-mask threshold of 0143).
--
-- Rule (the same in packages/shared/src/edc, maskStoredMessage, and in 0143; keep all equal).
-- Applied only to a message whose UTF-16 length is exactly 200 (astral
-- characters count twice, like JS string length). In order:
--   1. the existing chain of 0143 (card number run, digits before a mask,
--      digits after a mask);
--   2. TAIL_AFTER_MASK: '[disamarkan]', a separator run the old pattern could
--      not cross (2+ of space, tab or dash, or a tab), then digits to the end
--      of the message -> '[disamarkan]';
--   3. TAIL_CARD_RUN: a tail run of 7+ digits (spaces, tabs or dashes between)
--      that holds such a separator inside or trailing, optionally followed by a
--      cut prefix of '[disamarkan]', to the end of the message ->
--      '[disamarkan]'. A digit that follows a digit, or a digit and a dot or
--      comma, never starts the run, so 'Rp 50.000  4111  11' stays;
--   4. the result is cut to 200 characters (the replacement can be longer
--      than the run it replaces; the column is varchar(200)).
-- A message that is not exactly 200 long gets only step 1, which 0143 already
-- applied, so it is not touched. Accepted effect: a legitimate short code at
-- the very end of a 200 character message after a mask ('... [disamarkan] - 51')
-- is removed. Residual risk: a cut BEFORE the first wide separator
-- ('...4111 1111', '...41111111') cannot be told from a normal number and
-- stays.
--
-- Only the message column is written, and only on rows whose value changes
-- (updated_at, amount, status and every other column stay as they are). A
-- replacement holds no match for any of the patterns, so a second run
-- updates no row.
--
-- One statement on purpose, like 0143: the NO FORCE, the UPDATE and the FORCE
-- run inside one DO block, so they commit or fail together even without -1.
-- A failure can never leave FORCE ROW LEVEL SECURITY off.
--
-- RLS: edc_transactions is FORCE RLS and the role running this file is a
-- non-super table owner without tenant context, so FORCE is lifted for the
-- UPDATE and restored right after (precedent: 0096, 0135, 0143). Policies are
-- not touched. ALTER TABLE takes an ACCESS EXCLUSIVE lock held until the
-- transaction commits; lock_timeout 5s makes it fail fast and roll back
-- instead of queueing POS/EDC traffic. Run off-hours:
--   psql -1 -v ON_ERROR_STOP=1 -f apps/api/scripts/edc-pan-scrub-tail.sql
-- Runbook: docs/runbooks/edc-pan-scrub.md.
DO $scrub$
DECLARE
  prior_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;

  UPDATE "edc_transactions" AS t SET
    "message" = s.new_message
  FROM (
    SELECT e."id", r4.m AS new_message
    FROM "edc_transactions" e
    CROSS JOIN LATERAL (
      SELECT length(e."message")
        + length(regexp_replace(e."message", '[\u0001-\uffff]', '', 'g')) = 200 AS is_200
    ) w
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN e."message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
          OR e."message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
          OR e."message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}'
          THEN regexp_replace(
            regexp_replace(
              regexp_replace(e."message", '[0-9](?:[ \t-]*[0-9]){11,}', '[disamarkan]', 'g'),
              '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]', '[disamarkan]', 'g'),
            '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}', '[disamarkan]', 'g')
        ELSE e."message" END AS m
    ) r1
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_200
        THEN regexp_replace(r1.m,
          '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9])*[ \t-]*$',
          '[disamarkan]')
        ELSE r1.m END AS m
    ) r2
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_200
        THEN regexp_replace(r2.m,
          '(?<![0-9]|[0-9][.,])[0-9](?=(?:[ \t-]*[0-9]){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*[0-9])*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$',
          '[disamarkan]')
        ELSE r2.m END AS m
    ) r3
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_200 THEN left(r3.m, 200) ELSE r3.m END AS m
    ) r4
    WHERE e."message" IS NOT NULL
  ) s
  WHERE t."id" = s."id"
    AND s.new_message IS DISTINCT FROM t."message";

  ALTER TABLE "edc_transactions" FORCE ROW LEVEL SECURITY;

  PERFORM set_config('lock_timeout', prior_lock_timeout, true);
END
$scrub$;
