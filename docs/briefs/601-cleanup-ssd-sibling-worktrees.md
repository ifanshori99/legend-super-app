# Brief: engineer — cleanup-ssd dan parallel-report membaca worktree saudara legend-*

## Peran
Baca `~/.agents/team/roles/engineer.md` (bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, Grep + Read sempit). Tugas kecil, alat tim, bukan kode produk.

## Kartu
`legend-avtbg` (`bd update legend-avtbg --status in_progress`; saat lapor `--status review` + `bd comment`).

## Tujuan
1. `~/.claude/scripts/cleanup-ssd`: selain worktree di dalam repo, deteksi worktree saudara (folder `<induk>/<repo>-<hash>` yang terdaftar di `git worktree list` repo mana pun yang dipindai, mis. `/Users/ifanshori99/Projects/legend super app/legend-*`). Mode laporan: daftar worktree + ukuran + status (bersih? HEAD ada di remote? HEAD ancestor cabang milestone/main?). `--apply`: hapus hanya worktree yang bersih (tanpa untracked) DAN HEAD sudah ada di remote, dan tidak sedang dipakai sesi aktif (cek `ghostex agents list` / proses dengan cwd di folder itu bila mudah; minimal lewati folder yang punya proses dengan cwd di dalamnya, `lsof +D` terlalu lambat: pakai `lsof -a -d cwd`). Jangan hapus cabang yang belum merged; `git branch -d` saja (bukan -D). Path mengandung spasi: wajib aman.
2. `~/.claude/scripts/parallel-report`: ikut membaca folder sesi `~/.claude*/projects/-...-legend-<hash>` (thread di worktree), bukan hanya folder induk.
3. Perhatikan: output `git worktree list` di Mac ini dibungkus alat lain (path diawali `~`, tanpa format porcelain). Pakai `command git` / `/usr/bin/git` atau parse keduanya.

## Scope
Hanya dua skrip itu dan test di `~/.claude/scripts/tests/` bila ada. Jangan sentuh repo legend selain kartu bd. Jangan jalankan `--apply` sungguhan; uji pada repo git sementara di scratchpad (buat worktree tiruan bersih/kotor/belum-push/dipakai proses).

## Bukti
Output mode laporan pada repo legend asli (tanpa --apply), dan hasil test `--apply` pada repo tiruan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
