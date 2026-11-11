# Brief: absen masuk saat cuti disetujui (legend-9y6ri)

Keputusan founder W8 Q21: karyawan dengan cuti disetujui hari itu TETAP boleh clock-in. Absensi ditandai (flag) untuk ditinjau HR, alasan jelas, terlihat di daftar tinjauan HR (bila belum ada, tambahkan di respons API daftar absensi HR). Cuti TIDAK otomatis batal; saldo cuti dan payroll tidak berubah sampai HR memutuskan. Test: tidak ada bayaran ganda (cuti berbayar + hadir) tanpa keputusan HR. Aksi HR: tetap cuti / batalkan cuti (kembalikan saldo), pakai pola persetujuan yang ada. Layar baru: berhenti setelah API, tulis usulan UI.

Cabang: ws/9y6ri-leave-clockin-flag, worktree .worktrees/9y6ri (basis m1 + cherry-pick f0cbea6d). Migrasi bila wajib: nomor sementara 0276.
Service absensi: apps/api/src/services/hris-attendance.service.ts (clock) dan hris-attendance-admin.service.ts.
Test: apps/api/src/test/ (vitest). Jalankan: LEGEND_TEST_FILES="src/test/<file>" heavy pnpm test.

## Hasil peta (Explore)
- Tidak ada cek cuti di clock. Semua jalur (online, offline replay, edge) lewat `recordAttendanceLog` (`hris-attendance.service.ts` ~:595, inti ~:640-870). Titik sisip: setelah blok `offline_time_skew` (~:755-760), sebelum `resolveEmployeeShift`. Pola: `decision.reasons.push(...); if (decision.validity === "valid") decision.validity = "flagged"`. Insert (~:831-844) sudah set `reviewStatus: "pending"` bila flagged.
- Skema `attendanceLogs` (`db/schema/hris-attendance.ts:273`): `validity` valid|flagged|rejected, `flag_reasons` jsonb, `review_status` none|pending|accepted|rejected, `reviewed_by/at`. Enum alasan: `attendanceStoredFlagReasonSchema` di `packages/shared/src/hris/attendance.ts:378`. Cek apakah ada CHECK SQL untuk enum alasan/aksi (migrasi 0276 hanya bila wajib).
- Cuti: `leave_requests` (`db/schema/hris-leave.ts:227`; status pending|approved|rejected|cancelled; start_date,end_date,days), saldo `leave_balances` (used_days, pending_days). `decideLeaveRequest` (`services/hris-leave-request.service.ts:954`), aksi cancel :968 hanya pemohon/sistem; pengembalian saldo approved-belum-mulai :951-987 (cuti yang sedang berjalan/hari ini: cek apakah used dikembalikan; harus kembali tepat sekali).
- Tinjauan HR: `GET /attendance/review-queue` (`routes/hris-attendance-admin.routes.ts:160`), `listAttendanceReviewQueue` (`services/hris-attendance-admin.service.ts:435`), `decideAttendanceReview` (:566), `POST /attendance/logs/:logId/review`.
- Payroll belum membaca absensi/cuti sama sekali; tidak ada kode bayaran ganda. Bukti "tidak ada bayaran ganda" = proksi tes (log hari cuti tidak `valid` sampai HR memutuskan, saldo tak berubah).

## Kontrak (dari tes: apps/api/src/test/hris-attendance-leave-flag.test.ts, baca komentar atasnya)
- Flag `leave_approved`; clock-in 201, log validity flagged, review pending.
- Aksi review baru `keep_leave` (cuti tetap, saldo tak berubah, log tidak jadi valid, review keluar dari pending) dan `cancel_leave` (cuti cancelled, used kembali tepat sekali, log jadi valid). Perlu hr.attendance.manage; cancel_leave juga hr.leave.approve. Log tanpa flag leave: 409/422.

## Pembagian
- Implementer A: shared enum alasan `leave_approved` + deteksi cuti di `hris-attendance.service.ts` (hanya file ini + shared attendance.ts bagian alasan).
- Implementer B: aksi review `keep_leave`/`cancel_leave` di `hris-attendance-admin.service.ts`, route, enum aksi shared, helper pembatalan cuti oleh HR di `hris-leave-request.service.ts`.
- Jangan jalankan heavy/tsc/vitest kecuali A: hanya satu pemegang token heavy (A, vitest terarah di akhir).
