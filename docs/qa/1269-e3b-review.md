# Review K E3b gerbang tulis cloud (ws/1269-e3b 89ac8f635 vs 4f4354c2b)

Reviewer: architect (Opus), 26 Nov. Test tidak dijalankan reviewer. Hasil: **GAGAL**, satu perbaikan kecil sebelum merge (W1). W2 dan W3 berupa kartu dan keputusan CTO, tidak menahan merge.

## Aman
- Semua route di brief tergerbang lewat `assertPosWriteNotOnEdge`, jadi F3 cukup diubah di satu tempat. Route itu ada di pos-order (7), pos-shift (4), order-customer, receipt (3), acting-staff (2), kds (7, konfigurasi stasiun tidak ikut), recovery (3 + semua charge), table-links (di service), dan delivery manual/status/map-lines.
- Gerbang dipasang sesudah permission guard. Target di luar scope dilewatkan ke 403/404 milik route (`assertTargetOutletNotOnEdge`), jadi R1 terpenuhi. Test R1 mencakup semua route baru.
- Recovery digerbang seluruhnya, termasuk refund gateway. Ini sesuai keputusan CTO (menulis baris swap dan KDS milik edge). Kartu P2 legend-y0qg5.
- `/day/close` dan receipt write-off tidak digerbang. Ini sesuai handoff.
- Webhook delivery tidak menulis dobel. Hanya cloud yang menerima webhook dan menulis order itu. Nomor pickup berprefix platform dihitung dari order cloud per channel. Ingest edge tidak menyentuh `kitchen_tickets`.

## Wajib
- W1 (SEDANG, sebelum merge) Voucher permintaan maaf belum punya test yang diminta keputusan CTO ("tidak ada efek ke baris milik edge dan tidak dobel").
  - Masalah: `cloudWrites` di `apps/api/src/test/pos-write-on-edge-gate.test.ts` mengirim body tanpa Idempotency-Key. Responsnya 422, jadi test lolos tanpa menguji apa pun.
  - Perbaikan: tambah test untuk outlet dengan edge aktif:
    - Voucher dengan `orderIssueId` atas order hasil ingest edge mendapat 201.
    - Replay mengembalikan voucher yang sama, dan tetap hanya ada satu voucher.
    - Baris `orders`, `pos_orders`, `kitchen_tickets`, shift, dan kas tidak berubah.
  - Rujuk `refund-1095-void-voucher.test.ts` untuk void edge sesudah voucher.
  - Risiko sisa, dicatat di kartu 567 atau P2: voucher sudah dipakai di outlet cloud, lalu edge me-refund order offline. Ingest menolak (`apology_voucher_exists`), tapi uang laci sudah keluar. Ganti rugi dobel hanya terdeteksi, tidak tercegah.
- W2 (SEDANG, sebelum gerbang rilis edge) Delivery di outlet edge buntu.
  - Masalah:
    - Webhook tetap membuat order dan tiket KDS di cloud, lalu auto-accept ke platform.
    - KDS edge tidak pernah melihat tiket itu karena tidak ada replikasi order cloud ke edge.
    - E3b kini juga menolak bump KDS cloud dan status delivery.
    - Akibatnya pesanan diterima tapi tidak bisa dimasak atau diperbarui.
  - Aturan membatasi: untuk outlet dengan edge aktif, webhook tidak meng-inject dan tidak meng-accept (platform membatalkan sendiri), atau channel delivery tidak boleh aktif. Berlaku sampai ada kartu "delivery di edge". Perlu keputusan CTO dan kartu bd.
- W3 (SEDANG, kartu) Fitur mati di outlet edge.
  - Masalah: `/api/table-links`, `/api/pos/orders/:id/customer`, `/api/outlets/:id/delivery-orders`, dan route recovery tidak ada di `EDGE_API_PREFIXES` (`apps/api/src/edge/mode.ts`). Sesudah E3b keempatnya ditolak di edge (404) dan di cloud (409).
  - Arahnya benar: sebelum E3b, cloud menulis baris milik edge.
  - Perbaikan: buat kartu P2 untuk table-links, order-customer, dan delivery, seperti legend-y0qg5.

## Rendah
- R1 `POST /api/outlets/:outletId/orders/:orderId/issues` (`routes/order-issues.routes.ts:51`, KDS-07) tidak ada di brief dan tidak digerbang.
  - Isinya catatan cloud: log, stok, voucher inline. Refund manual sudah ditolak untuk order hasil ingest edge (`EDGE_ORDER_CORRECTION_BLOCKED`).
  - Perbaikan: biarkan terbuka, tapi tulis keputusannya dan masukkan ke `cloudWrites`. Voucher inline ikut diuji di W1.
- R2 Kasus berikut tidak bisa diselesaikan sesudah outlet di-enroll, dan uang tamu tertahan (outlet tidak rugi):
  - charge yang sudah dibayar sebelum enroll;
  - refund manual berstatus `requested`.

  Catat di legend-y0qg5. Belum diverifikasi: `order-recovery-charge-payment.ts` (webhook pembayaran charge lama) mungkin masih menembak swap ke KDS cloud.
- R3 `/api/staff-pins/pos-session/end` digerbang. Sesi acting-staff cloud yang tersisa sebelum enroll tidak bisa diakhiri dan hanya habis lewat TTL (TTL belum dicek).

## Keputusan CTO 26 Nov

1. W1: wajib. Tambah test voucher permintaan maaf di outlet beredge (pakai Idempotency-Key): 201, kirim ulang = voucher yang sama, baris order/pos_order/KDS/shift/kas tidak berubah.
2. W2: ambil aturan yang membatasi untuk rilis 1. Outlet beredge: webhook delivery tidak meng-inject order dan tidak meng-accept (platform membatalkan sendiri), catat log + alert ke outlet. Dikerjakan di E3b. Kartu P1 terpisah: kirim order delivery ke edge lewat `edge_cloud_commands`, wajib sebelum outlet beredge membuka delivery.
3. W3: kartu P2 untuk table-links, order-customer, delivery (recovery sudah legend-y0qg5). Fitur ini tidak tersedia di outlet beredge sampai kartunya selesai; dicatat di runbook F7.
4. KDS-07 `orders/:orderId/issues` boleh terbuka di cloud: hanya catatan cloud, tidak menulis baris milik edge.
5. Risiko voucher lalu refund offline di edge: dicatat di kartu 567 (deteksi sekarang, cegah kemudian).
6. Charge recovery/refund manual `requested` yang macet sesudah enroll dan `pos-session/end`: dicatat sebagai P3; runbook enroll F7 wajib menyelesaikan refund `requested` sebelum enroll.

## Re-review 26 Nov (687f074d8)

Reviewer: architect (Opus). Delta 89ac8f635..687f074d8. Isi merge int/rc2 090ea0a4e diabaikan; merge itu tidak mengubah route yang digerbang dan tidak menambah route tulis POS (hanya admin WFC). Test tidak dijalankan reviewer. Hasil: **LULUS** untuk merge.

### Temuan lama
1. W1 voucher: **tertutup**, sesuai Keputusan CTO no. 1.
   - Test baru di `test/pos-write-on-edge-gate-recovery.test.ts`. Outletnya punya edge aktif dan request memakai Idempotency-Key.
   - Approval dulu, lalu 201. Kirim ulang menghasilkan id dan kode yang sama, dan `apology_vouchers` hanya +1.
   - Snapshot md5 tabel `orders`, `order_items`, `pos_orders`, `kitchen_tickets`, `pos_shifts`, dan `cash_movements` tidak berubah.
2. W2 webhook delivery: **tertutup**, sesuai Keputusan CTO no. 2.
   - Di `services/delivery-ingest.service.ts`, outlet beredge melewati jalur `storeWithoutInjection`: pesanan disimpan berstatus `received` dengan `orderId` null, tanpa `orders`/`pos_orders`/KDS, dan tanpa accept.
   - Log hanya memuat id. Alert ke supervisor dan owner dikirim sekali per pesanan (hanya bila `!existing`).
   - Kirim ulang pesanan yang sudah di-inject sebelum enroll tidak mencoba accept lagi.
   - Tidak ada jalur lain yang meng-inject atau meng-accept: `autoAccept` tidak menjadwalkan retry, dan map-lines serta manual sudah 409.
   - Cek memakai `posWritesOnEdge`, yang juga dipakai `assertPosWriteNotOnEdge`, jadi F3 tetap diubah di satu tempat.
   - Test ada di `test/delivery-webhook-db.test.ts`: pesanan baru dan replay pesanan dari sebelum enroll.
3. W3: kartu dicatat di commit (legend-8ltyz, legend-fzsru, legend-ojq20, legend-erfme). Keberadaannya di bd belum dicek reviewer.

### Temuan baru (RENDAH, tidak menahan merge)
- R4: test W1 memakai voucher mandiri. Varian `orderIssueId`, yang menyelesaikan issue dan menautkan voucher ke order, tidak diuji di outlet beredge. Keputusan CTO tidak memintanya; cukup dicatat di kartu 567 bersama risiko voucher lalu refund offline.
- R5: pesanan yang di-inject di menit-menit sekitar enroll tetap ada di KDS cloud. Bump dan status di cloud sudah ditolak, jadi pesanan itu buntu sampai platform membatalkannya. Masuk runbook enroll F7: tutup channel delivery dan selesaikan pesanan terbuka sebelum enroll.
