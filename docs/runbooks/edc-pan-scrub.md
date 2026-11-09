# EDC PAN scrub (migrations 0135 and 0143, 200-char tail rule)

Two migrations mask card numbers (PAN) left in `edc_transactions` rows written
before the provider response boundary filter (`packages/shared/src/edc`,
`ecrResultDetailsSchema`). New writes never store a card number. 0143 also
carries the tail rule (section 6) for messages cut at 200 characters. A manual
fallback script exists only for a database that applied 0143 before legend-lg45.

- `apps/api/drizzle/0135_edc_pan_scrub.sql` (legend-5gub) matched digits split
  by one space or dash only. It may already be applied on dev, staging and
  pilot databases, and the migrator never re-runs an applied file, so it is
  kept as it was. **Never run 0135 by hand.**
- `apps/api/drizzle/0143_edc_pan_scrub_separators.sql` (legend-tjwb) is the
  effective scrub. It repeats the work with the wider separator pattern: any
  run of spaces, tabs or dashes between digits (`[ \t-]*`), so
  `4111  1111  1111  1111` or `4111 - 1111-1111 1111` are masked too. On a
  fresh database both run; 0135 masks what it can and 0143 masks the rest.

A card-number-like value is a run of digits with any number of spaces, tabs or
dashes between them (regex `[0-9](?:[ \t-]*[0-9]){N,}`). The write path's
thresholds apply: 13 or more digits in `rrn`, `invoice_no`, `batch_no` and
`dispatch_batch_no` (a 12-digit RRN is legitimate), 12 or more in `card_type`,
`message` and `masked_pan`. Ordinary dotted amounts such as `Rp 1.250.000.000.000`
are not card-like.

## What it masks per column

| Column                                               | Action                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `card_type`                                          | replaced with `UNKNOWN`                                                                                            |
| `rrn`, `invoice_no`, `batch_no`, `dispatch_batch_no` | set to `NULL`                                                                                                      |
| `message`                                            | each card-like run replaced with `[disamarkan]`; a 0135 leftover next to a mask is folded into it (below)          |
| `masked_pan`                                         | a bare 13-19 digit number (with separators) becomes first 6 + `*` + last 4; anything else card-like becomes `NULL` |

Only rows holding a card-like value are updated. Amount, status,
`completed_at`, `updated_at` and all other columns are unchanged. Replacements
hold no matching run, so a second run matches no row (idempotent).

0135 (and the write path before legend-tjwb) masked only the part of a run
split by single spaces or dashes, so `411111111111 - 1111111` became
`[disamarkan] - 1111111`: 7 card digits left. 0143 folds such a leftover into
the mask, but only when both hold:

- It is joined to the mask by a separator run the old pattern could not
  cross: anything but exactly one space or one dash (two or more separators,
  or a tab). A digit after a single space would have been masked by the old
  pattern, so it was never part of the card.
- It shows more than the receipt rule allows: 7 or more digits before the
  mask (only the first 6 may show) or 5 or more after it (only the last 4).

So `[disamarkan] - 1111111` and `4111111 - [disamarkan]` become
`[disamarkan]`, while `[disamarkan] - 51` (a response code the old write path
left after a masked card), `[disamarkan] 05`, `[disamarkan] - 1111` and
`4111 - [disamarkan]` stay exactly as they are. The API applies the same rule
when it reads a message, so a leftover is hidden even before 0143 runs.

This cannot be undone. A real number with 5 or more digits after a mask, or 7
or more before it, joined by two or more separators or a tab, is removed for
good: `[disamarkan] - 123456` (an approval code) becomes `[disamarkan]`. It
cannot be told apart from the end of a 17 to 19 digit card.

Both migrations run `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`, the update,
then `FORCE ROW LEVEL SECURITY`. 0143 puts these three statements in one
`DO` block, so FORCE is restored even when the block fails. Policies are not
touched.

## 1. Detection (read-only)

Run as a superuser or a role with `BYPASSRLS` (for example the database admin
role). The transaction is read-only and always rolls back.

```sql
BEGIN READ ONLY;

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE "card_type" ~ '[0-9](?:[ \t-]*[0-9]){11,}') AS card_type,
  count(*) FILTER (WHERE "rrn" ~ '[0-9](?:[ \t-]*[0-9]){12,}') AS rrn,
  count(*) FILTER (WHERE "invoice_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}') AS invoice_no,
  count(*) FILTER (WHERE "batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}') AS batch_no,
  count(*) FILTER (WHERE "dispatch_batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}') AS dispatch_batch_no,
  count(*) FILTER (WHERE "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
    OR "message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
    OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}') AS message,
  count(*) FILTER (WHERE "masked_pan" ~ '[0-9](?:[ \t-]*[0-9]){11,}') AS masked_pan,
  count(*) FILTER (WHERE "card_type" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
    OR "rrn" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "invoice_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "dispatch_batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
    OR "message" ~ '[0-9](?:[ \t-]*[0-9]){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]'
    OR "message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9]){4,}'
    OR "masked_pan" ~ '[0-9](?:[ \t-]*[0-9]){11,}') AS any_row
FROM "edc_transactions";

ROLLBACK;
```

Run it with `psql` using the admin connection string from the secret store.
Do not print the connection string.

If the managed database has no `BYPASSRLS` admin role, run the check as the
owner session instead. `NO FORCE` is allowed inside a transaction, so run the
detection SELECT from above between the ALTER and the ROLLBACK:

```sql
BEGIN;
ALTER TABLE "edc_transactions" NO FORCE ROW LEVEL SECURITY;
-- detection SELECT from above
ROLLBACK;
```

This is not read-only. The ALTER takes the same ACCESS EXCLUSIVE lock as the
deploy, so run it off-hours. The ROLLBACK restores `FORCE ROW LEVEL SECURITY`.

Note: `edc_transactions` is FORCE RLS, so the policies apply even to the table
owner. Run as the owner or the app role without tenant context, the query fails
with `tenant context is required` (0001_tenant_rls.sql). Run with a tenant
context, it counts only that tenant's rows. Only a superuser or `BYPASSRLS`
session counts the whole table, so only that count proves it clean. `ALTER
TABLE ... NO FORCE` is not allowed in a read-only transaction, so it is not
an option here.

### 1a. Tender references (read-only)

Before 0135 the POS EDC tender copied `edc_transactions.rrn` into
`pos_order_tenders.reference` when it held no 13-19 digits in a row, so a
split card number (`4111 1111 1111 1111`) could have been copied there.
Neither migration touches `pos_order_tenders`. In the same superuser or
`BYPASSRLS` session as above:

```sql
BEGIN READ ONLY;
SELECT count(*) AS tender_refs
FROM "pos_order_tenders"
WHERE "reference" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
  AND "reference" !~ '^[A-Z]{1,2}[0-9]{6}-[0-9A-Za-z]{8}$';
ROLLBACK;
```

The second condition skips our own order numbers (`P261109-12345678`). A
non-zero count needs a separate scrub; report it, do not fix it by hand.

## 2. Deploy

`ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock on `edc_transactions`. The lock
is held until the migration transaction commits, and it blocks reads and writes
on the table, including outlet POS and EDC traffic. The drizzle migrator runs
all pending migrations in one transaction, so 0135 (when pending) and 0143
share one lock window. The lock lasts until the whole batch commits, not only
until 0143 finishes. Both files scan the table, so the batch makes two table
scans under one lock. The migration sets `lock_timeout = '5s'`: if the ALTER
cannot get the lock in time, it fails and the whole batch rolls back. Nothing
is half-applied, so retry the deploy off-hours.

1. Check the size first, in the same superuser or `BYPASSRLS` session as
   section 1 (any other role errors or counts one tenant only):
   ```sql
   SELECT count(*) FROM "edc_transactions";
   ```
2. If the total is large (above about 1M rows), deploy outside outlet operating
   hours, for example 02:00-05:00 WIB.
3. If you run the statements manually instead of through the migrator, run
   only 0143, in one transaction, with `ON_ERROR_STOP` on:
   ```sh
   psql -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0143_edc_pan_scrub_separators.sql
   ```
   0143 is a superset of 0135, so 0135 is never run by hand. The `DO` block
   keeps FORCE RLS restored on failure, but `--single-transaction` is still
   required so the lock and the rest of the work commit or roll back together.
   A manual run is not recorded in the migrator's journal table, so the next
   deploy runs 0143 again. That second run changes no row, but it takes the
   same `ACCESS EXCLUSIVE` lock and scans the table again: schedule that
   deploy off-hours too.
   The migration sets `lock_timeout` to `5s` inside the block; if you run
   other statements in the same session, set it yourself first:
   ```sql
   SET lock_timeout = '5s';
   ```

## 2a. Edge nodes

Each edge node has its own PostgreSQL. The same migrator migrates it before the
API starts (`apps/api/src/edge/runtime.ts`, lines 11-13), so 0135 and 0143 run
on every edge node too.

1. Run the detection from section 1 before and after the upgrade on every edge
   node, in its own superuser or `BYPASSRLS` session.
2. Schedule edge upgrades outside the outlet's local operating hours. Edge
   nodes use their own local zone (WIB, WITA or WIT, depending on the outlet's
   timezone), so 02:00-05:00 WIB is not the right window for every node.

## 2b. Backups and logs

Backups and edge logs from builds before the response filter may still hold
card numbers. These migrations do not touch them. Follow the retention policy
for those backups and logs.

## 3. Verify after

Run the detection query from section 1 again. `any_row` must be `0`, and every
per-column count must be `0`.

## 4. Dev DB result (9 Nov 2026)

The dev database had only 54 applied migrations. The `edc_transactions` table
was absent, so the dev result proves nothing about this migration. 0143 has not
been re-run on dev yet. Run the detection on the staging and pilot databases
that ran EDC code.

## 5. Merge note

The `when` timestamp of 0143 in the drizzle journal must stay above every
migration already applied on dev, staging or pilot. If it sorts below one of
them, the migrator skips it on that database.

The merge train renumbered this file from 0141 to 0143 (batch10; the 0141 and 0142 numbers went to edge-access-apply). If it is renumbered again, regenerate
it with a new `when` above the other branch's and update the file name in
`apps/api/src/test/edc-pan-scrub-migration.test.ts`, in this runbook and in the
migration header.

## 6. Tail rule for 200-character messages (legend-lg45)

The tail rule runs inside `0143_edc_pan_scrub_separators.sql`, so the migrator
applies it on every database and every edge node at boot (section 2a). No
manual step is needed for a database that has not applied 0143 yet (0143 is
only on `milestone/m1`, never on `main`).

`apps/api/scripts/edc-pan-scrub-tail.sql` is a manual fallback script, not a
migration: the migrator never runs it. Use it ONLY on a database that applied
0143 before legend-lg45, that is, with the old 0143 that had no tail rule.
Check `drizzle.__drizzle_migrations` (the 0143 `hash` and `created_at`) against
the release that carried legend-lg45, and ask the CTO before running it.

### What it fixes

The old write path masked `message` first and then cut it to 200 characters.
On a message exactly 200 long, the cut can leave a card remnant that neither
the first 0143 nor the API read rule catches:

1. A card with several spaces or dashes between digit groups, cut at the end:
   `…4111  1111  11`. Only 10 digits are left, under the 12 digit threshold.
2. A mask cut after 7 or more digits: `…7777777  [disa` or
   `…7777777  [disamarkan` (only the `]` cut). The marker is not whole, so the
   0143 before-mask rule does not see it.
3. A mask followed by 3 to 4 leftover digits: `…[disamarkan] - 111`, under the
   5 digit after-mask threshold of 0143.

### The rule in plain words

It applies only to a message whose ORIGINAL length is exactly 200 UTF-16 units
(an emoji counts as 2, like JavaScript `text.length`; the SQL counts it twice
too). Any other message is left as it is. The length is checked on the
original message, before the 0143 chain runs, because the chain can shorten a
row (for example an earlier `4111  1111  1111  1111` becomes `[disamarkan]`)
and the 200 signal would be lost. For a 200-long message it does this, in order:

1. The 0143 chain, unchanged.
2. A mask followed at the very end by a wide separator (2 or more of space, tab
   or dash, or a tab) and digits becomes `[disamarkan]`.
3. A run of 7 or more digits at the very end becomes `[disamarkan]`, when it
   holds a separator the old pattern could not cross (2 or more of space, tab
   or dash, or a tab, inside the run or after it). The run may end in a cut
   piece of the marker (`[`, `[disa`, `[disamarka`, `[disamarkan`). A dotted or
   comma amount before it (`Rp 50.000  4111  11`) is not part of the run.
4. The result is cut to 200 characters, because `[disamarkan]` can be longer
   than the run it replaces (column `varchar(200)`).

Only `message` is updated, and only where the new value differs. A second run
changes no row.

The API applies the same rule when it reads a message (`edcTransactionSchema`),
so a remnant is hidden even before the migration runs. The write path does not
apply the tail rule: new writes behave as before, because a new write never
stores a card number. The JS and SQL rules must stay identical.

### Accepted effect

A short real code at the very end of a 200-long message, after a mask, is
removed: `… [disamarkan] - 51` becomes `… [disamarkan]`. It cannot be told
apart from a card remnant. This affects the read path and the stored data
only; new writes are unaffected. Messages shorter than 200 are not touched
(`[disamarkan] - 51` at 199 stays).

### Residual risk

1. A cut BEFORE the first wide separator, for example `…4111 1111` or
   `…41111111` (single separators or none), cannot be told from a normal
   number and stays. Same for a run of 6 digits or fewer.
2. A cut inside a wide separator after 7 digits, leaving a single trailing
   space, for example `… 7777777 `: it looks like a normal number and stays.
3. A run right after `digit,` or `digit.`, for example `…Rp50,4111  1111  11`:
   the lookbehind treats it as part of a dotted or comma amount and skips it.
4. Separators that were never masked, unrelated to the 200 cut: newline, CRLF,
   NBSP, `/` and `_` between digits. The old and new patterns do not cross
   them. These need a separate follow-up bead.

These need a separate decision if they matter.

### Fallback script gap

The fallback script runs the same chain and tail rule, but it can only check
"exactly 200" on the stored value. A row that the OLD 0143 already shortened
(for example an earlier `4111  1111  1111  1111` turned into `[disamarkan]`)
is no longer 200 long, so the script cannot recognise it and its tail stays.
That gap cannot be closed after the fact. It is the reason the rule lives in
0143 itself.

### Detection (read-only)

Run as a superuser or `BYPASSRLS` role, as in section 1. It counts the rows the
tail rule would still change at its two tail steps on the stored message. After
a database runs the new 0143 it must be `0`. (A row that the 0143 chain still
changes is counted by the section 1 query.) The lookbehind `(?<!…)` needs
PostgreSQL 9.6 or newer; the API runs on PostgreSQL 17.

```sql
BEGIN READ ONLY;

SELECT count(*) AS tail_rows
FROM "edc_transactions"
WHERE length("message") + length(regexp_replace("message", '[\u0001-\uffff]', '', 'g')) = 200
  AND ("message" ~ '\[disamarkan\](?:[ \t-]{2,}|\t)[0-9](?:[ \t-]*[0-9])*[ \t-]*$'
    OR "message" ~ '(?<![0-9]|[0-9][.,])[0-9](?=(?:[ \t-]*[0-9]){6})(?=[0-9 \t-]*?(?:[ \t-]{2,}|\t))(?:[ \t-]*[0-9])*[ \t-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$');

ROLLBACK;
```

The same RLS note as section 1 applies: only a superuser or `BYPASSRLS`
session counts the whole table.

### Deploy order

1. Normal path: deploy 0143 (section 2). It carries the tail rule and the
   migrator applies it on every edge node at boot (section 2a). Run the
   detection above before and after.
2. Fallback only, for a database that applied the old 0143: run off-hours.
   Like 0143, the script takes `ACCESS EXCLUSIVE` on `edc_transactions`
   (`NO FORCE` and `FORCE RLS`, `lock_timeout` 5s), so it blocks outlet POS and
   EDC traffic until it commits. Use the owner role, one transaction,
   `ON_ERROR_STOP` on:
   ```sh
   psql -1 -v ON_ERROR_STOP=1 -f apps/api/scripts/edc-pan-scrub-tail.sql
   ```
   The script is idempotent, so a failed run is retried the same way.
3. The edge node image has no `apps/api/scripts` (the Dockerfile copies `dist`
   and `drizzle` only). A fallback run on an edge node is `psql … -f` from an
   operator machine that has the repo and can reach the edge database, outside
   the outlet's local operating hours.

### Verify

Run the detection above again: `tail_rows` must be `0`. Then run the section 1
detection: `any_row` must still be `0`.
