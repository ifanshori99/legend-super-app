# Brief: engineer (Claude Opus) — hapus-buku yang dananya datang belakangan (legend-oan3p)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show legend-oan3p` (konteks commit 81f0c7e5a).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/writeoff-late-funds .worktrees/writeoff-late-funds origin/milestone/m1`.

## Tujuan
Bila hapus-buku kasus missing sudah diterapkan worker lalu impor kemudian mencocokkan penjualan (dana ternyata datang), sistem menandai kasus itu dan membuat antrean koreksi untuk finance. JANGAN membalik jurnal otomatis; finance yang memutuskan. Penanda terlihat di data rekonsiliasi (API). Penyetuju koreksi mengikuti aturan founder: Owner atau Finance Manager, satu tingkat. Migrasi bila perlu: nomor 0606-0607.

## Tingkat dan review
Tingkat K (uang, migrasi). Test gagal-dulu: dana datang setelah hapus-buku -> penanda + antrean koreksi, tidak ada jurnal ganda, tidak ada pembalikan otomatis, tenant lain tidak tersentuh, idempoten bila impor diulang. Satu subagent `architect` effort xhigh pada diff akhir.

## Bukti, sebelum melapor
Test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, `pnpm db:generate` kosong, typecheck api+web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (angka subagent). Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
