# 190b hasil architect 1 (review ganda Claude, brief 225)

Kartu: legend-awg5p. Kode diperiksa: `milestone/m1` 94d769c6 (merge 095d357e = ws/day-report-blind fa472534). Tidak ada perubahan sesudahnya pada berkas berisiko.

Hasil: **Bersih** (tidak ada temuan P1/P2).

## Per invariant
- POS-03 / keputusan CTO: `getEndOfDayRecap` (`apps/api/src/services/pos-day.service.ts:666`) menjalankan `blindOwnDrawer` (`:200`) untuk recap live dan recap beku (`pos_daily_closes`). Pemegang `pos.day.close` di outlet itu dapat recap penuh (`:208`); pembaca tanpa shift hari itu dapat recap penuh (`:221`); selain itu baris perangkat milik sendiri dikosongkan utuh (variance + expired cash out), dan bila tidak ada baris yang cocok semua perangkat dikosongkan (gagal tertutup, `:231-235`).
- Atribusi sama: `computeRecap` memasukkan variance per `posShifts.deviceId` dan `posShifts.businessDate` (`:548-571`, `:582-610`), sama dengan kunci `blindOwnDrawer` (outlet, tanggal, cashier lower-case, device lower-case). Shift sendiri di perangkat mana pun hari itu ikut tertutup, termasuk shift kasir lain di perangkat yang sama.
- Pengurangan: `totalVarianceIdr`, `totalExpiredCashOutIdr` null; baris tender selalu memuat semua `POS_TENDER_METHODS` dengan null, jadi metode yang dipakai pun tidak terbaca. Yang tersisa (total penjualan, refund, void, channel per perangkat) tidak dipisah per metode, jadi kas sendiri tidak bisa diturunkan dari recap.
- Skema: `endOfDayBlindRecapSchema` mewajibkan null pada total dan tender (`z.null()`); `endOfDayRecapViewSchema` union, recap penuh strict menolak `drawerFiguresHidden`, jadi tidak ada bentuk campuran.
- Isolasi: query shift memfilter tenant + outlet + tanggal di dalam `withTenant`; `assertApprover` memanggil `assertOutletInScope`.
- `closePosDay` hanya `pos.day.close`, jadi jawaban penuh benar.
- Web: `dayRecapFrom` dan layar tutup hari menampilkan tanda strip, tidak mengarang 0.
- Jalur lain: metrik `cash_variance` termasuk metrik uang, jadi hanya `report.financial.view` (`apps/api/src/routes/metrics.routes.ts:8-9`), bukan peran supervisor bawaan.

## P3
- Audit `pos_daily_close` / event `day.closed` membawa `totalVarianceIdr`: sudah ditangani legend-mxxev (brief 190c), belum di m1.
