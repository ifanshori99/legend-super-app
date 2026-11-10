# Brief: second-opinion — HRIS absensi cloud

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-414 origin/milestone/m1`, hapus setelah selesai.
Rentang: `git diff 17fd0206^ 704ecc3d`. Baca versi terkini di m1.

## Berkas
`hris-attendance*.service.ts`, `hris-attendance.ts`, `attendance-selfie-purge.job.ts`, `hris-attendance.routes.ts`

## Invariant
- Karyawan hanya absen untuk dirinya sendiri, di outlet tempat ia ditugaskan; isolasi tenant + RLS.
- Selfie = data pribadi: akses dibatasi peran, purge sesuai retensi, tidak bocor di log/URL.
- Absen tidak dobel, idempoten saat retry, jam server bukan jam klien.
- Koreksi absensi oleh HR tercatat audit.

## Effort
high (data pribadi; xhigh bila menyentuh payroll/akses).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
