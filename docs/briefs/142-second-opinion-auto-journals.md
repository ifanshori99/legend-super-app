# Brief 142: second opinion, auto-journals F19 slice 1 (legend-9pz9, legend-o9q9)

Role: second-opinion (Codex). Tier K (money, migration). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/dp-late-journal`, branch `ws/dp-late-journal` (base `milestone/m1`).
- Diff range: `5fc862cb..a9c8ca14` (5fc862cb = design doc only; review the code after it).
- Design (read first, section numbers are referenced in code): `docs/design/auto-journals.md`.
- Not wired yet: consumer registration is the separate patch `docs/briefs/141-auto-journals-wiring.patch` (main checkout), to be applied to `apps/api/src/worker-main.ts` after merge batch 3. Read it to know how events arrive (one delivery handler per outbox row, `apps/api/src/worker-main.ts` ~:115-170; `consumeOutbox` in `apps/api/src/services/core-outbox.ts` marks the row delivered in the same transaction).

## Runs (each at most 800 non-test lines)
Run each as its own pass and report per run. Tests (`apps/api/src/test/accounting-auto-journal.test.ts`, `tests/*.mjs`) may be read for intent; they do not count.

| Run | Files | Lines |
|---|---|---|
| A: contract, schema, migrations, posting path | `packages/shared/src/accounting/{coa,posting-rules,late-adjustment,journal,fixtures,index}.ts`, `packages/shared/src/events/catalog.ts`, `packages/shared/src/payment/index.ts`, `apps/api/src/db/schema/{accounting-auto-journal,accounting,index}.ts`, `apps/api/drizzle/0113_auto_journals.sql`, `apps/api/drizzle/0114_auto_journals_backfill_rls.sql`, `apps/api/src/services/{accounting-journal.service,accounting-shared,payment-support,payment.service}.ts` | ~445 |
| B: amounts and keys | `apps/api/src/services/accounting-auto-journal-amounts.ts` | ~538 |
| C: consumer, parking, sweep, late adjustment | `apps/api/src/services/accounting-auto-journal-consumer.ts` | ~555 |

Use `git diff 5fc862cb..a9c8ca14 -- <files>`.

### Run D: slice 2 (DP applied, DP forfeit, shift close), added 2026-11-09
- Range: `a9c8ca14..226f1155` (slice 2 is 21a289e7 + review fixes 5fc189b5, 226f1155; also contains 9fd84d0d test-only and 42ef352d web label). About 510 non-test lines changed (added + removed), under the 800 cap.
- Files: `apps/api/src/services/accounting-auto-journal-amounts.ts` (depositReceiptOf, orderDepositReceiptOf, forfeit and shift facts), `accounting-auto-journal-consumer.ts`, `pos-order.service.ts` (deposit CONFLICT removed, paidDepositIdr in order.paid), `pos-order-corrections.ts` (void of a DP sale refused), `pos-order-support.ts`, `packages/shared/src/pos/{events,schemas}.ts` (paidDepositIdr, depositAppliedIdr, tender sums), `packages/shared/src/accounting/posting-rules.ts` (forfeit rules with forfeitedGatewayIdr), web label + i18n.
- Extra invariants: DP applied to a sale + DP forfeited + DP refunded never exceed the DP received; a DP is debited from customer_deposit only if its receipt posted; order.paid tenders = total - paidDepositIdr; cash over/short sign (positive = over) and zero books nothing; a completed DP sale cannot be voided; a payment.refunded that takes back DP a completed sale applied parks (judged as of that refund, fund payouts exempt).
- Use `git diff a9c8ca14..226f1155 -- <files>`.

## Risky files
- `accounting-auto-journal-amounts.ts`: `receiptStatesOf` (cutover and ordering guard reading outbox, journals, parked rows), `autoJournalFactOf` (amounts per event), idempotency keys.
- `accounting-auto-journal-consumer.ts`: `deliverAutoJournalEvent`, `settleAutoJournal` (advisory lock, savepoint, park), `retryParkedAutoJournals`, late-adjustment date and audit.
- `payment.service.ts`: two new `payment.funds_unallocated` emissions in the same transaction as the fund insert.
- `0114_auto_journals_backfill_rls.sql`: RLS on `auto_journal_parked`; per-legal-entity backfill of accounts 2107 and 7103 and their mappings.
- `posting-rules.ts`: new and changed rules (`order.paid`, `order.refunded`, `payment.paid`, `payment.refunded`, `payment.funds_unallocated`, `reservation.cancelled`, `reservation.no_show`).

## Invariants to try to break
1. Every posted journal balances (debit = credit), integer IDR, no negative line.
2. One money arrival is booked once: a gateway receipt (`aj:receipt:<intentId>`) or an unallocated-fund receipt (`aj:receipt-fund:<fundId>`), never both, never twice, in any delivery order, retry, dead-letter replay or duplicate event id.
3. `customer_deposit` nets to zero across receipt, sale, refund and payout of the same money; it is never debited for money whose receipt never posts.
4. Idempotency: replaying any event posts nothing more; the journal fingerprint of existing manual and inventory journals is unchanged when `lateAdjustmentFrom` is null.
5. Tenant and outlet isolation: no read or write crosses tenants; `auto_journal_parked` is under tenant and outlet RLS like the other outlet-owned tables.
6. Late adjustment: money received in a closed period posts on the first day after the latest closed period, `late_adjustment_from < entry_date`, with one audit row; never posts into a closed period.
7. Parking: expected accounting failures park and never fail or roll back the outbox delivery; an event that cannot be parked must not be silently consumed.
8. Backfill safety: 0114 never changes an existing tenant account or mapping, never adds a child under a header that is itself used as a posting account, and is safe to run on a database with many legal entities.

## Report
Per run: findings with file:line, severity (High/Medium/Low), a concrete failing scenario, and a suggested fix. Say "no findings" for a run with none. Plain text, at most 600 words per run. Write it to `docs/briefs/142-second-opinion-auto-journals.result.md` in the main checkout.
