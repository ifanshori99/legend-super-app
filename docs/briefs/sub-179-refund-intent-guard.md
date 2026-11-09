# Sub-brief 179: refund intent guard (legend-riqu) + order.refunded parkir (legend-ni6o)

Worktree `.worktrees/refund-intent-guard`, cabang `ws/refund-intent-guard` dari milestone/m1 fee69d45. Subagent read-only kecuali disebut. Test: `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree, output ke berkas lalu baca ekornya.

## A. legend-riqu (tingkat K)

Approval refund (`refundableBalance`, payment-refund / payment-admin) tidak membaca `pos_order_tenders`: refund intent I bisa disetujui walau tender POS captured masih memakai I. Tamu dapat uang kembali, pesanan tetap lunas. Target: tolak 409 kode jelas bila saldo intent yang belum dipakai tender/penjualan tidak cukup; hitung di bawah kunci `payment_intents FOR UPDATE` yang sama (`lockIntentsForFact`, dari dp-intent-lock), waktu fakta dari kunci itu (`payment-refund-fact-time.ts`), bukan jam aplikasi sebelum commit (payment-refund.service.ts:~428, pos-order.service.ts:~1182). `assertSaleWithinReceipt` (aj-pos-intent) = guard sisi penjualan.

## B. legend-ni6o (tingkat K)

Consumer auto-journal `order.refunded` (`accounting-auto-journal-amounts.ts` ~:816-834) memposting Cr customer_deposit walau jurnal penjualan `aj:sale:<orderId>` parkir (mis. POSTING_AMOUNTS_MISMATCH). Handler void (`accounting-auto-journal-void.ts:131-139`) sudah punya guard. Target: parkir refund sampai jurnal penjualan posted, dan ulang otomatis saat penjualan diposting. Desain: `docs/design/auto-journals.md` §4, §10.

## Scope

Boleh: `payment-refund*.ts`, `payment-admin.service.ts` bagian refund, `payment-refund-fact-time.ts`, consumer/amounts auto-journal, test. Jangan: `pos-shift.service.ts`, `pos-order.service.ts` (baca saja), `tax.service.ts`, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Test B (ni6o), `apps/api/src/test/accounting-auto-journal.test.ts`, pola F2c/F2d (:3202/:3247) dan F1a/F1b (:2888), helper `makeWorld`, `seedPosOrder`, `seedOutboxEvent`, `markDelivered`, `deliver`, `post`, `sweep`, `parkedOf`, `journalCount`, `balanceOf`, `orderRefunded` (:676)

Perilaku baru (engineer yang mengedit): handler `order.refunded` memeriksa `backingStateOf({kind:"sale", orderId})` seperti void. `pending` → parkir `AUTO_JOURNAL_SALE_PENDING` (retryable, sweep mengulang); `none` → parkir `AUTO_JOURNAL_SALE_MISSING` (non-retryable); posted → posting seperti sekarang.

- N1: `order.paid` belum terkirim → `order.refunded` parkir SALE_PENDING retryable, tanpa jurnal; setelah penjualan diposting + `sweep`, refund terposting, baris parkir hilang.
- N2: penjualan parkir `POSTING_AMOUNTS_MISMATCH` (non-retryable) lalu refund bagian gateway → parkir SALE_MISSING, tidak ada jurnal refund, saldo `customer_deposit` tidak berubah.
- N3: penjualan posted → refund terposting seperti sekarang.
  Test lama (suite F19 :1584 dll.) yang memposting refund tanpa penjualan posted diubah agar penjualan diposting dulu; laporkan yang diubah. N1 dan N2 harus GAGAL di fee69d45; laporkan barisnya.

Catatan untuk test-writer: jangan mengembalikan berkas service di worktree ini untuk menguji kode lama; pakai worktree sementara di scratchpad (`git worktree add --detach <path> <sha>`).

## Test A (riqu), berkas baru `apps/api/src/test/payment-refund-pos-tender-guard.test.ts` (pola dan helper dari `reservation-deposit-refund-guard.test.ts`: test :626 menanam `pos_orders` + `pos_order_tenders` captured, :547 insert `payment_refunds` mentah + `/approve`)

Perilaku baru (engineer yang mengedit): `refundableBalance` mengurangi `posSaleInUse` dari `cap` = jumlah tender POS `captured` yang memakai intent itu, dikurangi bagian gateway yang sudah diretur lewat refund POS (`pos_order_refunds.lines`, metode sama, hanya bila semua tender metode itu di pesanan tersebut memakai intent yang sama). Kode 409 baru `REFUND_INTENT_IN_POS_SALE`.

- R1: intent I lunas Rp100.000 lewat tender POS QRIS captured (`payment_intent_id = I`, intent tanpa `order_id`). Permintaan refund Rp100.000 → 409 `REFUND_INTENT_IN_POS_SALE`, tidak ada baris refund.
- R2: refund pending di I (insert mentah, seolah dibuat sebelum tender) lalu approve → 409 `REFUND_INTENT_IN_POS_SALE`; refund `failed` (`cap_exceeded`); tidak ada payout.
- R3: pesanan itu diretur sebagian lewat refund POS (baris `qris` Rp30.000, boleh insert `pos_order_refunds` mentah) → refund intent Rp30.000 diterima; Rp30.001 → 409 `REFUND_INTENT_IN_POS_SALE`.
- R4: intent tanpa tender POS → perilaku lama.
- R5: daftar refundable payments (endpoint listing di payment-admin) menunjukkan `refundableAmountIdr` tanpa bagian yang dipakai tender.
  R1, R2, R3 (bagian Rp30.001), R5 harus GAGAL di fee69d45: uji kode lama di worktree sementara, jangan mengembalikan berkas service.
