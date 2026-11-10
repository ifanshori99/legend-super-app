# Brief: engineer — sisa kecil rollout konteks outlet (wpgfu, gmcmr, 5lsn5)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Tiga kartu, file berbeda: implementer paralel.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/outlet-followups`, cabang `ws/outlet-followups`, dari `ws/outlet-context-rollout` (a7af0003; sedang di batch48c). Lalu `pnpm worktree:setup`.

## Tujuan
1. legend-wpgfu (P2): `reservationId` di URL reservasi bisa basi setelah ganti outlet. Reproduksi dulu; bila benar, reset/abaikan id yang bukan milik outlet aktif.
2. legend-gmcmr (P3): mock `?outlets=many` untuk reservasi, delivery, roster agar outlet kedua punya data (pola mock inventori).
3. legend-5lsn5 (P3): teks deskripsi `/kelola/perangkat` menyempit jadi strip tinggi di 390px.
Ikuti `~/.agents/team/ui-standard.md`. Perubahan kecil di layar yang sudah disetujui; tidak ada layar baru.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya `apps/web` (fitur reservasi, delivery, roster, perangkat, mock). Tanpa API, tanpa migrasi.

## Bukti selesai
Test gagal-dulu untuk wpgfu; tsc + eslint + prettier web via `heavy`; screenshot 390 dan 1280 untuk 5lsn5 dan reservasi ganti outlet (path di laporan). Review: satu `reviewer` sonnet.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Tunggu job lewat notifikasi. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit per kartu, push. Hasil, bukti, file, subagent dan puncak, risiko.
