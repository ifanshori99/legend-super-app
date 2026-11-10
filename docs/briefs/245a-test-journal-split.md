# 245a test-writer: guard payout jurnal split bill QR (legend-05cm9)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/journal-split-guard` (branch `ws/journal-split-guard`). Jangan ubah `apps/api/src/services/*`. Jangan commit. Jangan jalankan suite penuh, jangan `pkill`, jangan `pnpm check`. Hanya `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree.

## Bug
`apps/api/src/services/accounting-auto-journal-guards.ts` `intentBackedAt`, blok `qrSales` (~761-780), hanya menghitung order QR pay-first yang `orders.payment_intent_id = intent` (payer) dengan `total - deposit_applied` penuh. Pada split bill (satu order, satu payment link, beberapa intent yang masing-masing bayar sebagian), payer ditanggung `total - DP` penuh padahal receipt-nya hanya bagiannya, jadi payout jurnal intent payer parkir `POSTING_AMOUNTS_MISMATCH` padahal sah. Intent non-payer tidak dihitung sama sekali (uang yang sudah masuk penjualan tidak ditahan).

## Perilaku yang benar (dipasang oleh engineer, kamu hanya menulis test)
Bagian intent I pada order QR pay-first yang sudah fired (`fired_at` dan tidak ada `pos_orders`) di link yang sama:
- allocation(I) = jumlah `payment_evidence.amount_idr` I dikurangi jumlah `payment_unallocated_funds.amount_idr` I (min 0), hanya intent berstatus paid/partially_refunded/refunded pada link itu;
- bila I adalah payer (`orders.payment_intent_id`) dan tidak ada intent lain di link dengan allocation > 0: bagian = `total - DP` penuh (perilaku lama, single payer);
- selain itu: bagian = `least(total - DP, allocation(I))`.
Jadi: split bill 60k + 50k (due 110k): payer (60k) hanya menahan 60k; non-payer (50k) menahan 50k.

## Catatan
- Jurnal penjualan (order.paid) split bill TIDAK bisa diposting hari ini (`qrSaleGatewayOf` di accounting-auto-journal-amounts.ts menolak intent payer yang `amount_idr < total-DP`; kartu terpisah). Jadi JANGAN mengirim order.paid split. Seed baris `orders` fired (guard membaca tabel `orders`, bukan jurnal sale), kirim payment.paid (receipt) tiap intent lewat `deliver`, lalu kirim payment.refunded (payout) yang diuji.
- Satu order QR pay_first, satu payment link, dua intent di link itu: P (payer, `orders.payment_intent_id`) dan N. Tiap intent punya `payment_evidence` (jumlah uang masuk) dan, bila perlu, `payment_unallocated_funds`. Status intent paid.

## Test yang diminta
File baru `apps/api/src/test/accounting-auto-journal-split-qr-guard.test.ts`, gaya dan helper dari `accounting-auto-journal.test.ts` bagian "F19 slice 3 QR sale" (~4303-4960: `makeWorld`, `bookedIntent`, `seedQrOrder`, `seedRefund`, `paymentPaid`, `paymentRefunded`, `deliver`). Salin helper yang perlu; jangan ubah file lama.
- S1 (bug permisif) due 110k; P evidence 60k, N evidence 50k, receipt posted tiap intent. Payout (completed sesudah fire) seluruh 50k intent N: harus parkir `POSTING_AMOUNTS_MISMATCH` (uang N sudah di penjualan). Di base: posted (karena N tidak dihitung). Wajib gagal di base.
- S2 (bug false mismatch payer) P evidence 110k dan fund unallocated 50k (alokasi P = 60k, `payment.paid` receivedIdr P = 110k), N evidence 50k. Payout non-fund 50k intent P sesudah fire: harus posted (bagian P di penjualan hanya 60k, 60k+50k <= 110k). Di base: mismatch palsu (110k+50k > 110k). Wajib gagal di base.
- S3 payout P sebesar 60k+ (melebihi receipt - bagian) tetap parkir mismatch (P 110k receipt, bagian 60k, payout 51k -> 111k > 110k). Lulus di base dan sesudah fix.
- S4 intent N yang seluruh uangnya `double_payment` unallocated (evidence = fund) menahan 0: payout non-fund N sebesar receipt-nya (receipt `payment.paid` N) posted.
- S5 urutan kirim (receipt dulu / payout dulu) untuk S1 memberi hasil sama (payout dulu parkir RECEIPT_PENDING atau menunggu lalu mismatch; ikuti perilaku yang ada, tulis apa yang terjadi).
- Single payer tidak berubah: cukup pastikan AJ-QR-16/17 di `accounting-auto-journal.test.ts` tetap hijau (jalankan file itu sekali di akhir).

Bukti gagal-dulu: jalankan file baru di base (tanpa perubahan service), laporkan test yang gagal beserta pesan gagal; gagal harus karena perilaku, bukan salah seed. Jangan pasang fix. Maks 30 giliran. Laporan: nama file, daftar test, hasil di base, jumlah baris.
