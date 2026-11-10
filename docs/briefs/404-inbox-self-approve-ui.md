# Brief: engineer — tombol Setujui untuk Owner tunggal di inbox (legend-mbhw1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/inbox-self-approve`, cabang `ws/inbox-self-approve`, dari `ws/owner-self-approve` (be5163bc). Lalu `pnpm worktree:setup`.

## Tujuan
`bd show legend-mbhw1`. Layar inbox sudah disetujui; ini perubahan kecil: tombol aktif + satu baris keterangan. Ikuti `~/.agents/team/ui-standard.md`. Keterangan bahasa biasa, contoh: "Anda satu-satunya Owner, jadi Anda bisa menyetujui sendiri. Tercatat di riwayat."

## Kartu
`legend-mbhw1`. Awal: `ghostex board associate legend-mbhw1`, `bd update legend-mbhw1 --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya `apps/web/src/features/ws01-approvals` dan test-nya. Tanpa API, tanpa migrasi.

## Bukti selesai
Test gagal-dulu (logic: own + selfApprovalAllowed true -> boleh setujui, tidak boleh tolak; false -> tetap blok). tsc + eslint + prettier web via `heavy`. Screenshot 390 dan 1280. Satu subagent `ui-auditor` atas layar, lalu satu `reviewer` sonnet.

## Laporan
Commit, push. Hasil, bukti, path screenshot, subagent, risiko.
