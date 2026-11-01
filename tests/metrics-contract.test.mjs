import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../packages/shared/src/core/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as metrics from "../packages/shared/src/metrics/index.ts";

const fixtures = metrics.cafeLegendMetricFixtures;

test("Cafe Legend metric fixtures parse and cover live and closed-period metrics", () => {
  assert.ok(fixtures.definitions.length >= 16);
  for (const definition of fixtures.definitions)
    metrics.metricDefinitionSchema.parse(definition);
  const codes = fixtures.definitions.map((definition) => definition.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(fixtures.definitionByCode.net_sales.unit, "idr");
  assert.equal(
    fixtures.definitionByCode.food_cost_pct.officiality,
    "closed_period_only",
  );
  assert.equal(fixtures.definitionByCode.pax.officiality, "live");
  assert.ok(metrics.metricPeriodSchema.parse(fixtures.closedMonthPeriod));
  assert.ok(metrics.metricPeriodSchema.parse(fixtures.openDayPeriod));
  assert.ok(metrics.metricSeriesSchema.parse(fixtures.netSalesDailySeries));
  assert.ok(metrics.metricQueryResponseSchema.parse(fixtures.queryResponse));
  assert.ok(
    metrics.metricQueryResponseSchema.parse(fixtures.estimateQueryResponse),
  );
  assert.ok(
    metrics.metricDefinitionListResponseSchema.parse(
      fixtures.definitionListPage,
    ),
  );
  assert.equal(fixtures.dailyRows.length, 2);
  for (const row of fixtures.dailyRows) metrics.metricDailyRowSchema.parse(row);
  assert.equal(
    fixtures.dailyRows[1].dimension.key,
    "channel",
    "dimension rows keep their split value",
  );
  assert.ok(events.eventEnvelopeSchema.parse(fixtures.aggregatedEvent));
});

test("metric definitions reject bad codes, units, routes, self references and time travel", () => {
  const definition = fixtures.definitionByCode.net_sales;
  for (const patch of [
    { code: "Net Sales" },
    { code: "" },
    { unit: "usd" },
    { status: "published" },
    { aggregation: "median" },
    { ownerModule: "marketing" },
    { grain: "hour" },
    {
      sourceReport: {
        reportCode: "sales.daily",
        route: "/reports/sales?day=1",
      },
    },
    { sourceReport: { reportCode: "sales.daily", route: "reports/sales" } },
    { dimensions: ["outlet", "outlet"] },
    { formula: { ...definition.formula, inputs: ["net_sales"] } },
    { formula: { ...definition.formula, inputs: ["pax", "pax"] } },
    { updatedAt: "2026-09-30T00:00:00.000Z" },
    { extra: true },
  ])
    assert.equal(
      metrics.metricDefinitionSchema.safeParse({ ...definition, ...patch })
        .success,
      false,
      JSON.stringify(patch),
    );
});

test("metrics_daily rows stay tenant-scoped and validate value, date and dimension", () => {
  const row = fixtures.dailyRows[0];
  for (const patch of [
    { tenantId: "" },
    { tenantId: "bad" },
    { outletId: "bad" },
    { metricDate: "31-10-2026" },
    { value: { unit: "idr", valueIdr: 1.5 } },
    { dimension: { key: "Channel", value: "qr" } },
    { definitionVersion: 0 },
    { finality: "official" },
    { extra: true },
  ])
    assert.equal(
      metrics.metricDailyRowSchema.safeParse({ ...row, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  const withoutTenant = { ...row };
  delete withoutTenant.tenantId;
  assert.equal(
    metrics.metricDailyRowSchema.safeParse(withoutTenant).success,
    false,
  );
});

test("metric values are typed by unit and reject float money", () => {
  assert.deepEqual(
    metrics.metricValueSchema.parse({ unit: "idr", valueIdr: 0 }),
    {
      unit: "idr",
      valueIdr: 0,
    },
  );
  assert.deepEqual(
    metrics.metricValueSchema.parse({ unit: "percent", value: "31.4200" }),
    { unit: "percent", value: "31.4200" },
  );
  for (const bad of [
    { unit: "idr", valueIdr: 1.5 },
    { unit: "idr", valueIdr: "1000" },
    { unit: "count", value: "12" },
    { unit: "percent", value: 31.42 },
    { unit: "seconds", value: { seconds: 5 } },
    { unit: "unknown", value: 1 },
    { unit: "idr", valueIdr: 1, extra: true },
  ])
    assert.equal(
      metrics.metricValueSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test("metric periods enforce order and cannot be open with a closed accounting period", () => {
  const period = fixtures.closedMonthPeriod;
  assert.equal(
    metrics.metricPeriodSchema.safeParse({
      ...period,
      startDate: "2026-11-01",
    }).success,
    false,
  );
  assert.equal(
    metrics.metricPeriodSchema.safeParse({ ...period, status: "open" }).success,
    false,
  );
  assert.equal(
    metrics.metricPeriodSchema.safeParse({
      ...period,
      accountingPeriodClosed: false,
    }).success,
    true,
  );
  assert.equal(
    metrics.metricPeriodSchema.safeParse({ ...period, bucket: "hour" }).success,
    false,
  );
});

test("SH-02: only closed periods with closed accounting produce final figures", () => {
  assert.equal(
    metrics.metricValueFinality({
      officiality: "live",
      periodClosed: false,
      accountingPeriodClosed: false,
    }),
    "estimate",
  );
  assert.equal(
    metrics.metricValueFinality({
      officiality: "closed_period_only",
      periodClosed: true,
      accountingPeriodClosed: false,
    }),
    "estimate",
  );
  assert.equal(
    metrics.metricValueFinality({
      officiality: "closed_period_only",
      periodClosed: true,
      accountingPeriodClosed: true,
    }),
    "final",
  );
  assert.equal(
    metrics.metricValueFinality({
      officiality: "live",
      periodClosed: true,
      accountingPeriodClosed: false,
    }),
    "final",
  );
});

test("metric definition and finality state machines allow only declared transitions", () => {
  assert.equal(
    metrics.canTransitionMetricDefinitionStatus("draft", "active"),
    true,
  );
  assert.equal(
    metrics.canTransitionMetricDefinitionStatus("active", "deprecated"),
    true,
  );
  assert.equal(
    metrics.canTransitionMetricDefinitionStatus("draft", "deprecated"),
    false,
  );
  assert.equal(
    metrics.canTransitionMetricDefinitionStatus("deprecated", "active"),
    false,
  );
  assert.equal(
    metrics.transitionMetricDefinitionStatus("draft", "active"),
    "active",
  );
  assert.throws(
    () => metrics.transitionMetricDefinitionStatus("draft", "deprecated"),
    (error) => error instanceof core.CoreError && error.code === "CONFLICT",
  );
  assert.equal(metrics.canTransitionMetricFinality("estimate", "final"), true);
  assert.equal(metrics.canTransitionMetricFinality("final", "estimate"), false);
  assert.throws(
    () => metrics.transitionMetricFinality("final", "estimate"),
    (error) => error instanceof core.CoreError && error.code === "CONFLICT",
  );
});

test("comparison keeps units, computes deltas and handles a zero baseline", () => {
  assert.deepEqual(
    metrics.compareMetricValues(
      { unit: "idr", valueIdr: 1_234_000 },
      { unit: "idr", valueIdr: 1_100_000 },
    ),
    {
      previousValue: { unit: "idr", valueIdr: 1_100_000 },
      changeValue: { unit: "idr", valueIdr: 134_000 },
      changePercent: "12.1818",
    },
  );
  assert.deepEqual(
    metrics.compareMetricValues(
      { unit: "percent", value: "32.4500" },
      { unit: "percent", value: "30.0000" },
    ),
    {
      previousValue: { unit: "percent", value: "30.0000" },
      changeValue: { unit: "percent", value: "2.4500" },
      changePercent: "8.1667",
    },
  );
  assert.deepEqual(
    metrics.compareMetricValues(
      { unit: "count", value: 1_306 },
      { unit: "count", value: 1_184 },
    ),
    {
      previousValue: { unit: "count", value: 1_184 },
      changeValue: { unit: "count", value: 122 },
      changePercent: "10.3041",
    },
  );
  assert.equal(
    metrics.compareMetricValues(
      { unit: "count", value: 10 },
      { unit: "count", value: 0 },
    ).changePercent,
    null,
  );
  assert.equal(
    metrics.compareMetricValues(
      { unit: "count", value: 90 },
      { unit: "count", value: 100 },
    ).changePercent,
    "-10.0000",
  );
  // A negative baseline (net loss) measures change against |previous|.
  assert.equal(
    metrics.compareMetricValues(
      { unit: "idr", valueIdr: -50_000 },
      { unit: "idr", valueIdr: -100_000 },
    ).changePercent,
    "50.0000",
  );
  assert.throws(
    () =>
      metrics.compareMetricValues(
        { unit: "count", value: 1 },
        { unit: "idr", valueIdr: 1 },
      ),
    RangeError,
  );
});

test("DASH-01: source report links carry the period, outlets and grouping", () => {
  const outletId = core.cafeLegendFixtures.outlets[0].id;
  const path = metrics.metricSourceReportPath(
    fixtures.definitionByCode.net_sales.sourceReport,
    {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      outletIds: [outletId],
      groupBy: "channel",
    },
  );
  assert.equal(
    path,
    `/reports/sales/daily?startDate=2026-10-01&endDate=2026-10-31&outletId=${outletId}&groupBy=channel`,
  );
  assert.equal(
    metrics.metricSourceReportPath(fixtures.definitionByCode.pax.sourceReport, {
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    }),
    "/reports/traffic/pax?startDate=2026-11-01&endDate=2026-11-01",
  );
});

test("metric query requests default the bucket and refuse client tenant fields", () => {
  const request = fixtures.queryRequest;
  assert.ok(metrics.metricQueryRequestSchema.parse(request));
  const parsed = metrics.metricQueryRequestSchema.parse({
    metricCodes: ["net_sales"],
    period: { startDate: "2026-10-01", endDate: "2026-10-31" },
  });
  assert.equal(parsed.bucket, "total");
  assert.equal(parsed.comparePrevious, false);
  assert.equal(parsed.requireFinal, false);
  for (const bad of [
    { ...request, tenantId: core.cafeLegendFixtures.tenant.id },
    { ...request, metricCodes: [] },
    { ...request, period: { startDate: "2026-10-31", endDate: "2026-10-01" } },
    { ...request, bucket: "hour" },
    { ...request, outletIds: [] },
    { ...request, extra: true },
  ])
    assert.equal(
      metrics.metricQueryRequestSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test("metric query responses link series to registered definitions and valid units", () => {
  const response = fixtures.queryResponse;
  assert.ok(metrics.metricQueryResponseSchema.parse(response));
  const [netSales, pax] = response.data.definitions;
  for (const bad of [
    {
      ...response,
      data: {
        ...response.data,
        definitions: [netSales, netSales],
      },
    },
    {
      ...response,
      data: {
        ...response.data,
        series: response.data.series.map((series) =>
          series.metricCode === "net_sales"
            ? { ...series, metricCode: "waste_cost" }
            : series,
        ),
      },
    },
    {
      ...response,
      data: {
        ...response.data,
        series: response.data.series.map((series) => ({
          ...series,
          definition:
            series.metricCode === "net_sales" ? { ...pax } : series.definition,
        })),
      },
    },
    {
      ...response,
      data: {
        ...response.data,
        series: response.data.series.map((series) =>
          series.metricCode === "net_sales"
            ? {
                ...series,
                points: [
                  {
                    ...series.points[0],
                    value: { unit: "count", value: 12 },
                  },
                ],
                dimension: null,
              }
            : series,
        ),
      },
    },
    {
      ...response,
      data: {
        ...response.data,
        series: [...response.data.series, response.data.series[0]],
      },
    },
  ])
    assert.equal(
      metrics.metricQueryResponseSchema.safeParse(bad).success,
      false,
      "expected rejection",
    );
  assert.equal(
    response.data.series.find((series) => series.metricCode === "net_sales")
      .points[0].finality,
    "final",
  );
  assert.equal(
    fixtures.estimateQueryResponse.data.series[0].points[0].finality,
    "estimate",
  );
});

test("definition list pages use the shared opaque cursor", () => {
  const page = fixtures.definitionListPage;
  assert.ok(metrics.metricDefinitionListResponseSchema.parse(page));
  assert.equal(page.data.length, 3);
  assert.equal(core.decodeCursor(page.meta.nextCursor).length, 2);
  assert.equal(
    metrics.metricDefinitionListQuerySchema.safeParse({ limit: "10" }).success,
    true,
  );
  assert.equal(
    metrics.metricDefinitionListQuerySchema.safeParse({ limit: "1000" })
      .success,
    false,
  );
  assert.throws(() => core.decodeCursor("!!!"), RangeError);
  assert.equal(
    metrics.metricDefinitionListQuerySchema.safeParse({
      cursor: "a".repeat(1025),
    }).success,
    false,
  );
  assert.equal(
    metrics.metricDefinitionListQuerySchema.safeParse({
      ownerModule: "marketing",
    }).success,
    false,
  );
});

test("WS-11 metrics.aggregated is catalogued and its payload is validated", () => {
  const entry = events.eventCatalog.find(
    (candidate) => candidate.name === "metrics.aggregated",
  );
  assert.ok(entry);
  assert.equal(entry.aggregateType, "metrics");
  assert.equal(entry.version, 1);
  assert.equal(entry.payloadSchemaRef, "metrics.aggregated.v1");
  assert.equal(entry.workstream, "WS-11");
  assert.ok(metrics.METRICS_EVENT_PAYLOAD_SCHEMAS["metrics.aggregated"]);
  assert.equal(
    metrics.metricsAggregatedEvent.payloadSchemaRef,
    entry.payloadSchemaRef,
  );
  assert.ok(
    metrics.metricsAggregatedEvent.envelopeSchema.parse(
      fixtures.aggregatedEvent,
    ),
  );
  const payload = fixtures.aggregatedEvent.payload;
  assert.ok(metrics.metricsAggregatedPayloadSchema.parse(payload));
  for (const bad of [
    { ...payload, status: "failed", errorCode: null },
    { ...payload, status: "succeeded", errorCode: "OUTAGE" },
    { ...payload, metricDate: "2026-10-32" },
    { ...payload, pointsWritten: -1 },
    { ...payload, metricCodes: [] },
    { ...payload, extra: true },
  ])
    assert.equal(
      metrics.metricsAggregatedPayloadSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test("metric domain errors map to stable codes and HTTP statuses", () => {
  assert.equal(metrics.metricErrorHttpStatus.PERIOD_NOT_CLOSED, 409);
  assert.equal(metrics.metricErrorHttpStatus.METRIC_NOT_FOUND, 404);
  assert.equal(
    metrics.metricErrorHttpStatus.METRIC_DIMENSION_NOT_SUPPORTED,
    400,
  );
  assert.ok(
    metrics.cafeLegendMetricFixtures.errors.periodNotClosed.error.message
      .length > 0,
  );
  assert.ok(
    core.isApiErrorBody(fixtures.errors.periodNotClosed),
    "fixture is a valid API error envelope",
  );
  assert.ok(metrics.metricErrorCodeSchema.parse("METRIC_NOT_FOUND"));
});

test("ratio aggregation: percentages are never summed and ratios name their inputs", () => {
  const base = fixtures.definitionByCode.food_cost_pct;
  assert.ok(metrics.metricDefinitionSchema.parse(base));
  assert.equal(
    metrics.metricDefinitionSchema.safeParse({ ...base, aggregation: "sum" })
      .success,
    false,
  );
  assert.equal(
    metrics.metricDefinitionSchema.safeParse({
      ...base,
      formula: { ...base.formula, inputs: [] },
    }).success,
    false,
  );
});
