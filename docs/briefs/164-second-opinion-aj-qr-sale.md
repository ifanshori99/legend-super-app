# Brief 164: second opinion, auto-journal slice 3 QR sale + revenue split + total-0 order.paid (legend-9pz9, legend-kej3, legend-fbms)

Role: second-opinion (Codex). Tier K (money, journals). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/aj-qr-sale`, branch `ws/aj-qr-sale`.
- Diff range: `7822d66e..02b37bf3` (7822d66e = `milestone/m1` a8c90378 + `ws/aj-settlement`, reviewed in briefs 142b and 163).
- Design (read first): `docs/design/auto-journals.md` §1 (revenue split, QR sale, total-0), §6, §8 row 3, §10 "QR sale time".

## Runs (each at most 800 non-test lines)

| Run | Files | Lines |
|---|---|---|
| A: emit + split | `packages/shared/src/pos/events.ts`, `apps/api/src/services/{order-revenue,qr-order-paid}.ts` (new), `pos-order.service.ts`, `qr-order.service.ts` (`fireQrOrder`), `qr-order-consumers.ts` | ~250 |
| B: journal guards | `apps/api/src/services/accounting-auto-journal-{amounts,guards,void}.ts` | ~420 |

Use `git diff 7822d66e..02b37bf3 -- <files>`. Tests (`accounting-auto-journal.test.ts` AJ-QR-*, `qr-order-paid-event.test.ts`,
`order-revenue.unit.test.ts`, `recipe-pos-hpp.test.ts`) may be read for intent.

## Risky spots
- One `order.paid` per QR order across the payment consumer, the deposit-covered placement and replays; emit in the fire transaction; pinned intent.
- Sale time `saleAt` (CASE over `pos_orders.completed_at` / `orders.fired_at`) in `timeOf`, `salesAt`, `sessionDepositAt`, `saleBoundOf`, payout sum, new `assertSaleWithinReceipt` / `intentBackedAt`; ties and microsecond precision.
- `orderRevenueSplit` vs the previous POS gross (inclusive and exclusive); total-0 `order.paid` downstream (recipe deduction, accounting).

## Invariants
- customer_deposit is never debited for money whose credit did not post, nor twice for the same intent money (QR sale, POS tender, DP, forfeit, payout), whatever the delivery order.
- A QR sale journal equals the order row split; DP and gateway parts never overlap.
- An all-zero order.paid books nothing and parks nothing; a full comp still posts discount against sales.
- Every query is tenant-scoped; no migration, RLS or posting-rule change.

## Output
Per run: findings with severity, file:line, concrete scenario, suggested fix; or "No findings" with what you verified. Write to `docs/briefs/164-second-opinion-aj-qr-sale.result.md`.
