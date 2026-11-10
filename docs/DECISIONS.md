# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

## 2026-11-10: Pesanan latihan tidak boleh menjurnal (legend-gkc6b)

Konteks: `accounting-auto-journal` dan jembatan stok ke buku besar
(`inventory-gl-consumer`) tidak memeriksa `pos_orders.is_training`. Event
`order.paid` terbit untuk tiap penjualan, jadi penjualan Mode Latihan masuk
buku besar sebagai pendapatan dan HPP, sedangkan laporan WS-11 sudah
mengecualikannya (legend-fr62g). Selisihnya muncul sebagai baris "Penyesuaian
buku besar". Tingkat K (uang), ditinjau satu architect.

Keputusan: pemeriksaan ada di sisi konsumen, bukan di sisi penerbit event.

1. **Satu titik per konsumen.** `isTrainingOrder` (`services/device-training.ts`)
   dipanggil di `postAutoJournal` untuk `order.paid`, `order.refunded`,
   `order.voided`, dan di `postStockSourceToGl` untuk sumber `order`. Hasilnya
   `ignored`: tidak ada jurnal, tidak ada baris parkir.
2. **Alasan di konsumen.** Penerbit ada banyak (POS, QR, delivery, koreksi) dan
   payload event tidak membawa penanda latihan. Penerbit baru yang lupa
   menandai akan lolos. Konsumen membaca `is_training` dari `pos_orders` per
   orderId, jadi semua penerbit, pengiriman ulang, dan sweep ikut tertutup
   (sweep dan pengiriman pertama lewat fungsi yang sama). Tanpa kolom atau
   migrasi baru.
3. **Void dan refund ikut diabaikan, kecuali jurnal penjualannya sudah ada.**
   Tanpa pengabaian, keduanya diparkir `AUTO_JOURNAL_SALE_MISSING` selamanya
   karena jurnal penjualannya memang tidak ada. Bila jurnal `aj:sale:<id>` dari
   sebelum aturan ini sudah ada, void dan refund tetap membaliknya (juga
   `return` stok yang sumbernya sudah terposting), supaya buku tidak setengah
   terbalik. Sumber stok latihan yang dulu terblokir dilepas dari
   `inventory_gl_blocked`, supaya sweep tidak mengulanginya terus.
4. **Tidak ada baris `pos_orders`** (QR bayar-dulu, id tidak dikenal) bukan
   latihan: tetap menjurnal seperti biasa. Pesanan QR tidak punya mode latihan.
5. **Tidak diubah:** pemotongan stok `recipe-deduction` untuk pesanan latihan
   (PRD dan kode tidak punya aturan; hanya jurnal HPP-nya yang ditutup),
   `payment.*` (uang gateway sungguhan, bukan pesanan), settlement (berbasis
   bank). `cashier_shift.closed` tidak diperiksa di sini, tetapi
   `computeShiftAggregates` (`pos-shift-support.ts`) menghitung tender tunai
   pesanan latihan ke kas yang diharapkan, sehingga satu shift campuran bisa
   mencatat selisih kas palsu. Dilaporkan sebagai kartu terpisah.
6. **Data lama:** jurnal latihan yang sudah terbentuk sebelum perbaikan ini
   tidak dihapus atau dikoreksi otomatis; perlu keputusan finance.

## 2026-11-10: Metric sources, metrics_daily and report runs (legend-5wzoc, legend-31fi)

Context: founder Q54 puts all 110 standard reports and 89 metrics in scope
before release. On m1 only `GET /api/metrics/query` answers, for 12 money
metrics read from posted journal lines and split by outlet only; every other
metric answers null. Twelve family cards (F1-F12) build the remaining sources
in parallel. Reviewed with an architect consult before implementation.

1. **Money totals stay on the ledger; other splits come from the sub-ledger
   with the ledger as control.** A money metric whose figure the ledger posts
   (`GL_METRIC_SOURCES`) keeps its ledger total for every query. A split the
   ledger cannot carry (channel, menu item, hour, employee, payment method,
   ...) is read from operational rows (orders, order items, payments) through
   `metrics_daily`. The rows of such a split are always followed by one
   residual row, dimension value `__ledger_adjustment__` (shown as
   "Penyesuaian buku besar"), equal to the ledger total minus the sum of the
   split rows for the same bucket and outlet filter. The rows therefore add
   up to the ledger total, like the "Tingkat badan usaha" series of the
   outlet split (DASH-02). The residual row is shown whenever it is not zero;
   there is no tolerance that hides it. Split rows are never scaled pro rata
   to the ledger: a scaled per-menu or per-employee figure would be a number
   nobody recorded. Split rows carry the finality of the ledger total of
   their bucket. A percent metric split this way (food cost % per menu) is
   recomputed per row from its split numerator and denominator; the residual
   row gets the ratio of the residual components, null when the residual
   denominator is zero. The old I1 rule (`metrics-query.service.ts` header)
   is narrowed to: a money total never comes from operational rows when the
   ledger posts it. A money metric the ledger never posts (void amount, pax
   spend, settlement in transit) may read operational rows directly; its
   family card states why in the source's comment and removes it from
   `NON_GL_MONEY_METRICS`.
2. **One registry, one engine.** `apps/api/src/services/metric-sources/`
   holds exactly one `MetricSource` per registry metric code (`gl`, `daily`,
   `derived` or `unavailable`) and at most one `MetricSplitSource` per
   (ledger metric, dimension). The 12 ledger sources live in
   `metric-sources/gl.ts`; each family file adds its own sources and splits
   and never edits another file. A code no family claims resolves to
   `unavailable` (`source_not_built`), so all 89 codes always resolve. The
   registry refuses at load a code claimed twice, a code missing from the
   catalog, a unit that does not fit the source kind, and a split on a code
   that is not `gl`. `evaluateMetrics` in `metrics-query.service.ts` is the
   only path that turns codes into values. `GET /api/metrics/query`, report
   run and preview (`report-run.service.ts`), the dashboard batch (F11) and
   the AI tools all call it. The AI helpers in
   `apps/api/src/services/ai-metrics/` (sales, finance, labor, stock) still
   compute registry metrics from operational tables, for example `net_sales`
   from orders. The card that owns each metric moves its helper onto the
   engine: sales to F1, stock to F5, finance to F6, labor to F9. The guard
   test `metric-single-path.test.ts` lists these four files as the only
   allowed exceptions, and INT requires the list to be empty.
3. **`metrics_daily` plus a batch engine for the 3-second dashboard.**
   `metrics_daily` stores outlet-day values of `daily` sources and of splits
   (tenant and outlet RLS forced). Ledger totals stay live from journal lines
   in the existing REPEATABLE READ READ ONLY snapshot, so a close or reopen
   is never stale. `evaluateMetrics` takes many codes for one period, bucket
   and outlet filter, and makes one ledger read and one `metrics_daily` read
   per call. F11 groups the 18 owner tiles by (period, bucket, outlet
   filter) and evaluates them in one snapshot. The p95 budget for one owner
   dashboard load is 3 s. F11 measures it on a seed of 10 outlets and 400
   days. If the ledger read alone exceeds 1 s p95 there, F11 adds a daily
   ledger roll-up as its own bead; A does not build one now. Ratios
   (`aggregation: ratio`) are never stored; they are recomputed from their
   input codes per bucket. A report run groups by the outlet and at most one
   other dimension in this release. A deeper group-by answers "belum
   tersedia" (`dimension_not_supported`) instead of a wrong table.
4. **Closed versus estimate.** A stored row is `final` only when its business
   day has settled (day end plus the settle delay, as in the AI daily
   summary). Point-of-sale metrics also need a `pos_daily_closes` row for
   that outlet and date. Every other row is `estimate`. On read, a value is
   `final` only when every stored row behind it is `final` and
   `metricValueFinality` says `final` now. `closed_period_only` metrics also
   need closed books (`bookState`). So a reopened month or a late
   recomputation turns a value back into an estimate without waiting for the
   job. `requireFinal` keeps refusing with `PERIOD_NOT_CLOSED` before any
   value is read; an unavailable metric is not counted in that check.
5. **The daily job is idempotent per outlet and date.**
   `worker/metrics-daily.job.ts` runs from the worker tick per tenant, every
   15 minutes. It handles today (estimate) and the last 7 settled business
   dates per open outlet. Each (tenant, outlet, date) takes a transaction
   advisory lock. Each family runs in its own savepoint, so a failing family
   is logged and retried on the next tick without blocking the others. The
   rows of a code are upserted on the unique key and rewritten only when the
   value, finality or definition version changes, so a rerun leaves
   `updated_at` unchanged. Rows of that code whose dimension no longer exists
   are deleted. A changed `final` row is logged as `metrics_daily final row
   changed` (late data) and still written. Dates older than the window are
   recomputed only through `recomputeMetricsDaily(context, outletId, from,
   to)`. A family card that bumps a definition version runs it over the
   history it changes. A family card that ships a new reader also runs it
   over the history its reports cover, before its reports leave the mock.
   Every reader writes a total row (no dimension) per outlet-day, zero when
   nothing happened; a stored value is `final` only when every business day
   of its bucket has that total row, so a day the job never computed (worker
   down for more than the window, a reader shipped without backfill) keeps
   the value an `estimate` instead of a closed figure that silently misses
   days (architect review 2026-11-10).
6. **"Belum tersedia" is a field, not a zero, an error or an empty row.**
   Report results (`reportResultSchema`) and metric series carry an
   availability per metric: `available`, or `unavailable` with a reason
   (`source_not_built`, `dimension_not_supported`) and an Indonesian message.
   An unavailable metric has null in every cell. A report whose metrics are
   all unavailable answers 200 with no rows and every metric marked
   `unavailable`, so the viewer, the dashboard and Tanya AI can say "belum
   tersedia". The low-level `GET /api/metrics/query` keeps answering 400
   `METRIC_DIMENSION_NOT_SUPPORTED` for a split the metric does not declare
   (unchanged). A split the metric declares but no card has built yet is
   marked `unavailable` by the engine and by report runs; `GET
   /api/metrics/query` keeps its m1 answer (400) for that case too, so the
   existing ledger regression tests stay unchanged. A split of a percent
   ledger metric is `dimension_not_supported` until a family card builds its
   numerator and denominator splits. Report run rows carry their bucket
   (`bucket` on the result, `bucketStart`/`bucketEnd` on each row; for
   `total` both equal the period bounds), so `day`, `week` and `month`
   reports answer one row per bucket and split; rows order by bucket, then
   dimensions, `sort` applies inside a bucket and `limit` counts all rows
   (legend-ymtsg, brief 267). A run splits by `outlet` plus at most
   `REPORT_RUN_MAX_SPLIT_DIMENSIONS` (1) other dimension: `metrics_daily`
   stores one dimension per row, so going deeper needs a schema change. A
   deeper `groupBy` is not refused by the schema; the run answers 200 with
   `unavailable` / `dimension_not_supported` (legend-hdfd2).
7. **File ownership.** Only card A, and after A merges only a serialized
   follow-up bead labelled `ws11-shared`, edits
   `metrics-query.service.ts`, `metrics-gl-sources.ts`,
   `metric-sources/index.ts`, `types.ts` and `gl.ts`,
   `report-run.service.ts`, `routes/reports.routes.ts`,
   `db/schema/metrics.ts`, `worker/metrics-daily.job.ts`,
   `packages/shared/src/metrics/*`, `packages/shared/src/dashboard/*` and
   `mock-day-model.ts`. A family card that needs a change there comments on
   that bead and does not edit the file in its own branch. A family card owns
   its own `metric-sources/<family>.ts`, `test/ms-<family>.test.ts`,
   `mock-families/<family>.ts`, `routes/_kelola/reports.<family>.*.tsx`, and
   any new schema file of its own migration. Report families map to source
   files as follows: sales; traffic and operations; menu and cogs; payments
   and tax; inventory and purchasing; finance; loyalty and crm; reservation
   and delivery; attendance, payroll and performance (`hr`); facility.
8. **`GET /api/metrics/query` follows the report run access rule**
   (legend-svrzc, CTO decision 2026-11-10, brief 267). Each metric's source
   report decides access: its full permission gives the caller's own scope;
   without it, `report.aggregate.view` gives the tenant aggregate only when
   the source report is on the aggregate whitelist
   (`reportAcceptsAggregateView`). Scopes intersect across the asked
   metrics; an empty intersection or no access answers 403
   `REPORT_NOT_PERMITTED`, never a tenant-wide figure. A metric code without
   a known source report keeps its old permission, without aggregate
   fallback. The shared logic lives in `routes/report-viewer.ts`. Callers
   that passed through the aggregate before without the source report now
   get 403: a shareholder asking for `cogs` (source `inventory.food_cost`,
   not whitelisted) is refused. The rule also widens access: money metrics
   no longer all need `report.financial.view`; each needs its source
   report's permission, so `report.operational.view` reads `cogs`,
   `food_cost_pct`, `waste_cost`, `payment_fee` and `stock_value`, and
   `report.sales.view` reads `net_sales` and `discount_amount`. The same
   figures were already readable through a report run (architect review
   2026-11-10).
   Founder decisions (legend-upmn7, 2026-11-10):
   - Q59: a shareholder (`report.aggregate.view`) may read the business
     total of `cogs` through `GET /api/metrics/query`, never a breakdown.
     `AGGREGATE_TOTAL_METRIC_CODES = ["cogs"]` in
     `packages/shared/src/dashboard/catalog.ts` lists such total-only
     metrics. A listed metric gets the aggregate reach only for a request
     with no `groupBy`, no `outletIds` filter and bucket `total`; any split
     (outlet, menu item, menu category), an outlet filter or a smaller
     bucket answers 403 `REPORT_NOT_PERMITTED`. The mark is per metric, so
     `food_cost_pct` from the same source report stays 403.
     `inventory.food_cost` is not added to `AGGREGATE_VIEW_REPORT_CODES`: its
     report run, with per-menu detail, stays closed to the aggregate view.
     The metric query follows the founder's words literally (whole business,
     whole period), although the `finance.income_statement` report run,
     which accepts the aggregate view, already lists `cogs` per outlet to a
     shareholder and `gross_profit` is `net_sales - cogs`; the per-menu split
     is the only detail no path shows (architect review 2026-11-10).
   - Q61 (2026-11-10): a shareholder may see the income statement per
     outlet, including each outlet's `cogs`, through the
     `finance.income_statement` report run. The per-menu `cogs` breakdown
     stays closed. The current behaviour already matches; no code change.
   - Q60: widening `report.operational.view` to `cogs`, `food_cost_pct`,
     `waste_cost`, `payment_fee` and `stock_value` is approved only within
     the outlets the role reaches. An outlet-scoped holder reads their own
     outlet without a filter and gets 403 for another outlet's filter
     (`apps/api/src/test/metrics-query-access.test.ts`).

9. **Shared round 2 (brief 272, 2026-11-10).**
   - One reader per metric code and dimension in `metrics_daily`; a
     reader's stale-row delete covers only the dimensions it writes. Which
     reader owns a code's total row is explicit (`writesTotal`), and two
     total writers for one code are refused by `assertRegistry`.
   - `net_sales` splits by `payment_method` (each order's net spread over
     its captured tenders with `allocateByWeight`, then the paid intent
     method, then `unassigned`) and by `menu_category` / `menu_item`
     (largest remainder per order). Sales owns every `net_sales` reader.
   - New source kinds: `share` (a split's summed value over the summed
     total, for `menu_popularity_pct`) and GL `balance` (all lines up to the
     bucket end, for `tax_payable`). A balance is a tenant figure only: by
     outlet, an outlet filter or an outlet scope answer
     `dimension_not_supported`, because the PBJT remittance journal may carry
     no outlet. A GL term may be limited to journal
     source types: `tax_collected` and `service_charge_collected` count
     only `sale` and `refund` journals (a reversal counts as the entry it
     reverses), so remittances and payouts do not reduce them.
   - `food_cost_pct` splits by splitting `cogs` and `net_sales` and
     dividing per split value; a split one side lacks is
     `dimension_not_supported`.
   - Multi-day `avg_serving_time` and `avg_dwell_minutes` are weighted by
     the catalog counts `served_ticket_count` and `closed_session_count`
     (`weightCode`); days without stored weight fall back to the plain
     mean until history is recomputed (legend-ka1hg).
   - A GL split is final only when every outlet with ledger lines has a
     final total row for every day of the bucket.
   - Dashboards: `managerRole` on the management query; tiles and queues
     carry `availability`; an unbuilt queue answers 200 with no rows and
     `source_not_built` instead of 501.

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

Tindak lanjut (legend-n8r5m, cabang `ws/cost-snapshot-edge`): DTO order POS
(`pos-order-support.ts`) tidak lagi memetakan NULL ke 0. HPP adalah data
finance (`inventory.cost.view`) sedangkan DTO POS bisa dibaca peran dengan
`order.view` saja, jadi DTO POS selalu mengirim `costSnapshotIdr: null` (tidak
diketahui / tidak ditampilkan); pembaca biaya memakai SQL. `ai-metrics/sales.ts`
masih menjumlah dengan `COALESCE` (HPP tak diketahui terbaca 0); berkas itu
milik alur WS-11 dan menunggu di sana.

Pesanan lewat edge: cloud tidak punya titik ingest `order_items` untuk pesanan
edge. Applier `qr_order.placed` hanya berjalan di edge (arah cloud_to_edge, baris
itu salinan dari pesanan cloud yang sudah ber-HPP) dan event `order.*` dari edge
hanya diparkir di `edge_deferred_events`. Pengisian HPP untuk pesanan POS edge
menunggu applier backfill (legend-078n).

10. **Shared round 3 (brief 284, 2026-11-10).**
    - Readers get the job's clock (`DailyComputeInput.now`) and never read
      the wall clock.
    - Finality hold: a reader may declare `pendingDay`; the job asks it
      before computing, and while it holds the reader's rows stay
      estimates. Delivery holds while an order of the day is
      `received`..`picked_up`; incident response holds while an incident of
      the day has no `responded_at`. Each sweep also revisits held days up
      to 90 days back, so a late end turns the day final and its value
      follows.
    - `keepFinal`: a reader whose inputs are configuration without history
      (facility operating hours) keeps its closed days as they are. Hours
      with an effective date are a follow-up (legend-4us1a).
    - Facility occupancy, unit utilization and incident response time are
      derived ratios over new stored sums, so multi-day values are weighted
      by volume.
    - `stock_value`, `purchase_total`, `supplier_due` and `delivery_sales`
      are owned by daily readers and are no longer listed as ledger gaps.
    - Training orders change no sales metric. Their sales journals are a
      separate bug (legend-gkc6b).
    - Mocks follow the registry: every family mock lists its unavailable
      metrics and a drift test pins the list to the registry.

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

## WS-07: purchase return and petty purchase journals (legend-1xbs, legend-v3lh)

Decided 10 Nov 2026 (architect, tier K money). Design brief: `docs/briefs/298a-sub-purchase-return-posting-design.md`.

1. **Return payload carries the split.** `purchase_return.recorded` adds
   `outletId`, `uninvoicedValueIdr`, `invoicedValueIdr` and `ppnIdr`;
   `valueIdr = uninvoicedValueIdr + invoicedValueIdr`, and `ppnIdr > 0` only
   when `invoicedValueIdr > 0`. A split (not one flag) keeps a mixed return
   balanced. The emitter sums per-line rounded values; it never prorates the
   total.
2. **Return journal.** Dr `grni` for the uninvoiced part (receipt not yet
   billed), Dr `accounts_payable` for the invoiced part plus PPN (debit note),
   Cr `inventory` for `valueIdr`, Cr `ppn_input` for `ppnIdr`. A return with
   `valueIdr = 0` posts nothing.
3. **Petty purchase** is an expense, never stock (the contract says it is not
   a stock document, so debiting `inventory` would break the GL to stock
   ledger tie). New event `petty_purchase.recorded` (id-only payload), new role
   `petty_purchase_expense`, default account `5104 Pembelian Langsung (Kas
   Kecil)` (tenant can remap). Credit goes to `petty_cash` (1102), not
   `cash_on_hand` (1101 is the POS drawer, settled at shift close). This
   overrides the card text "kredit kas". No PPN input on petty purchases.
4. **New journal source types** `purchase_return` and `petty_purchase`
   (check constraint widened in migration 0205, which also backfills 5104).
5. **Goods receipt is NOT posted here.** `goods_receipt.recorded` has a rule
   but no consumer yet (legend-29vw). A return that debits GRNI is only
   correct once receipts credit GRNI, so legend-29vw must ship before the
   purchase return emitter goes live. No emitter exists today, so nothing
   posts and no balance drifts.
6. **Known gaps (follow-up beads):** a debit note reduces AP in the ledger but
   creates no AP open item; invoice-vs-receipt price differences on returns;
   receipts recorded before go-live need a finance cutover entry; no PPN input
   on petty purchases; `supplier_invoice.recorded` still unposted.

## WS-06: supplier return and petty purchase backend (legend-65mgw)

Decided 10 Nov 2026 (architect, tier K). Design: `docs/briefs/301b-sub-return-petty-design.md`.

1. **Return gate.** `PURCHASE_RETURN_POSTING_ENABLED` (env, default off). While off the whole `POST /api/inventory/purchase-returns` is refused with 403 `FEATURE_DISABLED` before the idempotency claim: a stock-out without a GRNI journal would split the GL from stock. Reads stay open. `legend-29vw` (goods receipt journal) turns it on and adds a cutover guard.
2. **Return value.** Stock leaves at the receipt cost, not the moving average, so GRNI clears exactly. Each line books the cumulative rounded value minus earlier returns; `valueIdr` is the sum of line values. Split is `uninvoiced = valueIdr`, `invoiced = 0`, `ppn = 0` until supplier invoices exist.
3. **Over-return race.** Returns of one receipt are serialised by a row lock on the receipt's purchase order (`legend_app` has no UPDATE on `goods_receipts`, so locking the receipt fails). Own location lock and balance check give `INSUFFICIENT_STOCK` because the stock ledger allows negative balances.
4. **Petty purchase** is rejected, not approved, when over the limit or when no policy exists (409 `PETTY_PURCHASE_LIMIT_EXCEEDED`). Photo is mandatory, stored in `core_storage_objects` with source kind `petty_purchase`, linked once. Business date is the outlet business date; no back-dating. Policy writes: `PUT /api/inventory/petty-purchase-policy`, permission `purchasing.petty_policy.manage` (owner, finance).
5. **Permissions:** `purchasing.return.create` (owner, purchasing, warehouse), `purchasing.petty.record` (owner, general_manager, outlet_manager, kitchen_lead, purchasing), `purchasing.petty_policy.manage` (owner, finance).
6. **Known gaps (beads):** moving average not re-averaged on return; petty limit is per transaction only (daily cap bead); invoiced debit notes need AP open items (`legend-179bw`); batch returns from another location than received give a generic 422.
