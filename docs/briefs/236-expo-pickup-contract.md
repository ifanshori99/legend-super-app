# Brief: engineer — kontrak pickup picked-up dan runner-delivered (legend-usw3)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/expo-pickup-contract` dari `milestone/m1` terbaru (42ee5c28 atau lebih baru). Worktree `.worktrees/expo-pickup-contract`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-usw3` (P2, kontrak WS-04). Baca `bd show legend-usw3` dan komentar triase di `legend-vm6`. Kontrak kitchen punya `callPickupNumber` (assigned -> called, `packages/shared/src/kitchen/endpoints.ts:177`) dan status `picked_up` (`kitchen/schemas.ts:564`), tetapi belum ada endpoint transisi untuk menutup nomor pickup (called -> picked_up) dan menandai runner sudah mengantar (PRD `docs/PRD.md` §4 alur D langkah 4 dan alur G langkah 3).
- Tambah kontrak endpoint dan skema (request, response, kode error, katalog i18n bila pola proyek memakainya) untuk picked-up dan runner-delivered, dengan aturan transisi yang eksplisit (status asal yang sah, idempoten bila diulang).
- Hanya kontrak shared dan test kontrak. Implementasi API ada di kartu `legend-aiksz` (tabel + migrasi) dan `legend-mzhr0` (service/route): jangan dikerjakan di sini.
- Pastikan fixture layar expo/pickup di `apps/web` tetap cocok dengan kontrak (perbarui fixture bila tipe berubah, tanpa ubah UI).

## Kartu
`legend-usw3`. Di awal: `bd update legend-usw3 --status in_progress`. Saat melapor: `bd update legend-usw3 --status review` dan `bd comment legend-usw3 "<ringkasan>"`.

## Scope
Boleh: `packages/shared/src/kitchen/*`, test kontrak shared dan root (`tests/*.test.mjs` yang memeriksa kontrak), fixture web expo/pickup. Jangan: tabel/migrasi, service/route API, UI, refund, akses, edge.

## Bukti selesai
- Test kontrak untuk transisi baru (status sah dan tidak sah, idempoten).
- Test shared/root lewat `pnpm test` dari root worktree hanya bila perlu; test API terkait kitchen lewat `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) dengan `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`.
- tsc shared, api, dan web lewat `heavy` (satu kali), eslint, prettier.
- Reviewer Sonnet cukup (bukan tingkat K).

## Laporan
Sekali: hasil, endpoint baru dan aturan transisinya, bukti, file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
