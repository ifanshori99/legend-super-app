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

## Review architect (putaran 1) -> pekerjaan putaran 2
Kebutuhan (uang: batasi pembayaran, ragu = aturan paling ketat):
1. Batas outlet menyembunyikan cuti (leave_requests RLS per outlet asal karyawan). Buat migrasi 0276 (nomor sementara; cek drizzle/meta/_journal.json + pola migrasi/fungsi `app.*` SECURITY DEFINER yang ada) berisi fungsi `app.approved_leaves_on(p_tenant uuid, p_employee uuid, p_date date)` mengembalikan (leave_request_id, outlet_id, start_date, end_date, days) untuk cuti status approved yang mengandung tanggal, tanpa batas outlet (tetap ikat ke tenant). Pakai untuk: (a) deteksi saat clock-in (`hris-attendance.service.ts`~:769 dan jalur edge `attendance-logged-applier.ts`~:112 bila memanggil logika sendiri), (b) blok `accept`, (c) cek setelah `cancel_leave`: bila masih ada cuti approved di tanggal itu -> 409 dan rollback seluruh transaksi.
2. `cancel_leave` hanya boleh bila cuti satu hari (start_date = end_date = business date log); selain itu 409 dengan pesan jelas (HR tetap bisa `keep_leave`). Pembatalan sebagian/setengah hari = keputusan founder, tidak dikerjakan. `hris-leave-request.service.ts:~1167` jangan mengembalikan `days` penuh untuk rentang.
3. Tanggal deteksi = `shift?.businessDate ?? localDateOf(...)`, deteksi dipindah setelah `resolveEmployeeShift` (~:791) agar sama dengan tanggal yang dipakai review (`row.businessDate`).
4. Audit absen `after` memuat id cuti yang dibatalkan; hasil helper tidak diabaikan.
5. Tes tambahan (file baru `apps/api/src/test/hris-attendance-leave-flag-outlet.test.ts`): absen di outlet lain dari outlet asal tetap flagged; HR akses outlet sebagian: cancel_leave tetap membatalkan atau 409 (bukan valid tanpa batal), accept diblokir; cuti beberapa hari -> cancel_leave 409, keep_leave OK; shift malam tanggal sama deteksi vs review.
Pembagian putaran 2: C = migrasi + `hris-attendance.service.ts` (+ edge applier bila perlu). D = `hris-leave-request.service.ts` + `hris-attendance-admin.service.ts`. E (test-writer) = file tes baru. Token heavy: hanya saya (engineer) menjalankan vitest/tsc; subagent jangan.
