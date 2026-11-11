# Brief subagent: UI tinjauan HR absen saat cuti (legend-3jem1)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/3jem1` (cabang `ws/3jem1-hr-leave-review-ui`). Semua `cd` eksplisit ke worktree ini, cetak `pwd`.

## Sumber
- Mockup + copy: `design/mockups/hr-leave-clockin-review/README.md` (copy README = acuan teks). Baca HANYA gambar layar milikmu (desktop + mobile).
- Mockup generatif: shell/nav di gambar berbeda-beda dan rekaan. JANGAN tiru shell; pakai layout area `_kelola` yang ada.
- Pola acuan: `apps/web/src/features/ws10-attendance-qr/` (api.ts → queries.ts → hooks.ts → components, guard.ts, nav.ts, mock.ts, labels.ts) dan `components/selfie-review-page.tsx`, `review-dialog.tsx`.
- Kit UI: `apps/web/src/components/ui/` (`badge.tsx` Badge/StatusPill, `data-table-shell.tsx` DataState loading/error/empty/ready, `feedback-state.tsx` EmptyState/ErrorState, `dialog.tsx`, `table.tsx`, `skeleton.tsx`, `toast.tsx`). Token: `apps/web/src/styles/tokens.css`, arah: `DESIGN.md` root.
- String: i18n `useT()`; pesan di `packages/shared/src/i18n/messages/<feature>.ts` lalu didaftarkan di `messages/id.ts` (lihat `ws10-attendance-qr.ts`). Namespace baru: `leaveClockinReview.*`, berkas `packages/shared/src/i18n/messages/hr-leave-clockin-review.ts`.
- Mock: `VITE_API_MOCK=true` memakai `registerMock(endpoint, handler)` (`apps/web/src/lib/mock/registry.ts`). Komponen tidak tahu data mock.
- Jangan ubah `apps/api/**`. Celah API: catat, jangan betulkan.

## Fitur: `apps/web/src/features/hr-leave-clockin-review/`
Route (file routes TanStack, area `_kelola`):
- Antrean: `routes/_kelola/kelola.absensi.tinjauan-cuti.index.tsx` → `/kelola/absensi/tinjauan-cuti`
- Detail: `routes/_kelola/kelola.absensi.tinjauan-cuti.$logId.tsx`
- Guard: hak tinjau absensi (`hr.attendance.manage`), pola `attendanceGuard`. Nav entry di area kelola grup team, label "Tinjauan cuti".

Keadaan (10, tiap 1280 + 390):
1. Antrean berisi — judul "Tinjauan absensi", sub "Tinjau absensi yang memerlukan keputusan HR.", cari nama, bagian "Perlu ditinjau". Desktop tabel: Status | Nama karyawan | Tanggal | Cuti | Jam masuk | Jam pulang | Aksi "Tinjau". Mobile kartu: pill, nama, tanggal, jenis cuti, jam masuk/keluar, tombol Tinjau penuh lebar (≥44 px). Jam keluar null → "Belum absen keluar" (bukan angka).
2. Detail — halaman (bukan modal; deep link + mobile), tombol kembali ke antrean. Kartu ringkasan: Nama karyawan, Jenis cuti, Periode cuti (disetujui), Tanggal absensi, Jam masuk, Jam keluar; info "Saldo cuti dan gaji belum berubah sampai HR memutuskan." Bagian "Keputusan": "Pilih tindakan untuk absensi pada {tanggal}." Tombol utama "Tetap cuti", sekunder "Batalkan cuti hari ini, hitung hadir". Penjelasan dampak (README §2). Multi-hari: "Hanya cuti pada tanggal ini yang dibatalkan; hari cuti lain tetap berlaku."
3. Konfirmasi tetap — dialog "Tetap cuti untuk tanggal ini?" + dampak; Kembali / Tetap cuti.
4. Konfirmasi batal — dialog "Batalkan cuti hari ini dan hitung hadir?" + dampak (tanggal disebut); Kembali / Batalkan cuti hari ini.
5. Hasil tetap / 6. Hasil batal — di halaman detail: banner sukses "Keputusan tersimpan" + rincian; status "Tetap cuti" atau "Cuti hari ini dibatalkan" (JANGAN "Ditolak"); tombol "Kembali ke antrean".
7. Tanpa hak membatalkan — tombol batal `disabled` + alasan terbaca di dekatnya (aria-describedby): "Anda tidak memiliki hak untuk membatalkan cuti. Minta HR yang berwenang meninjau keputusan ini." Tetap cuti tetap aktif.
8. Koreksi manual — sama dengan detail, pill/jenis kasus "Koreksi absen manual", tanpa Terima/Tolak. Pembatalan selalu satu hari penuh.
9. Perlu ditinjau ulang — pill "Perlu ditinjau ulang" + teks "Perlu ditinjau ulang: ada cuti baru disetujui".
10. Antrean kosong — "Tidak ada tinjauan absensi" / "Absensi yang memerlukan tinjauan akan muncul di sini."
Plus: loading (skeleton bentuk isi), error (apa salah + Coba lagi), gagal konfirmasi (error di dialog, dialog tetap terbuka, tombol bisa diulang), offline bila pola ada.

Aturan: status = ikon + teks; `tabular-nums` untuk jam/tanggal; target sentuh ≥24 (aksi utama mobile ≥44); 320 px tanpa scroll horizontal; fokus terlihat; dialog shadcn; hanya transform/opacity; reduced-motion.

## Kontrak
Semua di `packages/shared/src/hris/attendance.ts` + `endpoints.ts`. JANGAN ubah API.
- Antrean: `GET /api/hris/attendance/review-queue` (endpoints.ts:585), query cursor + `outletId?`, `businessDate?`, `reviewStatus?`. Item `AttendanceReviewItem` (attendance.ts:421): `{log, source, flagReasons[], reviewStatus: none|pending|accepted|rejected, reviewedBy, reviewedAt}`. Kasus cuti = `flagReasons` memuat `leave_approved`. Hak: `hr.attendance.manage` atau `hr.attendance_correction.approve`.
- Keputusan: `POST /api/hris/attendance/logs/:logId/review` (endpoints.ts:597), body `{action: "keep_leave"|"cancel_leave", note?, idempotencyKey}` → `{data: AttendanceReviewItem}`. `keep_leave` butuh `hr.attendance.manage`; `cancel_leave` juga `hr.leave.approve` di outlet cuti (403 bila tidak).
- 409 (tampilkan pesan manusiawi, bukan kode): `ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED`, `ATTENDANCE_LEAVE_NOT_APPROVED` (cuti sudah tidak disetujui), `ATTENDANCE_LEAVE_DECISION_REQUIRED`, `ATTENDANCE_LEAVE_NOT_REACHABLE`, `ATTENDANCE_LEAVE_DAYS_MISMATCH`, `ATTENDANCE_LEAVE_STILL_APPROVED`, `ATTENDANCE_CORRECTION_LEAVE_DAY`. Plus 403 tanpa hak, network/offline, generik.
- Item tidak membawa nama, jenis/periode cuti, jam keluar, jenis kasus, hak batal (kartu API `legend-eps6t`). UI memperkaya di lapisan api.ts feature (lihat "Data layer"), komponen menerima view-model `LeaveClockinCase`.

## Data layer (potongan A) — kontrak antar potongan
Tipe: `apps/web/src/features/hr-leave-clockin-review/types.ts` (sudah ada, jangan ubah bentuk tanpa lapor). Potongan A menulis `api.ts`, `queries.ts`, `hooks.ts`, `enrich.ts` (fungsi murni), `guard.ts`, `nav.ts`, `mock.ts` + fixture, dan pendaftaran import mock/nav di tempat ws10 didaftarkan. Hook yang DIPAKAI B dan C (nama tetap):
- `useLeaveClockinCases(): UseQueryResult<LeaveClockinCase[]>` — outlet dari `useTenantContext()`; antrean `review-queue` `{outletId, reviewStatus:"pending"}`, saring `flagReasons` memuat `leave_approved`.
- `useLeaveClockinCase(logId: string): UseQueryResult<LeaveClockinCase | null>` — ambil dari cache antrean bila ada, bila tidak query sendiri (antrean pending + accepted/rejected bila perlu, cari logId). Null = tidak ditemukan.
- `useDecideLeaveClockin(): UseMutationResult<LeaveClockinCase, ApiError, {case: LeaveClockinCase; action: LeaveClockinAction}>` — POST review dengan `idempotencyKey` baru per percobaan konfirmasi (crypto.randomUUID), invalidasi antrean.
- `useLeaveClockinPermissions(): LeaveClockinPermissions` — `canKeepLeave = holdsAny(access,["hr.attendance.manage"])`, `canCancelLeave = canKeepLeave && holdsAny(access,["hr.leave.approve"])`. 403 dari server tetap ditangani (pesan tanpa hak).
- `leaveClockinErrorKey(error): string` — memetakan kode 409/403/network ke kunci i18n `leaveClockinReview.errors.*`.
Pengayaan (`enrich.ts`, murni, diuji): karyawan (`fetchEmployees`/`listEmployees`), cuti (`listLeaveRequests {employeeId, status:"approved"}` → yang mencakup businessDate) + nama jenis (`listLeaveTypes`), jam keluar (`listAttendanceLogs {employeeId, outletId, businessDate}` → `type:"out"` terakhir setelah clock-in). Jenis kasus: `log.method==="manual_correction"` → `manual_correction`; cuti `decidedAt` > `log.occurredAt` → `re_review`; lainnya `clock_in_on_leave`. Keputusan: pending → `pending`; rejected → `kept_leave`; accepted → `cancelled_leave`. businessDate dari `occurredAt` di zona waktu outlet (pakai helper ws10 `clock.ts`/`ATTENDANCE_TIME_ZONE`). Gagal pengayaan per baris → field null, bukan error seluruh layar.
Mock (`VITE_API_MOCK`): daftarkan `getAttendanceReviewQueue`(nama sebenarnya cek endpoints.ts), `decideAttendanceReview`, `listLeaveRequests`, `listLeaveTypes` (cek dulu belum ada owner lain). Fixture hari 2026-10-26 (sama dengan spec 0z5k) atau tanggal yang konsisten; 4 kasus: (1) cuti tahunan multi-hari, ada jam keluar; (2) cuti 1 hari, belum absen keluar; (3) re_review; (4) koreksi manual. Mock keputusan mengubah status di memori. Sediakan cara memaksa antrean kosong, error, dan tanpa hak batal di mode mock (ikuti pola mock yang ada, mis. query param atau localStorage; cek `lib/mock`), dokumentasikan di header mock.ts.

## Layar (potongan B: antrean, C: detail + dialog + hasil)
- B: `components/leave-clockin-queue-page.tsx` + route index. Pakai hanya hook di atas + `types.ts`.
- C: `components/leave-clockin-detail-page.tsx`, `components/decision-dialog.tsx`, `components/decision-result.tsx` + route `$logId`. Hasil tampil di halaman detail setelah sukses (state lokal + data mutasi). Detail tidak ditemukan → EmptyState + kembali ke antrean.
- Navigasi antrean → detail: `<Link to="/kelola/absensi/tinjauan-cuti/$logId">`.

## Test (potongan D)
Playwright mock: `e2e/legend-3jem1.mock.spec.ts`, pola `e2e/legend-0z5k.mock.spec.ts` (jam beku, `captureScreenshot`). Alur utama: antrean → Tinjau → Tetap cuti → konfirmasi → hasil "Tetap cuti" (tanpa teks "Ditolak") → kembali; batal cuti hari ini (multi-hari, kalimat hanya tanggal ini) → hasil; tanpa hak: tombol batal disabled + alasan; kosong; error + Coba lagi; 390 px tanpa scroll horizontal. Locator lewat role/teks i18n. Screenshot tiap keadaan 1280 + 390 ke `e2e/screenshots/legend-3jem1/`.
