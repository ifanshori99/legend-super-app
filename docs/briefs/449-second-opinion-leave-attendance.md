# Brief: second-opinion Codex — area cuti + absensi (bayar ganda)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit, jangan commit. Effort xhigh (gaji).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis pembanding `origin/milestone/m1`.

## Cabang (sekali untuk seluruh area, bertumpuk)
- `origin/ws/9y6ri-leave-clockin-flag` f516b937 — clock-in saat cuti disetujui diizinkan + ditandai HR (alasan `leave_approved`, aksi `keep_leave`/`cancel_leave`), migrasi 0276, cherry-pick f0cbea6d.
- `origin/ws/5nt2z-leave-partial` 24e5d299 — batal cuti hanya hari datang (pecah rentang, saldo +1 sekali), flag log saat cuti disetujui (migrasi 0277 `app.flag_attendance_for_leave`), tolak koreksi manual di hari cuti (409), log `accepted` dibuka ulang saat cuti baru disetujui.

## Keputusan founder
W8 Q21: clock-in saat cuti boleh, ditandai HR. W8 Q27: HR batalkan cuti hanya hari karyawan datang. Aturan: tidak ada bayar ganda (cuti berbayar + hadir) tanpa keputusan HR; ragu = batasi pembayaran.

## Fokus
Bayar ganda atau saldo cuti bertambah lebih dari sekali (race dua HR, retry, idempotensi), pecah rentang salah di batas bulan/hari libur, RLS dan akses (HR tanpa hak, outlet lain), migrasi 0276/0277 di data yang sudah ada, jalur approve yang terlewat flag, sinkron cloud/edge.

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent: total, puncak bersamaan.
