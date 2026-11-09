# Auto-journal parked AUTO_JOURNAL_SALE_MISSING (legend-3bsyh)

A void (`order.voided`, key `aj:sale-void:<orderId>`) or a refund
(`order.refunded`, key `aj:order-refund:<refundId>`) of order X mirrors the sale
journal `aj:sale:X`. If that sale journal is not posted and will not post
(for example the sale itself parked `POSTING_AMOUNTS_MISMATCH`), the void or
refund parks with error code `AUTO_JOURNAL_SALE_MISSING`, `retryable = false`
and `next_retry_at = NULL`. The worker sweep (`retryParkedAutoJournals`) only
picks retryable rows, so it never looks at them.

## Normal recovery (nothing to do by hand)

When `aj:sale:X` posts through the consumer (a replay of `order.paid` after the
data is fixed, or the sweep itself), `settleAutoJournal` marks the parked void
and refund rows of that order in the same transaction: `retryable = true`,
`next_retry_at = now`. The next sweep books them. A replay over a sale that is
already posted (`already_posted`) does the same.

## Symptom

- Finance sees void or refund rows parked with `AUTO_JOURNAL_SALE_MISSING`
  that stay there.
- The sale of the same order has a posted journal (`journal_entries` with
  `idempotency_key = 'aj:sale:<orderId>'`), but the void or refund has none.

## Find the parked rows

Replace `:tenant_id` with the tenant. Always filter by tenant.

```sql
SELECT p.idempotency_key, p.event_name, p.payload->>'orderId' AS order_id,
       p.retryable, p.next_retry_at, p.last_failed_at,
       EXISTS (
         SELECT 1 FROM journal_entries j
          WHERE j.tenant_id = p.tenant_id
            AND j.idempotency_key = 'aj:sale:' || (p.payload->>'orderId')
       ) AS sale_posted
  FROM auto_journal_parked p
 WHERE p.tenant_id = :tenant_id
   AND p.error_code = 'AUTO_JOURNAL_SALE_MISSING'
 ORDER BY p.first_failed_at;
```

Rows with `sale_posted = true` and `retryable = false` are stuck.

## The sale was posted by hand (not through the consumer)

A manual journal never passes through `settleAutoJournal`, so the dependents
are not re-queued. Replaying `order.paid` is not possible when the sale was
booked by hand under a different key. Re-queue the dependents of that one order
directly, then wait for the next sweep (the worker runs it on its own tick;
rows are due as soon as `next_retry_at <= now()`).

```sql
UPDATE auto_journal_parked
   SET retryable = true, next_retry_at = now()
 WHERE tenant_id = :tenant_id
   AND error_code = 'AUTO_JOURNAL_SALE_MISSING'
   AND event_name IN ('order.voided', 'order.refunded')
   AND payload->>'orderId' = :order_id;
```

The sweep rebuilds each event from the stored payload. The consumer finds the
sale through its key `aj:sale:<orderId>`: if your manual journal does not carry
that key the row parks `AUTO_JOURNAL_SALE_MISSING` again (attempts +1) and
needs a finance decision instead of a retry.

## Warnings

- Never run the UPDATE without `tenant_id` and `payload->>'orderId'`. Rows of
  other tenants or other orders must not change.
- Only rows with `error_code = 'AUTO_JOURNAL_SALE_MISSING'` are safe to
  re-queue this way. Do not touch `AUTO_JOURNAL_VOID_UNSUPPORTED` rows: they
  are parked on purpose (the void returns cash only) and retrying changes
  nothing.
- Run it inside a transaction as the application role with the tenant context
  set (row level security applies), and check the row count before commit.
