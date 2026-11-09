# Brief lanjutan G3xjx: WS-07 kontrak laporan keuangan

Lanjutan di thread yang sama sesudah pxcs + dux2 dilaporkan. Peran dan aturan sama dengan brief 257.

## Repo
Cabang baru `ws/finance-report-contracts` dari SHA akhir `ws/finance-policy-asset-register` (v0s2 butuh register aset). Worktree baru `.worktrees/finance-report-contracts`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi; bila perlu, berhenti dan lapor (nomor berikut dipesan CTO).

## Kartu (P2), satu commit per kartu, implementer paralel bila berkas tidak bertumpuk
1. `legend-6mla`: respons statement membawa basis (`closed_snapshot | live`) dan info periode tutup.
2. `legend-v0s2`: respons aset tetap membawa `bookValueIdr` dan hasil pelepasan.
3. `legend-p4yd` (uang): `parseBankCsvAmount` lebih ketat (maks 2 digit desimal, pemisah ribuan valid, tolak yang ambigu).
4. `legend-z6a5`: unduhan ekspor Coretax memasang `Content-Disposition: attachment` dengan nama berkas aman.
5. `legend-3wyz`: aging report menampilkan item terbuka per dokumen (nomor, jatuh tempo, sisa).
6. `legend-bddb`: daftar legal entity untuk layar keuangan (izin dan cakupan tenant).

Baca `bd show` tiap kartu dulu. Jangan sentuh posting jurnal otomatis atau refund.

## Bukti selesai
- Test gagal-dulu tiap kartu; p4yd dengan tabel input ambigu dan valid.
- `LEGEND_TEST_FILES` terarah, sebut jumlah file dan tes; contract root bila `packages/shared` berubah.
- Typecheck api + shared lewat `heavy` sekali; eslint + prettier berkas berubah.
- Review (Q48): p4yd dan v0s2 menyentuh angka uang, jadi satu `architect` untuk diff gabungan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, kontrak baru untuk UI, risiko, jumlah subagent dan puncak bersamaan.
