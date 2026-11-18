# Brief: engineer — fix SO edge ronde 2 (legend-f0pwc, legend-1rfy7)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo dan cabang
Worktree Ghostex base `ghostex/status-edge-ke-cloud-s1-s5` (3a5c4962c). Langkah 0 (disk sempit): `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Dua cabang, satu worktree (jangan buat worktree kedua):
1. F1 di cabang worktree ini; rename ke `ws/1073-edge-sweep-race`, commit, push tanpa force.
2. Lalu `git switch -c ws/1073-edge-digest-cancel origin/ghostex/job-rekonsiliasi-edge-berkala` (80e75d2fc), `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`, fix F2, commit, push tanpa force.

## Temuan
Laporan: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-edge-ronde2-1070.md` (F1, F2: lokasi, skenario, usul test).
- F1 `legend-f0pwc`: sweep offline (edge-offline-sweep.ts ~:280/:305/:371) membuka lagi alarm outlet yang ditutup bersamaan. Fix: keputusan per outlet memakai status terbaru di dalam transaksi/lock yang sama (atau cek ulang status sebelum raise), alarm outlet closed/retired tidak pernah dibuka lagi.
- F2 `legend-1rfy7`: buildDigest di reconciliation-sender.ts (~:100, :170; runtime.ts ~:1540) tidak kena timeout/abort. Fix: signal abort diteruskan ke builder (statement_timeout / lock_timeout di transaksi digest, atau cancel query), timeout mencakup build + HTTP, stop() selesai dalam batas waktu.
Bead: awal `bd update <id> --status in_progress`; lapor `--status review` + `bd comment`.

## Scope
Hanya berkas di sekitar temuan dan test-nya. Tanpa migrasi.

## Pembagian paralel
- Explore (2): F1 dan F2.
- test-writer (2): gagal-dulu F1 (race tutup outlet vs sweep, pakai dua koneksi/transaksi) dan F2 (builder tertahan lock: stop() selesai < batas, timeout memicu).
- implementer (2): satu per temuan (F2 setelah switch cabang).
- test-runner: pemegang token heavy.
- reviewer sonnet per cabang.

## Bukti selesai
Gagal-dulu merah lalu hijau; test edge terkait hijau; typecheck API; eslint, prettier; `db:generate` kosong.

## Laporan
Dua cabang + head SHA, bukti, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
