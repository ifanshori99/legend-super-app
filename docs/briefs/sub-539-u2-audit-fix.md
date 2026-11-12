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

# Architect money review (12 Nov) — rules same as above; founder rule: no party paid more, outlet never loses; when unsure, limit payment

## E — owner I1 (`features/ws04-pos-correction/**`, `pos-correction.ts`)
1. `hooks.ts:53,188-205`, `components/refund-form.tsx:60`: refund idempotency key is derived from form content. Timeout/5xx after the server recorded it, cashier edits the note, resubmits, gets a second refund (server ceiling `apps/api/src/services/pos-order-corrections.ts:896` only caps at total paid). Fix: on failure with status 0/408/409/>=500 (reuse `chargeFailureKind` from `features/ws04-pos-order-detail` if it fits, else a local equivalent) treat the result as UNCERTAIN: keep the same idempotency key for any resend even if the form changed, lock the form, call `refreshOrder`, show a notice "Hasil refund belum pasti. Cek riwayat refund sebelum mengajukan lagi." (catalog key). Only a definite 4xx rejection unlocks a new key.
2. `hooks.ts:140-158` discount: same pattern (server sums discounts, `pos-order-discounts.ts:135`); also `refreshOrder` in `onError` so `existingIdr` updates.
Export the pure key/uncertainty helper (e.g. `correctionFailureKind(status)` + `nextIdempotencyKey(prev, failureKind)`) from `correction-logic.ts` so tests can cover it; put its signature in your report.

## F — owner I5 (ws04-pos-kasir shift/supervisor + `shift-extra-*.ts`, `pos-kasir-supervisor.ts`)
1. `shift-extra-logic.ts:25`, `shift-extra-api.ts:71`, `components/supervisor/held-cash-out-gate.tsx:137`: "Selisih buku" = physical variance + held cash-out (-20.000 + 200.000 = +180.000 shown as surplus). The API drops held cash-out at close and books physical variance + held correction (`apps/api/src/services/pos-shift.service.ts:1401-1404` — read it). Fix: the number shown as booked must equal what the API books; label held cash-out as "Kedaluwarsa, tidak dibukukan" (catalog key). Rename/adjust `bookVarianceIdr` to mirror the API formula exactly; put its new signature + formula in your report. If the API needs `heldCorrectionIdr` that the contract lacks, take 0 and add a CONTRACT-GAPS.md entry.

## G — owner I4 (`components/payment/**`, `api.ts`, `pos-kasir-payment.ts`)
1. `components/payment/dp-lunas-panel.tsx:105` + `api.ts:393`: if `completePosOrder` fails (e.g. CONFLICT, items held), the cashier sees only "cetak gagal" and can press "Lewati" with the order still `awaiting_payment`. Fix: distinct error for complete-failed vs print-failed (catalog keys); hide "Lewati" until the order is completed.

## H — owner I6 (`features/ws05-payment-admin/**`)
1. `refund-actions.ts:69`: `maybeSent` ignores `payoutPendingPolls` (not in `RefundView`); release/reopen can show while API returns 409 `REFUND_PAYOUT_MAYBE_SENT`. Check the API refund response/guard for that field (`apps/api/src/services/*refund*`, `packages/shared/src/payment/admin.ts`). If the response carries it, add it to the view and to `maybeSent` (>0 → maybe sent). If not, note a contract gap; and on 409 `REFUND_PAYOUT_MAYBE_SENT` show a clear message and hide release/reopen.

## T2 — test-writer, `tests/ws04-pos-extra-logic.test.mjs` (add, don't rewrite)
Add tests (read the source for signatures; E/F change some — read after they land, or write against the spec above and note it): `refundableIdr`, `refundAmountIssue` (never allows over total paid), `chargeFailureKind` (409 and 5xx = uncertain), `displayBalance` (never above total, never negative), `bookVarianceIdr` (equals API formula `pos-shift.service.ts:1401-1404`; held cash-out not added), `percentDiscountIdr` (floor), `discountNeedsApproval` (cumulative manual discount), correction idempotency key stays the same after an uncertain failure (E's helper), `sessionFromOrder` with DP and `printReceipt` completes the order only when remaining = 0 (if importable without DOM; else skip and say why). Run nothing; report test names and which ones are expected to fail before E/F land.

# Mockup compare (impeccable-finish-reviewer, 12 Nov) — rules as at the top. Screenshots: `design/screenshots/pos-u2/<screen>-<state>-light-{1280,390}.png`; mockups in main checkout `design/mockups/pos/pos-extra-<card>-*.png` + `.html` (copy source).

## P — owner I7 (`features/ws01-approvals/**`, `ws01-approvals.ts` add keys only)
1. `persetujuan-normal` 1280: table clips the Status/action column at the right edge → no clip at 1280 (and no horizontal page scroll at 390).
2. Mock: make the `cash_shift_close` request the newest/first so the inbox opens on it (mockup 6om3 focus: "Tutup shift kasir", "Selisih kas", action "Tinjau permintaan"); its card/row shows the variance (approver only) and a visible review action.
3. `persetujuan-peminta`: requester view showed another user's request with disabled Tolak/Setujui. No dead buttons: when the viewer cannot approve, hide Tolak/Setujui (show status text instead). If a "Permintaan saya" filter/tab exists, the requester demo should land on their own request.
4. Keep existing empty/error copy of the shared inbox (other screens use it); just report the copy difference.

## D2 — owner I3 (`features/ws04-display/**`, `pos-display.ts` add keys only)
1. `display-success` 1280: confirmation sits below the fold under "Rincian tagihan". Mockup `pos-extra-5w6-display-success-*`: right pane leads with "Terima kasih", big paid amount, payment line. Put the confirmation at the top of the right pane (keep bill details below/left as mockup).

## R — owner I6 (`features/ws05-payment-admin/**`, `ws05-refund-followup.ts` add keys only). Keep the dialog form (page-per-state is a founder question); add what the mockups `pos-extra-kfkt-*`, `pos-extra-hn5q-*` show:
1. failed: primary "Ajukan refund baru" (link to the order's correction refund `/pos/pesanan/$orderId/koreksi?mode=refund` if orderId is known, else hide) + "Kembali ke daftar refund" (closes dialog).
2. rejected: primary "Lihat pesanan" (`/pos/pesanan/$orderId`) + "Kembali ke daftar refund".
3. karantina: "Tinjau pelepasan" is the primary (solid); add "Jejak pemeriksaan" (show the audit trail section already in view data, or scroll to it) and "Lihat transaksi" (link if a route exists, else omit and report).
4. dilepas (after release success): the dialog shows a "Karantina dilepas" success state with trail + "Lihat semua refund", not the failed state with a toast.
5. buka-ulang: no dialog stacked on dialog — confirm inside the same dialog (step) instead.
No dead buttons; money buttons keep pending/idempotency guards.

## K — owner I1 (`features/ws04-pos-correction/**`, `pos-correction.ts` add keys only)
1. At 390 the sticky footer (two stacked buttons, ~200px) hides the form fields on first view. Make the footer inline/compact at 390 (buttons side by side or footer not sticky on small screens) so the first field is visible.
2. Refund notice: mockup headline "Item gagal setelah dibayar" — use the mockup copy as the notice title, keep the server-limit sentence as body (money safety).
6. buka-ulang: the dialog never shows the `reopen.heading` copy from the mockup ("Kembalikan refund untuk ditinjau"); show it as the heading of the reopen step.
