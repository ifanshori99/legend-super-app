# 190c hasil architect 1 (review ganda Claude, brief 225)

Kartu: legend-mxxev. Kode diperiksa: ws/day-closed-audit-blind 45b95ec2. Commit ini BELUM ada di `milestone/m1` (94d769c6); ia ada di integ/m1-batch25 sampai batch31, tanpa perubahan lanjutan pada `audit-events.service.ts`. Sampai digabung, m1 masih membuka `totalVarianceIdr` dan angka laci lewat `GET /api/audit/events` bagi pemegang `audit.log.view` (kartu legend-mxxev, P3).

Hasil: **Bersih** (tidak ada temuan P1/P2 pada 45b95ec2).

## Per invariant
- Satu-satunya pembaca `audit_logs` adalah `listAuditEvents`. Tidak ada endpoint ekspor atau baca tunggal lain, jadi wiring di `apps/api/src/services/audit-events.service.ts:533-560` menutup semua jalur.
- Cakupan field: `pos_shift` (`shiftAuditView` + `countId`/`heldCashOutIdr`/`differenceIdr`/`expiredCashOutIdr` dari `writeClose`), `pos_shift_count` (`expectedIdr`/`varianceIdr`/`heldCashOutIdr`), `pos_override` `cash_shift_close` (`valueIdr` + `shiftCloseFigures` + spread `shiftCloseVariance` dari edge), dan `pos_daily_close` (`totalVarianceIdr`). Semuanya ada di `SHIFT_DRAWER_FIELDS`/`OVERRIDE_DRAWER_FIELDS`/`DAY_CLOSE_DRAWER_FIELDS`. `countedIdr` tetap tampil karena itu hitungan pembaca sendiri. Audit `approval.requested`/`decided` tidak membawa nominal untuk `cash_shift_close` (`amountIdr` null, tanpa payload). Audit jurnal otomatis juga tanpa nominal.
- Aturan pembaca: pemegang `pos.day.close` di outlet melihat angka mentah. Selain itu, angka disembunyikan bila shift milik pembaca (cek `shift.outletId` dari DB, cashier dibandingkan lower-case), bila pembaca peminta override, atau bila hari itu pembaca punya shift di outlet+tanggal. Shift kasir lain tetap terlihat.
- Gagal tertutup: outlet/tanggal null, id bukan UUID, shift/count tidak ditemukan, atau objectType override tidak dikenal, semuanya disembunyikan bagi pembaca tanpa `pos.day.close`.
- Filter list hanya actor/objectType/action/outlet/tanggal, tanpa filter nilai, jadi tidak ada oracle lewat pencarian.
- Event `day.closed` dan baris audit tersimpan tidak diubah. Isolasi tenant: kedua query lookup memfilter `tenantId` di dalam transaksi tenant.

## P3
- Supervisor yang menutup paksa shift kasir lain adalah peminta override-nya, jadi angka override itu ikut disembunyikan darinya di audit, padahal laporan shift (176c) menampilkannya. Ini terlalu ketat (gagal tertutup) dan sesuai teks brief, bukan bocor.
- Gerbang: 45b95ec2 perlu masuk m1 sebelum rilis. Bila tidak, legend-mxxev tetap terbuka di m1.
