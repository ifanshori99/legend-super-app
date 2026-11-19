# 1178 notes bersama (kartu legend-3dfri, legend-chmz2)

Brief: `docs/briefs/1178-reservasi-so1171-fix.md`. Temuan: `docs/qa/second-opinion-reservasi-dp-1171.md`.
Cabang: `ws/1178-reservasi-so1171-fix`. Tanpa migrasi. Jangan sentuh: `reservation.routes.ts`, `reservation-booking.ts`, `order-given.ts`, `edge-*`, `access.service.ts`, `payment-webhook.service.ts`.
Tes terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree (path relatif ke apps/api). Satu job heavy pada satu waktu per thread; jangan jalankan sendiri bila engineer sudah menjalankan; kamu BOLEH menjalankan tes filemu sendiri untuk bukti gagal-dulu, lewat `heavy`, tunggu dengan run_in_background.

## Helper tes yang bisa dipakai ulang
`apps/api/src/test/reservation-m0kqn-cap-db.test.ts`: `book` (~167-188), `openIntent` (~189), `shapeUnanswered` (~204), `sweepAt` (~217), `asOwner` (~81), `liveHolds`, `depositRefundRows`, `intentStatus` (~240-277), `confirmAt` (~288, tanpa opsi strict), `paymentPaidEvent` (~306). Tes lama DOIT late-pay di ~433-470; tes sweep 150 baris di ~475. Terkait: `reservation-deposit-db.test.ts:705,781`, `reservation-1163-proof-db.test.ts`.
Salin helper ke file barumu (jangan ubah file m0kqn) atau export bila perlu; jangan mengubah tes yang ada.

## Kartu 1 (legend-3dfri) perilaku yang diuji
Cap = `payableUntil + GATEWAY_POLL_WINDOW_MS` (24 jam; `services/payment-poll-window.ts`), payableUntil = max(batas link reservasi, expiry intent).
DP (Rp100.000) terbukti datang SESUDAH cap (bukti waktu = waktu bayar provider / penerimaan pertama), untuk DOIT dan Duitku, via callback (`confirmPayment` dengan opsi strict `closedIntentNeedsOpenBill: true` utk Duitku; DOIT tanpa) dan via polling (`strictOptions(intent)` di payment.service ~3669), SEBELUM sweep (reservasi masih `pending_deposit`) dan SESUDAH sweep (sudah `cancelled`):
- reservasi `cancelled`, holds nol (`liveHolds` = 0), TIDAK pernah `confirmed`, tanpa kredit booking (`deposit_payment_id` tetap null sampai refund dicatat lewat RSV-02 `refundLateDeposit`);
- intent `paid` (settle), TEPAT SATU event `payment.paid` untuk intent itu;
- setelah `handlePaymentPaid` (konsumer RSV-02): hasil `late_refund_requested`, TEPAT SATU permintaan refund Rp100.000 penuh; replay konfirmasi + replay `handlePaymentPaid` tidak menambah refund/event; total refund <= uang diterima;
- tidak ada baris dana tak teralokasi (parkir) untuk pembayaran ini.
Kontrol (harus tetap lolos, tes lama tidak diubah): DP terlambat SEBELUM cap (sesudah expiry, sebelum cap) tetap diparkir (aturan parkir pdi5u), tanpa `payment.paid`.
Matriks: {DOIT, Duitku} x {callback, polling} x {sebelum sweep, sesudah sweep} (8 sel) pada cap + 1 menit; plus kontrol sebelum-cap (cap - 1 menit) minimal DOIT dan Duitku.

## Kartu 2 (legend-chmz2) perilaku yang diuji
Kandidat sweep (`reservation-sweeps.ts` `sweepStaleDepositHolds`) mengecualikan di SQL baris legacy unresolved: `deposit_payment_link_id IS NULL`, `deposit_payment_id` terisi, intent provider belum final (`provider_ref` ada, `provider_final_at` null, bukan paid), lewat cap. Legacy BERBAYAR (intent paid) tetap masuk dan terkonfirmasi.
Tes: 100-150 legacy unresolved (tertua) + satu booking baru jatuh tempo tanpa kode + satu legacy berbayar; sweep berulang dengan limit default (tanpa opsi limit): booking baru batal dan holds lepas; legacy unresolved tetap `pending_deposit` dan holds tetap; legacy berbayar `confirmed`; tenant/outlet lain tidak berubah (tambah satu booking jatuh tempo outlet lain pada sweep berscope outlet: tidak tersentuh). Seed legacy: raw SQL via `asOwner` (`UPDATE reservations SET deposit_payment_link_id = NULL, deposit_link_expires_at = <lampau>`).

## Putaran 3 (CTO, 19 Nov sore)
Tes lama: `reservation-1178-late-dp-cap-db.test.ts`, `reservation-1178-two-late-codes-db.test.ts` (helper, cara membuat kode B via SQL; JANGAN diubah, boleh disalin helper ke file baru).
(1) Duitku strict, kode kedua pada link DP yang sudah lunas: callback ditolak `BILL_CLOSED` lalu `handleRejectedConfirmation` (payment-duitku-webhook.service.ts ~254-269) harus mencatat dana tak teralokasi. Tes harus lewat jalur webhook Duitku yang NYATA (bukan `confirmPayment` langsung): tepat satu baris `payment_unallocated_funds` per transaksi dengan nominal diterima; replay callback tidak menambah baris. Fixture sebelumnya tidak menunjukkan baris fund: betulkan fixture dulu; bila jalur nyata memang tidak mencatat uang itu, itu BUG: perbaiki di source (lapor persis apa yang diubah).
(2) Barrier dua koneksi: sweep (`sweepStaleDepositHolds`) dan callback/poll kode terlambat (sesudah cap) berjalan BERSAMAAN dua transaksi/koneksi nyata (barrier/Promise.all dengan koneksi pool terpisah; lihat pola tes konkurensi lain di src/test, mis. grep -l "Promise.all" atau "pg_advisory|barrier"). Tepat satu refund DP Rp100.000 via RSV-02, total refund <= diterima, booking cancelled, holds nol, tepat satu payment.paid; ulang beberapa iterasi (mis. 10) untuk DOIT dan Duitku-strict.
(3) Hardening: `refundLateDeposit` (reservation-consumers.ts) skip hanya untuk fund `reason = 'double_payment'` (evidence-matched atau evidenceId null tetap skip). Tes: fund reason `overpayment` pada intent settling TIDAK menahan refund DP alokasi.
