# Brief: engineer (Sonnet) — pesanan latihan tidak boleh membuat jurnal

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Bug: reproduksi dulu, cari akar masalah, baru perbaiki.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/training-orders-no-journal` dari `milestone/m1` (94995dad), worktree `.worktrees/training-orders-no-journal`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi; bila perlu kolom baru, berhenti dan lapor.

## Tujuan
`legend-gkc6b` (P1, tingkat K uang/akuntansi). Dugaan dari review (belum direproduksi): `accounting-auto-journal` tidak memeriksa `is_training`, dan `order.paid` terbit untuk tiap penjualan (`pos-order.service.ts` sekitar :1246). Sejak legend-fr62g pecahan penjualan WS-11 mengecualikan pesanan latihan, jadi owner akan melihat baris "Penyesuaian buku besar" sebesar penjualan latihan, dan pendapatan di buku besar terlalu besar.
1. Reproduksi dengan tes: pesanan latihan dibayar lalu jurnal penjualan terbentuk.
2. Telusuri semua jalur yang bisa menjurnal pesanan latihan: `order.paid`, void, refund, koreksi, potong stok/HPP (`recipe-deduction`), tutup hari/EOD, settlement, QR dan delivery bila punya mode latihan. Putuskan di mana pemeriksaan ditaruh (sumber event atau konsumen jurnal) supaya tidak bisa terlewat; catat alasannya di `docs/DECISIONS.md`.
3. Potong stok pesanan latihan: ikuti perilaku yang sudah ditetapkan PRD/kode untuk mode latihan; bila tidak ada aturan, jangan ubah, tulis di laporan.

## Kartu
Awal: `ghostex board associate legend-gkc6b`, `bd update legend-gkc6b --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: auto-journal accounting, penerbit event pesanan, test, `docs/DECISIONS.md`. Jangan: `services/metric-sources/*` (WS-11), skema jurnal, refund flow di luar pemeriksaan latihan.

## Bukti selesai
- Test gagal-dulu: pesanan latihan dibayar, di-void, dan di-refund tidak membuat baris jurnal; pesanan biasa tetap menjurnal sama persis; isolasi tenant.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes, termasuk tes auto-journal yang sudah ada.
- Typecheck api lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K): satu `architect`.

## Laporan
Sekali di akhir: akar masalah, jalur yang ditutup, SHA, bukti, file berubah, risiko (mis. jurnal latihan yang sudah terlanjur ada di data lama), jumlah subagent dan puncak bersamaan.
