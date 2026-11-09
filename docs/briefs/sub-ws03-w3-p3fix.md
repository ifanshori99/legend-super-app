# P3 fix round (legend-zmc2, K tier) after Opus review + architect

Worktree `.worktrees/ws03-pay`. Do NOT commit. Rules from `docs/briefs/sub-ws03-w3.md` apply.
P3 is in commit 2837a486 (+ payment link hunk in 1f898989). Another agent (P5) edits web files under `apps/web/src/features/ws03-qr-order/` and `qr-glass-*` i18n: do not touch those.

## Fix

1. Shared helper, e.g. `orderNetSubtotalIdr({subtotalIdr, serviceChargeIdr, taxIdr, pricesIncludeTax})` in a new file under `packages/shared/src/tax/` or `packages/shared/src/qr-order/` (exported from its barrel): returns subtotal minus service minus tax when inclusive, else subtotal. Use it at:
   - `apps/api/src/services/qr-order-payment.ts` ~171 (replace the inline calculation; edit only that hunk).
   - `apps/api/src/services/pos-order.service.ts` ~1148 (sales journal / `order.paid` amounts), `pos-order-corrections.ts` ~316 (refund split), `pos-order-payment.ts` ~326 (payment link subtotal). These are unreachable today (POS refuses inclusive rules) but must be correct when POS inclusive lands. Read the `orders` row's `pricesIncludeTax` where available; keep behaviour identical for exclusive orders.
2. DB check: inclusive branch of `orders_total_check` also requires `service_charge_idr + tax_idr <= subtotal_idr - discount_idr`. Change it in `apps/api/src/db/schema/qr-order.ts`, then regenerate 0088: remove `apps/api/drizzle/0088_qr_inclusive_orders.sql`, `meta/0088_snapshot.json` and the 0088 entry in `meta/_journal.json`, run `pnpm db:generate --name qr_inclusive_orders` (check `apps/api/package.json` for the exact script), re-add the top SQL comment, confirm a second `pnpm db:generate` produces nothing.
3. One session, one pricing mode: placing an order whose inclusive flag differs from an existing non-voided order in the same table session is refused (409, new code e.g. `QR_ORDER_PRICING_MODE_MIXED`, Indonesian message like the other QR order errors). Put it in `qr-order.service.ts` next to the mixed-cart refusal.

## Tests

Extend `apps/api/src/test/ws03-inclusive-order.test.ts`: helper unit cases (inclusive/exclusive), DB check refuses service+tax > subtotal-discount on raw insert, mixed-mode session refused. Run targeted: `LEGEND_TEST_FILES="src/test/ws03-inclusive-order.test.ts src/test/qr-order-api.test.ts src/test/ws03-guest-va.test.ts" pnpm test` plus any pos-order test files that cover the three POS call sites (grep `src/test/pos-order*`). `heavy pnpm --filter @starter/api typecheck`; `pnpm --filter @starter/shared typecheck` via heavy; eslint touched files.

Result max 12 lines.
