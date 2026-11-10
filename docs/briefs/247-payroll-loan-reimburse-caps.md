# Brief: engineer (Sonnet) — batas kasbon + batas bulanan reimburse dan receipt (legend-fij0l, legend-8399r)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/payroll-caps` dari `ws/payroll-schema-api` f99d9d2e (skema + API payroll, migrasi 0167). Worktree `.worktrees/payroll-caps`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Satu commit per kartu. Baca `bd show` + komentar tiap kartu (8399r punya catatan kepemilikan receipt antar-tenant). PRD `docs/PRD.md` §30 dan bagian H.
1. `legend-fij0l` (K uang): batas kasbon sesuai kartu/PRD, ditegakkan di service saat ajukan dan setujui (aman terhadap pengajuan paralel).
2. `legend-8399r` (K uang): batas bulanan reimburse per kategori + receipt URL; receipt hanya boleh milik tenant yang sama.

## Kartu
Di awal: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: service/route payroll kasbon dan reimburse, kontrak shared payroll, test. Jangan: migrasi baru (butuh kolom: berhenti dan lapor; CTO memberi nomor), run lifecycle (`legend-07eg`), mesin hitung, `legend-xo0xx`, akses, edge, UI.

## Bukti selesai
- Per kartu: test gagal-dulu (termasuk dua pengajuan paralel yang bersama-sama melewati batas, dan receipt tenant lain), lalu lulus. Test payroll lama tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan. Maks 2 subagent bersamaan.
- Brief Codex: tambahkan rentang diff ke `docs/briefs/237b-second-opinion-payroll-schema.md` (satu area payroll, satu run Codex).

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, risiko, jumlah subagent.
