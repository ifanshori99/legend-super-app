# Brief Codex 256c: second opinion, promo min_spend sebelum pajak (legend-u5tkd)

Tingkat K (uang). Effort xhigh. Read-only review; jangan edit. Jangan dijalankan oleh engineer; dijalankan CTO sebelum gerbang rilis.

Repo: `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/promo-minspend-pretax` (commit 4e9f3e7b, 9900fff9, di atas b1c694bb).

## Keputusan founder Q53

Minimum belanja promo dihitung dari harga sebelum pajak dan service, juga di outlet harga-termasuk-pajak (inclusive). Exclusive tidak berubah.

## Desain

- `OrderPromoInput.minSpendSubtotalIdr?` (opsional): tagihan pra-promo, sebelum pajak+service. Diisi hanya oleh `qr-order.service.ts` (`promoMinSpendBasis`: `calculateTax` dengan diskon 0 lalu `orderNetSubtotalIdr`) bila semua aturan inclusive. Kosong = basis `subtotalIdr` (perilaku lama).
- `subtotalIdr` gross tetap untuk diskon, `paidIdr`, laporan revenue. Hanya kondisi `min_spend`, `sameDaySpendIdr` (`crm-promo-minspend.ts`) dan evaluasi ulang refund (`crm-promo-refund.ts`) memakai basis baru.
- Tanpa migrasi: basis disimpan di jsonb `promotion_order_applications.result.minSpendSubtotalIdr`. Baris lama tanpa field memakai `subtotal_idr`.
- Same-day: per aplikasi floor(basis x (subtotal - refunded) / subtotal). Refund recheck: floor(basis x kept / subtotal).

## Pertanyaan

1. Quote dan redeem selalu memberi basis yang sama (fingerprint redeem, retry/replay)? Ada jalur yang menghitung basis dari input berbeda?
2. Keranjang campuran (sebagian aturan inclusive, sebagian exclusive): fallback ke gross benar atau terlalu longgar?
3. Pembulatan: floor proporsional pada refund dan same-day; bisa melewati ambang karena satu rupiah? Menyimpang dari pembulatan `calculateTax` (inclusive base rounding)?
4. Baris lama tanpa field + outlet yang berganti inclusive/exclusive di tengah hari: same-day menjumlah dua basis berbeda; wajar?
5. Ada pemakai port promo yang terlewat (POS, `/evaluate`, jalur lain) yang di outlet inclusive masih memakai gross?
6. Zod strict `promotionApplicationResultSchema`: data lama tetap lolos parse? Replay hasil lama?
7. Konsistensi dengan min spend zona QR (v9fh b1c694bb) dan tampilan web.

## Berkas

`apps/api/src/services/{qr-order.service,crm-promo-engine,crm-promo-minspend,crm-promo-refund,order-promo,order-promo-port,crm-promo.service}.ts`, `packages/shared/src/crm/promo.ts`, `packages/shared/src/tax/{calculate,net-subtotal}.ts`, tes `apps/api/src/test/{crm-promo-minspend-pretax-db,qr-order-api}.test.ts`.
Jalankan tes: `heavy bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/crm-promo-minspend-pretax-db.test.ts" pnpm test'` (path relatif ke apps/api).

## Keluaran

Temuan bernomor: tingkat (K/S), file:baris, skenario gagal konkret, usulan perbaikan. Tidak ada temuan: katakan eksplisit.
