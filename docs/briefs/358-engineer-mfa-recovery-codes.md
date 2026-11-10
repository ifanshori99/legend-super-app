# Brief: engineer — MFA recovery codes staf (legend-omp4)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (auth + migrasi): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/omp4-mfa-recovery -b ws/omp4-mfa-recovery milestone/m1`. Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Kode cadangan sekali pakai untuk MFA TOTP staf: generate (tampil sekali), simpan hash, verifikasi sekali pakai saat login MFA, regenerate membatalkan set lama, audit log, rate limit sama seperti TOTP.

## Kartu
`legend-omp4`. Di awal: `ghostex board associate legend-omp4` dan `bd update legend-omp4 --status in_progress`. Saat melapor: `bd update legend-omp4 --status review` dan `bd comment legend-omp4 "<ringkasan>"`.

## Masukan
- `bd show legend-omp4`. Cek dulu kode MFA TOTP yang sudah ada di m1; jangan tulis ulang.
- Kontrak di `packages/shared`; tambahkan endpoint di kontrak dulu.

## Scope
- Boleh diubah: modul auth/MFA di `apps/api`, kontrak terkait di `packages/shared`, schema + migrasi baru.
- Jangan disentuh: rute HRIS/edge (`apps/api/src/edge/`), staff PIN, modul akuntansi.
- Migrasi: rentang 0239-0240 saja, FK inline di CREATE TABLE, migrator non-superuser.

## Bukti selesai
- Test gagal-dulu tiap butir (generate, sekali pakai, regenerate, rate limit, audit).
- Typecheck dan test terarah lewat `heavy`.
- Review architect, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Sebelum melapor
Commit, push cabang kerja, update `docs/PROGRESS.md`.

## Laporan
SHA, test gagal-dulu, temuan review, kartu sisa, risiko.
