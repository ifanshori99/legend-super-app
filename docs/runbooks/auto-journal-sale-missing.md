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

## Payouts and QR sales that wait on a parked POS refund (legend-hxpd5)

A payout of a payment intent (`aj:payout:<refundId>`) or a QR pay-first sale
of it subtracts the gateway part a POS refund gave back only once that POS
refund's journal (`aj:order-refund:<refundId>`) is posted. While the POS
refund is parked `AUTO_JOURNAL_SALE_MISSING`, it counts as "can still post",
so a payout that does not fit without it parks retryable
`AUTO_JOURNAL_RECEIPT_PENDING` and the sweep retries it every 10 minutes.
Once the sale posts (by replay, or by hand plus the step above) the refund
posts and the next sweep posts the payout.

If the sale will never post (finance decided to leave it), those payouts keep
retrying with `AUTO_JOURNAL_RECEIPT_PENDING` and a growing `attempts`. Find
them with:

```sql
SELECT idempotency_key, event_name, error_code, attempts, last_failed_at
  FROM auto_journal_parked
 WHERE tenant_id = :tenant_id
   AND error_code = 'AUTO_JOURNAL_RECEIPT_PENDING'
   AND attempts > 20
 ORDER BY first_failed_at;
```

and resolve them together with the parked sale (manual journal for the sale
or the payout). Nothing is posted wrongly while they wait.

## Release step: voids of QRIS sales (legend-x1i1h)

Before legend-x1i1h every void of a sale with a gateway tender (QRIS, VA,
e-wallet, card) parked `AUTO_JOURNAL_VOID_UNSUPPORTED`, non-retryable. Now a
gateway tender paid by a payment intent whose receipt journal is posted is
supported: the void reverses the sale and its gateway part goes back to
`customer_deposit`. A refund of that intent approved meanwhile (the refund
guard already freed the voided sale) parked `POSTING_AMOUNTS_MISMATCH`. Run
these steps once per tenant after the deploy, in order.

1. Find the void rows that can now post (gateway tender with an intent):

```sql
SELECT p.idempotency_key, p.payload->>'orderId' AS order_id, p.attempts
  FROM auto_journal_parked p
  JOIN pos_order_voids v
    ON v.tenant_id = p.tenant_id AND v.id = (p.payload->>'voidId')::uuid
 WHERE p.tenant_id = :tenant_id
   AND p.event_name = 'order.voided'
   AND p.error_code = 'AUTO_JOURNAL_VOID_UNSUPPORTED'
   AND EXISTS (
     SELECT 1 FROM pos_order_tenders t
      WHERE t.tenant_id = p.tenant_id AND t.order_id = v.order_id
        AND t.status = 'captured'
        AND t.method IN ('qris', 'va', 'ewallet', 'card')
        AND t.payment_intent_id IS NOT NULL)
 ORDER BY p.first_failed_at;
```

2. Re-queue them (same filter), then let the next sweep run:

```sql
UPDATE auto_journal_parked p
   SET retryable = true, next_retry_at = now()
  FROM pos_order_voids v
 WHERE p.tenant_id = :tenant_id
   AND v.tenant_id = p.tenant_id AND v.id = (p.payload->>'voidId')::uuid
   AND p.event_name = 'order.voided'
   AND p.error_code = 'AUTO_JOURNAL_VOID_UNSUPPORTED'
   AND EXISTS (
     SELECT 1 FROM pos_order_tenders t
      WHERE t.tenant_id = p.tenant_id AND t.order_id = v.order_id
        AND t.status = 'captured'
        AND t.method IN ('qris', 'va', 'ewallet', 'card')
        AND t.payment_intent_id IS NOT NULL);
```

3. Re-queue the payouts of those intents parked `POSTING_AMOUNTS_MISMATCH`.
   The payout payload carries `paymentIntentId`:

```sql
UPDATE auto_journal_parked p
   SET retryable = true, next_retry_at = now()
 WHERE p.tenant_id = :tenant_id
   AND p.event_name = 'payment.refunded'
   AND p.error_code = 'POSTING_AMOUNTS_MISMATCH'
   AND (p.payload->>'paymentIntentId')::uuid IN (
     SELECT t.payment_intent_id
       FROM pos_order_tenders t
       JOIN pos_order_voids v
         ON v.tenant_id = t.tenant_id AND v.order_id = t.order_id
      WHERE t.tenant_id = :tenant_id
        AND t.status = 'captured'
        AND t.payment_intent_id IS NOT NULL);
```

Steps 2 and 3 may run in the same transaction: a payout swept before its void
sees the void as "can still post" and parks retryable
`AUTO_JOURNAL_RECEIPT_PENDING`; a later sweep posts it.

Expected re-parks (attempts +1, not an error):

- a void whose sale also holds EDC or points money, or a gateway tender whose
  intent receipt is not posted, parks `AUTO_JOURNAL_VOID_UNSUPPORTED` again;
- a payout that still does not fit the receipt (or whose void re-parked) parks
  `POSTING_AMOUNTS_MISMATCH` again and needs a finance decision.

## Warnings

- Never run the UPDATE without `tenant_id` and `payload->>'orderId'`. Rows of
  other tenants or other orders must not change.
- Only rows with `error_code = 'AUTO_JOURNAL_SALE_MISSING'` are safe to
  re-queue this way. `AUTO_JOURNAL_VOID_UNSUPPORTED` rows are re-queued only
  by the one-time release step above (legend-x1i1h). Outside it, leave them:
  a void of a sale with EDC or points money, or gateway money without a posted
  intent receipt, is parked on purpose and retrying changes nothing.
- Run it inside a transaction as the application role with the tenant context
  set (row level security applies), and check the row count before commit.
