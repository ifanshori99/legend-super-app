# WS-12 wave 3: AI insights (legend-hkd4, legend-lely)

Worktree `.worktrees/ws12-ai`, branch `ws/ws12-ai`. Read first: `docs/briefs/sub-ws12-ai.md` (Decisions, Invariants), `apps/api/src/db/schema/ai.ts`, `apps/api/src/services/ai-gateway.service.ts` (`aiPreflight` :312, `aiComplete` :606), `apps/api/src/services/permission-resolver.ts` (`AccessSnapshot`, `allows`, `contextFor`, `allowsVia`).

## Hard rule while the full test gate runs

Phase A (now): **create new files only**. Do NOT edit any existing file (no `db/schema/index.ts`, `routes/index.ts`, `worker-main.ts`, `packages/shared/src/ai/index.ts`, drizzle meta). Do not run tests that need the DB yet. You may run `pnpm exec eslint <your files>` and `pnpm exec prettier --check <your files>`. No tsc (heavy only, gate owner).
Phase B (after gate, coordinator wires): exports, migration 0090 via `pnpm db:generate`, route mount, worker hooks, then each part runs its own test file.

## Scope (built now) and gaps (filed, not built)

Built: AI-07 forecast (rule-based), AI-08 purchase suggestion (par-based), AI-13 roster inputs (headcount per hour from forecast), AI-09 anomaly alerts (rule-based, stored + notified), AI-10 daily summary (LLM via gateway + template fallback, web push), AI-12 promo/menu copy draft, AI-14 expense account suggestion.
Gaps: AI-11 (no review table), AI-06 (no recipe table), AI-14 reconciliation matching (no bank statement table), AI-08 forecast-driven usage (no recipes), AI-13 skills/preferences (no skills/roster table), AI-09 cash variance (no cash variance table).

## Fixed interfaces (everyone codes against these names)

### Shared contract: `packages/shared/src/ai/insights.ts` (part S)
Strict zod 4 schemas + endpoint descriptors in the same style as `packages/shared/src/ai/endpoints.ts`:
- `forecastMetricCodes = ["sales_idr","orders","covers"] as const`; `forecastRowSchema {id, outletId, targetDate (YYYY-MM-DD), hour (0-23), metricCode, value (number), modelVersion ("rule-v1"), generatedAt}`; `listForecastsQuerySchema {outletId, from, to, metricCode?}` (max 31 days); endpoint `listAiForecasts` GET `/api/ai/forecasts`.
- `purchaseSuggestionSchema {inventoryItemId, itemName, locationId, locationName, unit, onHand, parMin, parMax, suggestedQty, reason: "below_min"|"below_max"}`; query `{outletId}`; endpoint `listAiPurchaseSuggestions` GET `/api/ai/purchase-suggestions`.
- `rosterInputSchema {outletId, date, hours: {hour, forecastCovers, forecastOrders, suggestedHeadcount}[] , coversPerStaff, basis: "forecast"|"rule_baseline"}`; query `{outletId, date, coversPerStaff? (default 12)}`; endpoint `getAiRosterInputs` GET `/api/ai/roster-inputs`.
- `anomalyAlertSchema {id, outletId, businessDate, kind: "void"|"discount"|"refund"|"waste", observedIdr, baselineIdr, ratio, severity: "warn"|"high", status: "open"|"acknowledged", createdAt}`; query `{outletId?, status?, from?, to?}`; endpoints `listAiAnomalyAlerts` GET `/api/ai/anomalies`, `acknowledgeAiAnomalyAlert` POST `/api/ai/anomalies/:id/acknowledge`.
- `dailySummarySchema {id, outletId, businessDate, text, aiAssisted: boolean, metrics: {salesIdr, orders, voidIdr, discountIdr, refundIdr, wasteIdr}, createdAt}`; query `{outletId, from?, to?}`; endpoint `listAiDailySummaries` GET `/api/ai/daily-summaries`.
- `promoCopyDraftInputSchema {kind: "menu_description"|"banner"|"campaign", menuItemIds?: uuid[] (max 10), brief: string (max 500), tone?: "santai"|"formal"}`; output `{drafts: string[] (1-3), aiAssisted: true, label: "Dibantu AI"}`; endpoint `draftAiPromoCopy` POST `/api/ai/drafts/promo-copy`.
- `expenseAccountSuggestInputSchema {description: string (max 300), amountIdr?: int}`; output `{suggestions: {accountId, code, name, confidence: "high"|"medium"|"low"}[] (max 3), aiAssisted: true, label: "Dibantu AI"}`; endpoint `suggestAiExpenseAccount` POST `/api/ai/drafts/expense-account`.
- Test: `tests/ai-insights-contract.test.mjs` (node --test, imports from `../packages/shared/src/ai/insights.ts` the same way `tests/ai-contract.test.mjs` imports).

### DB: `apps/api/src/db/schema/ai-insights.ts` + `apps/api/src/db/schema/ai-insights.custom.sql` (part S)
Copy conventions from `ai.ts` / `ai.custom.sql` (tenant_id NOT NULL, RLS enforced tenant + outlet like other outlet-owned tables, unique keys include tenant_id).
- `forecasts`: id uuid pk, tenant_id, outlet_id, target_date date, hour smallint 0-23, metric_code varchar(20), value numeric(14,2), model_version varchar(20), generated_at timestamptz; unique (tenant_id, outlet_id, target_date, hour, metric_code).
- `ai_anomaly_alerts`: id, tenant_id, outlet_id, business_date date, kind varchar(20), observed_idr bigint, baseline_idr bigint, ratio numeric(8,2), severity varchar(10), status varchar(15) default 'open', acknowledged_by uuid null, acknowledged_at null, created_at; unique (tenant_id, outlet_id, business_date, kind).
- `ai_daily_summaries`: id, tenant_id, outlet_id, business_date, text text, ai_assisted bool, metrics jsonb, created_at; unique (tenant_id, outlet_id, business_date).
Export table consts `forecasts`, `aiAnomalyAlerts`, `aiDailySummaries`.

### Services (all receive `access: AccessSnapshot`, run reads/writes inside `withTenant(access.contextFor(perm, {outletId}) ...)`; deny with `HttpError(403)` when `!access.allows(perm, {kind:"outlet", outletId})`)
Part F:
- `services/ai-forecast.service.ts`: `generateForecasts(context, {outletId, fromDate, days}): Promise<number>` (worker, system context) — rule-v1: for each hour, mean of the same weekday+hour over the last 8 weeks of `orders` (status not voided; sales from total_idr, orders = count, covers = count of distinct table_session_id, else orders); fewer than 8 weeks: use available weeks; zero history: no rows. Upsert. `listForecasts(access, query)` perm `report.sales.view`.
- `services/ai-purchase-suggestion.service.ts`: `listPurchaseSuggestions(access, {outletId})` perm `purchasing.request.create` OR `inventory.stock.view` — from `par_levels` + `stock_balances` (active locations only); below par_min → suggest par_max − onHand; else none.
- `services/ai-roster-inputs.service.ts`: `getRosterInputs(access, query)` perm `hr.schedule.manage` — reads forecasts; headcount = ceil(covers / coversPerStaff), min 1 during hours with orders.
- `worker/ai-forecast.job.ts`: `runAiForecastJob(systemContext, now)` — once per day per tenant/outlet (skip if forecasts for tomorrow already generated today), next 7 days.
Part A:
- `services/ai-anomaly.service.ts`: `detectAnomalies(context, {outletId, businessDate})` — observed per kind (voids `pos_order_voids.amount_idr`, discounts `pos_order_discounts` not removed, refunds `pos_order_refunds`, waste `waste_logs.value_idr`) vs baseline = mean of the same kind over previous 28 business days; ratio ≥ 2 → warn, ≥ 3 → high; skip if baseline 0 and observed < Rp100.000. Upsert alert; on new alert create a notification via `createNotificationService` (services/notification-center.ts:75) to users holding `report.operational.view` at that outlet. `listAnomalyAlerts(access, query)` + `acknowledgeAnomalyAlert(access, id)` perm `report.operational.view`.
- `services/ai-daily-summary.service.ts`: `generateDailySummary(context, {tenantId, outletId, businessDate})` — metrics from the same sources + orders; text via `aiComplete` (feature `AI-10`, channel `tanya_ai`, system prompt: Indonesian, max 5 sentences, only the given numbers, no PII) when `aiPreflight` passes; otherwise a deterministic Indonesian template with `aiAssisted:false`. Never send raw rows to the model, only the metrics object. Notify (web push via notification service) users with `report.sales.view` at the outlet. `listDailySummaries(access, query)` perm `report.sales.view`. NOTE: aiPreflight/aiComplete take an `AccessSnapshot`; for the worker build a system snapshot the same way other worker jobs do, or add a `systemAiComplete` in a NEW file `services/ai-system-call.ts` that applies the same budget/kill-switch/usage accounting (read gateway code; do not edit the gateway).
- `worker/ai-anomaly.job.ts`, `worker/ai-daily-summary.job.ts`: run for the previous business day once per tenant/outlet; idempotent via the unique keys.
Part D:
- `services/ai-drafts.service.ts`: `draftPromoCopy(access, input)` perm `promo.manage` OR `campaign.manage` OR `menu.item.manage` plus `ai.ask`; menu item name/description/allergens loaded server-side (tenant RLS); LLM via `aiPreflight`+`aiComplete` feature `AI-12`; user brief passed as data (content-as-data, like ai-prompts.ts); output parsed strictly to 1-3 strings. `suggestExpenseAccount(access, input)` perm `accounting.expense.request` OR `accounting.journal.view` plus `ai.ask`; candidate accounts = active expense accounts from `chart_of_accounts` (max 80 sent, code+name only); model must answer with codes from that list only; unknown codes dropped. Feature `AI-14`. PII-scan input (`lib/ai/pii.ts`) and reject with `AiError` like the orchestrator does.
Part R:
- `routes/ai-insights.routes.ts`: export `aiInsightsRouter`; per-route `requireAuth, requireTrustedOrigin, requireTenantContext` (+ `jsonBody` on POST), zod parse with the shared schemas, call services, `res.json({data})`. Copy the pattern from `routes/ai-governance.routes.ts`.

### Tests (new files, run in phase B)
`apps/api/src/test/ai-forecast.test.ts` (F), `ai-anomaly-summary.test.ts` (A), `ai-drafts.test.ts` (D, fake provider via `setAiProviderForTests`), `ai-insights-api.test.ts` (R: auth 401, 403 without perm, cross-tenant isolation, cross-outlet denial). Use helpers from `src/test/ai-acceptance-helpers.ts`. Each covers cross-tenant isolation for its tables.

## Report
≤12 lines: files created, anything you needed in an existing file (exact line to add), open questions.
