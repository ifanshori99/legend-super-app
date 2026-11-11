# Rencana 452 (legend-x0avw): antarmuka yang disepakati test-writer dan implementer

Cabang `ws/5nt2z-leave-partial`. Brief induk: `docs/briefs/452-leave-codex-fixes.md`. Aturan uang: pilih aturan yang membatasi pembayaran.

## F1 lock bersama (P1 race)
- Berkas baru `apps/api/src/services/hris-leave-attendance-lock.ts` mengekspor
  `lockEmployeeLeaveAttendance(tx, tenantId, employeeId): Promise<void>`.
  Isi: `SELECT pg_advisory_xact_lock(hashtextextended('hris:leave-attendance:<tenantId>:<lower(employeeId)>', 0))`.
  Per karyawan (lebih luas dari karyawan+tanggal, aman untuk rentang cuti).
- Dipanggil SEBELUM baca/tulis cuti atau log di empat jalur:
  1. `recordAttendanceLog` (hris-attendance.service.ts), sebelum pengecekan `approved_leaves_on` (mencakup online, offline, dan up-sync edge; semua lewat fungsi ini).
  2. `applyOutcome` dan jalur disetujui-saat-diajukan di `createLeaveRequest` (hris-leave-request.service.ts), sebelum status jadi approved.
  3. `applyApproved` di hris-attendance-correction.service.ts (koreksi manual, juga dilewati settle), sebelum `assertNoApprovedLeave`.
- Urutan kunci: kunci ini selalu pertama; kunci shift/idempotensi/koreksi boleh sesudahnya (tanpa siklus).
- Test interleaving: dua transaksi nyata, tx A menahan kunci, tx B mencoba, lalu urutan dibalik; hasil akhir: tidak pernah ada cuti approved + log `in` valid tanpa flag, untuk tiap jalur.

## F2 backfill + F4 hari libur: migrasi baru `0278_leave_clash_backfill.sql`
- Idx 278, journal `when` 1794331000002, plus snapshot (pola 0277).
- `CREATE OR REPLACE` untuk `app.approved_leaves_on` dan `app.flag_attendance_for_leave`: hari yang ada di `lr.excluded_holiday_dates` BUKAN hari cuti (tidak dikembalikan; tidak ditandai).
- Pernyataan TERAKHIR migrasi: satu `UPDATE public.attendance_logs` idempoten (backfill) yang menandai log `in` lama (validity valid atau flagged, review_status none/pending/accepted, bukan rejected) yang tanggal bisnisnya tercakup cuti approved milik karyawan yang sama (bukan hari libur terkecuali) menjadi validity flagged, review_status pending, reviewed_by/at NULL, `leave_approved` ditambah sekali. Sama aturannya dengan `flag_attendance_for_leave`. Menjalankan dua kali tidak mengubah apa pun. Test mengambil pernyataan terakhir itu dari berkas dan menjalankannya ulang.
- Perhatikan FORCE RLS: backfill migrasi berjalan sebagai pemilik; cek pola migrasi backfill lain (mis. 0249) untuk cara melewati RLS.

## F3 antrean
- `queued()` di hris-attendance-admin.service.ts: log `flagged` yang `flag_reasons` memuat `leave_approved` selalu masuk antrean, apa pun `sampling.flaggedAlways`.

## F5 cloud-sync event untuk split/batal
- Sekarang hanya ada `leave.approved` (packages/shared/src/hris/events.ts:104, catalog.ts:56, fixtures.ts, appender `appendLeaveApproved` hris-leave-request.service.ts:326).
- Tambah event baru `leave.changed` v1 (strictObject, destination cloud-sync): leaveRequestId, employeeId, outletId, startDate, endDate, days, excludedHolidayDates, status (approved|cancelled), changeReason (`range_split`|`range_cancelled`), splitFromLeaveRequestId (nullable, diisi pada baris tail baru). Appender sejajar `appendLeaveApproved`, sequence per aggregate memakai `nextLeaveEventSequence`.
- `cancelApprovedLeaveOnDateByHr` menerbitkan satu `leave.changed` per baris leave yang berubah (dipersempit / dibatalkan / tail baru) di transaksi yang sama dengan UPDATE+INSERT: semua ada atau tidak ada.
- Daftarkan di hrisDomainEvents, catalog, fixtures, dan tes katalog/kontrak yang ada.

## F6 batas bayar
- `attendance.logged` (appendAttendanceLogged hris-attendance.service.ts:523) sudah membawa `validity`. Test kontrak: log benturan cuti menerbitkan `attendance.logged` dengan `validity: "flagged"`. Tambah komentar kontrak di events.ts: consumer WAJIB mengecualikan validity flagged/rejected dan review_status pending (flag dapat berubah sesudah event lewat `leave_approved`, jadi baca ulang status sebelum menghitung bayar/timing). Tidak ada consumer gaji yang membaca log hari ini (payroll belum membaca absensi): catat di kartu legend-em8y2.
