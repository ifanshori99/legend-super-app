# Brief: engineer (Sonnet) — Tutup Hari: hapus loop celah per perangkat (legend-sgh4l)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/close-day-gap-loop` dari `milestone/m1` 4c818489. Worktree `.worktrees/close-day-gap-loop`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-sgh4l` (P3 bug). Baca `bd show legend-sgh4l` dan komentarnya. Loop celah per perangkat menyembunyikan pesan nomor struk hilang di Tutup Hari.

## Kartu
Di awal: `bd update legend-sgh4l --status in_progress`. Saat melapor: `--status review` + `bd comment`.

## Scope
Boleh: service Tutup Hari dan test-nya. Jangan: migrasi, refund, payment, akses, edge sync, UI.

## Bukti selesai
- Test yang gagal di basis (nomor hilang tidak dilaporkan), lalu lulus. Test Tutup Hari lama tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` sekali, eslint, prettier.
- Review (tingkat S): satu subagent `reviewer` sonnet.

## Laporan
Sekali: perbaikan, bukti, file berubah, SHA, jumlah subagent.
