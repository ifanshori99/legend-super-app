# WS-03 wave 3 P5: real VA on the QR guest web (legend-3160, VA only)

Worktree `.worktrees/ws03-pay`, branch `ws/ws03-pay`. Do NOT commit; the engineer commits.
Rules from `docs/briefs/sub-ws03-w3.md` ("Rules for every slice") apply. UI follows `~/.agents/team/ui-standard.md`.

## Contract (P4, already in the tree)
`packages/shared/src/qr-order/guest.ts` payment section:
- `GUEST_PAYMENT_METHODS = ["qris","va"]`.
- `createGuestPayment` input: `bankCode` required for `va`, none for `qris`.
- `guestPaymentSchema`: `vaNumber`, `bankCode`, `bankName` (non-null only for `va`), `expiresAt`.
- `getGuestPaymentOptions` GET `/api/table-sessions/:sessionId/payment-options`: per method `enabled`, `unavailableReason`, `banks` (provider channels for `va`).
Do not edit the contract or anything under `apps/api`. A gap: stop and report.

## Own
- `apps/web/src/features/ws03-qr-order/components/cart/online-pay-page.tsx`, `checkout-page.tsx` (VA routing only), `payment-methods.tsx` (VA availability from payment options).
- `apps/web/src/features/ws03-qr-order/api.ts`, `hooks.ts` (payment options query, create VA with bankCode, poll payment).
- `apps/web/src/features/ws03-qr-order/mock-engine.ts`, `mock.ts`, `apps/web/src/lib/mock/ws03/engine.ts`: guest payment returns VA fields; mock payment options with a few banks; `va` create returns a deterministic VA number.
- `apps/web/src/routes/_customer/t.$token.bayar.$orderId.tsx`.
- qr-glass i18n keys under `packages/shared/src/i18n/messages/qr-glass-pay.ts` / `qr-glass-checkout.ts` (id + en).
- e2e mock specs touching VA (`apps/web/e2e/*.mock.spec.ts`, never `e2e/acceptance/` or `e2e/visual/`).

## Do
1. Remove the hard-coded `BANKS` demo list, `demoVaNumber`, `DEMO_WINDOW_MS` and the `!API_MOCK` "not available" block in `online-pay-page.tsx`.
2. Bank list from `getGuestPaymentOptions` (`va.banks`). VA disabled (`enabled:false`): show the unavailable state with the reason and a way back to checkout (QRIS or kasir).
3. Guest picks a bank, then `createGuestPayment({target:{kind:"order",orderId}, method:"va", bankCode, idempotencyKey})`. Same idempotency key for the same order+bank (repeat taps, refresh); a new key when the bank changes.
4. Show the real `vaNumber` (grouped by 4, copy button), `bankName`, amount from the order total, countdown to `expiresAt`. Poll `getGuestPayment` until `paid` (then `PaymentSuccess` with method `va`) or `expired`/`failed` (offer "buat VA baru").
5. "Ganti bank" returns to the bank list; the server supersedes the old VA.
6. Loading, error (network, 409, 422) and empty bank list states, mobile first.

## Verify
- `eslint` on touched files.
- `heavy pnpm --filter @starter/web typecheck`.
- `heavy pnpm test:e2e:mock <VA + checkout mock specs>`; add one mock spec step: pick VA, pick bank, see VA number, mock pays, success screen.
- Result max 12 lines: files, tests + counts, anything left.
