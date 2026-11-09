# Brief: engineer (Sonnet) — WS-11 F5 replay stok memakai posting_seq

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/ws11-f5-posting-seq` dari `milestone/m1` (d2080951; sudah memuat `posting_seq` 0186 dan ws11-shared-3). Worktree `.worktrees/ws11-f5-posting-seq`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi.

## Tujuan
`legend-5ymew` (P2, tingkat S). `apps/api/src/services/metric-sources/inventory-purchasing.ts` sekitar :222 me-replay `stock_ledger` dengan `ORDER BY occurred_at, id`. Ganti ke urutan `posting_seq` (pola pembaca ledger lain di m1 sesudah 0186), supaya nilai stok hari lalu sama dengan urutan live. Periksa pembaca replay `stock_ledger` lain di `metric-sources/*` dengan masalah yang sama dan betulkan sekaligus.

## Kartu
Awal: `ghostex board associate legend-5ymew`, `bd update legend-5ymew --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: `apps/api/src/services/metric-sources/*`, tes. Jangan: penulis ledger, migrasi, UI.

## Bukti selesai
- Tes gagal-dulu: dua baris dengan `occurred_at` sama atau backdated menghasilkan posisi dan biaya rata-rata sesuai urutan `posting_seq`, bukan `occurred_at, id`.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'` (tes metrik inventori dan stock ledger terkait), sebut jumlah file dan tes.
- `tsc` api lewat `heavy` sekali; eslint + prettier.
- Review (tingkat S): satu `reviewer`.

## Laporan
Sekali di akhir: SHA, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
