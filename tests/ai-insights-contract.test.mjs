// WS-12 wave 3 AI insights contract tests (beads legend-hkd4, legend-lely).
// AI-07 forecast, AI-08 purchase suggestion, AI-09 anomaly alerts, AI-10 daily
// summary, AI-12 promo copy draft, AI-13 roster inputs, AI-14 expense account.
// Run with: node --test tests/ai-insights-contract.test.mjs (no database needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as i from "../packages/shared/src/ai/insights.ts";

const OUTLET = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-09T01:00:00+07:00";
const clone = (value) => structuredClone(value);
const rejects = (schema, value) =>
  assert.equal(schema.safeParse(value).success, false);
const accepts = (schema, value) => {
  const result = schema.safeParse(value);
  assert.ok(result.success, result.success ? "" : result.error.message);
  return result.data;
};

test("AI-07 forecast row is strict and only rule-v1 / known metrics pass", () => {
  const row = {
    id: ID,
    outletId: OUTLET,
    targetDate: "2026-11-10",
    hour: 12,
    metricCode: "sales_idr",
    value: 1250000.5,
    modelVersion: "rule-v1",
    generatedAt: NOW,
  };
  assert.deepEqual(
    [...i.forecastMetricCodes],
    ["sales_idr", "orders", "covers"],
  );
  accepts(i.forecastRowSchema, row);
  rejects(i.forecastRowSchema, { ...row, extra: 1 });
  rejects(i.forecastRowSchema, { ...row, hour: 24 });
  rejects(i.forecastRowSchema, { ...row, hour: -1 });
  rejects(i.forecastRowSchema, { ...row, metricCode: "profit" });
  rejects(i.forecastRowSchema, { ...row, modelVersion: "rule-v2" });
  rejects(i.forecastRowSchema, { ...row, targetDate: "10-11-2026" });
});

test("AI-07 forecast query: range max 31 days, ordered, outlet required", () => {
  const query = { outletId: OUTLET, from: "2026-11-01", to: "2026-12-01" };
  accepts(i.listForecastsQuerySchema, query);
  accepts(i.listForecastsQuerySchema, { ...query, metricCode: "covers" });
  rejects(i.listForecastsQuerySchema, { ...query, to: "2026-12-02" });
  rejects(i.listForecastsQuerySchema, { ...query, to: "2026-10-31" });
  rejects(i.listForecastsQuerySchema, { from: query.from, to: query.to });
  rejects(i.listForecastsQuerySchema, { ...query, tenantId: ID });
  assert.equal(i.listAiForecasts.method, "GET");
  assert.equal(i.listAiForecasts.path, "/api/ai/forecasts");
});

test("AI-08 purchase suggestion shape, reasons and endpoint", () => {
  const row = {
    inventoryItemId: ID,
    itemName: "Biji kopi",
    locationId: OUTLET,
    locationName: "Gudang",
    unit: "kg",
    onHand: 2.5,
    parMin: 5,
    parMax: 20,
    suggestedQty: 17.5,
    reason: "below_min",
  };
  accepts(i.purchaseSuggestionSchema, row);
  accepts(i.purchaseSuggestionSchema, { ...row, reason: "below_max" });
  rejects(i.purchaseSuggestionSchema, { ...row, reason: "expired" });
  rejects(i.purchaseSuggestionSchema, { ...row, suggestedQty: 0 });
  rejects(i.purchaseSuggestionSchema, { ...row, extra: true });
  accepts(i.listPurchaseSuggestionsQuerySchema, { outletId: OUTLET });
  rejects(i.listPurchaseSuggestionsQuerySchema, {});
  assert.equal(i.listAiPurchaseSuggestions.method, "GET");
  assert.equal(
    i.listAiPurchaseSuggestions.path,
    "/api/ai/purchase-suggestions",
  );
});

test("AI-13 roster inputs: coversPerStaff defaults to 12 and reads from a query string", () => {
  const base = { outletId: OUTLET, date: "2026-11-10" };
  assert.equal(accepts(i.rosterInputsQuerySchema, base).coversPerStaff, 12);
  assert.equal(
    accepts(i.rosterInputsQuerySchema, { ...base, coversPerStaff: "8" })
      .coversPerStaff,
    8,
  );
  rejects(i.rosterInputsQuerySchema, { ...base, coversPerStaff: 0 });
  rejects(i.rosterInputsQuerySchema, { ...base, coversPerStaff: "abc" });
  rejects(i.rosterInputsQuerySchema, { outletId: OUTLET });

  const roster = {
    outletId: OUTLET,
    date: "2026-11-10",
    hours: [
      {
        hour: 12,
        forecastCovers: 30,
        forecastOrders: 22,
        suggestedHeadcount: 3,
      },
    ],
    coversPerStaff: 12,
    basis: "forecast",
  };
  accepts(i.rosterInputSchema, roster);
  accepts(i.rosterInputSchema, {
    ...roster,
    basis: "rule_baseline",
    hours: [],
  });
  rejects(i.rosterInputSchema, { ...roster, basis: "guess" });
  rejects(i.rosterInputSchema, clone({ ...roster, hours: [{ hour: 12 }] }));
  assert.equal(i.getAiRosterInputs.path, "/api/ai/roster-inputs");
});

test("AI-09 anomaly alert shape, filters and endpoints", () => {
  const alert = {
    id: ID,
    outletId: OUTLET,
    businessDate: "2026-11-08",
    kind: "void",
    observedIdr: 450000,
    baselineIdr: 100000,
    ratio: 4.5,
    severity: "high",
    status: "open",
    createdAt: NOW,
  };
  for (const kind of ["void", "discount", "refund", "waste"])
    accepts(i.anomalyAlertSchema, { ...alert, kind });
  accepts(i.anomalyAlertSchema, {
    ...alert,
    severity: "warn",
    status: "acknowledged",
  });
  rejects(i.anomalyAlertSchema, { ...alert, kind: "cash_variance" });
  rejects(i.anomalyAlertSchema, { ...alert, severity: "low" });
  rejects(i.anomalyAlertSchema, { ...alert, status: "closed" });
  rejects(i.anomalyAlertSchema, { ...alert, observedIdr: 1.5 });
  rejects(i.anomalyAlertSchema, { ...alert, extra: 1 });

  accepts(i.listAnomalyAlertsQuerySchema, {});
  accepts(i.listAnomalyAlertsQuerySchema, {
    outletId: OUTLET,
    status: "open",
    from: "2026-11-01",
    to: "2026-11-08",
  });
  rejects(i.listAnomalyAlertsQuerySchema, { status: "closed" });
  assert.equal(i.listAiAnomalyAlerts.path, "/api/ai/anomalies");
  assert.equal(i.acknowledgeAiAnomalyAlert.method, "POST");
  assert.equal(
    i.acknowledgeAiAnomalyAlert.path,
    "/api/ai/anomalies/:id/acknowledge",
  );
  accepts(i.acknowledgeAiAnomalyAlert.params, { id: ID });
  rejects(i.acknowledgeAiAnomalyAlert.params, { id: "nope" });
});

test("AI-10 daily summary shape and query", () => {
  const summary = {
    id: ID,
    outletId: OUTLET,
    businessDate: "2026-11-08",
    text: "Penjualan kemarin Rp5.000.000 dari 80 pesanan.",
    aiAssisted: false,
    metrics: {
      salesIdr: 5000000,
      orders: 80,
      voidIdr: 0,
      discountIdr: 25000,
      refundIdr: 0,
      wasteIdr: 10000,
    },
    createdAt: NOW,
  };
  accepts(i.dailySummarySchema, summary);
  accepts(i.dailySummarySchema, { ...summary, aiAssisted: true });
  rejects(i.dailySummarySchema, { ...summary, text: "" });
  rejects(i.dailySummarySchema, { ...summary, metrics: { salesIdr: 1 } });
  rejects(i.dailySummarySchema, {
    ...summary,
    metrics: { ...summary.metrics, customerName: "Budi" },
  });
  accepts(i.listDailySummariesQuerySchema, { outletId: OUTLET });
  rejects(i.listDailySummariesQuerySchema, {});
  assert.equal(i.listAiDailySummaries.path, "/api/ai/daily-summaries");
});

test("AI-12 promo copy input: brief max 500, up to 10 menu items, strict output label", () => {
  const input = { kind: "banner", brief: "Diskon akhir pekan", tone: "santai" };
  accepts(i.promoCopyDraftInputSchema, input);
  accepts(i.promoCopyDraftInputSchema, {
    ...input,
    menuItemIds: Array.from({ length: 10 }, () => ID),
  });
  rejects(i.promoCopyDraftInputSchema, {
    ...input,
    menuItemIds: Array.from({ length: 11 }, () => ID),
  });
  rejects(i.promoCopyDraftInputSchema, { ...input, brief: "x".repeat(501) });
  accepts(i.promoCopyDraftInputSchema, { ...input, brief: "x".repeat(500) });
  rejects(i.promoCopyDraftInputSchema, { ...input, kind: "email" });
  rejects(i.promoCopyDraftInputSchema, { ...input, tone: "kasar" });
  rejects(i.promoCopyDraftInputSchema, { ...input, menuItemIds: ["x"] });
  rejects(i.promoCopyDraftInputSchema, { ...input, outletId: OUTLET });

  const output = { drafts: ["Satu"], aiAssisted: true, label: "Dibantu AI" };
  accepts(i.promoCopyDraftOutputSchema, output);
  accepts(i.promoCopyDraftOutputSchema, { ...output, drafts: ["a", "b", "c"] });
  rejects(i.promoCopyDraftOutputSchema, { ...output, drafts: [] });
  rejects(i.promoCopyDraftOutputSchema, {
    ...output,
    drafts: ["a", "b", "c", "d"],
  });
  rejects(i.promoCopyDraftOutputSchema, { ...output, aiAssisted: false });
  rejects(i.promoCopyDraftOutputSchema, { ...output, label: "AI" });
  assert.equal(i.draftAiPromoCopy.method, "POST");
  assert.equal(i.draftAiPromoCopy.path, "/api/ai/drafts/promo-copy");
});

test("AI-14 expense account input and output limits", () => {
  const input = { description: "Beli galon air", amountIdr: 45000 };
  accepts(i.expenseAccountSuggestInputSchema, input);
  accepts(i.expenseAccountSuggestInputSchema, { description: "x".repeat(300) });
  rejects(i.expenseAccountSuggestInputSchema, { description: "x".repeat(301) });
  rejects(i.expenseAccountSuggestInputSchema, { ...input, amountIdr: 1.5 });
  accepts(i.expenseAccountSuggestInputSchema, {
    ...input,
    legalEntityId: "11111111-1111-4111-8111-111111111111",
  });
  rejects(i.expenseAccountSuggestInputSchema, {
    ...input,
    legalEntityId: "not-a-uuid",
  });
  rejects(i.expenseAccountSuggestInputSchema, { ...input, extra: 1 });

  const suggestion = {
    accountId: ID,
    code: "6-1100",
    name: "Beban Operasional",
    confidence: "high",
  };
  const output = {
    suggestions: [suggestion],
    aiAssisted: true,
    label: "Dibantu AI",
  };
  accepts(i.expenseAccountSuggestOutputSchema, output);
  accepts(i.expenseAccountSuggestOutputSchema, { ...output, suggestions: [] });
  rejects(i.expenseAccountSuggestOutputSchema, {
    ...output,
    suggestions: Array.from({ length: 4 }, () => suggestion),
  });
  rejects(i.expenseAccountSuggestOutputSchema, {
    ...output,
    suggestions: [{ ...suggestion, confidence: "certain" }],
  });
  rejects(i.expenseAccountSuggestOutputSchema, { ...output, label: "AI" });
  assert.equal(i.suggestAiExpenseAccount.method, "POST");
  assert.equal(
    i.suggestAiExpenseAccount.path,
    "/api/ai/drafts/expense-account",
  );
});

test("every insights endpoint has a unique id under /api/ai", () => {
  const endpoints = [
    i.listAiForecasts,
    i.listAiPurchaseSuggestions,
    i.getAiRosterInputs,
    i.listAiAnomalyAlerts,
    i.acknowledgeAiAnomalyAlert,
    i.listAiDailySummaries,
    i.draftAiPromoCopy,
    i.suggestAiExpenseAccount,
  ];
  assert.equal(new Set(endpoints.map((e) => e.id)).size, endpoints.length);
  for (const endpoint of endpoints)
    assert.ok(endpoint.path.startsWith("/api/ai/"));
});
