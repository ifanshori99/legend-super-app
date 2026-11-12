# sub-539-u2 QRIS hold for DP orders (founder decision 12 Nov)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-extra`. Own files only, no commit, no tsc/dev server. Copy via catalog keys (`packages/shared/src/i18n/messages/pos-display.ts`, add keys only). Do NOT edit `packages/shared/src/pos/schemas.ts` or `endpoints.ts`.

## Rule (money: limit payment)
Customer display (`apps/web/src/features/ws04-display`) must NEVER show a QRIS code for an order with a DP (`depositAppliedIdr > 0`), because the display QRIS is always the full total (contract `customerDisplayStateSchema` forces `qris.amountIdr === totalIdr` and has no deposit field). Show "pay at the cashier" instead, until backend card "QRIS DP" is fixed.

Display contract has no deposit. Source of truth: the order itself, `getPosOrder` (`/api/outlets/:outletId/pos/orders/:orderId`, `posOrderDetailSchema.depositAppliedIdr`), read with `state.orderId` while `state.state === "awaiting_payment"`.

## Pure helper in `ws04-display/lib.ts` (exact signature)
```ts
export type DisplayDeposit = { kind: "known"; depositAppliedIdr: number } | { kind: "loading" } | { kind: "unknown" };
export type DisplayPayMode = "not_paying" | "loading" | "qris" | "pay_at_cashier";
export function displayPayMode(
  state: Pick<CustomerDisplayState, "state" | "qris">,
  deposit: DisplayDeposit,
): DisplayPayMode;
```
- `state.state !== "awaiting_payment"` → `"not_paying"`.
- deposit `known` and `depositAppliedIdr > 0` (or not a finite number) → `"pay_at_cashier"` (even if `qris` is non-null).
- deposit `unknown` (order read failed, orderId null) → `"pay_at_cashier"`.
- deposit `loading` → `"loading"` (never `"qris"`).
- deposit `known` and 0 → `"qris"` if `qris !== null`, else `"loading"`.

## T — test-writer: `tests/ws04-pos-extra-logic.test.mjs` (add a `describe`/tests, don't rewrite)
Use the existing `load("ws04-display/lib.ts")` helper and `display({...})` fixture. Cases: each rule above; property: for every deposit > 0 (1, 50_000, total, total+1, NaN) and every qris (null / present), mode is never `"qris"`; unknown never `"qris"`; loading never `"qris"`; deposit 0 + qris → `"qris"`. Do not run tests; report test names.

## I — implementer
1. Add `displayPayMode` + types to `lib.ts` (above).
2. Hook in `ws04-display` (hooks.ts/queries.ts/api.ts pattern) reading the order deposit: reuse an existing order query from `features/ws04-pos-kasir/queries.ts` if one exists for `getPosOrder`, else add `fetchDisplayOrder` in `ws04-display/api.ts` + query. Enabled only while `awaiting_payment` and `orderId !== null`. Map to `DisplayDeposit` (pending → loading, error/no orderId → unknown).
3. `components/customer-display-screen.tsx`: switch the right pane on `displayPayMode`. `"pay_at_cashier"` → new `QrisStatusPanel` kind `"cashier"` (`qris-status-panel.tsx`; tone neutral/warning, icon e.g. `Store`/`HandCoins`), badge "Bayar di kasir", title "Silakan bayar di kasir", hint "Pesanan ini memakai DP. Kasir akan menghitung sisa yang perlu dibayar." (deposit known) — for unknown use same title, hint "Kasir akan menghitung sisa yang perlu dibayar." Keep it simple: one kind, one hint is fine ("Kasir akan menghitung sisa pembayaran Anda."). NO amount and NO QR on this panel. Also `BillTotals` must not show a "remaining/sisa" from the QRIS amount in this mode (pass `unverified` or a prop so no remaining-to-pay figure from qris is shown). Keep existing error/expired/loading paths for `"qris"`/`"loading"` modes.
4. Mock: `ws04-display/mock.ts` add demo `"awaiting_deposit"` (localStorage `legend-display-mock`), state awaiting_payment with qris present, whose `orderId` resolves in the `getPosOrder` mock (`features/ws04-pos-kasir/mock.ts:60`, engine in that feature) to an order with `depositAppliedIdr > 0`; the default `"awaiting_payment"` demo's orderId must resolve to an order with deposit 0 (check: today `getPosOrder` mock for the display fixture orderId — if it 404s, the default screen would hold QRIS; make it resolve, e.g. a display-only order in the engine/fixtures or a mock override keyed by the display order ids). Read the engine before choosing; smallest change.
5. `scripts/ui-check-pos-u2.mjs`: add state `display-dp` (mock `awaiting_deposit`) expecting text "Silakan bayar di kasir", and NO `img` with the QRIS alt (check how `display-normal` locates the QR) — assert QR absent.
6. Update the `DisplayBalance.depositIdr` comment in `lib.ts` to point at `displayPayMode`.
Report ≤8 lines: files, mock order ids, how deposit is read, anything skipped.
