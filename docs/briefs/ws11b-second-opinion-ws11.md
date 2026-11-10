# Brief: second-opinion (Codex) for the whole WS-11 area (shared rounds 1-3, all families)

Do not run before the CTO decides. Tier K (money, access, migrations, personal data). Effort: xhigh (migration and access rules). Required before the release gate. It does not block the next slice.

Replaces the family briefs 260b, 268ab, 268bb, 268cb. Their focus questions are merged below; duplicates are dropped.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/ws11-shared-3`.

Branch to review: `ws/ws11-shared-3`, compared with the merge-base of `milestone/m1`:

```
git diff $(git merge-base milestone/m1 ws/ws11-shared-3)..ws/ws11-shared-3
```

This branch already contains the merged families F1, F2, F3, F4, F5, F8, F10, F11 and the shared rounds 1 to 3. Review the whole area, not only the last round.

## Context

- Decisions: `docs/DECISIONS.md`, entry 2026-11-10 "Metric sources, metrics_daily and report runs", points 1 to 9. Point 9 is shared round 2 (brief 272): one reader per code and dimension, `writesTotal`, `net_sales` splits, `share` and GL `balance` kinds, `managerRole`.
- Shared round briefs: `docs/briefs/267-ws11-shared-serial-1.md` (buckets, access rule), `docs/briefs/272-ws11-shared-serial-2.md` (round 2 contract), `docs/briefs/284-ws11-shared-serial-3.md` (round 3 slices T1 to T5), and `docs/briefs/sub-ws11-shared-3.md` (slice rules).
- Family briefs were merged here. Their source files are still in `docs/briefs/`.
- Migration `0181_sales_targets` (`when` 1794260000000, prevId = snapshot of 0176). Migration `0176_metrics_daily.sql` and `db/schema/metrics.custom.sql` also apply.
- Card state: `bd show legend-3nfc9` (items 1 to 9), `bd show legend-fr62g`, `bd show legend-iwsrp`, `bd show legend-u4js6`.

## Invariants to check

1. One `MetricSource` per code. Each reader writes a total row (no dimension) per outlet-day, zero when there was no activity. A day with no total row must not be `final`.
2. Money totals stay on the GL. A split comes from operational rows and is followed by one residual row `__ledger_adjustment__`. Split rows plus the residual equal the GL total for the same bucket and outlet filter. Splits are never scaled pro rata.
3. Non-GL money metrics (`stock_value`, `purchase_total`, `supplier_due`, `delivery_sales`, `facility_product_revenue`, and others) read operational rows. There must be no double counting. Cancelled, rejected, and voided orders must not count. Check the reason written in each source comment.
4. Tenant and outlet isolation. Tenant B cannot see or write tenant A rows. An outlet context cannot read another outlet. RLS is the second wall. Every reader query filters `tenant_id` and `outlet_id` explicitly, including raw SQL joins.
5. Business date. Reservations use `reservedFor`. Delivery uses `receivedAt` or `deliveredAt`. Facility uses session time. The conversion to the outlet business date (time zone, closing hour) must match the other readers.
6. Job idempotency. `recomputeMetricsDaily` is idempotent. Advisory lock per (tenant, outlet, date). Upsert only when the value, finality, or definition version changes. Delete dimension rows that no longer exist, only for dimensions the reader writes. One savepoint per family. Dimension values are at most 200 characters and hold ids only, with no person names and no guest personal data.
7. Finality. A row is `final` only when its day has settled. POS metrics also need `pos_daily_closes`. `closed_period_only` metrics also need closed books. A reopened month returns to `estimate`. A GL split is `final` only when every outlet with ledger lines has a final total row for every day of the bucket. A delivery order in `received..picked_up` holds its day as `estimate`.
8. Access (brief 267, legend-svrzc). `GET /api/metrics/query` and report runs apply the same rule: full permission gives own scope; `report.aggregate.view` gives tenant aggregate only for whitelisted source reports. An empty scope intersection answers 403 `REPORT_NOT_PERMITTED`. Q59: `cogs` is total-only for shareholders (no `groupBy`, no `outletIds`, bucket `total`). Q60: outlet-scoped holders cannot read another outlet. Check that the widened `report.operational.view` and `report.sales.view` reads stay within the outlets the role reaches. Name every web caller that gets 403 now.
9. Access in dashboards. Cache of 15 seconds is keyed by tenant, role, and reach. No cross-tenant or cross-role leak. Shareholder sees aggregate only (`report.aggregate.view`). Tiles are filtered by permission. Batch answers equal single runs. `availability` and reason appear on each tile and queue. `managerRole` is honoured.
10. Money rounding. `allocateByWeight` and largest-remainder splits sum exactly to the total. Check refunds, voids, discounts, multi-tender orders, orders with no tender (`unassigned`), QR payment intents, negative values, rounding, and orders that cross a business day.
11. Ratios (`reservation_no_show_pct`, `shower_occupancy_pct`, `shower_fnb_conversion_pct`, `unit_utilization_pct`, `seat_occupancy_pct`, `food_cost_pct`, `menu_popularity_pct`) are derived from two registered codes. They are null when the denominator is zero. They are never stored. `share` kind is correct for `menu_popularity_pct`.
12. Rolling averages (`avg_serving_time`, `avg_dwell_minutes`) are weighted by `weightCode` counts. Days without weight fall back to a plain mean; check that this is stated.
13. `tax_payable` (GL `balance`) is a tenant figure only. By outlet, an outlet filter, or outlet scope it must answer `dimension_not_supported`. `tax_collected` and `service_charge_collected` count only `sale` and `refund` journals.
14. Unavailable metrics. Unavailable metrics have null in every cell and carry a reason and message. No mock or fixture gives a number for a metric the API marks unavailable. Check `ownerDashboardBoardRuns`, `buildRun`, `SERVED_REPORTS`, and `tax_payable` by outlet in the mocks.
15. Sales. `net_sales` has one owner (sales). Splits by `per_channel`, `per_menu`, `per_hour`, `per_employee`, and `payment_method` use `business_date` and orders with `status='completed'`. Training orders (`is_training`) change no sales metric, including `menu_sold_qty`. Check the queries at `metric-sources/sales.ts` (around lines 54, 135, 142, 148, 160).
16. Double writers. `assertRegistry` refuses two readers for one code, or two total writers. No other reader writes the same code (for example `menu_sold_qty`, `net_sales` by payment method). `netSalesByMethodReader` is only input for the sales card.
17. Inventory and stock (F5). Stock helper moved into the registry. AI number for `tl-03-stock-levels` does not change. `ai-metrics/stock.ts` removed. `metric-single-path.test.ts` exception list shrank as the decision requires. Replay ledger uses `ORDER BY occurred_at, id` and not `posting_seq`, unless `posting_seq` is on m1. Check that this is stated.
18. Reservation and delivery (F8). Delivery service and platform sync are not changed. Delivery data not yet final is never marked `final`. Reservation data uses no guest personal data.
19. Facility (F10). `web/features/facility-report` and the registry use one source of numbers. New codes `shower_used_minutes`, `shower_available_minutes`, `unit_used_minutes`, `unit_available_minutes`, `facility_incident_response_total_seconds`, `facility_incident_answered_count` are `sum`. Available minutes stay `unavailable` when operating hours are not stored. Check that the percent codes become unavailable with them. Check the `seconds` result on the `derived` kind.
20. Migrations. `0181_sales_targets`: FK inside CREATE TABLE, FORCE RLS for tenant and outlet, journal index 181, `prevId` correct, unique (`tenant_id`, `outlet_id`, `target_date`), CHECK `target_idr >= 0`. If 0177 to 0180 land first, the chain must be rebased. `pnpm db:generate` must produce nothing new.
21. Sales targets API (`/api/outlets/:outletId/sales-targets`: GET, PUT, PUT `/month`, DELETE). Read needs `report.sales.view`. Write needs `org.settings.manage`. Outlet scope is enforced. Monthly split sums exactly with no remainder. Bad input answers 422. DELETE passes `requireTrustedOrigin`.
22. Two old tests changed (`metrics-engine.test.ts`, `metrics-runtime.test.ts`). Check that the security guarantee did not weaken. The new examples must be codes nobody claims.
23. Contract. `availability` is required in `reportResultSchema` and `metricQueryResponseSchema`. Check the impact on the web mocks and on every consumer, including Tanya AI tools.
24. Shared contract for `dimension_not_supported`, `source_not_built`, bucket fields (`bucket`, `bucketStart`, `bucketEnd`), and the limit of one split dimension beyond outlet (`REPORT_RUN_MAX_SPLIT_DIMENSIONS`). A deeper `groupBy` answers 200 with `unavailable`.
25. Mock drift. Each family mock's unavailable list equals the registry's unavailable codes for that family (`ws11-mock-drift.test.ts`). The `facility` mock and `inventory-purchasing` mock cover all their codes.

## Output

For each finding: `path:line`, level (blocker / important / suggestion), the problem, one concrete failing scenario, and the fix. Group findings by invariant number. If there is no finding, say so in one line.

Do not claim pass without a test run. Mark anything you did not verify as not verified.
