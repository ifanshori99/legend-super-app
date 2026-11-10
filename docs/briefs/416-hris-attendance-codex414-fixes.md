# Brief: engineer — perbaikan temuan Codex 414 (HRIS absensi), kartu legend-whiwv

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Giliran pertama: Explore + test-writer + implementer per kelompok berkas (service utama / admin / purge job), semua sekaligus; temuan di berkas yang sama berurutan dalam satu implementer.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/fix-414`, cabang `fix/codex-414-hris-attendance` dari `origin/milestone/m1`. `pnpm worktree:setup`.

## Temuan (keputusan CTO: betulkan semua)
1. P1 `apps/api/src/services/hris-attendance.service.ts:974` — izin absen diperiksa tanpa cakupan outlet; karyawan berizin di A tapi punya outlet asal/shift di B bisa absen di B. Periksa izin pada outlet tujuan sebelum membentuk scope.
2. P1 `hris-attendance.service.ts:785` — tidak ada keunikan atomik absen sejenis per karyawan dan shift; dua clock-in berkunci berbeda sama-sama tercatat dan menerbitkan event. Keunikan atomik (constraint/partial index) yang mempertimbangkan koreksi dan penolakan.
3. P2 `apps/api/src/services/hris-attendance-admin.service.ts:345` — URL selfie ditandatangani tanpa cek foto milik log itu; validasi `sourceId` dan outlet dulu.
4. P2 `apps/api/src/worker/attendance-selfie-purge.job.ts:167` — batas 10.000 baris menghitung foto belum jatuh tempo dan cursor kembali ke awal; saring jatuh tempo per outlet di SQL atau simpan cursor.
5. P2 `hris-attendance.service.ts:1001` — retry memilih ulang outlet sebelum cari kunci idempotensi; cari log asal dengan otorisasi pemilik dulu.
6. P2 `hris-attendance.service.ts:1025` — dua retry identik bersamaan; serialisasi per kunci atau ulangi pencarian saat validasi selfie gagal.

Migrasi (constraint): nomor sementara, merge train yang renumber; cek data duplikat lama dulu dan tulis cara menanganinya di laporan.

## Bukti selesai
Test gagal-dulu per temuan (unit/integration, termasuk dua request paralel), lalu lulus. tsc + eslint + test area via `heavy`. Satu subagent architect effort xhigh (akses + migrasi + data pribadi) atas diff; temuan nyata dibetulkan.

## Kartu
`ghostex board associate legend-whiwv`, `bd update legend-whiwv --status in_progress`. Selesai: `--status review` + `bd comment`.

## Laporan
Commit, push. Hasil, bukti test, subagent dan puncak, risiko.
