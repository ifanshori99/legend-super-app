# Brief: perbaikan temuan Codex — WFC (legend-bz9h) + refund setelah jual (legend-tz4dg)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/bz9h-wfc-products` (74fad85f); buat worktree `.worktrees/bz9h` lagi. Rebase/merge `origin/milestone/m1` (3c7217b2) dulu (merge-base sekarang a5d58300). Keputusan CTO: semua nyata, uang -> architect xhigh setelah perbaikan. Migrasi: ubah 0250/0251 sementara.

1. P1 `wfc-payment.ts:153`: order belum final diterima. Wajib order lunas DAN final (status closed/paid penuh); baris WFC di order tidak bisa di-void setelah pass terbit tanpa mencabut pass (tz4dg).
2. P1 `wfc-payment.ts:201`: cek tender tanpa lock order POS. Ambil lock order yang sama dengan refund/void POS, cek ulang setelah lock.
3. P1 `wfc-bundle.service.ts:229,562`: harga komponen dibaca tanpa lock. Kunci semua komponen dalam urutan id tetap sampai commit, saat buat dan beli.
4. P1 `wfc-seat.service.ts:963`: refund pass kedaluwarsa (sweep belum jalan) tercatat penuh. Cek `expiresAt` di bawah lock; test sebelum dan sesudah sweep.
5. P2 :958: refund parsial 40rb atas pass 100rb lalu sisa 60rb ditolak. Keputusan: izinkan refund sisa selama total refund <= dibayar, berdasarkan grant yang sudah dicabut refund pertama. Test: 40 + 60 = 100 ok; 40 + 61 ditolak.
6. P2 :683: reservasi pending_payment dikonfirmasi setelah slot lewat. Tolak konfirmasi setelah slot mulai; tender yang sudah ditangkap -> refund otomatis atau `needs_review` (pilih needs_review bila ragu).
7. P2 :546: durasi reservasi wajib PERSIS durasi produk (akhir slot dihitung server).
8. P2 :764 + `wfc-bundle.service.ts:800`: waktu diambil sebelum lock. Ambil `now()` DB setelah semua lock.
9. P3 `wfc-bundle.service.ts:709`: floating point. Pakai BigInt, bulatkan ke atas nilai terpakai.
10. P3 `0250_wfc_products.sql:156`: FK komposit tenant/outlet/zona untuk kursi (tambah unique `(tenant_id, outlet_id, id)` di floor_zones bila perlu).
11. legend-tz4dg: refund/void tender POS yang membiayai WFC wajib mencabut pass/reservasi/bundel di transaksi yang sama, atau tolak refund sampai WFC dibatalkan. Test gagal-dulu.

Paralel: test-writer gagal-dulu per butir, implementer per file (wfc-payment, wfc-bundle.service, wfc-seat.service, migrasi, jalur refund POS), lalu architect xhigh. Bukti: test gagal-dulu, 8 berkas WFC + baru hijau, eslint+prettier, typecheck api heap 6144, commit+push. Laporan: commit, angka test, angka subagent.
