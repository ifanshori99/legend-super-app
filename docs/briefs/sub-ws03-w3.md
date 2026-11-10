# WS-03 wave 3 slices (CTO decisions 9 Nov)

Worktree: `.worktrees/ws03-pay`, branch `ws/ws03-pay` (from ws/ws03-menu d06b163c). Do NOT commit; the engineer commits.
Card text: `bd show legend-<id>`. Earlier context: `docs/briefs/sub-ws03-slices.md`, `docs/briefs/sub-ws03-w2.md`.

## Rules for every slice

- Edit ONLY the files your slice owns. Need another file: stop and report.
- Payments for QR guests: online QRIS + VA (DOIT) only; at cashier cash, EDC, QRIS. No bank transfer, no online card, no e-wallet option (e-wallet pays through QRIS).
- Migration: only P3 may add one (next number 0088 in `apps/api/drizzle`, `pnpm db:generate`; FKs into FORCE-RLS tables need the 0068 NO FORCE/FORCE lift).
- Tests: targeted `LEGEND_TEST_FILES="src/test/a.test.ts src/test/b.test.ts" pnpm test` from worktree root, NO heavy. Typecheck web/api: `heavy pnpm --filter <pkg> typecheck` once at the end. Never full suite or `pnpm check`. Never kill other processes.
- Result max 12 lines: files, tests + counts, anything left.

## P1 remove e-wallet from QR checkout (CTO decision 2)

Own: `apps/web/src/features/ws03-qr-order/components/cart/*` (payment method list, checkout, online pay, success), `apps/web/src/routes/_customer/t.$token.bayar.$orderId.tsx`, qr-glass i18n keys for e-wallet, `apps/web/src/features/ws03-qr-order/mock-engine.ts` e-wallet branch, e2e `*.mock.spec.ts` steps that pick e-wallet (never `e2e/acceptance/` or `e2e/visual/`: report instead), shared contract enum value only if the QR guest payment method enum offers e-wallet (`packages/shared/src/qr-order/guest.ts`: report before editing).

- Online methods offered: QRIS, VA, "Bayar di kasir". QRIS copy may say e-wallet apps can scan it.
- Verify: eslint touched files, e2e mock specs touching QR checkout via `heavy pnpm test:e2e:mock <specs>`.

## P2 lock secondary-table scan behaviour (CTO decision 3) — test-writer

Own: new `apps/api/src/test/ws03-secondary-scan.test.ts` only.

- Scanning the QR of a secondary table of a multi-table party returns the party session with the PRIMARY table (`session.tableId` = primary table id, scan response table = primary). Assert ordering into it works from the secondary QR and that a non-occupied secondary table does not join. Read `table-session.service.ts` (party join via reservation_tables) and `ws03-table-session.test.ts` for fixtures.

## P3 inclusive-price QR orders (legend-zmc2) — K tier (money + migration), Opus

Own: `apps/api/src/services/qr-order.service.ts` (assertQuotePlaceable + order insert), `qr-order-pricing.ts`, migration 0088 (orders_total_check), `apps/api/src/db/schema/` orders file (check constraint only), `packages/shared/src/qr-order/schemas.ts` (qrOrderSchema total invariant), new `apps/api/src/test/ws03-inclusive-order.test.ts`.

- Store inclusive QR orders exactly as POS stores inclusive orders (find how `pos-order*.ts` persists subtotal/tax/service/total when prices include tax): same columns, same invariants, same rounding. Totals must equal POS for the same lines. Remove `QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED` refusal. Mixed (some inclusive, some exclusive rules) stays refused unless POS supports it.
- Downstream: payment amount, open-bill exposure, receipts/journal consumers read `orders.total_idr`; confirm they stay correct (grep consumers).
- Tests: inclusive single line PB1 10% + service 5% equals POS; exclusive unchanged; mixed refused; pay-first payment amount = total.

## P4 real VA for QR guests — BE + contract (legend-3160 narrowed: VA only) — K tier (payment), Opus

Own: `packages/shared/src/qr-order/guest.ts` (guest payment section ONLY: `GUEST_PAYMENT_METHODS`, `guestPaymentSchema`, start-payment input), `apps/api/src/services/qr-order-payment.ts`, `apps/api/src/routes/qr-order.routes.ts` (payment routes only), new `apps/api/src/test/ws03-guest-va.test.ts`.

- Methods: `["qris","va"]` — drop `ewallet` from the enum (CTO decision 2; P1 removes the UI). Start-payment input takes `bankCode` for VA, validated against the provider's channel list (`channels()`/payment methods endpoint; list exposed to the guest via a GET or inside the session payment options).
- Create VA through the same gateway path QRIS uses (`ensurePaymentLink`/`createPaymentLink` in payment.service.ts with method `va` + channelCode); expiry = existing VA default (180 min) capped by open-bill/session rules; idempotent per order+method+bank; switching method/bank supersedes the old link like QRIS re-issue does.
- Response: `guestPaymentSchema` gains VA fields (`vaNumber`, `bankCode`, `bankName`, `expiresAt`) from the link `instructions`; QRIS unchanged. Paid webhook settles exactly like QRIS (same `handleQrOrderPaymentPaid`).
- DOIT provider is on milestone/m1 (not this branch); code against the gateway interface in this branch (`payment-gateway.ts`); tests use the test gateway. Report any interface gap vs m1 `payment-doit.ts:429 createIntent` (inputs: method, channelCode, amountIdr, idempotencyKey, expiresAt, outletId; bank codes `DOIT_VA_BANKS` payment-doit-wire.ts:72) — read m1 with `git show milestone/m1:<path>`.
- Tests: create VA (bank valid/invalid), idempotent repeat, switch bank supersedes, paid webhook settles order + floor bill, other session's order 404, amount = order total (incl. inclusive orders once P3 lands: just assert `total_idr`).
