# Sub-brief: WS-11 shared round 3 slices (brief 284)

Worktree `.worktrees/ws11-shared-3`, branch `ws/ws11-shared-3`. F5 F8 F10 are
merged (54a24341, 11e69a8d, bc5c94ad); their readers already satisfy the
round-2 contract (DECISIONS 2026-11-10 point 9). Card: `bd show legend-3nfc9`
(items 1-9 incl. comments), `bd show legend-fr62g`.

Rules for every slice:
- Touch only your slice's files. Another slice owns the rest; if you need a
  change outside your files, stop and say so in your report.
- Test first: write the new test, run it red, then fix, run green. Report
  the red line and the green count.
- Each bash call starts with `cd` to the worktree and `pwd`. API tests run
  from the root: `LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test`. Pure
  vitest files can run in `apps/api` with a dummy env:
  `DATABASE_URL=postgres://x:x@localhost/x BETTER_AUTH_SECRET=<40 chars> npx vitest run <file>`.
- No commit, no migration, no tsc (the lead runs typecheck once). Run eslint
  and prettier on your files. Never run prettier on `docs/DECISIONS.md`.
- Report: files changed, red/green proof, contract changes, open risks.

## T1: delivery finality hook and `now` (items 1, 3; item 9 note only)

Files: `apps/api/src/services/metric-sources/types.ts`,
`apps/api/src/services/metrics-daily.service.ts`,
`apps/api/src/services/metric-sources/reservation-delivery.ts`,
`apps/api/src/services/metric-sources/inventory-purchasing.ts`,
`apps/api/src/test/metrics-daily-job.test.ts`,
`apps/api/src/test/ms-reservation-delivery.test.ts`,
`apps/api/src/test/ms-inventory-purchasing.test.ts`.

- `DailyComputeInput.now` (types.ts:42-47). The job already holds `now`
  (metrics-daily.service.ts:250, :335). Replace `Date.now()` at
  inventory-purchasing.ts:328.
- Finality hook: a reader may declare a hold, e.g. an optional
  `pendingDays(input) -> outlet-dates that may still change`. The job keeps
  a row an estimate while held, on top of `settled && (!requiresDailyClose
  || closed)` (metrics-daily.service.ts:269-294). Delivery readers
  (`delivery_orders`, `delivery_sales`) hold a day while any delivery order
  of that outlet-date is in `received..picked_up`
  (CHECK at db/schema/delivery.ts:222).
- Tests: a row stays estimate while an order is in flight and turns final
  after it completes or is cancelled; `now` is the job's clock.
- Item 9 (`ORDER BY occurred_at, id` at inventory-purchasing.ts:222): do not
  change. `posting_seq` is not on this branch.

## T2: facility count and sum codes, derived ratios (item 2)

Files: `packages/shared/src/dashboard/metric-catalog.ts`,
`apps/api/src/services/metric-sources/facility.ts`,
`apps/api/src/test/ms-facility.test.ts`,
`apps/web/src/features/ws11-reports/mock-families/facility.ts`,
`apps/web/src/features/facility-report/mock.ts`, plus catalog tests that
pin the code list (`tests/metrics-contract.test.mjs` or similar).

- Spec: `docs/briefs/268b-requests-facility.md` section 1. Six new catalog
  codes (`shower_used_minutes`, `shower_available_minutes`,
  `unit_used_minutes`, `unit_available_minutes`,
  `facility_incident_response_total_seconds`,
  `facility_incident_answered_count`), sum aggregation, dimensions as the
  table there.
- `shower_occupancy_pct`, `unit_utilization_pct` (scale 100) and
  `facility_incident_response_seconds` (scale 1) become `derived`
  (pattern: metric-sources/sales.ts:573, types.ts:98). If the engine's
  derived kind refuses a `seconds` result, say so; the lead decides.
- Facility reader writes the new sums. Available minutes: from facility
  operating hours if stored; unit lifetime lower bound `created_at`
  (no retirement column exists, no migration allowed). If operating hours
  are not stored, keep the available-minutes codes `unavailable`, which
  leaves the percents unavailable; report it.
- Update the facility mock unavailable list so the existing drift test
  (ms-facility.test.ts:567) stays exact.

## T3: NON_GL money list (item 4)

Files: `apps/api/src/services/metrics-gl-sources.ts`,
`apps/api/src/test/metrics-runtime.test.ts` (only the test at :919-935),
`apps/api/src/test/metrics-gl-sources.test.ts`.

- Loosen the "every money metric maps to GL or NON_GL" test so a money
  metric may also be served by a registered daily reader with a written
  reason, and remove `stock_value`, `purchase_total`, `supplier_due`,
  `delivery_sales` from `NON_GL_MONEY_METRICS` only where that holds.
  Do not add GL sources for them (the readers own them now); write the
  reason per code in a comment next to the list.

## T4: web mocks, owner board fixture, drift test (items 5-8, tax_payable)

Files: `apps/web/src/features/ws11-reports/mock.ts`,
`apps/web/src/features/ws11-reports/mock-families/*.ts` except
`facility.ts`, `packages/shared/src/dashboard/fixtures.ts`, a new
`apps/api/src/test/ws11-mock-drift.test.ts`, and root `tests/ws11-*.mjs`
that pin these mocks.

- Item 5: `SERVED_REPORTS` (mock.ts:412-430) gains delivery; in `buildRun`
  (:321), `delivery.by_menu` / `delivery.settlement` follow the real
  availability of their metrics (no mock numbers for metrics the API calls
  unavailable).
- Item 6: `ownerDashboardBoardRuns` (fixtures.ts:649) gives no number for
  metrics the API answers unavailable (`shower_revenue`,
  `shower_occupancy_pct`, `revpash`, `seat_occupancy_pct`; check the
  registry for others). Keep DASH-02 tests green.
- Item 7: `mock-families/inventory-purchasing.ts` covers all 12 numbered
  codes of F5 with `cellFor`.
- Item 8: one drift test for all families: each family mock's unavailable
  list equals the registry's `unavailable` codes for that family (pattern
  ms-facility.test.ts:567). It must stay exact after T2 lands; read the
  registry, do not hard-code facility codes.
- `mock-families/payments-tax.ts`: `tax_payable` by outlet shows
  unavailable, same as the API (`dimension_not_supported`).

## T5: training orders in sales (legend-fr62g)

Files: `apps/api/src/services/metric-sources/sales.ts`,
`apps/api/src/test/ms-sales.test.ts`.

- Queries at sales.ts:54, :135, :142, :148, :160 filter only
  `status = 'completed'`. Check which tables can hold training orders;
  exclude them in every sales reader that can see them, not only
  `menu_sold_qty` (pattern `COALESCE(po.is_training, false) = false`,
  menu-cogs.ts:62). Test: a training order changes no sales metric.

## Architect review fixes (F-A and F-B in parallel, files do not overlap)

### F-A: job hold order, catch-up pass, keepFinal (findings 2, 5 and the job part of 1, 3)

Files: `apps/api/src/services/metric-sources/types.ts`,
`apps/api/src/services/metrics-daily.service.ts`,
`apps/api/src/worker/metrics-daily.job.ts`,
`apps/api/src/test/metrics-daily-job.test.ts`.

- Ask `pendingDay` before `compute` (metrics-daily.service.ts:117-120), so
  an order that ends after the check never lets a wrong row become final.
- Catch-up pass: each run also refreshes outlet-dates older than the
  7-day window (`metrics-daily.job.ts:26`) that still hold `estimate` rows
  of a reader with `pendingDay`, back at most 90 days. A day held past the
  window turns final once its hold ends, and its value follows (an order
  cancelled on day 10 drops out).
- New optional reader flag `keepFinal?: boolean`: once the reader's rows
  for an outlet-date are final, the job neither rewrites nor deletes them.
  An outlet-date with no rows yet is written normally (backfill works).
- Tests: hold checked before compute; a day held 10 days becomes final
  after the order ends and drops a cancelled order; keepFinal rows stay
  unchanged when the reader returns a new value.

### F-B: facility readers (findings 1, 3, 6, 7)

Files: `apps/api/src/services/metric-sources/facility.ts`,
`apps/api/src/test/ms-facility.test.ts`.

- Available-minute codes (`shower_available_minutes`,
  `unit_available_minutes`) and their used-minute partners are read from
  today's `facilities.operating_hours`; set `keepFinal: true` on the reader
  that writes them (split the reader if it also writes other codes), so a
  later change of hours never rewrites a closed day. Say in the header
  that hours have no effective date yet (follow-up card).
- `facility_incident_response_total_seconds` and
  `facility_incident_answered_count` get their own reader with
  `pendingDay`: hold while any incident of the outlet-day has no
  `responded_at`.
- A running ticket (no `ended_at`) counts as used up to
  `min(input.now, day end)`, not its planned `ends_at`.
- Header note: units under maintenance count as available.
- F-A adds `keepFinal` and the catch-up pass in the job at the same time;
  run your DB tests after it lands (the lead tells you), pure checks
  before.
