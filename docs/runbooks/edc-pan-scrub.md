# EDC PAN scrub (migrations 0135 and 0141)

Two migrations mask card numbers (PAN) left in `edc_transactions` rows written
before the provider response boundary filter (`packages/shared/src/edc`,
`ecrResultDetailsSchema`). New writes never store a card number.

- `apps/api/drizzle/0135_edc_pan_scrub.sql` (legend-5gub) matched digits split
  by one space or dash only. It may already be applied on dev, staging and
  pilot databases, and the migrator never re-runs an applied file, so it is
  kept as it was. **Never run 0135 by hand.**
- `apps/api/drizzle/0141_edc_pan_scrub_separators.sql` (legend-tjwb) is the
  effective scrub. It repeats the work with the wider separator pattern: any
  run of spaces, tabs or dashes between digits (`[ \t-]*`), so
  `4111  1111  1111  1111` or `4111 - 1111-1111 1111` are masked too. On a
  fresh database both run; 0135 masks what it can and 0141 masks the rest.

A card-number-like value is a run of digits with any number of spaces, tabs or
dashes between them (regex `[0-9](?:[ \t-]*[0-9]){N,}`). The write path's
thresholds apply: 13 or more digits in `rrn`, `invoice_no`, `batch_no` and
`dispatch_batch_no` (a 12-digit RRN is legitimate), 12 or more in `card_type`,
`message` and `masked_pan`. Ordinary dotted amounts such as `Rp 1.250.000.000.000`
are not card-like.

## What it masks per column

| Column                                               | Action                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `card_type`                                          | replaced with `UNKNOWN`                                                                                                         |
| `rrn`, `invoice_no`, `batch_no`, `dispatch_batch_no` | set to `NULL`                                                                                                                   |
| `message`                                            | each card-like run replaced with `[disamarkan]`; digits joined to a `[disamarkan]` by spaces, tabs or dashes are folded into it |
| `masked_pan`                                         | a bare 13-19 digit number (with separators) becomes first 6 + `*` + last 4; anything else card-like becomes `NULL`              |

Only rows holding a card-like value are updated. Amount, status,
`completed_at`, `updated_at` and all other columns are unchanged. Replacements
hold no matching run, so a second run matches no row (idempotent).

The folding in 0141 removes what 0135 left behind: 0135 masked only the
single-separator part of a run, so `411111111111 - 1111111` became
`[disamarkan] - 1111111` (7 card digits). Folding errs on the safe side and
cannot be undone: a legitimate number joined to a mask is removed too, for
example `[disamarkan] - 51` (a response code) becomes `[disamarkan]`.

Both migrations run `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`, the update,
then `FORCE ROW LEVEL SECURITY`. 0141 puts these three statements in one
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
  count(*) FILTER (WHERE "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}') AS message,
  count(*) FILTER (WHERE "masked_pan" ~ '[0-9](?:[ \t-]*[0-9]){11,}') AS masked_pan,
  count(*) FILTER (WHERE "card_type" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
    OR "rrn" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "invoice_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "dispatch_batch_no" ~ '[0-9](?:[ \t-]*[0-9]){12,}'
    OR "message" ~ '[0-9](?:[ \t-]*[0-9]){11,}'
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
all pending migrations in one transaction, so 0135 (when pending) and 0141
share one lock window. The lock lasts until the whole batch commits, not only
until 0141 finishes. Both files scan the table, so the batch makes two table
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
   only 0141, in one transaction, with `ON_ERROR_STOP` on:
   ```sh
   psql -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0141_edc_pan_scrub_separators.sql
   ```
   0141 is a superset of 0135, so 0135 is never run by hand. The `DO` block
   keeps FORCE RLS restored on failure, but `--single-transaction` is still
   required so the lock and the rest of the work commit or roll back together.
   A manual run is not recorded in the migrator's journal table, so the next
   deploy runs 0141 again. That second run changes no row, but it takes the
   same `ACCESS EXCLUSIVE` lock and scans the table again: schedule that
   deploy off-hours too.
   The migration sets `lock_timeout` to `5s` inside the block; if you run
   other statements in the same session, set it yourself first:
   ```sql
   SET lock_timeout = '5s';
   ```

## 2a. Edge nodes

Each edge node has its own PostgreSQL. The same migrator migrates it before the
API starts (`apps/api/src/edge/runtime.ts`, lines 11-13), so 0135 and 0141 run
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
was absent, so the dev result proves nothing about this migration. 0141 has not
been re-run on dev yet. Run the detection on the staging and pilot databases
that ran EDC code.

## 5. Merge note

The `when` timestamp of 0141 in the drizzle journal must stay above every
migration already applied on dev, staging or pilot. If it sorts below one of
them, the migrator skips it on that database.

If the merge train renumbers 0141 (another branch also adds a 0141), regenerate
it with a new `when` above the other branch's and update the file name in
`apps/api/src/test/edc-pan-scrub-migration.test.ts`, in this runbook and in the
migration header.
