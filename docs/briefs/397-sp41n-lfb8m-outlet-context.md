# Brief: engineer — konteks outlet ke fitur lain + akun station-only (sp41n, lfb8m)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Pecah per fitur: 1 Explore per fitur (ws07, ws08, ws10, kitchen, inventory) paralel, lalu 1 implementer per fitur paralel (berkas tidak bertumpuk).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru `.worktrees/outlet-context-rollout`, cabang `ws/outlet-context-rollout`, dari `ws/ebt9f-me-outlets` (d515f3fc). Lalu `pnpm worktree:setup`.

## Tujuan
1. legend-sp41n: ganti ID outlet hardcode (`INVENTORY_OUTLET_ID`, `KITCHEN_OUTLET_ID`, `ROSTER_OUTLET_ID`, dll.) dan `useOutlets` per fitur di layar operasional dengan konteks outlet AreaFrame (`lib/areas/outlet-selection.ts`). Layar Kelola yang punya pemilih outlet sendiri tetap. Tanpa tampilan baru.
2. legend-lfb8m: akun station-only tidak melihat error 403 di layar operasional. Pilih yang paling sempit dan aman (EmptyState yang menjelaskan, atau jangkauan baca terbatas) dan tulis alasannya di laporan. Jangan memperluas izin tulis.

## Kartu
`legend-sp41n`, `legend-lfb8m`. Di awal: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
- Boleh: `apps/web/src/features/*` layar operasional, `lib/areas/*`, mock terkait, test terkait; untuk lfb8m boleh `apps/api` permission resolver bila perlu (tingkat K, lihat bawah).
- Jangan: modul uang di API, migrasi.

## Bukti selesai
- `grep -rn "_OUTLET_ID" apps/web/src` hanya tersisa di mock/test.
- Test terarah (node --test tests/*.mjs terkait, vitest api bila lfb8m menyentuh api); typecheck web (+api) lewat `heavy`; prettier; mock e2e layar yang disentuh.
- Review: satu `reviewer` sonnet; bila lfb8m mengubah izin di API: satu `architect` opus (effort high).

## Batas kerja ulang
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua. Gagal ketiga: lapor.
- Satu typecheck per worktree pada satu waktu. Tunggu job lewat notifikasi, bukan loop sleep.
- Jangan `pkill`. Jam dari `date '+%H:%M'`. Di zsh pakai `git diff --name-only | while read f`.

## Sebelum melapor
Commit per kartu di `ws/outlet-context-rollout`, push ke `origin`.

## Laporan
Hasil, bukti, file berubah, commit, jumlah subagent dan puncak bersamaan, risiko tersisa.
