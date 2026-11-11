# 501 temuan second-opinion HRIS cuti/PIN (Codex G6jk9, 11 Nov 13:40) dan keputusan CTO

Reset PIN WhatsApp: tidak ada temuan baru.

1. P1 (ws/5nt2z-leave-partial, apps/api/src/services/hris-attendance-admin.service.ts:500): antrean koreksi manual dibatasi per outlet saja, supervisor bisa membaca absensi + selfie pegawai supervisor lain di outlet yang sama.
   Keputusan: supervisor hanya melihat bawahannya (rantai supervisor); cakupan HR tetap sesuai izin. Test: supervisor A tidak melihat pegawai supervisor B di outlet yang sama.
2. P1 (apps/api/drizzle/0276_approved_leaves_on.sql:33; di UI ref nomornya 0256): lookup cuti tidak memeriksa excluded_holiday_dates, sehingga hari libur yang dikecualikan dianggap bentrok cuti (keep leave menolak absensi, koreksi terhalang).
   Keputusan: kecualikan tanggal itu di lookup dan penandaan. Test clock-in sebelum dan sesudah persetujuan.
3. P2 (hris-leave-request.service.ts:1580): persetujuan mengunci baris pengajuan lalu karyawan, pembatalan sebaliknya, sehingga bisa deadlock.
   Keputusan: semua jalur lock karyawan dulu, baru baris pengajuan. Test konkuren approve vs cancel.
4. P2 (ws/3jem1-hr-leave-review-ui, apps/web/src/features/hr-leave-clockin-review/api.ts:39): ambil 500 entri lalu filter alasan cuti di klien, sehingga kasus lama hilang.
   Keputusan: filter alasan di server + pagination sampai nextCursor habis.

Pemilik: 1-3 masuk thread WS-D (G1jk7, brief 499) sebagai migrasi/fix tambahan; 4 ke engineer Sonnet di cabang 3jem1 sebelum batch48h. Tingkat K (data pribadi + akses + gaji): review architect.
