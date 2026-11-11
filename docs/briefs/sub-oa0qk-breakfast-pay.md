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

### Pembagian v2 (I3 kena batas giliran; dipecah)
Sudah ada: `apps/api/src/services/facility-breakfast-money.ts` (lockBreakfastOrder, requestBreakfastRefund, cancelBreakfastOrderTx,
fireBreakfastOrderTx, breakfastLines). Impor dari sana, jangan duplikasi. Kecuali I3, jangan edit file itu (minta lewat laporan).
- I3 (lanjut): selesaikan money.ts; `services/facility-breakfast-consumers.ts` (`handleBreakfastPaymentPaid`, `handleBreakfastPaymentClosed`);
  cabang channel 'facility' di `order-payment-consumers.ts dispatchInTx`; sweep `fireDueBreakfastOrders` di `worker-main.ts` (pola sweepUnpaidQrOrders).
- I4: `services/facility-breakfast.service.ts` (menu, create + idempotency/fingerprint, pay = ensure link sekali + token sealed seperti
  qr-order-payment ensurePaymentLink, cancel/fire wrapper buka tx tenant + panggil *Tx dari money.ts, DTO ke `breakfastOrderSchema`);
  `routes/facility-breakfast.routes.ts` (member chain untuk /tickets/..., staf `facility.booth.operate` untuk /breakfast-orders/:orderId/fire);
  daftar di `routes/index.ts` sebelum facilityRouter.
- I5: guard app-level di `services/kds.service.ts routeFiredItemsToKitchen` (order channel 'facility' tanpa linked paid -> HttpError 409
  BREAKFAST_NOT_PAID); exhaustif channel di `services/kds-support.ts`, `services/pos-order-pricing.ts`, dan cari `OrderChannel`/channel switch
  lain di apps/api yang perlu 'facility'.

### Pembagian v3 (I4 kena batas tanpa menulis)
Signature tetap `services/facility-breakfast.service.ts` (I4):
- `getBreakfastMenuForMember(context, member: { customerProfileId: string }, ticketId: string, now?: Date): Promise<BreakfastMenu>`
- `createBreakfastOrderForMember(context, member, ticketId, body: CreateBreakfastOrderBody, now?): Promise<BreakfastOrder>`
- `payBreakfastOrderForMember(context, member, ticketId, orderId, body: { idempotencyKey }, now?): Promise<{ order: BreakfastOrder; paymentToken: string | null }>`
- `cancelBreakfastOrderForMember(context, member, ticketId, orderId, body: { idempotencyKey }, now?): Promise<{ order: BreakfastOrder; refundIdr: number }>`
- `fireBreakfastOrderByStaff(context, actorUserId: string, orderId, body: { idempotencyKey }, now?): Promise<BreakfastOrder>`
Error: lempar HttpError / FacilityError dengan kode brief. Ticket bukan milik member -> 404 NOT_FOUND.
I6: `routes/facility-breakfast.routes.ts` + registrasi `routes/index.ts` memakai signature di atas (parse body/params dengan schema shared, balas `{ data }`).

### Keputusan sweep unpaid (engineer, setelah run test 1)
Order `awaiting_payment` yang lewat fire_at TIDAK dibatalkan langsung: tamu masih boleh bayar sampai sesi tiket berakhir (`access_tickets.ends_at`);
bila lunas setelah fire_at, sweep berikut langsung mengirim. Sweep membatalkan order unpaid hanya bila now >= ends_at tiket atau tiket mati
(DEAD_TICKET_STATUSES). Pembayaran yang datang setelah batal -> refund penuh (sudah ada).

### Temuan architect (HEAD 1bdcffbc) -> perbaikan
- A (money.ts + accounting): (1) fire tidak membukukan penjualan: emit `order.paid` seperti `appendQrOrderPaid` + `recordTaxSnapshots` bila taxResult ada;
  tambah 'facility' di guard akuntansi `accounting-auto-journal-guards.ts:462,849`, `accounting-auto-journal-amounts.ts:872`. Pajak sarapan (order dibuat
  tanpa taxResult) -> JANGAN ubah harga; laporkan sebagai follow-up. (2a) `cancelBreakfastOrderTx` menutup link bayar (`cancelPaymentLinkInTx`) di semua batal.
  (6) catat saja.
- B (service + consumers): (2b) pay menolak tiket mati / sesi berakhir -> 422 BREAKFAST_UNAVAILABLE; (4) sweep tidak macet oleh baris yang selalu gagal
  (mis. urut fire_at lalu updated_at, bump updated_at saat gagal, log). Jangan edit money.ts.
- C (SQL + KDS): (3) trigger + `assertBreakfastPaid` hanya terima status 'fired' (paid_at NOT NULL); (7) trigger item `BEFORE INSERT OR UPDATE OF order_id,
  order_item_id, ticket_id`. Edit 0321 + kds.custom.sql + kds.service.ts. db:generate tetap kosong.
- D test-writer: ubah test kontrol "trigger lets a paid order through" -> hanya 'fired' lolos, 'paid' ditolak; test pay setelah batal / tiket berakhir -> 422
  dan link tertutup; test fire menulis event order.paid. File test breakfast saja.

### Temuan reviewer (271ccdc3) -> perbaikan E
- Lock order: konvensi repo link -> intent (`pos-order-payment.ts:601,934`, komentar `cancelPaymentLinkInTx`). Di `fireBreakfastOrderTx`
  (cabang ticketDead / reserved>0) dan cabang `refuse` consumer, link dikunci SETELAH intent -> deadlock 40P01 dengan konfirmasi webhook.
  Perbaikan: kunci baris `payment_links` FOR UPDATE sebelum lock intent di kedua jalur (urutan: order -> linked -> link -> intent).
- Sweep: kandidat unpaid hanya yang tiketnya mati atau now >= ends_at (join di query `dueOrderIds`), supaya baris unpaid yang belum boleh
  dibatalkan tidak memenuhi batch 100.
- Satukan `DEAD_TICKET_STATUSES` (satu sumber, di money.ts; consumers & service impor dari sana).
