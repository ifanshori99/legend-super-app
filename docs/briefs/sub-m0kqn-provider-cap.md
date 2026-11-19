# Sub-brief legend-m0kqn: batas atas kode DP penyedia yang tidak pernah final

Cabang `ws/1163-reservasi-slot-pickup`, tingkat K (uang DP), tanpa migrasi.

## Keputusan CTO

- Kode DP berpenyedia (`provider_ref` ada, `provider_final_at` null) yang tidak pernah final dibatasi di
  `payableUntil + GATEWAY_POLL_WINDOW_MS` (24 jam). Lewat batas itu `reconcileDeposit` membatalkan booking
  (`cancelUnpaidDeposit`), melepas slot, dan menulis baris audit yang menandai sebabnya
  (`providerUnanswered: true` di `before`/`after`, reason tetap `deposit_not_paid`).
- Pembayaran yang datang sesudah batal tidak dikreditkan: diparkir di `payment_unallocated_funds`
  lewat jalur BILL_CLOSED yang sudah ada (aturan A tetap aman).
- `sweepStaleDepositHolds` melewati baris yang masih pending (intent berpenyedia belum final dan batas belum lewat)
  di SQL, supaya `LIMIT 100 ORDER BY created_at` tidak kelaparan.

## Implementasi (dikerjakan engineer, JANGAN diubah oleh test-writer)

- `services/reservation-core.ts` (`reconcileDeposit`, `cancelUnpaidDeposit`), `services/reservation-sweeps.ts`,
  konstanta `GATEWAY_POLL_WINDOW_MS` (tetap diekspor dari `payment.service.ts`).

## Tes gagal-dulu (test-writer)

Berkas baru: `apps/api/src/test/reservation-m0kqn-cap-db.test.ts`. Pakai pola dan helper dari
`apps/api/src/test/reservation-1163-proof-db.test.ts` (book, openIntent, shapeIntent, expireLink, settleAt, ...).
Boleh menyalin helper; jangan ubah berkas produksi atau berkas tes lain.

1. Kode tidak final melewati batas: intent berpenyedia (`providerRef` terisi, `provider_final_at` null) dan
   sweep/reconcile pada `payableUntil + GATEWAY_POLL_WINDOW_MS + 1 menit` -> booking `cancelled`
   (`close_reason` `deposit_not_paid`), `liveHolds` 0, baris audit `reservation.cancelled` dengan
   `providerUnanswered` true. Kontras: tepat sebelum batas (`- 1 menit`) booking tetap `pending_deposit`.
2. Bayar sesudah batal: setelah kasus 1, konfirmasi pembayaran intent itu (jalur webhook/`confirmPayment`)
   -> `PaymentConfirmationRejected("BILL_CLOSED")`, baris `payment_unallocated_funds` sebesar DP, booking tetap
   `cancelled`, tidak ada pembayaran terkredit ke reservasi (saldo/`deposit_paid` tak berubah).
3. Sweep 150 baris: 150 reservasi `pending_deposit` lama dengan intent berpenyedia belum final dan batas belum
   lewat (boleh disisipkan lewat SQL massal bila memesan satu per satu terlalu lambat) + 1 reservasi lebih baru
   yang jatuh tempo normal (tanpa kode penyedia). `sweepStaleDepositHolds` dengan limit default 100 harus
   melepas yang baru (ada di `released`), dan 150 baris pending tetap `pending_deposit`.

## Temuan architect (ronde 1) yang dikerjakan implementer

- P2: batas cap harus dihitung dari `expiresAt` SEMUA intent yang masih bisa dibayar (`depositIntentMayStillPay`),
  apa pun statusnya (bukan hanya `pending`), karena poller bertanya sampai `intent.expiresAt + GATEWAY_POLL_WINDOW_MS`.
  - TS: `loadDepositState` di `reservation-core.ts` (~L726-731): ganti `if (intent.status === "pending" && ...)`
    dengan `if (depositIntentMayStillPay(intent) && intent.expiresAt > payableUntil)` (pertahankan perilaku untuk `pending`
    yang sudah ada; intent `pending` tanpa providerRef tetap memperpanjang seperti sebelumnya).
  - SQL: `gatewayStillPollable` di `reservation-sweeps.ts`: hapus `case when status='pending'` sehingga `expires_at`
    ikut `greatest(...)` untuk semua intent yang lolos filter (providerRef tidak null, providerFinalAt null, status bukan paid/dst).
- P3: `gatewayStillPollable` di SQL harus FALSE bila link DP punya intent lain berstatus `paid` / `partially_refunded`
  (sweep harus tetap memanggil `reconcileDeposit` supaya DP yang sudah dibayar dikonfirmasi). Tambahkan `not exists`.
- Jangan ubah berkas lain. Jangan jalankan test/tsc. Setelah selesai: prettier --write lalu eslint pada dua berkas (satu perintah per panggilan).

Setiap tes harus gagal pada kode saat ini (kasus 2 mungkin sudah lulus karena jalur BILL_CLOSED; bila begitu,
tandai sebagai tes regresi di komentar). Jangan jalankan test atau tsc: agent utama yang menjalankan.
Setelah selesai: `pnpm exec prettier --write` lalu `pnpm exec eslint` pada berkas itu (dari apps/api), satu perintah per panggilan.
