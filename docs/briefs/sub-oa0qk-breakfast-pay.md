# Sub-brief oa0qk: sarapan tiket wajib lunas sebelum dapur

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/breakfast-pay (cabang ws/breakfast-pay). Kerja HANYA di sini.
Tingkat K (uang). Migrasi baru hanya nomor 0321-0322 (apps/api/drizzle). Jangan jalankan tsc/vitest kecuali diminta; heavy dipegang satu subagent.

## Konteks
- UI ijv8 (commit 47304aa5) sudah lolos gerbang founder. Tipe + endpoint mock ada di
  apps/web/src/features/facility/breakfast.ts (TODO pindah ke packages/shared), api.ts, hooks.ts, queries.ts, mock.ts, flow.ts,
  components/breakfast-section.tsx. Endpoint: GET /api/facility/tickets/:ticketId/breakfast-menu,
  POST /api/facility/tickets/:ticketId/breakfast-orders. Status sekarang: held|fired. fireAt = slot.endsAt - fireOffsetMinutes.
- Keputusan founder Q43: sarapan dari tiket WAJIB lunas sebelum dikirim ke dapur/KDS.

## Wajib
1. Kontrak shared (packages/shared/src/facility...) untuk tipe+endpoint; web pakai tipe shared.
2. API pesan + bayar; kirim ke dapur/KDS ditolak bila belum paid (kode error jelas). Idempotency bayar & kirim.
3. Tidak ada jalur lain (retry, edge sync, captain, resend, worker) yang memasukkan pesanan sarapan belum lunas ke KDS.
4. Test uang: belum bayar tak pernah di KDS; bayar ganda tak menagih dua kali; batal setelah bayar refund <= dibayar;
   konkurensi dua koneksi bayar+kirim bersamaan.

## Desain (final, engineer)

Fakta: route tiket fasilitas belum ada di API (web masih mock). KDS satu pintu: `apps/api/src/services/kds.service.ts:250 routeFiredItemsToKitchen`
(caller: pos-order fireLines, qr-order fireQrOrder + open-bill, delivery-inject, order-recovery-swap-kitchen). Pola tahan-sampai-bayar
sudah ada di QR (`qr-order.service.ts:1956` payFirst, `qr-order-payment.ts ~165 ensurePaymentLink`, `qr-order-consumers.ts:506 handleQrOrderPaymentPaid`,
`:781 requestQrDoublePaymentRefund`, `:867 sweepUnpaidQrOrders`). Routing event bayar: `order-payment-consumers.ts:98 dispatchInTx` by `orders.channel`.
Worker sweep per tenant: `worker-main.ts:398-425,665`. Member auth: `middleware/member.ts requireMember` + `getMemberScope(req)` (chain di `member.routes.ts:5`).

### Model
- Pesanan sarapan = baris `orders` (schema `db/schema/qr-order.ts:185`) channel BARU `'facility'`, paymentMode `pay_first`, status `awaiting_payment`,
  serviceType `dine_in` (meja) / `takeaway` (pickup), `customerProfileId` = pemilik tiket, + `order_items` fireStatus `held`. Harga dari server (menu outlet tiket).
  Tidak ada baris `pos_orders`.
- Tabel baru `facility_linked_orders` (export `facilityLinkedOrders` di `db/schema/facility.ts`):
  id uuid pk defaultRandom; tenant_id; outlet_id; facility_id uuid; access_ticket_id uuid NOT NULL; order_id ulidInUuid NOT NULL;
  status varchar(20) CHECK IN ('awaiting_payment','paid','fired','cancelled'); delivery jsonb NOT NULL; subtotal_idr, total_idr idr NOT NULL (>=0);
  paid_idr idr NOT NULL default 0; paid_intent_id uuid NULL; paid_at timestamptz NULL; fire_offset_minutes int CHECK 0..240; fire_at timestamptz NOT NULL;
  fired_at NULL; cancelled_at NULL; refunded_idr idr NOT NULL default 0; idempotency_key varchar(120) NOT NULL; request_fingerprint varchar(64) NOT NULL;
  created_at, updated_at.
  Unik: (tenant_id, order_id); (tenant_id, access_ticket_id) WHERE status <> 'cancelled'; (tenant_id, access_ticket_id, idempotency_key).
  CHECK: status IN ('paid','fired') => paid_at NOT NULL AND paid_intent_id NOT NULL AND paid_idr = total_idr; status='fired' => fired_at NOT NULL;
  refunded_idr <= paid_idr; status='cancelled' => cancelled_at NOT NULL. RLS tenant seperti tabel facility lain.
- Trigger DB (backstop semua jalur): `kitchen_tickets` BEFORE INSERT -> bila `orders.channel='facility'` untuk NEW.order_id (filter tenant) dan TIDAK ada
  `facility_linked_orders` order_id=NEW.order_id dengan paid_at NOT NULL AND status IN ('paid','fired') -> RAISE ... USING ERRCODE='23514',
  CONSTRAINT='kitchen_tickets_breakfast_paid'. Pola: `db/schema/kds.custom.sql:11-20`, `crm-rewards.custom.sql:80`.
- Widen `orders_channel_check` (pola `pos-order.custom.sql:10-19`) + tambah `'facility'`. Migrasi: `apps/api/drizzle/0321_facility_breakfast_pay.sql`
  (hasil db:generate di-rename ke 0321 + SQL custom di depan/belakang; journal tag ikut). Nomor 0322 cadangan.

### Kontrak shared (`packages/shared/src/facility/breakfast.ts`, export dari index facility)
Pindahkan isi `apps/web/src/features/facility/breakfast.ts` + ubah:
- `breakfastOrderStatusSchema = z.enum(["awaiting_payment","paid","fired","cancelled"])` ("paid" = lunas, menunggu fireAt; dulu "held").
- `breakfastOrderSchema` tambah: `totalIdr` (yang dibayar tamu), `paidAt: isoDateTime|null`, `firedAt: isoDateTime|null`. `id` = orderId (ULID).
- Endpoint (semua body punya `idempotencyKey`):
  - `getBreakfastMenu` GET `/api/facility/tickets/:ticketId/breakfast-menu` (member).
  - `createBreakfastOrder` POST `/api/facility/tickets/:ticketId/breakfast-orders` (member) -> order `awaiting_payment`.
  - `payBreakfastOrder` POST `/api/facility/tickets/:ticketId/breakfast-orders/:orderId/pay` (member) -> `{ order, paymentToken: string|null }`
    (token link bayar `pl_...` untuk `/bayar/$token`; null bila sudah lunas). Link dibuat sekali, dipakai ulang.
  - `cancelBreakfastOrder` POST `.../breakfast-orders/:orderId/cancel` (member) -> `{ order, refundIdr }`.
  - `fireBreakfastOrder` POST `/api/facility/breakfast-orders/:orderId/fire` (staf, `facility.booth.operate`) -> order. Kirim sekarang.
- Kode error baru di `packages/shared/src/facility/errors.ts`: `BREAKFAST_NOT_PAID: 409`, `BREAKFAST_ORDER_EXISTS: 409`,
  `BREAKFAST_ALREADY_FIRED: 409`, `BREAKFAST_ORDER_CANCELLED: 409`, `BREAKFAST_UNAVAILABLE: 422`.
- `ORDER_CHANNELS` (`packages/shared/src/pos/schemas.ts:128`) tambah `"facility"`.

### Aturan uang (jangan sampai rugi)
- Bayar: tanda lunas HANYA dari event `payment.paid` terverifikasi (cabang baru di `dispatchInTx` untuk channel 'facility' -> `handleBreakfastPaymentPaid`
  dalam tx consumer). Lock `orders` FOR UPDATE lalu linked order FOR UPDATE. Lunas bila status awaiting_payment dan dibayar == total_idr.
  Pembayaran kedua/terlambat (status sudah paid/fired/cancelled, atau intent beda) -> refund PENUH intent itu (pola requestQrDoublePaymentRefund). Tidak pernah dua tanda lunas.
- Kirim ke dapur (sweep worker `fireDueBreakfastOrders` saat now >= fire_at, dan endpoint fire): lock linked order FOR UPDATE; status harus 'paid'
  (else 409 BREAKFAST_NOT_PAID; 'fired' -> idempoten balikan order; 'cancelled' -> 409 BREAKFAST_ORDER_CANCELLED). Set status 'fired'+fired_at, orders
  status 'sent'+firedAt, items fireStatus 'fired', lalu `routeFiredItemsToKitchen(onUnresolved:'skip')`. Cek app-level juga di routeFiredItemsToKitchen
  (channel facility belum lunas -> HttpError 409 BREAKFAST_NOT_PAID) supaya kode error jelas sebelum trigger.
- Batal (member): awaiting_payment -> cancelled (void order, refund 0). paid & belum fired -> cancelled + refund paid_idr - refunded_idr atas paid_intent_id
  (pakai jalur refund yang ber-cap `refundableBalance`, lihat `payment-admin.service.ts:74,477`, `payment-refund.service.ts:475`); refunded_idr naik sekali.
  fired -> 409 BREAKFAST_ALREADY_FIRED. Batal ulang -> idempoten, refund 0.
- Idempotency: create (key+fingerprint di linked order; replay -> order sama; key sama payload beda -> 409 IDEMPOTENCY_KEY_REUSED), pay (link sekali),
  fire/cancel (status machine + lock = idempoten). Pola fingerprint/advisory: `services/operations-idempotency.ts:41-78`.
- Ticket: milik member (customerProfileId), status issued/in_use, now < fire_at, else 422 BREAKFAST_UNAVAILABLE. fire_at = ends_at - fireOffsetMinutes
  (`linkedOrderFireAt` shared machines.ts:241). fireOffsetMinutes default 15 (konstanta, catat TODO config).

### Pembagian (file tidak bertumpuk)
- I1 shared+web: packages/shared/src/facility/{breakfast.ts,errors.ts,index.ts}, packages/shared/src/pos/schemas.ts, apps/web/src/features/facility/**
  (breakfast.ts jadi re-export atau dihapus + impor diganti; mock.ts endpoint baru+status; breakfast-section: status awaiting_payment tampil tombol
  "Bayar sarapan" -> payBreakfastOrder -> navigasi `/bayar/$token`; status cancelled), i18n facility-breakfast.ts, tests/legend-ijv8-breakfast.test.mjs bila impor berubah.
- I2 DB: apps/api/src/db/schema/facility.ts (+facility.custom.sql), kds.custom.sql, pos-order.custom.sql (komentar channel), apps/api/drizzle/0321*, meta/_journal.json, meta snapshot.
- I3 API: apps/api/src/services/facility-breakfast.service.ts (baru), services/facility-breakfast-consumers.ts (baru), routes/facility-breakfast.routes.ts (baru),
  routes/index.ts, services/order-payment-consumers.ts, worker-main.ts, services/kds.service.ts, services/kds-support.ts + pos-order-pricing.ts (exhaustif channel).
- T test-writer: apps/api/src/test/facility-breakfast-pay.test.ts + facility-breakfast-concurrency.test.ts.

### Heavy
Implementer TIDAK menjalankan tsc/vitest/db:generate kecuali I2 (db:generate, sekali, lewat `heavy`). test-writer boleh satu run gagal-dulu lewat `heavy`.
Engineer menjalankan gate setelah gabung.
