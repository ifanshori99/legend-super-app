# Brief 142b: second opinion, fixes of brief 142 findings (legend-9pz9)

Role: second-opinion (Codex). Tier K (money, journals). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/aj-fix142`, branch `ws/aj-fix142`.
- Diff range: `b714f7b6..84218ab4` (b714f7b6 = tip of `ws/dp-late-journal`, already reviewed in brief 142).
- Design (read first): `docs/design/auto-journals.md`, section 10 is new and states the intended rules.
- Your earlier report (findings this diff claims to close): `docs/briefs/142-second-opinion-auto-journals.result.md`.

## Runs (each at most 800 non-test lines; tests may be read for intent, they do not count)

| Run | Files | Lines |
|---|---|---|
| A: guards | `apps/api/src/services/accounting-auto-journal-guards.ts` (new) | ~670 |
| B: facts, consumer, void | `apps/api/src/services/accounting-auto-journal-{amounts,consumer,void}.ts` | ~590 |
| C: reversal extraction | `apps/api/src/services/accounting-journal.service.ts` (`reverseJournalInTransaction`, `reverseJournal`) | ~265 |

Use `git diff b714f7b6..84218ab4 -- <files>`.

## Risky spots
- Backing state of a payout (intent receipt vs fund receipt) and of a void (sale journal): outbox, parked, journal read order.
- Time bounds and ties in `refundsAt`, `forfeitsAt`, `salesAt`, `sessionDepositAt`, `assertPayoutWithinReceipt`, `assertForfeitWithinIntent`.
- Void reversal: idempotency key, replay, late adjustment, fingerprint of manual reversals unchanged.

## Invariants
- customer_deposit is never debited for money whose credit did not post (receipt, fund receipt, order.refunded gateway part).
- DP applied + DP forfeited + DP and intent payouts never exceed what the intent received.
- The same historical facts give the same journals whatever order the events are delivered in.
- A completed-sale void leaves cash and revenue as if the sale had not happened, or parks for finance; it never books money the void did not move.
- Every query is tenant-scoped; no change to RLS, migrations or posting rules.

## Output
Per run: findings with severity, file:line, concrete scenario, suggested fix; or "No findings" with what you verified. Write to `docs/briefs/142b-second-opinion-fix142.result.md`.
