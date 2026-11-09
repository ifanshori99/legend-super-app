# EDC PAN scrub (migration 0135)

Migration `apps/api/drizzle/0135_edc_pan_scrub.sql` (legend-5gub) masks card
numbers (PAN) left in `edc_transactions` rows written before the provider
response boundary filter (`packages/shared/src/edc`, `ecrResultDetailsSchema`).
New writes never store a card number.

A card-number-like value is a run of digits, optionally split by single
spaces or dashes, with the write path's thresholds: 13 or more digits in
`rrn`, `invoice_no`, `batch_no` and `dispatch_batch_no` (regex
`[0-9]([ -]?[0-9]){12,}`; a 12-digit RRN is legitimate), 12 or more in
`card_type`, `message` and `masked_pan` (regex `[0-9]([ -]?[0-9]){11,}`).

## What it masks per column

| Column                                               | Action                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `card_type`                                          | replaced with `UNKNOWN`                                                                        |
| `rrn`, `invoice_no`, `batch_no`, `dispatch_batch_no` | set to `NULL`                                                                                  |
| `message`                                            | each card-like run replaced with `[disamarkan]`                                                |
| `masked_pan`                                         | bare 13-19 digit number becomes first 6 + `*` + last 4; anything else card-like becomes `NULL` |

Only rows holding a card-like value are updated. Amount, status,
`completed_at`, `updated_at` and all other columns are unchanged. The
migration is idempotent: a second run matches no row.

The migration runs `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`, the update,
then `FORCE ROW LEVEL SECURITY`, in one migration transaction. Policies are not
touched.

## 1. Detection (read-only)

Run as a superuser or a role with `BYPASSRLS` (for example the database admin
role). The transaction is read-only and always rolls back.

```sql
BEGIN READ ONLY;

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE "card_type" ~ '[0-9]([ -]?[0-9]){11,}') AS card_type,
  count(*) FILTER (WHERE "rrn" ~ '[0-9]([ -]?[0-9]){12,}') AS rrn,
  count(*) FILTER (WHERE "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}') AS invoice_no,
  count(*) FILTER (WHERE "batch_no" ~ '[0-9]([ -]?[0-9]){12,}') AS batch_no,
  count(*) FILTER (WHERE "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}') AS dispatch_batch_no,
  count(*) FILTER (WHERE "message" ~ '[0-9]([ -]?[0-9]){11,}') AS message,
  count(*) FILTER (WHERE "masked_pan" ~ '[0-9]([ -]?[0-9]){11,}') AS masked_pan,
  count(*) FILTER (WHERE "card_type" ~ '[0-9]([ -]?[0-9]){11,}'
    OR "rrn" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "message" ~ '[0-9]([ -]?[0-9]){11,}'
    OR "masked_pan" ~ '[0-9]([ -]?[0-9]){11,}') AS any_row
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

## 2. Deploy

`ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock on `edc_transactions`. The lock
is held until the migration transaction commits, and it blocks reads and writes
on the table, including outlet POS and EDC traffic. The drizzle migrator runs
all pending migrations in one transaction, so the lock lasts until the whole
batch commits, not only until 0135 finishes. The migration sets
`lock_timeout = '5s'`: if the ALTER cannot get the lock in time, it fails and
the whole batch rolls back. Nothing is half-applied, so retry the deploy
off-hours.

1. Check the size first, in the same superuser or `BYPASSRLS` session as
   section 1 (any other role errors or counts one tenant only):
   ```sql
   SELECT count(*) FROM "edc_transactions";
   ```
2. If the total is large (above about 1M rows), deploy outside outlet operating
   hours, for example 02:00-05:00 WIB.
3. If you run the statements manually instead of through the migrator, set a
   lock timeout in the session so the deploy fails fast instead of queueing
   behind traffic:
   ```sql
   SET lock_timeout = '5s';
   ```

## 2a. Edge nodes

Each edge node has its own PostgreSQL. The same migrator migrates it before the
API starts (`apps/api/src/edge/runtime.ts`, lines 11-13), so 0135 runs on every
edge node too.

1. Run the detection from section 1 before and after the upgrade on every edge
   node, in its own superuser or `BYPASSRLS` session.
2. Schedule edge upgrades outside the outlet's local operating hours
   (WIB, WITA or WIT, depending on the outlet's timezone).

## 2b. Backups and logs

Backups and edge logs from builds before the response filter may still hold
card numbers. This migration does not touch them. Follow the retention policy
for those backups and logs.

## 3. Verify after

Run the detection query from section 1 again. `any_row` must be `0`, and every
per-column count must be `0`.

## 4. Dev DB result (9 Nov 2026)

The dev database had only 54 applied migrations. The `edc_transactions` table
was absent, so the dev result proves nothing about this migration. Run the
detection on the staging and pilot databases that ran EDC code.
