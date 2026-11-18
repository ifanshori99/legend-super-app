# Brief: engineer — worktree-slim gagal di worktree Ghostex (legend-ejzc7)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree Ghostex ini (base `ws/1069-worktree-hemat` f08d6c161). Kerja di cabang `ws/1069-worktree-hemat` (rename cabang worktree: `git branch -m` tidak bisa karena nama sudah ada; pakai `git switch ws/1069-worktree-hemat` bila bisa, atau commit di cabang worktree lalu laporkan namanya).

## Tujuan
`node scripts/worktree-slim.mjs` (dan salinannya `~/.claude/scripts/worktree-slim.mjs`) berhasil di worktree yang dibuat `ghostex coordinator start-thread --worktree`. Thread lain melaporkan galat `git rev-parse --git-dir gagal`. Kartu: `legend-ejzc7` (awal `bd update legend-ejzc7 --status in_progress`; lapor `--status review` + `bd comment`).

## Langkah
- Reproduksi di worktree ini dulu (jalankan skrip dari root worktree, catat galat persis). Kemungkinan: cwd/`GIT_DIR` env, path berspasi ("legend super app"), `execFileSync` tanpa `cwd`, atau worktree `.git` berupa file.
- Betulkan, tambah test kecil (node --test atau skrip shell) yang membuat worktree sementara dengan path berspasi dan menjalankan `--dry-run`.
- Jalankan skrip sungguhan di worktree ini, lalu `heavy pnpm worktree:setup` dan `heavy pnpm --filter @starter/api typecheck`. Catat `du -sh` sebelum/sesudah.
- Salin skrip final ke `~/.claude/scripts/worktree-slim.mjs` lewat berkas sementara lalu `mv` (atomik).

## Pembagian paralel
- Explore (1): cara skrip memanggil git dan cara Ghostex membuat worktree (`git worktree list --porcelain`, isi `.git`).
- implementer (1): fix + test.
- test-runner: pemegang token heavy.
- reviewer sonnet di akhir.

## Bukti selesai
Skrip sukses di worktree Ghostex (output + `du`), test baru merah sebelum fix lalu hijau, typecheck API, prettier/eslint berkas berubah.

## Laporan
Akar masalah, fix, bukti, commit SHA, cabang, salinan ~/.claude/scripts diperbarui. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
