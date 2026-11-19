# 1188 notes (bead legend-qs2r4)

Temuan: `docs/qa/second-opinion-reservasi-dp-1186.md` (P2). Cabang `ws/1188-reservasi-so1186` dari 15e1fa0ea. Tanpa migrasi. Notes 1178: `docs/briefs/1178-notes.md`.
Tes terarah lewat `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` (run_in_background). Jangan ubah tes 1178 yang ada; boleh salin helper.

## Aturan baru `refundLateDeposit` (reservation-consumers.ts ~L112-160)
Refund DP dilewati HANYA bila ada bukti pasti transaksi settle kode itu diparkir penuh:
 (a) fund `reason='double_payment'` dengan `evidence_id` = evidence transaksi settle (provider + intent.providerRef), ATAU
 (b) legacy: fund `reason='double_payment'`, `evidence_id IS NULL`, `amount_idr >= intent.amount_idr`, DAN ada intent LAIN pada link yang sama berstatus paid/partially_refunded (kode lain memegang uang teralokasi).
Selain itu TIDAK menahan refund: fund `overpayment` (evidence null atau tidak), fund legacy tanpa evidence reason apa pun selain (b), fund transaksi kedua pada kode yang sama. Total refund + parkir <= diterima.
## Tes baru: apps/api/src/test/reservation-1188-legacy-fund-db.test.ts
Setup mengikuti `reservation-1178-overpayment-fund-db.test.ts` (DOIT dan Duitku-strict; sebelum/sesudah sweep). Skenario:
 1. SO: DP 100.000, DOIT menerima 150.000 sesudah cap; fund surplus 50.000 reason `overpayment` dengan `evidence_id = NULL` (UPDATE fund yang tercatat jadi NULL, meniru writer lama). Konsumsi + replay `payment.paid`: tepat satu refund DP 100.000, fund tetap 50.000, refund + fund <= 150.000.
 2. Legacy fund transaksi kedua pada kode yang sama: `double_payment`, evidence NULL, 100.000, kode itu satu-satunya intent paid pada link: refund DP 100.000 tetap diminta (satu), total refund + fund <= 200.000.
 3. Legacy kode B (double_payment, evidence NULL, 100.000, kode A paid pada link yang sama): konsumsi event A lalu B dan B lalu A: tepat satu refund DP (A), B tidak direfund konsumer, total refund + fund <= 200.000 (diterima A + B).
 4. Kontrol: fund double_payment dengan evidence = evidence settle tetap melewati refund (tes 1178 two-late-codes tetap hijau).
Fail-first: skenario 1 dan 2 gagal pada kode sekarang (`unchanged` bukan `late_refund_requested`). Skenario 3 mungkin lolos sekarang.
