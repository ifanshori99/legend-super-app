# 528 Edge: stream sinkron catalog:promotions dan catalog:vouchers (legend-09sxa, P1, tingkat K uang)

Langkah 0: `git worktree add .worktrees/edge-promo-streams -b ws/edge-promo-streams origin/ws/edge-catalog-fresh` (basis e38a3fdc, sudah berisi gerbang kesegaran 10nex + fix 521).
Masalah: sejak gerbang kesegaran katalog (10nex), promo dan voucher di kasir edge mati karena tidak ada stream sinkron `catalog:promotions` dan `catalog:vouchers`; sinkron hanya membawa menu/harga.
Tujuan: tambah kedua stream mengikuti pola stream katalog yang ada (pull cloud->edge, versi/high-water, kesegaran per stream). Promo/voucher hanya aktif di edge bila stream-nya segar menurut aturan 10nex (Q57: basi = promo/voucher mati; Q62: usia tak terbukti = promo/voucher mati, jual tetap jalan).
Jangan sampai rugi: test wajib membuktikan (a) voucher sekali-pakai tidak bisa dipakai dua kali lewat dua kasir edge offline atau edge + cloud (tentukan aturan: redeem voucher di edge harus dicadangkan/diverifikasi; bila tidak bisa dibuktikan aman offline, voucher hanya boleh saat online, catat sebagai keputusan); (b) promo kedaluwarsa/dinonaktifkan di cloud tidak dipakai edge setelah sinkron; (c) diskon tidak melebihi total dan tidak negatif; (d) stream basi -> promo/voucher ditolak tanpa mengubah baris keuangan.
Migrasi bila perlu: rentang 0333-0334 saja.
Mulai: Explore pola stream yang ada (edge sync registry, catalog freshness, trusted-clock) sebelum menulis kode. Test gagal-dulu, test terarah lewat `heavy`, tsc lewat `heavy`, `db:generate` sesuai.
Selesai: commit + push ws/edge-promo-streams (tanpa --force). Laporan akhir: keputusan aturan voucher offline, hash, test + hasil, angka subagent.
