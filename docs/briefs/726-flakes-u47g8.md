# Brief: engineer (Codex) — tiga flake run penuh batch62 (legend-u47g8)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/flakes-u47g8 .worktrees/flakes-u47g8 origin/milestone/m1`.

## Tujuan
Run penuh batch62 merah di tiga file yang lulus 3x terarah: `ai-chatgpt-device-code` (B4 refresh), `operations-prep-production-creator` (qq4k: expected 2 orders got 0), `panic-review-e` (G2 resend stops). Satu subagent per file: cari akar masalah (jam/timer nyata, urutan, data bersama antar file, tenant/outlet tidak unik, polling tanpa batas waktu), bukti dengan reproduksi (mis. ulang 20x, beban paralel, `--sequence.shuffle`). Perbaiki test atau isolasi datanya; JANGAN melonggarkan assertion. Bila akar masalah di kode produk: laporkan dengan bukti, jangan ubah logika uang/akses. Jangan jalankan suite penuh.

## Bukti, sebelum melapor
Per file: akar masalah + bukti merah sebelum dan hijau berulang sesudah (lewat `heavy`), pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push tanpa force. Jangan merge, jangan deploy.
