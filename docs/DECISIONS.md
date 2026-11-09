# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

## 2026-11-10: WS-11: HPP per baris pesanan saat penjualan (legend-u4js6)

Konteks: `order_items.cost_snapshot_idr` (bigint, nullable) sudah ada tapi tidak
ada insert yang mengisinya. Pembacanya `ai-metrics/sales.ts` dan reader WS-11
F3 (`metric-sources/menu-cogs.ts`) sudah menganggapnya "HPP seluruh baris saat
terjual" dan NULL = tidak diketahui. Ditinjau architect sebelum implementasi
(tingkat K, uang).

1. **Nilai = HPP total baris** (jumlah x HPP per porsi), rupiah bulat. Resep
   satu baris diledakkan dengan jumlah sebenarnya (bukan 1 porsi dikali jumlah),
   lalu jumlah bahan (Decimal4) x `avg_cost_idr` (Decimal4) dijumlah dalam skala
   penuh dan dibulatkan **sekali per baris**, setengah ke atas, lewat
   `scaledCostToIdr` (`inventory-ops.shared.ts`). Tanpa pembulatan per bahan.
2. **Sumber biaya: `stock_balances.avg_cost_idr` di lokasi jual outlet
   (`outlet_inventory_settings.sale_location_id`) pada saat baris dimasukkan**,
   di transaksi yang sama. Alasan: kolom ini "HPP teoretis saat terjual"
   (PRD), ditulis sekali bersama barisnya, tanpa jalur tulis kedua dan tanpa
   menyentuh konsumen `order.paid` milik `recipe-deduction.service.ts`. Biaya
   deduksi (`recipe_deductions.cost_idr`) boleh berbeda: real_time memakai
   rata-rata saat lunas, day_close saat tutup hari, dan deduksi dibulatkan per
   pesanan, bukan per baris. Selisih itu (pergerakan harga rata-rata, pembulatan,
   baris NULL) masuk ke baris residual `__ledger_adjustment__` WS-11; itu yang
   diharapkan, bukan bug. `recipes.theoretical_cost_idr` tidak dipakai (belum
   pernah diisi, default 0).
3. **Varian dan modifier ikut**, dengan aturan yang sama dengan deduksi: resep
   varian, kalau tidak ada resep menu; modifier add-on dan aturan
   add/replace/remove. Pesanan delivery menyimpan `modifiers: []`, jadi modifier
   platform tidak dihitung (hanya resep dasar). Batas yang diketahui.
4. **NULL, bukan 0**, untuk baris yang: menunya tanpa resep; resepnya tidak aktif
   atau rusak; outletnya tanpa lokasi jual; jumlahnya kurang dari 1; resepnya
   meledak jadi nol bahan; atau satu saja bahannya tidak punya saldo di lokasi
   jual atau `avg_cost_idr` = 0. **Tidak ada nilai sebagian**: HPP sebagian
   terbaca sebagai margin palsu. Bahan yang memang gratis ikut jadi NULL;
   selisihnya tertampung di residual. Baris lain di pesanan yang sama tetap
   dihitung sendiri-sendiri.
5. **Edge `qr-order-applier.ts` menulis NULL, payload tidak diubah.** Pesanan
   itu dibuat di cloud oleh `qr-order.service.ts`, yang sudah menulis snapshot
   di barisnya; laporan membaca cloud, jadi tidak perlu pengisian ulang. Payload
   `qr_order.placed` adalah `z.strictObject`: menambah field membuat edge versi
   lama menolak event dan menahan semua pesanan QR. Master sync edge tidak
   membawa resep atau `stock_balances`. POS yang berjalan di edge memakai helper
   yang sama dan mendapat NULL bila data itu tidak ada. Bila nanti ada applier
   cloud untuk pesanan dari edge (legend-kai), applier itu memanggil helper ini
   di cloud saat menerapkan.
6. **Snapshot tidak pernah ditulis ulang.** Void, refund, koreksi, remake, comp
   dan fire hanya mengubah `status` atau `fire_status`; pembaca mengecualikan
   baris `voided`. Remake dan comp punya biaya sendiri di deduksinya. Replay
   edge memakai `onConflictDoNothing`.
7. **Kegagalan tidak menggagalkan pesanan.** Helper berjalan di savepoint
   (`tx.transaction(...)`, pola `openRefundChainSafely` di
   `payment-refund.service.ts`). Galat SQL tanpa savepoint membatalkan seluruh
   transaksi Postgres, jadi try/catch saja tidak cukup. Galat tak terduga: semua
   baris pesanan NULL, `logger.warn` dengan tenant, outlet, order id dan kode
   galat saja. Alasan NULL yang biasa (tanpa resep dan sebagainya) tidak dicatat
   ke log.
8. **Bentuk.** Berkas baru `apps/api/src/services/order-cost-snapshot.service.ts`:
   `computeLineCostSnapshots(tx, context, outletId, lines) -> Promise<(number |
   null)[]>` (urutan sama dengan `lines`; baris =
   `{menuItemId, variantId, modifierIds, quantity}`). Nama tidak bentrok dengan
   `estimateDeductionCostIdr` (cabang KDS, yang mengembalikan 0, kontrak
   berbeda), dan tidak mengimpor dari `recipe-deduction.service.ts`. Satu
   pesanan memakai jumlah query tetap: lokasi jual (berhenti di sini bila
   kosong), satu ledakan per baris yang memuat data master sekali, satu baca
   saldo. Untuk itu `recipe-bom.service.ts` mendapat ekspor tambahan
   `explodeMenuLinesEach` (hasil per baris), dengan pemuatan data master dan
   konversi UOM diekstrak ke fungsi internal bersama; perilaku
   `explodeMenuLines` tidak berubah. Dipanggil tepat sebelum
   `insert(orderItems)` di `pos-order.service.ts`, `qr-order.service.ts` dan
   `delivery-inject.ts`. Tidak ada migrasi; slot 0183 dilepas.
9. **Tidak ada backfill dan tidak ada kartu bd untuk itu.** Mengisi baris lama
   dengan harga hari ini memalsukan "saat terjual". Baris lama tetap NULL dan
   tampil sebagai residual WS-11.

Tindak lanjut yang dicatat: DTO `pos-order-support.ts` memetakan NULL ke 0
(`?? 0`), dan `ai-metrics/sales.ts` menjumlah dengan `COALESCE`, sehingga HPP
yang tidak diketahui terbaca 0 di dua tempat itu. Perbaikannya kartu terpisah.

## 2026-11-08: Worker event transport, acknowledgement and gap replay (legend-18qw)

Context: the production worker refused to start without an operator-supplied
transport module (`WORKER_TRANSPORT_MODULE`) and had no notification recipient
resolver or channel providers, so no outbox event was delivered in production.
Reviewed with an architect consult before implementation.

1. **No new HTTP ingest.** The authenticated edge/cloud ingest is the existing
   edge link `/api/edge-link` (legend-2pi): bearer credential checked against
   its stored hash, Origin header refused, re-verified every 30 s, revoked nodes
   closed with 4403. A second ingest path would duplicate that surface.
2. **Built-in transport** (`apps/api/src/worker/transport.ts`, selected with
   `WORKER_TRANSPORT=builtin`; the module overrides stay for operators):
   - Cloud: destination `cloud-sync` is a local sink. The in-process consumers
     already ran inside `consumeOutbox`; the `domain_event_consumptions` row
     (unique per consumer + event id) is the durable, idempotent
     acknowledgement, so a redelivered job is a no-op.
   - Edge (`EDGE_MODE=true`): `cloud-sync` events are queued `edge_to_cloud`
     with `enqueueEdgeEvent` on the consumption transaction (idempotent by
     event id, gap-free link sequence). The link's batch/ack/resend frames
     carry them; `edge_outbound_queue.status` + `sync_cursors.acked_out_seq`
     are the wire acknowledgement. This is the edge outbox drain the up-sync
     bead legend-kai mentions; legend-kai keeps the cloud-side applier,
     reconciliation and outage tests.
   - Any other destination, or a row with a non-null `direction`, throws: the
     job retries and then dead-letters (operator replay exists). Cloud-to-edge
     fan-out is not routed here: outbox sequences are per destination, not per
     edge node, and master-data versus transaction classification belongs to
     legend-97p.
3. **Gap replay.** An outbox sequence is allocated in the producer's own
   transaction, so a missing sequence is a producer bug that no peer can fill;
   wire-level gaps are already resent by the link. `requestMissing` records the
   gap in `domain_event_gap_requests` (unique per tenant, destination,
   aggregate and missing sequence; tenant RLS), counts repeats, logs
   `Outbox sequence gap` on the first request and each power of two, and the
   relay marks it resolved once the consumer offset passes it. The relay asks
   every tick, but a gap row is counted and rewritten at most once a minute
   (a resolved gap requested again is always reopened). Nothing skips a gap
   automatically; the aggregate stays held until the event arrives. An
   audited operator "skip gap" action would be a separate bead. A failure to
   write the gap record is logged and never aborts the relay tick.
4. **Producer bug fixed.** `operations-events.ts` numbered checklist events
   across destinations, so the `notification` alert of a started run got a
   sequence above 1 and was blocked forever. Sequences are now per
   destination, like the other allocators.
5. **Notifications fail closed at startup.** `NOTIFICATION_EMAIL_PROVIDER`,
   `NOTIFICATION_PUSH_PROVIDER` and `NOTIFICATION_WHATSAPP_PROVIDER` are
   required; `disabled` is an explicit value. A disabled channel is reported as
   unreachable to the delivery planner, so it is skipped, never reported as
   sent; in-app notifications are always written. Email has a Brevo adapter
   (account and sender domain: legend-wwuc); web push and WhatsApp templates
   stay `disabled` until legend-hyq. Only Brevo 400 and 422 decline a
   message for good; every other failure (401, 403, 404, 408, 429, 5xx,
   network) throws, is retried and is logged with the channel and HTTP status
   only (never the body, the address or the key). `BREVO_API_KEY` must be
   printable ASCII without spaces and `NOTIFICATION_EMAIL_FROM` must not be a
   placeholder (`.invalid`, `replace_me`); both are checked at startup.
6. **Recipients come from server state only**, by event name:
   `approval.requested` goes to holders of the current level's approver roles
   whose assignment covers the outlet (requester excluded);
   `approval.resolved` to the requester; `support_access.*` to tenant admins
   (`org.settings.manage` on a tenant-wide assignment); checklist missed and
   failed alerts to the outlet's `supervisor`/`outlet_manager` roles, falling
   back to the tenant owner. An event without a rule throws, so it is retried
   and dead-lettered instead of dropped silently. Banned (disabled) or missing
   accounts are dropped from every audience before a fallback is chosen (a
   banned supervisor does not hide the owner fallback) and unreachable at send
   time; an account whose `ban_expires` has passed counts as active again.
   `approval.resolved` reaches the requester only while they still hold an
   active assignment in the tenant. A malformed stored preference falls back
   to the defaults for that user only.
7. **Email is at-least-once, deduplicated within Brevo's window.** Every send
   carries `headers.idempotencyKey`, a UUID derived from the delivery
   attempt's stable reference, so a retry of the same attempt (lost response,
   worker crash) reuses the key. Brevo processes a key once for 30 minutes and
   answers a reuse with error code `duplicate_parameter` (status undocumented,
   so any 4xx carrying it counts), which the adapter treats as the
   acknowledgement. A retry later than 30 minutes after an accepted send whose
   response was lost can still deliver a second copy; with the default retry
   table (30 s, 2 min, 10 min, 1 h; tenant policy may change it) only the
   last retry falls outside the window. A duplicate notification email is accepted as the lesser failure
   compared with a lost one.
