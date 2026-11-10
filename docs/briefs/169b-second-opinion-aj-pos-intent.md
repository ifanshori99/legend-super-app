# Brief 169b: second opinion, POS intent sale check + settlement provider allow-list + fire guard (legend-6bq2, legend-x9w2)

Role: second-opinion (Codex). Tier K (money, journals). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/aj-pos-intent`, branch `ws/aj-pos-intent`.
- Diff range: `6cc87dab..da059c28` (6cc87dab = tip of `ws/aj-qr-sale`, reviewed in brief 164).
- Design (read first): `docs/design/auto-journals.md` §1 (QR sale, intent backing), §4 (settlement emitter contract), §10 "QR sale time".

## Runs (each at most 800 non-test lines)

| Run | Files | Lines |
|---|---|---|
| A: POS sale-side check | `apps/api/src/services/accounting-auto-journal-amounts.ts` (POS `order.paid` branch), read `accounting-auto-journal-guards.ts` (`assertSaleWithinReceipt`, `intentBackedAt`, `saleBoundOf`) | ~20 changed, ~400 context |
| B: provider allow-list + fire guard | `packages/shared/src/payment/settlement-events.ts`, `apps/api/src/services/qr-order.service.ts` (`fireQrOrder`), read `qr-order-consumers.ts` | ~40 |

Use `git diff 6cc87dab..da059c28 -- <files>`. Tests (`accounting-auto-journal.test.ts` AJ-POSI-*, AJ-SET-*, `settlement-events.unit.test.ts`,
`qr-order-paid-event.test.ts` QR-PAID-05) may be read for intent.

## Risky spots
- A POS sale paid by a gateway intent tender now asserts the intent's backed sum (earlier sales, forfeits, payouts up to the sale bound, this sale included) stays within the posted receipt credit. Ties: sale earlier than refund; sale vs sale by `orders.id`. Check two intents in one sale, DP plus intent tender, a pending receipt (must stay retryable), delivery order permutations.
- `pos-order.service.ts` was deliberately not changed; say if the check truly needs it.
- `settlement.reconciled.provider` is now `z.enum(["doit", "duitku"])`: any emitter or stored payload with another provider parks as payload invalid.
- `fireQrOrder` UPDATE now also requires `status = 'awaiting_payment'` and throws otherwise; both callers lock the order and check the status first. Check the throw cannot poison a legit redelivery.

## Invariants
- customer_deposit is never debited for money whose credit did not post, nor twice for the same intent money (QR sale, POS tender, DP, forfeit, payout), whatever the delivery order.
- One `order.paid` per QR order; a second fire rolls back.
- Every query is tenant-scoped; no migration, RLS or posting-rule change.

## Output
Per run: findings with severity, file:line, concrete scenario, suggested fix; or "No findings" with what you verified. Write to `docs/briefs/169b-second-opinion-aj-pos-intent.result.md`.
