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
