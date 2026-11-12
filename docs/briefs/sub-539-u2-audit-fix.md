# sub-539-u2 audit fix (ui-auditor, 12 Nov)

Rules: same as `docs/briefs/sub-539-u2.md` (own files only, no commit, no tsc/test/dev server; copy via message catalog, add keys only). Report ≤8 lines: files changed, what you did per item, anything skipped + why.

## A — owner I2 (`features/ws04-pos-order-detail/**`)
1. `components/order-detail-screen.tsx:115` `canVoid` also true for `completed` (paid) orders → link lands on a dead-end. Fix: no void link when `completed`; show a "Refund" link to `/pos/pesanan/$orderId/koreksi?mode=refund` instead (copy key in `pos-order-detail.ts`, e.g. "Ajukan refund").
2. Retry buttons get `loading={query.isFetching}`: `order-detail-screen.tsx:92`, `kitchen-notices.tsx:40`, `charge-screen.tsx:205`.
3. `order-detail-screen.tsx:72-111`, `charge-screen.tsx:175-225`: loading/empty/error branches outside `data-density="kontras"` wrapper → lift wrapper to top so all branches are inside.
4. `order-detail-screen.tsx:166` void link: pass `itemId` search param of the line it belongs to (route supports `itemId`) when the link is per line; if it is a general link, leave it.

## B — owner I1 (`features/ws04-pos-correction/**`, `pos-correction.ts`)
1. `components/refund-form.tsx:56,171` `refundedIdr = 0` hard-coded → "Dapat direfund" shows full paid amount. Fix: relabel the line "Maks. sesuai pembayaran" (new key) and keep the existing notice that the server checks earlier refunds. Money rule: never show a number implying more is refundable than is known.
2. `components/correction-screen.tsx:159` voided StateBlock has no action → add back button (same pattern other StateBlocks use in this feature).
3. `components/refund-form.tsx:201` amount input rewrites to `formatRupiah` while typing; deleting last digit can leave "Rp". Fix: keep raw digits in the field (use `parseDigits` from `ws04-pos-kasir/components/shared`), show the formatted amount as helper text beside/below.
4. `components/discount-form.tsx:250` `placeholder="10"` → move into catalog key.

## C — owner I5 (`ws04-pos-kasir` shift/supervisor files, `pos-kasir-shift.ts`, `pos-kasir-supervisor.ts`)
1. `components/supervisor/shift-force-close.tsx:353` permanently `disabled` "Tutup paksa" on witness stage → replace with plain text hint (no dead button), or `aria-disabled` + `aria-describedby`, focusable, no-op onClick.
2. `shift-force-close.tsx:249-253` empty `<p>` when count is 0 and not confirming → render only when `confirmingZero`, with `role="status"`.
3. `components/supervisor/held-cash-out-gate.tsx:204` "Coba lagi" → `loading={held.isFetching}`.
4. `components/shift/blind-count-screen.tsx:63` + `shift-waiting.tsx:67`: "Lihat status" on the limit screen navigates to `/pos/shift` where `ShiftWaiting` renders `ShiftCountLimit` again → one tap must reach the status view (pass a flag / state).
5. `components/shift/shift-device-error.tsx:28-38` panel title repeated as StateBlock title → drop the duplicate.
6. Check: `/pos/shift?demo=shift-sendiri` (seed now holds 3 counts) — does the cashier screen still show "Hitungan kas terkirim" or the limit screen? Report which; if limit screen, say which seed shows "terkirim" (e.g. `kas-kosong`).

## D — owner I6 (`features/ws05-payment-admin/**`)
1. `components/refund-followup-dialog.tsx:210` permanently disabled "retryLocked" button → plain text hint instead of a dead button.
2. `refund-followup-dialog.tsx:49` copies Notice colour classes → use shared `Notice` from `features/ws04-pos-kasir/components/shared` if it fits the dialog, else leave and say why.
3. `refund-followup-dialog.tsx:492` Release ends the refund as failed → `variant="destructive"` (check variant name in `components/ui/button`).
