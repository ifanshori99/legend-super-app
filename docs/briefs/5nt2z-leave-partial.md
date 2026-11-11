# Brief: tiga kartu cuti/absen (cabang ws/5nt2z-leave-partial, basis f516b937)

Konteks: lihat docs/briefs/9y6ri-leave-clockin-flag.md dan entri PROGRESS "Absen masuk saat cuti disetujui". Fungsi SQL `app.approved_leaves_on(tenant, employee, date)` (migrasi 0276) membaca cuti approved lintas outlet. Flag alasan `leave_approved`; aksi HR `keep_leave`/`cancel_leave` di `POST /attendance/logs/:logId/review` (hris-attendance-admin.service.ts, helper `cancelApprovedLeaveOnDateByHr` di hris-leave-request.service.ts).
Uang: jangan sampai rugi. Tiap kartu: tidak ada hari dibayar ganda (cuti berbayar + hadir), saldo kembali tepat sekali, idempoten. Ragu = aturan paling ketat.

## legend-5nt2z (founder W8 Q27)
Cuti >1 hari: `cancel_leave` hanya membatalkan HARI log itu. Pecah rentang; saldo kembali tepat 1 hari (0.5 bila setengah hari); hari lain tetap cuti approved; log hari itu valid. Sekarang 409 `ATTENDANCE_LEAVE_MULTI_DAY`. Idempoten (ulang = tidak mengembalikan dua kali), atomik dalam transaksi review.
## legend-7o3hd
Saat cuti disetujui (hris-leave-request.service.ts `applyOutcome` ~:1246), log absen type `in` yang belum rejected di rentang cuti (outlet mana pun, karyawan sama) menjadi flagged/pending dengan alasan `leave_approved` (hanya yang valid/flagged; bukan log yang sudah rejected atau sudah ada review diputuskan). Cuti bisa diajukan untuk tanggal lalu.
## legend-em8y2
Koreksi manual absensi yang disetujui (hris-attendance-correction.service.ts ~:689-712) di hari yang punya cuti approved: tolak 409 (kode jelas), pakai `app.approved_leaves_on`. Tidak ada log valid tertulis di hari cuti.

## Pembagian file
- 5nt2z: hris-leave-request.service.ts (cancel helper) + hris-attendance-admin.service.ts (hapus batas MULTI_DAY). Pemilik tunggal hris-leave-request.service.ts, termasuk satu baris panggilan helper 7o3hd di applyOutcome.
- 7o3hd: file BARU services/hris-leave-attendance-flag.service.ts (fungsi `flagAttendanceForApprovedLeave(tx, ctx, leave)`); pemilik 5nt2z memanggilnya dari applyOutcome.
- em8y2: hris-attendance-correction.service.ts.
Tes: file baru per kartu di apps/api/src/test/. Token heavy: hanya engineer (saya).

## Hasil peta (applyOutcome + koreksi)
- `applyOutcome(tx, context: ScopedTenantContext, row, outcome, now)` hris-leave-request.service.ts:1246; context outlet-scoped ke outlet home cuti, row terkunci. Titik sisip: setelah `appendLeaveApproved(tx, context, approved, now)` (:1285), sebelum `return "approved"`; `approved` (hasil .returning()) = leave; `approved.decidedBy` ada. Jalur ke approved: settle :1361 dan cancel-chain :1057, keduanya lewat applyOutcome; cek :929 `transitionLeaveRequest("pending","approve")` apakah jalur ketiga.
- Flag log: insert hris-attendance.service.ts:850-863 (validity, flagReasons, reviewStatus pending). `transitionAttendanceValidity` packages/shared/src/hris/attendance.ts:197-223 (valid -flag-> flagged).
- RLS `attendance_logs` per outlet (0215:175-177): update log lintas outlet dari context cuti butuh fungsi SECURITY DEFINER BARU, pola 0276 (migrasi 0277 sementara; `when` > 1794331000000; cek `node scripts/migration-renumber.mjs check --from-idx 240`).
- Koreksi: `applyApproved(tx, row, decidedBy, decidedAt, now)` hris-attendance-correction.service.ts:646, businessDate :655-658, insert valid :689-712. Dua pemanggil (:476 create-langsung, :791 settle). Cek cuti taruh di awal `applyApproved` (setelah businessDate), pakai `findApprovedLeaveOnDate` dari hris-leave-request.service.ts. Tolak 409.

## Desain 5nt2z (diputuskan engineer dari peta schema)
Fakta: tidak ada kolom half-day; `days` = hari kalender dikurangi `excludedHolidayDates` (bilangan bulat); akhir pekan dihitung. Jadi hari yang dibatalkan = 1 hari (setengah hari tidak ada di model; tidak dibangun, catat di laporan).
- Hari log D di rentang [s..e] (cuti approved, outlet mana pun):
  - D di `excludedHolidayDates`: hari itu tidak dibayar sebagai cuti -> tidak ada pemecahan, saldo tidak berubah, log valid (tidak ada bayaran ganda).
  - D = s: baris asli dipersempit ke [D+1..e]. D = e: dipersempit ke [s..D-1]. Tengah: baris asli dipersempit ke head [s..D-1], BARIS BARU (id baru) tail [D+1..e], status approved, decidedBy/decidedAt disalin, attachmentKey NULL, createIdempotencyKey NULL, outletId sama, approvalChainId sesuai skema (null bila boleh), excludedHolidayDates difilter ke rentang masing-masing.
  - Rentang yang menjadi kosong (s=e=D, kasus satu hari lama) tetap: status `cancelled` seperti sebelumnya.
  - `days` head+tail = days asli - 1 (hitung dari tanggal dikurangi libur dalam rentang). Saldo `used` turun tepat 1 (moveBalance), sekali.
  - Idempoten: panggilan kedua tidak menemukan cuti approved yang memuat D -> tidak mengubah apa pun, tidak mengembalikan lagi.
  - Cek akhir STILL_APPROVED (tidak ada cuti approved memuat D) tetap berlaku; audit memuat id asli, id tail, rentang sebelum/sesudah.
  - Hak: hr.leave.approve di outlet cuti (tetap).
