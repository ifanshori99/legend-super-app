# 1116 Perbaikan SO refund kasir 1095 (tingkat K uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang `ws/1095-void-refund-ganda-voucher` (head a8885a91f), worktree `legend-05b932c9`. Laporan SO: `docs/qa/second-opinion-refund-kasir-1095-1114.md` (2 P1; lokasi, skenario, usul test). Push tanpa `--force`. Tanpa migrasi.

## Keputusan CTO (membatasi; tutup kelasnya)
1. P1 `order-given.ts:92`: "dibayar" hanya pembayaran yang benar-benar lunas/terkonfirmasi (status final sukses). Tagihan QR/VA/e-wallet yang belum dibayar, kedaluwarsa, gagal, atau masih pending TIDAK dihitung. Ragu = tidak dihitung.
2. P1 `order-given.ts:84`: semua uang yang sudah atau mungkin keluar lewat penyedia mengurangi ruang: refund penyedia tercatat (fakta `payment_provider_refunds`/refund gateway apa pun status sukses atau sedang proses) DAN nilai hold refund yang masih terbuka untuk pembayaran pesanan itu. Satu sumber tetap `order-given.ts`, dipakai refund kasir, voucher maaf, void.
3. Rumus akhir harus menjamin: total keluar ke tamu (refund kasir + refund penyedia + voucher + void) <= jumlah pembayaran lunas. Tambah satu test properti/tabel yang menyilang semua jalur.

## Bukti
Per temuan: test merah di a8885a91f, hijau di head (skenario SO: QR belum bayar -> voucher ditolak; bayar 100.000 + refund penyedia 100.000 -> voucher/refund kasir 0). Regresi `refund-1095-*`, apology-voucher, order-recovery*, single-refund-lane-1042, pos-refund-*. Typecheck API sekali (heap 8 GB bila OOM). Prettier/eslint. Architect xhigh delta sekali.

## Laporan
Per temuan: commit, head SHA, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
