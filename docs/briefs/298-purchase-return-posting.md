# Brief: engineer (Sonnet) — WS-07 aturan jurnal retur pembelian dan pembelian sederhana

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/purchase-return-posting` dari `milestone/m1` (dc345b64 atau ujung terbaru). Worktree `.worktrees/purchase-return-posting`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan. Migrasi hanya bila perlu: nomor dipesan `0205`, `when` 1794284000000, satu migrasi.

## Tujuan
Dua kartu, satu cabang (tingkat K uang):
- `legend-1xbs`: event `purchase_return.recorded` (dari legend-ejk, membawa `valueIdr`) belum punya aturan di `posting-rules.ts`, jadi retur mengurangi stok tanpa jurnal. Kredit persediaan; debit GRNI bila penerimaan belum ditagih, selain itu debit utang usaha (nota debit). Bila payload belum cukup untuk membedakan, tambahkan penanda `invoiced` atau jumlah terpisah di sumber event.
- `legend-v3lh`: pembelian sederhana (petty purchase: `amountIdr`, foto, batas) belum dijurnal. Debit beban/persediaan sesuai kategori, kredit kas. PRD §3.18 Retur Pembelian dan Pembelian Sederhana, §3.19 Jurnal Otomatis.

Mulai dengan `Explore`: `posting-rules.ts`, consumer jurnal otomatis (batch42 baru di m1), contoh aturan pembelian yang sudah ada, dan sumber kedua event. Keputusan akun (GRNI vs AP, akun beban default) lewat satu subagent `architect`, catat di `docs/DECISIONS.md`.

## Kartu
Awal: `ghostex board associate legend-1xbs`, `ghostex board associate legend-v3lh`, `bd update <id> --status in_progress` untuk keduanya. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: `posting-rules.ts` dan consumer jurnal bagian dua event ini, sumber event di service retur/pembelian sederhana bila payload perlu dilengkapi, `packages/shared/src/accounting/*` bila kontrak perlu, test. Jangan: urutan nomor jurnal (`ws/ws11-f5-posting-seq` belum masuk m1), kas-bank (`ws/cash-bank-recon` belum masuk m1), settlement, UI.

## Bukti selesai
- Test gagal-dulu: retur sebelum ditagih menjurnal debit GRNI kredit persediaan; retur sesudah ditagih menjurnal debit utang usaha; pembelian sederhana menjurnal kredit kas; jurnal seimbang; event yang sama dua kali hanya menjurnal sekali; isolasi tenant; pesanan latihan tidak dijurnal.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api dan shared lewat `heavy` sekali; eslint + prettier berkas berubah. Jangan `pnpm check` penuh atau `pnpm test` penuh.
- Review (tingkat K): satu subagent `architect`.
- Tulis brief Codex `docs/briefs/298b-second-opinion-purchase-return-posting.md`, jangan dijalankan.

## Laporan
Sekali di akhir: SHA, migrasi (ada/tidak), keputusan akun, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
