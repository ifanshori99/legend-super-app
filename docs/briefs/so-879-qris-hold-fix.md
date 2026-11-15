# Brief: perbaikan second opinion QRIS hold (cabang fix/qris-hold-so-879)

Laporan temuan: `docs/qa/second-opinion-qris-hold.md` (berkas:baris, skenario, usul test). Baca seluruhnya.
Basis: cabang ini = C1+C2/C3 (6cfe64ba6) + merge origin/milestone/m1; migrasi C1/C2/C3 sekarang 0379/0380/0381. Migrasi baru: 0621-0625.
Aturan founder: jangan sampai rugi. Tiap perbaikan dibuktikan test: pelanggan tidak bayar lebih dari tagihan, outlet tidak terima kurang, tidak ada refund ganda. FORCE RLS: tanpa FK NOT VALID.

Keputusan CTO (aturan paling membatasi, jangan ditanya ulang):
- zff37: release (manual dan job) baca ulang status intent + evidence teralokasi di bawah kunci order/hold/link/intent dalam transaksi release. Ada bukti bayar: release ditolak, pembayaran diselesaikan (capture sekali), tanpa tender void/refund.
- ota0l: migrasi/cutover bikin hold untuk setiap kode penyedia yang mungkin masih tertagih (tender void lokal, link/split expired lokal, intent superseded) selama belum ada bukti penyedia bahwa mati. Tertahan sampai job cek penyedia membuktikan mati/bayar. Jangan lewati riwayat ambigu.
- w0ows: agent EDC dan route tender EDC menolak memulai sale kartu bila tagihan punya hold QR aktif. Balapan (QR masuk saat sale kartu diproses): kartu menang, QR direfund penuh (founder Q7). Satu pembukuan, urutan kunci tanpa siklus.
- 9ho2v: provider-proof periksa semua intent penyedia tagihan/reservasi yang mungkin pegang uang (pending, expired lokal, superseded), fail closed bila belum terbukti; pembatalan reservasi tunggu rekonsiliasi sebelum putuskan refund/forfeit.
- kf104: QR tamu order utuh pakai aturan sama dengan split: satu kode tertagih per tagihan, kode pengganti terbit hanya setelah kode lama terbukti mati.
- eqeu7: I/O penyedia + settlement keluar transaksi yang pegang kunci order, baca ulang di bawah kunci. Pairing: serialisasi per outlet (advisory lock transaksi) sebelum hitung/insert, batas 5/terminal dan 20/outlet tetap.
- 5ailc: guard hold 409 QRIS_HOLD_ACTIVE pada penulisan orders di qr-order.service.ts (m1, setelah 5dcc1cfd9) + test rollback item/stok/promo saat trigger menolak.
