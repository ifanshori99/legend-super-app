# 1059 POS: ganti voucher salah (legend-kuh0w, founder Q41) + QR member sekali pakai terikat order (legend-weexf) + door-check tolak perangkat latihan (legend-g7l20)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Tingkat K (uang: voucher/poin): architect xhigh sekali di akhir.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: Explore per kartu, test-writer gagal-dulu per kartu, implementer per kartu (berkas tidak bertumpuk).
Base: origin/ghostex/8eb871ce a93468ca8 (1048). Migrasi kerja 0676-0677 (merge train menomori ulang).
- kuh0w (Q41): kasir boleh melepas voucher salah lalu memasang voucher lain di pesanan yang sama. Saat ini baris promo application tertinggal setelah release sehingga voucher kedua 409. Voucher pertama kembali utuh (tidak terpakai), tidak bisa dipakai ganda, tetap dibatasi subtotal (Q40). Test bersamaan (lepas x pasang x bayar).
- weexf (keputusan CTO): QR member untuk tukar poin sekali pakai dan terikat ke order (dan nominal bila murah). Replay QR yang sama, di order lain, atau sesudah 120 detik ditolak. Tidak ada poin terdebit ganda.
- g7l20: POST /api/facility/tickets/door-check dari perangkat mode latihan ditolak, seragam dengan penolakan lain.
Test: tidak ada pihak dibayar lebih, poin/voucher tidak dipakai dua kali, outlet tidak rugi, tenant/outlet lain ditolak, mode latihan tidak mengubah uang/poin.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API (dan web bila tersentuh) lewat heavy, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).

## Tambahan: temuan SO POS 936 ronde 2 (docs/qa/second-opinion-pos-936-ronde2-1058.md) — kerjakan DULU, keputusan sudah diambil CTO
- R2-01 P1: penukaran poin lintas PT membukukan utang loyalty pada PT yang salah (pos-points.service.ts:189). Program/saldo wajib sesuai entitas outlet; lintas PT ditolak.
- R2-02 P2: replay kunci pra-migrasi 0672 membatalkan cetakan terbaru. Arsipkan kunci lama saat migrasi atau tolak replay tanpa riwayat.
- R2-03 P2: door-check memakai waktu sebelum lock; pakai jam DB sesudah lock untuk validUntil.
- R2-04 P2 + legend-0xt77: penghitung tebakan PIN bisa direset dengan memenuhi map. Pindahkan penghitung ke DB (sekaligus bersama antar instans), hitung hanya lookup gagal.
- R2-05 P2: token kasir outlet A mengubah tiket outlet B (facility-pos-ticket.routes.ts:193). Cek outlet token seperti setOutlet :69.
- R2-06 P2: pergantian mode latihan saat penjualan menunggu kunci tetap mengambil slot riil (facility-pos-ticket-sale.ts:150). Kunci/baca ulang mode perangkat di dalam transaksi.
Urutan: R2-01..06 + 0xt77 + g7l20 (area pintu/tiket/poin), lalu weexf (berbagi pos-points.service dengan R2-01, kerjakan sesudahnya), lalu kuh0w. Satu implementer per berkas; berkas bertumpuk dikerjakan berurutan. Claim juga legend-0xt77.
