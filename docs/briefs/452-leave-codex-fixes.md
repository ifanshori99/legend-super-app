# Brief: engineer — perbaikan temuan second-opinion cuti + absensi (legend-x0avw)

Lanjut di cabang `ws/5nt2z-leave-partial` (24e5d299), worktree baru `.worktrees/5nt2z`. Kartu `legend-x0avw`; tutup juga kartu P3 milikmu yang tumpang tindih (hari libur, flaggedAlways=false, cloud-sync split). Keputusan CTO: semua temuan nyata. Aturan "jangan sampai rugi": benturan cuti+hadir tidak boleh dibayar dua kali sebelum keputusan HR.

## Temuan (Codex G7v62, baris pada 24e5d299)
1. P1 `hris-attendance.service.ts:781`: race clock-in vs approval cuti (dan koreksi manual, up-sync edge) -> cuti approved + hadir valid tanpa flag. Lock bersama per karyawan+tanggal (advisory lock) di keempat jalur; test interleaving dua transaksi.
2. P1 `0277_flag_attendance_for_leave.sql:21`: data lama yang sudah berbenturan tidak ditandai. Tambah backfill di migrasi (idempoten) yang menandai benturan lama sebagai flagged/pending `leave_approved`.
3. P2 `hris-attendance-admin.service.ts:441`: `flaggedAlways=false` menyembunyikan `leave_approved` dari antrean. Benturan cuti selalu masuk antrean tanpa sampling.
4. P2 `0276_approved_leaves_on.sql:34`: hari di `excludedHolidayDates` dianggap hari cuti. Kecualikan saat deteksi benturan dan saat `keep_leave`.
5. P2 `hris-leave-request.service.ts:1226`: split/batal tidak menerbitkan event cloud-sync. Terbitkan perubahan + tail secara atomik di outbox.
6. Batas bayar: log flagged tetap menerbitkan `attendance.logged` dan dihitung untuk timing. Pastikan payload membawa status flagged dan tulis di `legend-em8y2`/kartu payroll bahwa consumer wajib mengecualikan flagged/pending; test kontrak bila ada consumer.

## Kerja
test-writer gagal-dulu per temuan, implementer maks 3 file terpisah, architect xhigh (gaji + migrasi). `pnpm --filter @starter/api lint` hijau, typecheck API heap 6144. Commit + push tiap langkah (kuota bisa habis).

## Laporan
sha, bukti per temuan, angka subagent (total, puncak, pemegang heavy).
