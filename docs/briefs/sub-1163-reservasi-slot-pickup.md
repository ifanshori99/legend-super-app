# Sub-brief 1163: reservasi bukti waktu, jam kosong tiket kasir, nomor panggil

Cabang: `ws/1163-reservasi-slot-pickup` (base m1). Tanpa migrasi. Tingkat K (uang DP).
Jangan sentuh: `reservation-deposit-credit.ts`, `reservation-deposit-remainder.ts`, `order-given.ts`, `payment-admin.service.ts`.
Path di bawah relatif ke `apps/api`. Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test` dari root worktree. Jangan `tsc`/suite penuh (agent utama yang menjalankan).
Brand types (TenantId, OutletId): pakai helper bertipe, bukan `as`.

## Kartu 1: legend-pdi5u (tutup legend-ytwlo duplikat)
Masalah: waktu lokal jadi bukti. `services/reservation-core.ts` `reconcileDeposit` (~:902) membatalkan `pending_deposit` dengan DP nol begitu `payableUntil <= now` (`cancelUnpaidDeposit`); `reservation-deposit-resend.ts` `oldLinkBlock` (~:113) mengganti tautan DP lama saat `payableUntil <= now`. Kode lama masih bisa dibayar sampai penyedia menjawab final (`payment_intents.provider_final_at`, migrasi 0405; ada di m1, lihat komentar `db/schema/payment.ts:~219`).

Aturan (keputusan CTO, arah membatasi pembayaran):
- **A (potongan I1)**: batalkan DP nol / ganti tautan hanya bila TIDAK ada intent DP yang masih bisa menerima uang: intent dengan `providerRef` bukan null, `providerFinalAt` null, status belum `paid`/`partially_refunded`/`refunded`. Helper murni baru `services/reservation-deposit-proof.ts` (`depositIntentMayStillPay`), dipakai `loadDepositState` (tambah field `providerPending`) dan `oldLinkBlock`. Selama masih mungkin dibayar: reservasi tetap `pending_deposit` dan tautan lama tetap berlaku (tidak diganti).
- **B (potongan I2)**: DP yang TERBUKTI terlambat tidak dikreditkan otomatis ke reservasi dan tidak mengurangi tagihan tautan; uangnya masuk dana belum teralokasi (`payment_unallocated_funds`, jalur BILL_CLOSED yang sudah ada di `payment.service.ts` ~:2998, `payment-late-settlement.ts` `billClosedForLateSettlement`). Terbukti terlambat = waktu konfirmasi (`confirmation.at`, dari penyedia bila ada, bukan jam lokal) > max(batas tautan reservasi `depositLinkExpiresAt ?? createdAt + paymentWindowMinutes`, `expiresAt` intent itu sendiri), pada reservasi yang masih `pending_deposit`. Tambahkan parameter waktu konfirmasi ke `billClosedForLateSettlement`; pastikan pemeriksaan ini berjalan juga untuk intent `pending` yang dibayar lewat batas (bukan hanya opsi `closedIntentNeedsOpenBill`). TIDAK boleh menambah nilai `reason` baru (CHECK constraint, tanpa migrasi): pakai jalur parkir yang sudah ada.
- Setelah dana diparkir, reservasi harus bisa dibatalkan normal (DP nol, hold dilepas): pastikan intent yang uangnya diparkir tidak membuat `depositIntentMayStillPay` benar selamanya (cek apakah parkir mengisi `providerFinalAt`; bila tidak, tandai intent itu final di jalur parkir atau kecualikan di helper).

Bukti (test-writer T1, file `src/test/reservation-1163-proof-db.test.ts`; pola: `reservation-deposit-resend-db.test.ts`, `reservation-deposit-db.test.ts`, `qris-hold-so885-d-recon-money.test.ts`):
1. Lewat batas lokal tetapi intent berpenyedia belum final: reconcile TIDAK membatalkan, resend TIDAK mengganti tautan.
2. Penyedia final (`providerFinalAt` terisi, tidak ada uang): reconcile membatalkan seperti sebelumnya, resend boleh mengganti.
3. DP terlambat (konfirmasi setelah batas): tagihan tautan tidak berkurang (`outstanding` sama), reservasi tidak `confirmed`, ada baris `payment_unallocated_funds` sebesar DP (tidak hilang), uang tidak dihitung dua kali.
4. DP tepat waktu: tetap mengkonfirmasi reservasi (regresi).
Tes lama yang bergantung pada pembatalan berbasis jam lokal harus diperbarui sesuai aturan baru bila memang menguji perilaku lama (laporkan tiap perubahan).

## Kartu 2: legend-tkxhs
`GET /api/outlets/:outletId/pos/tickets/slots` -> `facility-pos-ticket-catalog.ts:~212` `listPosTicketSlots` memanggil `getFacilityAvailability` (`facility-slots.service.ts:263`) yang menjalankan `assertFacilityPermission(... OPERATE_PERMISSION ...)` (:271-277). Kasir murni (tanpa `facility.booth.operate`) 403. Perbaikan: ekstrak inti tanpa cek izin (mis. `computeFacilityAvailability(tx/context, facility, query, now)`), `getFacilityAvailability` jadi pembungkus: muat fasilitas, cek izin, panggil inti. `listPosTicketSlots` memanggil inti (route sudah menjaga `pos.sale.create` dan scope outlet + fasilitas milik outlet, cek ulang di kode). JANGAN menambah izin `facility.booth.operate` ke role kasir/katalog. Route `/availability` tetap butuh `operate`.
Tes (T2, `src/test/pos-1096-ticket-cashier-reads.test.ts`, `wideCashier` = kasir murni): kasir murni 200 untuk slots; tes slot yang memakai `boothCashier` dialihkan/ditambah ke kasir murni; kasir tanpa `pos.sale.create` tetap ditolak; `GET .../availability` untuk kasir murni tetap 403; fasilitas outlet lain tetap ditolak/tidak bocor.

## Kartu 3: legend-hpze7 (sisa)
Sudah di m1 (peta Explore): `pickup.service.ts:138-215` `allocatePickupCall` (MAX+1 per tenant/outlet/tanggal bisnis, advisory lock), `shared/kitchen/pickup-code.ts` `formatPickupCode` (A-001..A-999, B-001, ... Z-999, AA-001), dipanggil `pos-order.service.ts:~999`; tes `pickup.test.ts:533-654`, `pos-order-pickup-call.test.ts:419-466`. Tidak ada batas/penolakan. Sisa: jalankan kedua tes itu hijau, tambah satu tes lintas batas Z-999 -> AA-001 lewat `allocatePickupCall` bila belum ada (cek `pickup.test.ts:645` dulu). Kesimpulan untuk laporan: legend-hpze7 dapat ditutup.
