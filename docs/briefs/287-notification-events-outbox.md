# Brief: engineer (Sonnet) — event notifikasi ke outbox transaksional berurutan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/notification-outbox-events` dari `milestone/m1` (d2080951). Worktree `.worktrees/notification-outbox-events`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Migrasi hanya bila perlu: nomor dipesan `0192`, `when` 1794271000000 (cek dulu tidak dipakai cabang lain di `docs/PROGRESS.md`; bila bentrok pakai `0193`, `when` 1794272000000).

## Tujuan
`legend-9p0k` (P2, tingkat S kecuali butuh migrasi). PRD v1.7 bagian 3.15. Skema event sudah ada (`packages/shared/src/notification/events.ts` sekitar :22, :51; `notification-consumer.ts` :10), tapi API belum menerbitkannya. Terbitkan `notification.created`, `notification.read`, dan `notification_preference.updated` lewat outbox transaksional di transaksi yang sama dengan perubahan datanya, dengan nomor urut agregat yang tahan restart, memakai pola penerbit outbox domain lain di m1 (cari lewat `Explore`). Jangan bangun outbox baru.

## Kartu
Awal: `ghostex board associate legend-9p0k`, `bd update legend-9p0k --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: service dan route notifikasi di `apps/api`, `packages/shared/src/notification/*` bila kontrak event perlu dilengkapi, tes. Jangan: izin kebijakan notifikasi (legend-kz1m), template, kanal push/WebSocket, UI.

## Bukti selesai
- Tes gagal-dulu: tiap aksi menulis tepat satu baris outbox di transaksi yang sama; rollback tidak meninggalkan baris outbox; urutan agregat naik per notifikasi dan tidak berulang; tandai baca dua kali tidak menerbitkan dua event; isolasi tenant.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- `tsc` api (dan shared bila berubah) lewat `heavy` sekali; eslint + prettier.
- Review: satu `reviewer` (tingkat S); bila ada migrasi, satu `architect` (tingkat K).

## Laporan
Sekali di akhir: SHA, migrasi (ada/tidak), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
