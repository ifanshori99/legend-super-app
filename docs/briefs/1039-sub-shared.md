# 1039 POS 936 backend: konteks bersama subagent (legend-hpgyw)

Worktree: /Users/ifanshori99/Projects/legend super app/legend-8eb871ce (cabang ghostex/8eb871ce, sudah memuat UI 936). Brief induk: /Users/ifanshori99/Projects/legend super app/legend/docs/briefs/1039-pos-936-backend.md. Daftar kontrak web: apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md. Tipe web lokal: apps/web/src/features/ws04-pos-kasir/types.ts (VoucherCheck, PointsAccount, PointsQuote, PaymentBill.voucher, AttemptStatus "declined", edc.declineReason/responseCode) dan fungsi `api.ts` (applyVoucherCode, removeVoucherCode, fetchPointsAccount, quotePointsValue, redeemPointsValue) + `ticket/api.ts` (sellTicket, printTicket) yang sekarang `contractPending` di luar mock.

## Aturan uang (wajib, founder: jangan sampai rugi)

- Server hitung semua: potongan, nilai poin, pajak + service setelah potongan, total, sisa. Klien hanya menampilkan.
- Potongan voucher/poin TIDAK melebihi SISA TAGIHAN (total dikurangi tender yang sudah teralokasi), bukan hanya subtotal. Ragu: pilih aturan yang membatasi pembayaran.
- Pembulatan nilai poin ke bawah (tamu tidak dibayar lebih). Tamu tidak dipotong/dibayar lebih; outlet tidak rugi (GL seimbang).
- Voucher dan poin tidak terpakai ganda: dua permintaan bersamaan (Promise.all) dan replay (kunci idempotensi sama) menghasilkan SATU efek. Kunci berbeda untuk niat yang sama tidak boleh melepas dua kali.
- Semua query difilter tenant + outlet (RLS/FORCE RLS dipakai proyek; ikuti pola service POS yang ada). Test: tenant/outlet lain ditolak (404/403 sesuai pola).
- Izin baru: daftarkan di katalog izin root + label teks (lihat engineer.md "Katalog dan registry silang").

## Pembagian bagian (satu pemilik per file)

- A voucher: hardening `applyPosDiscount`/`removePosDiscount` (apps/api/src/services/pos-order-discounts.ts, pos-order-support.ts repriceOrder) agar batas = sisa tagihan, pajak+service dihitung ulang, release hanya voucher itu, aman saat bersamaan. Web memakai endpoint discount source "voucher" yang sudah ada. Tanpa migrasi bila tidak perlu.
- B poin: port `PosPointsTenderPort` (apps/api/src/services/pos-order-ports.ts:176, dipasang di app.ts) diisi implementasi nyata lewat point-ledger.service (debit ledger idempotent, nilai poin dari loyalty program, jurnal GL, link order -> member). Route baru di file baru apps/api/src/routes/pos-points.routes.ts (satu baris registrasi di routes/index.ts):
  - GET /api/pos/orders/:orderId/points -> { account: { memberId, memberName, balancePoints, minRedeemPoints, maxRedeemPoints } | null } (null = order tanpa member; maxRedeemPoints = min(saldo, poin setara sisa tagihan))
  - POST /api/pos/orders/:orderId/points/quote body { points } -> { points, valueIdr }
  - POST /api/pos/orders/:orderId/points/redeem body { points, idempotencyKey } -> sama bentuk dengan getPosOrder (order terbaru dengan alokasi tender "points")
    Validator di packages/shared/src/pos/points.ts (+ export di package.json). Migrasi kerja 0670 bila perlu.
- C EDC ditolak: attempt EDC status `declined` (kolom responseCode dan message sudah ada di db/schema/edc.ts; declineReason = message), tagihan TIDAK berubah (tak ada tender, sisa sama, order tetap bisa dibayar metode lain/ulang), sesi pembayaran (yang dipakai web) memuat status declined + declineReason + responseCode. Cari jalur tulis (EDC agent/ECR hasil) dan jalur baca (getPosOrder / payment attempts). Migrasi kerja 0672 hanya bila kolom perlu.
- D tiket fasilitas: tiket = item biasa di tagihan POS (alur bayar/refund/shift/pajak yang ada). Tiket TIDAK terbit sebelum order lunas; terbit saat order paid (semua jalur lunas: tunai, QRIS, EDC, poin, split); refund/void order membatalkan tiket (status refunded/cancelled, slot dilepas, entitlement dibalik). `sellAccessTicketAtPos` (POST /api/facility/tickets/pos) tidak boleh menerbitkan tiket sebelum lunas: ubah menjadi menambah item ke tagihan POS dan mengembalikan order + tiket `pending_payment`. Ikuti preseden sarapan fasilitas (migrasi 0279, facility-breakfast-consumers.ts) untuk "order paid -> terbitkan". Migrasi kerja 0671 (tabel link item -> tiket) bila perlu. Cetak tiket lewat Print Agent: pola pos-receipt-edge-print.ts.
- Web (setelah backend): ganti mode mock dengan API nyata di api.ts dan ticket/api.ts, hapus baris CONTRACT-GAPS yang tertutup. Dikerjakan terakhir oleh satu implementer.

## Aturan kerja subagent

- Migrasi: nomor kerja 0670-0673 hanya sebagai nama berkas/journal sementara bila memang perlu; FK tabel baru inline di CREATE TABLE (bukan ALTER ADD CONSTRAINT); tabel baru masuk tes cakupan tabel dan apps/api/src/test/data-import-registry.test.ts. Jangan `db:generate` bila tidak ada perubahan skema. Jangan menimpa migrasi yang sudah diterapkan.
- Test API: apps/api/src/test/pos-936-<bagian>.test.ts, ID ULID, brand type helper (TenantId, OutletId). Jalankan dengan `LEGEND_TEST_FILES="src/test/<file>" heavy pnpm test` dari root worktree.
- SATU TOKEN HEAVY per thread: sebelum menjalankan vitest/tsc, ambil kunci `mkdir /private/tmp/claude-501/legend-8eb871ce-heavy.lock` (ulangi tiap 10 detik sampai berhasil), lepas dengan `rmdir` segera setelah selesai. Jangan menjalankan tsc penuh (saya yang menjalankan sekali).
- Hanya sunting file milik bagianmu. File bersama (routes/index.ts, packages/shared exports, katalog izin): sunting satu baris saja dengan Edit, jangan menulis ulang berkas.
- Format: `pnpm exec prettier --write <berkas>`; `pnpm exec eslint <berkas>`. Satu perintah sederhana per panggilan Bash.
- Jangan commit. Saya yang commit. Laporan 5-10 baris: berkas, perilaku, keputusan, celah.

## Kontrak D: tiket fasilitas (ditulis sub-D, langkah 1; belum diimplementasi)

Temuan kode: `POST /api/facility/tickets/pos` hanya ada sebagai kontrak (shared/facility/endpoints.ts); route dan service jual/terbit/batal tiket TIDAK ada (hanya `holdFacilitySlot`, `cancelFacilitySlotHold`, sweeper di facility-slots.service.ts; kredensial QR/PIN belum punya kolom, bead legend-bzih). Satu-satunya jalur lunas POS = `completePosOrder` (pos-order.service.ts ~1263; semua tender: tunai, QRIS, EDC, poin, split lewat jalur ini). Void sebelum lunas: `voidPosOrder`, `voidPosOrderItem`; sesudah lunas: `voidPosOrderCorrection`, `refundPosOrder` (pos-order-corrections.ts). Harga baris POS datang dari daftar harga menu (`loadPosCatalogue`), `order_items.menu_item_id` NOT NULL FK ke menu_items.

Validator shared: `packages/shared/src/pos/ticket.ts` (subpath `@starter/shared/pos/ticket`, sudah ditulis, prettier+eslint lolos): `posTicketSaleSchema`, `posOrderTicketSchema`, `posTicketLineStatusSchema`, `posTicketPrintSchema`, `issuePosTicketCredentialBodySchema`, endpoint `listPosOrderTickets`, `issuePosTicketCredential`. Saat implementasi: `sellAccessTicketAtPos` di facility/endpoints.ts ganti `response` ke `dataResponseSchema(posTicketSaleSchema)` (impor dari ../pos/ticket.ts, tanpa siklus).

### Keputusan (default membatasi pembayaran; CTO konfirmasi sebelum implementasi)

- D1 Baris tagihan: baris tiket = item POS biasa dengan `menu_item_id` = `facility_products.menu_item_id` produk itu. Produk tanpa menuItemId: 422 `TICKET_PRODUCT_NOT_SELLABLE_AT_POS` (tidak menambah kolom/admin baru). Harga = harga daftar POS (channel takeaway), klien tidak kirim harga; tidak ada cek sama dengan `priceIdr` produk (layar membaca harga dari order). Akibat web: filter `menuItemId === null` di ticket/api.ts harus dibalik.
- D2 Jual selalu membuat order POS BARU (channel pos, takeaway, 1 baris qty 1). Tidak ada tambah-item ke order yang ada (POS belum punya endpoint itu).
- D3 Terbit saat lunas di `completePosOrder`; tiket di sebelum itu `pending_payment`, tidak ada kredensial.
- D4 Kredensial QR/PIN tidak disimpan plaintext (aturan di accessTicketCredentialSchema): hanya digest. Dibuat saat cetak/tampil (`.../credential`), tiap panggilan kunci baru memutar kredensial (yang lama mati).
- D5 Refund tiket yang sudah dipakai (`in_use`/`completed`/`no_show`): ditolak 409 `TICKET_ALREADY_USED` (tamu tidak dibayar lebih). Keputusan founder bila ingin kebijakan lain.
- D6 Hold POS 30 menit (bukan 10 menit tamu): tambah `holdMinutes` opsional (1..60) di `holdSlotInputSchema`.

### Route

1. `POST /api/facility/tickets/pos` (ada di shared, route baru di facility.routes.ts; izin `pos.sale.create` pada outlet fasilitas + `requireTenantContext`, outlet dari fasilitas)
   - Body: `staffSellTicketSchema` apa adanya (facilityId, areaId, unitId?, productId, customerProfileId, timing, addonIds?, issuedOffline?, idempotencyKey). `issuedOffline: true` ditolak 422 (jual POS harus online); `addonIds` non-kosong ditolak 422 (belum ada harga addon di tagihan).
   - Respons 200: `{ data: { ticket (status pending_payment, holdExpiresAt = now+30m), order: PosOrderDetail (status open, 1 baris tiket) } }`.
   - Idempotensi: kunci sama + sidik jari sama = order dan tiket yang sama (satu hold, satu tagihan, replay dan Promise.all); kunci sama beda isi = 409 `IDEMPOTENCY_KEY_REUSED`.
   - Error: 404 fasilitas/produk/pelanggan/area (tenant/outlet lain = 404), 409 `SLOT_UNAVAILABLE`, `UNIT_NOT_BOOKABLE`, `FACILITY_CLOSED`, 422 produk tidak aktif / bukan `single` / tanpa menuItemId, 409 hari bisnis ditutup (pola createPosOrder).
2. `GET /api/pos/orders/:orderId/tickets` (izin `pos.order.view`): `{ data: { tickets: PosOrderTicket[] } }`; order outlet/tenant lain = 404.
3. `POST /api/pos/orders/:orderId/tickets/:ticketId/credential` (izin `pos.sale.create`), body `{ idempotencyKey }` -> `{ data: { credential, print } }`. Hanya tiket `issued`; `pending_payment` = 409 `TICKET_NOT_PAID`; cancelled/refunded = 409 `TICKET_TRANSITION_INVALID`; kunci yang sama diulang = 409 `TICKET_CREDENTIAL_SHOWN`. Cetak lewat Print Agent bila edge (pola pos-receipt-edge-print.ts, `enqueueTicketOnEdge` baru), di cloud `print` berisi null dan `reprint` false.

### Migrasi kerja 0671 (FK inline di CREATE TABLE; RLS + FORCE RLS seperti 0279/facility.custom.sql; tabel masuk tes cakupan tabel dan data-import-registry.test.ts)

- `facility_ticket_pos_lines`: id uuid pk, tenant_id, outlet_id, facility_id, access_ticket_id (ULID in uuid), order_id, order_item_id, status ('pending','issued','cancelled','refunded'), line_total_idr bigint >= 0 (snapshot harga baris), issued_at, cancelled_at, refunded_at, created_at, updated_at. UNIQUE(tenant, access_ticket_id), UNIQUE(tenant, order_item_id). FK komposit ke access_tickets, orders, order_items, facilities.
- `access_ticket_credentials`: tenant_id, access_ticket_id (pk bersama tenant), qr_digest, pin_digest, version int, valid_from, valid_until, minted_idempotency_key, revoked_at, created_at, updated_at; UNIQUE(tenant, qr_digest); FK komposit ke access_tickets. Tanpa plaintext.
- Drizzle: `db/schema/facility-pos-ticket.ts` (baru, export di schema/index.ts).

### Hook (file milik D, satu panggilan per titik)

- Baru `services/facility-pos-tickets.ts`: `sellPosTicket`, `listPosOrderTickets`, `issuePosTicketCredential`, `assertPosTicketsIssuable(tx, ctx, orderId, now)`, `issuePosTicketsForPaidOrder(tx, ctx, {orderId, now, actorUserId})`, `releasePosTicketsOfVoidedLines(tx, ctx, {orderId, itemIds|null, now, actorUserId})`, `refundPosTicketsOfRefundedLines(tx, ctx, {orderId, itemIds|null, now, actorUserId})`. Semua mengunci baris link FOR UPDATE dan filter tenant+outlet.
- PAID: di `completePosOrder`: `assertPosTicketsIssuable` sebelum `issueForSale` (tiket hold sudah dilepas sweeper: bila slot masih kosong hold dihidupkan lagi, bila tidak 409 `TICKET_HOLD_LAPSED` dan order tetap terbuka); `issuePosTicketsForPaidOrder` setelah update status order, sebelum `freshDetail`, satu transaksi: tiket `mark_paid` -> `issued`, link `issued`. Replay complete (kunci sama) tidak menerbitkan dua kali (UPDATE ... WHERE status='pending' RETURNING).
- VOID sebelum lunas (`voidPosOrder`, `voidPosOrderItem` pada baris tiket, lewat `voidLines`): tiket `cancel` -> `cancelled`, slot lepas, `notifyNextInQueue`, link `cancelled`. Sweeper `releaseExpiredSlotHolds` tetap jalan; order dengan tiket lapse tidak bisa complete.
- REFUND sesudah lunas: `voidPosOrderCorrection` (semua tiket order) dan `refundPosOrder` (hanya bila baris tiket ikut direfund) -> tiket `refund` -> `refunded` (issued) atau `cancelled`->`refunded`; credential `revoked_at` diisi; link `refunded`; status in_use/completed/no_show = 409 `TICKET_ALREADY_USED` SEBELUM uang bergerak. Tiket POS bersumber `purchase` tanpa ledger entitlement; bila `entitlement_ledger_id` terisi, panggil `cancelEntitlementsForSource` (dibalik).
- Izin: `pos.sale.create` dan `pos.order.view` sudah ada, tidak ada izin baru.

### Test D (pos-936-ticket.test.ts) harus membuktikan

Tiket tidak terbit sebelum lunas (tunai, QRIS, EDC, poin, split); terbit sekali saat lunas (replay + Promise.all complete = 1 tiket); harga baris = harga daftar POS dan total = baris + pajak/service dihitung server; void sebelum lunas melepas slot (jual ulang slot yang sama berhasil); refund penuh dan void koreksi membalik tiket + cabut kredensial + GL seimbang, tidak ada refund lebih dari yang dibayar; refund tiket terpakai ditolak; kredensial hanya setelah lunas, rotasi mematikan yang lama, replay kunci 409; tenant/outlet lain 404; produk tanpa menuItemId / nonaktif 422; slot bentrok dua penjualan bersamaan = satu berhasil.
