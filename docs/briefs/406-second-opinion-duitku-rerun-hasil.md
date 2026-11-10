# Hasil second-opinion Codex 406 (Duitku ulang), 10 Nov

Basis `origin/ws/s5jup-duitku` 008cbd93.

1. `apps/api/src/services/payment.service.ts:1325` P1: poller dapat melunasi intent saat webhook memproses callback bertanda tangan dengan nominal berbeda; bila poller menang, pencatatan mismatch dilewati karena bukti pembayaran sudah ada. Simpan penahanan mismatch secara atomik dan wajibkan kedua jalur menghormatinya.
2. `apps/api/src/services/payment.service.ts:1683` P1: guard tagihan tertutup hanya memeriksa intent `failed`/`expired`; pembatalan POS bisa meninggalkan intent lewat expiry sebagai `pending`, lalu poller/webhook melunasi tagihan yang dibatalkan. Periksa tagihan tertutup juga untuk intent `pending` yang direkonsiliasi.
3. `apps/api/src/services/payment-late-settlement.ts:47` P1: status reservasi dibaca tanpa kunci bersama pembatalan; pembatalan yang belum commit terbaca masih terbuka, pembayaran terlambat dilunasi lalu reservasi dibatalkan. Sinkronkan cek dan pembatalan dengan protokol kunci yang sama.
4. `apps/api/src/services/payment-duitku-webhook.service.ts:375` P2: `paidAt` dipilih dari status sebelum panggilan Duitku; bila poller mengubah intent jadi failed/expired selama panggilan, tanggal akuntansi salah. Pilih dari status intent yang terkunci.
5. `apps/api/src/services/payment-duitku-webhook.service.ts:388` P2: mismatch nominal ditandai `ignored` tanpa warning. Tandai gagal untuk review dan keluarkan warning tanpa rahasia (sesuai keputusan s5jup D2).

Status 374: #1 tertutup, #2 tertutup, #3 belum (1, 5), #4 belum (2, 3).
