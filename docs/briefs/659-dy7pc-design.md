# 659 dy7pc: desain order QR dibayar di kasir edge

Worktree: `.worktrees/edge-resilience-659` (branch `ws/edge-sync-resilience`). Migrasi 0538-0541. Uang: jangan sampai rugi.

Masalah: order QR sudah jadi baris `orders` di cloud (`awaiting_payment`), lalu dibayar di kasir edge. Ingest edge (`apps/api/src/edge/order-ingest.ts` ~l.343) menolak `order_exists`, jadi pembayaran edge tidak masuk cloud.

Target: tautkan pembayaran edge ke order cloud yang ada ("adopt"), idempoten, tanpa bayar ganda, tanpa order kedua, total uang cloud = edge.

Baca: `docs/design/edge-order-ingest.md` (R1-R4, bagian `order_exists` l.76-83), `edge/order-ingest.ts`, `services/qr-order-consumers.ts` (l.11, 513, 803, 848), `routes/payment-webhook.routes.ts`, `db/schema/pos-order.ts` l.231-310, `test/edge-order-ingest.test.ts:1036`.

Tulis ke bagian baru di `docs/design/edge-order-ingest.md` ("Adopt order QR (legend-dy7pc)"): aturan adopt (status existing, total sama payload, belum ada tender, kunci idempoten di `edge_order_ingests`), perlakuan intent/payment link QR yang masih terbuka (batalkan? tolak webhook susulan?), webhook datang SESUDAH adopt (guard `awaiting_payment` consumer), pembayaran ganda (QRIS sudah lunas di cloud + edge juga ambil uang: tolak adopt, catat konflik), jurnal/stok/loyalti/receipt number (R3), migrasi bila perlu. Daftar keputusan bisnis yang terbuka, dan pilihan aman bila ragu (membatasi pembayaran). Jangan ubah kode.
