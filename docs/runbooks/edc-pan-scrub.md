# EDC PAN scrub (migration 0113)

Migration `apps/api/drizzle/0113_edc_pan_scrub.sql` (legend-5gub) masks card
numbers (PAN) left in `edc_transactions` rows written before the provider
response boundary filter (`packages/shared/src/edc`, `ecrResultDetailsSchema`).
New writes never store a card number.

A card-number-like value is 13 or more digits, optionally split by single
spaces or dashes. The regex is `[0-9]([ -]?[0-9]){12,}`.

## What it masks per column

| Column | Action |
|---|---|
| `card_type` | replaced with `UNKNOWN` |
| `rrn`, `invoice_no`, `batch_no`, `dispatch_batch_no` | set to `NULL` |
| `message` | each card-like run replaced with `[disamarkan]` |
| `masked_pan` | bare 13-19 digit number becomes first 6 + `*` + last 4; anything else card-like becomes `NULL` |

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
  count(*) FILTER (WHERE "card_type" ~ '[0-9]([ -]?[0-9]){12,}') AS card_type,
  count(*) FILTER (WHERE "rrn" ~ '[0-9]([ -]?[0-9]){12,}') AS rrn,
  count(*) FILTER (WHERE "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}') AS invoice_no,
  count(*) FILTER (WHERE "batch_no" ~ '[0-9]([ -]?[0-9]){12,}') AS batch_no,
  count(*) FILTER (WHERE "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}') AS dispatch_batch_no,
  count(*) FILTER (WHERE "message" ~ '[0-9]([ -]?[0-9]){12,}') AS message,
  count(*) FILTER (WHERE "masked_pan" ~ '[0-9]([ -]?[0-9]){12,}') AS masked_pan,
  count(*) FILTER (WHERE "card_type" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "rrn" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "invoice_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "dispatch_batch_no" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "message" ~ '[0-9]([ -]?[0-9]){12,}'
    OR "masked_pan" ~ '[0-9]([ -]?[0-9]){12,}') AS any_row
FROM "edc_transactions";

ROLLBACK;
```

Run it with `psql` using the admin connection string from the secret store.
Do not print the connection string.

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
on the table, including outlet POS and EDC traffic.

1. Check the size first:
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

## 3. Verify after

Run the detection query from section 1 again. `any_row` must be `0`, and every
per-column count must be `0`.

## 4. Dev DB result (9 Nov 2026)

The dev database had 54 applied migrations. The `edc_transactions` table did
not exist yet, and there were 0 rows, so nothing needed scrubbing.
