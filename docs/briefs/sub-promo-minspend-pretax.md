# Sub-brief: legend-u5tkd - promo min_spend dan sameDaySpend sebelum pajak (Q53 penuh), tingkat K

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/promo-minspend-pretax` (cabang `ws/promo-minspend-pretax`, dari b1c694bb). `cd` ke sini dulu, cetak `pwd`. Jangan push/merge, JANGAN migrasi (tidak boleh kolom baru). Satu commit per implementer, `git add` berkas spesifik. Jangan `pnpm check`/tsc (induk jalankan sekali lewat heavy).

## Masalah
Engine promo (`apps/api/src/services/crm-promo-engine.ts`) membandingkan `min_spend` dengan `subtotal = sum(lineTotalIdr)` dari pemanggil. Di outlet harga-termasuk-pajak (inclusive) subtotal itu sudah memuat pajak dan service. Keputusan founder Q53: min spend dihitung dari harga SEBELUM pajak dan service, juga di inclusive. Exclusive tidak berubah.

## Desain (wajib diikuti)
Nilai baru opsional `minSpendSubtotalIdr` = tagihan pra-promo (setelah diskon item, sebelum promo), sebelum pajak+service. Hanya diisi pemanggil di outlet inclusive; bila kosong, basis = `subtotalIdr` (perilaku lama, exclusive tidak berubah, POS exclusive, `/evaluate` tanpa konteks pajak).
- `subtotalIdr` (gross) TETAP dipakai untuk diskon, `paidIdr`, laporan revenue. Hanya kondisi `min_spend` dan `sameDaySpendIdr` yang memakai basis baru.
- Tanpa migrasi: simpan nilai itu di jsonb `promotion_order_applications.result` (atau `rulesSnapshot`, pilih yang skemanya mudah ditambah field opsional; skema zod strict harus diperbarui) sebagai `minSpendSubtotalIdr` opsional. Baris lama tanpa field = pakai `subtotalIdr`.
- `sameDaySpendIdr` (crm-promo-minspend.ts ~112-140): per aplikasi, basis = `coalesce(result->>'minSpendSubtotalIdr', subtotal_idr)` dikurangi bagian refund secara proporsional: floor(basis * (subtotal - refundedSubtotal) / subtotal) (subtotal = 0: 0). Tanpa field: persis rumus lama.
- Jalur refund (`crm-promo-refund.ts` ~278, 333, 432, 633) mengevaluasi ulang min_spend atas sisa tagihan `standing = subtotal - refundedSubtotal` (gross): untuk aplikasi yang punya `minSpendSubtotalIdr`, basis yang dibandingkan = floor(minSpendSubtotalIdr * keptSubtotal / subtotal) (proporsional); tanpa field: lama.
- Perbaiki komentar `packages/shared/src/crm/promo.ts:77` dan `crm-promo-minspend.ts:17` agar akurat (basis sebelum pajak dan service di inclusive via `minSpendSubtotalIdr`).

## Pemanggil yang mengisi (potongan Y)
- `apps/api/src/services/qr-order.service.ts`: `promoInput` (~890) dipanggil di ~932 (quote) dan ~1810 (redeem). Di outlet inclusive (`settings.pricesIncludeTax`), hitung pra-promo pra-pajak: `calculateTax` (`packages/shared/src/tax/calculate.ts:285`) dengan `orderDiscountIdr: 0` atas baris yang sama, tarif outlet lewat `loadTaxConfig` (qr-order-pricing.ts ~437), lalu `orderNetSubtotalIdr` (`packages/shared/src/tax/net-subtotal.ts`) atau `tax.baseIdr` (cek mana yang benar, selaraskan dengan pembulatan `qr-order-pricing.ts:786-826` hasil v9fh). Taxconfig dimuat setelah promo di ~934; pindahkan/siapkan sebelum promo tanpa mengubah hasil lain. Quote dan redeem harus memberi nilai yang sama (fingerprint redeem).
- `apps/api/src/services/pos-order-discounts.ts` (~190-215): cek apakah outlet POS bisa inclusive; bila ya isi sama, bila POS tidak punya konsep inclusive, lapor dan biarkan.
- `crm-promo.service.ts` `/evaluate`: tidak ada konteks pajak; biarkan, tambahkan catatan di komentar.
- Tipe: `OrderPromoInput`/`OrderPromoQuote` (`order-promo-port.ts`), `PromoEvaluationInput` (shared crm/promo.ts) dapat field opsional `minSpendSubtotalIdr`; `order-promo.ts` meneruskan.

## Pembagian
- Implementer X (engine): shared `crm/promo.ts`, `order-promo-port.ts`, `order-promo.ts`, `crm-promo-engine.ts`, `crm-promo-minspend.ts`, `crm-promo-refund.ts`, skema result, test engine/minspend/refund di `apps/api/src/test/`.
- Implementer Y (pemanggil): `qr-order.service.ts`, `pos-order-discounts.ts`, test QR inclusive. Y memakai nama field `minSpendSubtotalIdr?: Idr` di `OrderPromoInput` persis; X menambahkannya ke tipe (Y boleh menambahkan tipe sementara bila X belum commit; jangan edit berkas X).

## Test gagal-dulu (jalankan dulu, lihat gagal)
Inclusive: promo min_spend 100.000, keranjang gross 100.000 dengan pajak+service di dalamnya (basis < 100.000) -> TIDAK lolos; gross tepat basis 100.000 pra-pajak -> lolos. Exclusive tidak berubah. sameDaySpend inclusive memakai basis pra-pajak (+ proporsional setelah refund); baris lama tanpa field tidak berubah. Refund inclusive: sisa tagihan dievaluasi dengan basis proporsional. Quote dan redeem konsisten.
`bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="<berkas>" pnpm test'`, sebut jumlah file/tes; eslint + prettier berkas berubah. Lapor SHA, berkas, hasil, risiko.
