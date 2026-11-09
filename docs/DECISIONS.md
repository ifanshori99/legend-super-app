# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

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
