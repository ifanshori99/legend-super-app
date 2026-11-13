# Brief: engineer — dua P1 payroll (piutang PPh 21 di simulasi, reseal hasil run)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang/gaji: "jangan sampai rugi" (test bukti tidak ada karyawan/negara dibayar lebih atau kurang).

## Repo
Worktree baru dari `milestone/m1` (a2234853d, payroll lengkap sudah di m1): `git worktree add .worktrees/payroll-644 -b fix/payroll-o2-o3 milestone/m1`, `pnpm worktree:setup`. Rentang migrasi: **0506-0507**.

## Kartu (detail: `bd show <id>`)
1. `legend-bypw2` — simulate harus menagih piutang PPh 21 terbuka (O2).
2. `legend-m6zdl` — reseal job harus mencakup `payroll_run_results` (O3).
Satu `Explore` + satu `test-writer` (gagal-dulu) per kartu di giliran pertama, lalu satu `implementer` per kartu.

## Review
Tingkat K (uang): satu subagent `architect`, "architect effort xhigh", atas diff gabungan; maks 2 ronde, cek ulang fix dengan reviewer sonnet.

## Bukti selesai
Test gagal-dulu, test terarah lewat `heavy`, typecheck api lewat `heavy` sekali sebelum lapor, prettier + eslint, `db:generate` kosong. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, atau `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
