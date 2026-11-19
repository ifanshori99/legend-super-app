# 1033 Kredit DP: pool net bersama + blok saat hold terbuka (legend-6n4p3, legend-obgj5)

Sumber temuan: `docs/qa/second-opinion-refund-area-1032.md` temuan 2 dan 3 (ada di `../legend/docs/qa/`). Tingkat K (uang): tamu tidak boleh dibayar lebih, outlet tidak rugi, bila ragu pilih aturan yang membatasi.
Jangan sentuh: `payment-provider-partial-refund.ts`, `payment-webhook.service.ts`. Tidak ada migrasi.

## Desain (diputuskan engineer)

File kode: `apps/api/src/services/reservation-deposit-credit.ts` (`allocationCredits`, `transferredCreditPools`, `creditProviderCutOfIntent`) dan `reservation-deposit-remainder.ts` (`finalizeReservationDepositRemainders` heldSql/heldBaseSql, `applyReservationCustomerCredit`).

### Temuan 2 (legend-6n4p3): satu pool net per intent
Tiap alokasi DP sebuah intent punya urutan stabil `(allocated_at, id)` di `reservation_deposit_allocations`. Kredit alokasi i:
`min(allocated_i, max(0, netIntent - sum(allocated_j untuk j lebih awal pada intent yang sama)))`,
`netIntent = least(deposit, amount intent [, evidence]) - depositPrincipalReservedSql - providerRefundedForeignIdrSql - hold terbuka (lihat temuan 3)`.
Klaim sesi lebih awal dihitung penuh (terpakai + sisa kredit pindahan), sehingga total semua sesi <= net dan tidak bergantung pada urutan tutup/bayar. Pakai fragmen SQL bersama (satu fungsi) di credit.ts, dipakai juga oleh finalize (heldSql: kurangi klaim lebih awal; `provider_refunded` snapshot = held tanpa potongan provider minus held dengan potongan provider, keduanya sudah memotong klaim lebih awal). Pengunci tetap `deposit-intent:{tenant}:{intent}` shared (baca/finalize) vs exclusive (refund). Contoh: DP 100, alokasi 50/50, provider refund 40 -> sesi awal 50, sesi akhir 10, total 60.

### Temuan 3 (legend-obgj5): hold terbuka membatasi kredit
`openReconHoldIdrSql(tenant, intent)` = sum `refund_recon_holds.amount_idr` dengan `resolved_at IS NULL` dan `reason <> 'credit_used_before_provider_refund'` (hold itu hanya penanda surplus yang sudah dipakai, jalur 1025c, sudah net). Dikurangkan dari netIntent di allocationCredits dan finalize; juga ditambahkan ke `provider` di `transferredCreditPools` (refundedSince dan creditProviderCutOfIntent ikut membatasi kredit pindahan). Hold resolve `not_this_intent`: kredit penuh kembali; `counted_against_intent`: refund tercatat, terhitung sebagai refund provider.

## Test (gagal-dulu, berkas baru)
`apps/api/src/test/reservation-deposit-dp-pool-1033.test.ts`; fixture meniru `reservation-deposit-dp-shared-intent-refund.test.ts` (`sharedDp`, `providerRefunded`, `close`, `applyCredit`, insert `refund_recon_holds`). Skenario: temuan 2 persis (50/50, refund 40; kedua urutan tutup; bersamaan), satu sesi sudah tutup lalu refund provider; temuan 3 (hold sebelum finalisasi dan sebelum apply, resolve `not_this_intent` dan `counted_against_intent`, hold atas intent lain tidak ikut); tenant lain tidak terpengaruh; jumlah nilai terpakai + refund <= DP. Tes 1028 (`reservation-deposit-dp-shared-intent-refund`, `reservation-deposit-credit-provider-refund-1020`, `refund-1025-d-resolve-hold`, `refund-1025c-b-credit-vs-provider-refund`) tetap hijau; bila angka lama bertentangan dengan pool, laporkan, jangan melemahkan.
