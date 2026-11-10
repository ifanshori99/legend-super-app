# 190c result, architect 2 (Claude double review, brief 225)

Kartu: legend-mxxev. Diff fa472534..45b95ec2.

Catatan status: 45b95ec2 BELUM ada di milestone/m1 (94d769c6). Ia digabung lewat 3033a0d1 (integ batch25) dan ada di integ/m1-batch25 sampai integ/m1-batch31. audit-events.service.ts tidak berubah lagi di integ/m1-batch31 sesudah 45b95ec2. Review dilakukan pada 45b95ec2; nomor baris di bawah merujuk berkas di commit itu.

## Hasil: Bersih (tidak ada P1/P2)

- Semua baris audit yang membawa angka laci tercakup oleh drawerRef (audit-events.service.ts, blok "Own drawer figures"): pos_shift (opened/closed/force_closed; shiftAuditView + heldCashOutIdr, differenceIdr, expiredCashOutIdr), pos_shift_count (expectedIdr, varianceIdr, heldCashOutIdr), pos_override recorded/requested cash_shift_close (valueIdr, expectedIdr, varianceIdr; jalur edge access-applier.ts:494-518 menyebar angka secara datar, jadi redaksi tingkat atas cukup), pos_daily_close (totalVarianceIdr). before dan after sama-sama diredaksi.
- Baris lain diperiksa dan tidak membawa angka laci: pos_override.denied (status saja), approval.requested (amountIdr null untuk cash_shift_close), approval.decided.
- Gagal tertutup tahan: outlet/tanggal/shift/count yang tidak terselesaikan atau id bukan UUID disembunyikan bagi pembaca tanpa pos.day.close.
- Shift kasir lain tetap tampil untuk supervisor; force close oleh supervisor A disembunyikan dari A sebagai peminta (lebih ketat dari perlu, aman).
- Izin dicek pada outlet shift (shift.outletId), bukan outlet event, untuk baris shift. Semua query memfilter tenantId.
- Event day.closed dan baris audit tersimpan tidak diubah.

## Temuan P3 (tanpa kartu)
- apps/api/src/services/pos-shift.service.ts:665-685 dan pos-shift-support.ts:488 (tidak disentuh diff): baris audit pos_shift.cash_movement_held dan pos_shift.cash_movement_expired milik shift sendiri tetap terbaca oleh pembaca audit.log.view tanpa pos.day.close. Keberadaan baris held berarti amount > expected saat itu. Pembaca dengan peran kustom bisa melakukan pencarian serakah dengan cash out menurun (yang tidak held mengurangi expected) sampai sisa < 1, sehingga expected = jumlah cash out yang tidak held. Butuh peran kustom dan banyak gerakan kas yang tercatat, jadi P3. Saran: masukkan objectType cash_movement dengan action *_held/*_expired ke drawerRef (sembunyikan seluruh baris atau tandai tanpa membedakan held), atau catat sebagai efek diterima.
- Sama dengan 190b: pos_daily_close disembunyikan hanya bila pembaca punya shift ber-businessDate sama. Shift yang melewati cutoff tidak memicu penyembunyian totalVarianceIdr hari berikutnya; varian hari berikutnya tidak memuat varian shift itu, jadi dampaknya kecil.
