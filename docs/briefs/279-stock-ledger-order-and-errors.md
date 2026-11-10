# Brief: engineer (Sonnet) — urutan rebuild stok dan pemetaan galat inventory

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua kartu, berkas tidak bertumpuk: dua cabang, dua worktree, dua `implementer` paralel sesudah Explore. Jangan checkout di folder utama. Jangan push, jangan merge.

## Kartu
1. `legend-bsw9` (P2, tingkat K uang + migrasi). Cabang `ws/stock-ledger-sequence` dari `milestone/m1` (3517283b), worktree `.worktrees/stock-ledger-sequence`. Nomor migrasi dipesan `0186`, `when` 1794265000000. Keputusan sudah ada di catatan kartu: tambah urutan sisip (bigserial) di `stock_ledger`, `rebuildStockBalances`/`foldStockLedger` melipat berdasarkan urutan itu sehingga sama dengan urutan posting live; posting mundur tanggal (EOD, opname, impor) tetap boleh. Isi urutan untuk baris lama di migrasi secara deterministik (`occurred_at, id`) dan sebut risikonya. Kamu pegang langsung; implementer hanya untuk tes.
2. `legend-ul4s` (P2, tingkat S). Cabang `ws/inventory-error-http` dari `milestone/m1` (3517283b), worktree `.worktrees/inventory-error-http`. Kontrak HTTP untuk `InventoryError` dan `PurchasingError` di `docs/plan/contracts.md` (D-CORE-4), satu pemetaan umum (status + pesan aman) yang dipakai route inventory dan purchasing, menggantikan pemetaan lokal (`purchasing-flow.shared.ts` sekitar :65, `inventory-count.shared.ts` sekitar :172). Baca komentar audit di kartu.

Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Catatan lintas thread
- Thread HPP (G8www) membaca `stock_balances.avg_cost_idr`; jangan ubah perilaku posting live.
- Reader WS-11 F5 (`ws/ws11-inventory-purchasing`) memutar ulang `stock_ledger` per hari untuk nilai stok hari lampau. Jangan ubah berkas itu; tulis di laporan apakah urutan putar ulangnya perlu ikut urutan sisip.

## Bukti selesai
- bsw9 gagal-dulu: posting mundur tanggal sesudah posting lain membuat rebuild berbeda dari saldo live di basis, dan sama sesudah perbaikan; isolasi tenant; migrasi mengisi urutan untuk baris lama.
- ul4s gagal-dulu: tiap galat domain menjawab status dan kode kontrak, tanpa pesan internal.
- `pnpm db:generate` lalu periksa SQL, generate kedua kosong, test migrasi RLS.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'` per worktree, sebut jumlah file dan tes. Kontrak root bila `packages/shared` berubah.
- Typecheck api (+ shared bila berubah) lewat `heavy`, berurutan per worktree; eslint + prettier.
- Review (Q48): bsw9 satu `architect`; ul4s satu `reviewer` sonnet.
- Tulis brief Codex `docs/briefs/279b-second-opinion-stock-ledger.md` untuk bsw9 (xhigh: uang + migrasi), jangan dijalankan.

## Laporan
Sekali di akhir: per kartu (cabang, SHA, hasil), migrasi (`when`, prevId), bukti, file berubah, catatan untuk F5, risiko, jumlah subagent dan puncak bersamaan.
