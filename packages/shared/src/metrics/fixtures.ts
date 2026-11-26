// Cafe Legend mock data for the metric layer (FE mock mode + contract tests).
// Realistic figures for the Bandung outlet; the second outlet is sample data.
// Definitions are global registry rows: the full report/metric catalog is
// WS-11's own contract (legend-mmjb), while these 16 cover every unit,
// aggregation and officiality the dashboards cite (PRD §3 F34-F36, §6 J).

import {
  apiErrorBody,
  cafeLegendFixtures,
  encodeCursor,
} from "../core/index.ts";
import type { z } from "../core/index.ts";
import { eventEnvelopeSchema } from "../events/index.ts";
import {
  metricDailyRowSchema,
  metricDefinitionListResponseSchema,
  metricDefinitionRefSchema,
  metricDefinitionSchema,
  metricPeriodSchema,
  metricPointSchema,
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  metricSeriesSchema,
  metricValueSchema,
} from "./schemas.ts";
import type {
  MetricDefinition,
  MetricDefinitionRef,
  MetricValue,
} from "./schemas.ts";
import { compareMetricValues } from "./values.ts";

const createdAt = "2026-10-01T00:00:00.000Z";
const updatedAt = "2026-10-20T03:15:00.000Z";

const definitionInputs = [
  {
    id: "dce874d4-b0a0-4403-b0e3-50b202a52076",
    code: "net_sales",
    version: 2,
    name: "Penjualan bersih",
    description:
      "Saldo bagian pendapatan di buku besar (kredit dikurangi debit), sudah dikurangi akun kontra diskon, refund, dan comp.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.net_sales",
      expression:
        "sum(journal_lines.credit_idr - journal_lines.debit_idr) where chart_of_accounts.report_group = 'revenue'",
      inputs: [],
    },
    unit: "idr",
    aggregation: "sum",
    dimensions: [
      "outlet",
      "channel",
      "menu_category",
      "hour",
      "payment_method",
      "menu_item",
      "employee",
      "day_of_week",
      "promo",
      "legal_entity",
    ],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "sales.daily",
      route: "/reports/sales/daily",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "5b4471d0-6dfd-46d9-9225-351b0ee44722",
    code: "pax",
    version: 1,
    name: "Jumlah tamu (pax)",
    description:
      "Jumlah tamu yang tercatat pada sesi meja, termasuk tamu yang tidak memesan.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.pax",
      expression: "sum(table_session.pax)",
      inputs: [],
    },
    unit: "count",
    aggregation: "sum",
    dimensions: [
      "outlet",
      "channel",
      "hour",
      "day_of_week",
      "zone",
      "customer_tier",
    ],
    grain: "day",
    officiality: "live",
    sourceReport: { reportCode: "traffic.pax", route: "/reports/traffic/pax" },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "87392f33-d238-48d6-b900-f1a2d0834a14",
    code: "transaction_count",
    version: 1,
    name: "Jumlah transaksi",
    description: "Jumlah pesanan yang dibayar penuh pada periode.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.transaction_count",
      expression: "count(order.paid)",
      inputs: [],
    },
    unit: "count",
    aggregation: "sum",
    dimensions: ["outlet", "channel", "payment_method", "hour", "employee"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "sales.transactions",
      route: "/reports/sales/transactions",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "7105ef54-c864-4493-aad3-0089e1466a9d",
    code: "avg_spend_per_pax",
    version: 1,
    name: "Rata-rata belanja per tamu",
    description: "Penjualan bersih dibagi jumlah tamu pada periode yang sama.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.avg_spend_per_pax",
      expression: "net_sales / pax",
      inputs: ["net_sales", "pax"],
    },
    unit: "idr",
    aggregation: "ratio",
    dimensions: ["outlet", "channel", "hour", "zone"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "sales.per_pax",
      route: "/reports/sales/per-pax",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "212e7b30-18ae-47f0-b6b1-cd5fe103802c",
    code: "food_cost_pct",
    version: 2,
    name: "Food cost %",
    description:
      "HPP di buku besar dibagi penjualan bersih; resmi setelah periode akuntansi ditutup.",
    ownerModule: "inventory",
    formula: {
      formulaRef: "inventory.food_cost_pct",
      expression:
        "sum(journal_lines.debit_idr - journal_lines.credit_idr) where chart_of_accounts.report_group = 'cogs' / net_sales * 100",
      inputs: ["cogs", "net_sales"],
    },
    unit: "percent",
    aggregation: "ratio",
    dimensions: ["outlet", "menu_category", "menu_item", "legal_entity"],
    grain: "day",
    officiality: "closed_period_only",
    sourceReport: {
      reportCode: "inventory.food_cost",
      route: "/reports/inventory/food-cost",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "90437aa2-128d-415b-ac80-59cb03ea5ec2",
    code: "labor_cost_pct",
    version: 2,
    name: "Labor cost %",
    description:
      "Beban gaji dan BPJS perusahaan di buku besar dibagi penjualan bersih; resmi setelah periode akuntansi ditutup. Gaji dicatat di tingkat badan usaha, jadi untuk satu outlet nilainya kosong.",
    ownerModule: "payroll",
    formula: {
      formulaRef: "payroll.labor_cost_pct",
      expression:
        "sum(journal_lines.debit_idr - journal_lines.credit_idr) where account_mappings.role in ('salary_expense', 'bpjs_expense') incl. child accounts / net_sales * 100",
      inputs: ["net_sales"],
    },
    unit: "percent",
    aggregation: "ratio",
    dimensions: ["outlet", "employee"],
    grain: "day",
    officiality: "closed_period_only",
    sourceReport: {
      reportCode: "payroll.labor_cost",
      route: "/reports/payroll/labor-cost",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "79b9ca9c-2622-4c78-b197-d68e0b46b48b",
    code: "prime_cost_pct",
    version: 2,
    name: "Prime cost %",
    description:
      "Food cost % ditambah labor cost %; dasar margin operasional harian.",
    ownerModule: "accounting",
    formula: {
      formulaRef: "accounting.prime_cost_pct",
      expression:
        "(sum(journal_lines.debit_idr - journal_lines.credit_idr) where chart_of_accounts.report_group = 'cogs' or account_mappings.role in ('salary_expense', 'bpjs_expense') incl. child accounts) / net_sales * 100",
      inputs: ["cogs", "net_sales"],
    },
    unit: "percent",
    aggregation: "ratio",
    dimensions: ["outlet"],
    grain: "month",
    officiality: "closed_period_only",
    sourceReport: {
      reportCode: "finance.prime_cost",
      route: "/reports/finance/prime-cost",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "51bef82a-99b3-4a0f-9191-71938e788f8d",
    code: "table_turnover",
    version: 1,
    name: "Perputaran meja",
    description: "Rata-rata berapa kali satu meja dipakai ulang per hari.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.table_turnover",
      expression: "count(table_session.closed) / count(table)",
      inputs: [],
    },
    unit: "decimal",
    aggregation: "average",
    dimensions: ["outlet", "zone"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "operations.table_turnover",
      route: "/reports/operations/table-turnover",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "f84c048d-fe6d-401b-93aa-e22e12625d2a",
    code: "table_occupancy_pct",
    version: 1,
    name: "Okupansi meja",
    description: "Persentase waktu meja terisi dibanding jam buka outlet.",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.table_occupancy_pct",
      expression:
        "sum(table_session.minutes) / (count(table) * open_minutes) * 100",
      inputs: [],
    },
    unit: "percent",
    aggregation: "average",
    dimensions: ["outlet", "zone", "hour"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "operations.occupancy",
      route: "/reports/operations/occupancy",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "3d6fdafe-b497-4ad2-930c-9f3583374f90",
    code: "revpash",
    version: 1,
    name: "RevPASH zona WFC",
    description:
      "Pendapatan per kursi tersedia per jam di zona WFC (U19); resmi setelah hari ditutup.",
    ownerModule: "facility",
    formula: {
      formulaRef: "facility.revpash",
      expression: "zone_revenue / (available_seats * open_hours)",
      inputs: ["net_sales"],
    },
    unit: "idr",
    aggregation: "ratio",
    dimensions: ["outlet", "zone", "hour"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "facility.revpash",
      route: "/reports/facility/revpash",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "975da87a-0741-4783-be20-63ae686b46dc",
    code: "shower_revenue",
    version: 1,
    name: "Pendapatan shower room",
    description:
      "Penjualan tiket akses dan langganan shower room pada periode.",
    ownerModule: "facility",
    formula: {
      formulaRef: "facility.shower_revenue",
      expression: "sum(access_ticket.paid_idr) + sum(subscription.billed_idr)",
      inputs: [],
    },
    unit: "idr",
    aggregation: "sum",
    dimensions: ["outlet", "facility", "unit"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "facility.revenue",
      route: "/reports/facility/revenue",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "07895f58-83d8-4c4e-b881-464494790035",
    code: "wifi_quota_used",
    version: 1,
    name: "Pemakaian kuota Wi-Fi",
    description: "Total kuota Wi-Fi terpakai tamu pada periode, dalam GB.",
    ownerModule: "facility",
    formula: {
      formulaRef: "facility.wifi_quota_used",
      expression: "sum(wifi_quota.used_gb)",
      inputs: [],
    },
    unit: "decimal",
    aggregation: "sum",
    dimensions: ["outlet", "facility"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "facility.wifi",
      route: "/reports/facility/wifi",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "104ed679-71b2-492f-a83b-266e4b94ad16",
    code: "net_profit",
    version: 2,
    name: "Laba bersih",
    description:
      "Laba bersih akuntansi periode; hanya resmi setelah periode ditutup (SH-02).",
    ownerModule: "accounting",
    formula: {
      formulaRef: "accounting.net_profit",
      expression:
        "sum(journal_lines.credit_idr - journal_lines.debit_idr) where chart_of_accounts.report_group in ('revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense')",
      inputs: [],
    },
    unit: "idr",
    aggregation: "sum",
    dimensions: ["outlet", "legal_entity"],
    grain: "month",
    officiality: "closed_period_only",
    sourceReport: {
      reportCode: "finance.income_statement",
      route: "/reports/finance/income-statement",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "08a70f21-46b4-4b9c-ae10-a2f66d788102",
    code: "ebitda",
    version: 2,
    name: "EBITDA",
    description:
      "Laba sebelum bunga, pajak, depresiasi, dan amortisasi dari jurnal yang sudah diposting; resmi setelah periode ditutup.",
    ownerModule: "accounting",
    formula: {
      formulaRef: "accounting.ebitda",
      expression:
        "sum(journal_lines.credit_idr - journal_lines.debit_idr) where chart_of_accounts.report_group in ('revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense') and the account (incl. child accounts) is not mapped to account_mappings.role in ('depreciation_expense', 'amortization_expense', 'interest_expense', 'income_tax_expense')",
      inputs: [],
    },
    unit: "idr",
    aggregation: "sum",
    dimensions: ["outlet", "legal_entity"],
    grain: "month",
    officiality: "closed_period_only",
    sourceReport: {
      reportCode: "finance.ebitda",
      route: "/reports/finance/ebitda",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "5bac2588-4757-48bb-87a1-f6ac5d7d71d7",
    code: "void_rate_pct",
    version: 1,
    name: "Void rate",
    description:
      "Nilai void dan pembatalan dibagi penjualan bersih; dipantau untuk anomali (AI-09).",
    ownerModule: "pos",
    formula: {
      formulaRef: "pos.void_rate_pct",
      expression: "sum(order.void_idr) / net_sales * 100",
      inputs: ["net_sales"],
    },
    unit: "percent",
    aggregation: "ratio",
    dimensions: ["outlet", "employee"],
    grain: "day",
    officiality: "live",
    sourceReport: { reportCode: "sales.void", route: "/reports/sales/void" },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
  {
    id: "6808467f-6b4b-4e98-ac71-7ed828586833",
    code: "waste_cost",
    version: 2,
    name: "Biaya waste",
    description: "Nilai bahan rusak, tumpah, atau kedaluwarsa pada periode.",
    ownerModule: "inventory",
    formula: {
      formulaRef: "inventory.waste_cost",
      expression:
        "sum(journal_lines.debit_idr - journal_lines.credit_idr) where account_mappings.role = 'waste_expense' incl. child accounts",
      inputs: [],
    },
    unit: "idr",
    aggregation: "sum",
    dimensions: ["outlet", "menu_item", "menu_category", "legal_entity"],
    grain: "day",
    officiality: "live",
    sourceReport: {
      reportCode: "inventory.waste",
      route: "/reports/inventory/waste",
    },
    status: "active",
    effectiveFrom: "2026-01-01",
    createdAt,
    updatedAt,
  },
] as const;

export const cafeLegendMetricDefinitions = definitionInputs.map((input) =>
  metricDefinitionSchema.parse(input),
);

export const metricDefinitionByCode = Object.fromEntries(
  cafeLegendMetricDefinitions.map((definition) => [
    definition.code,
    definition,
  ]),
) as Readonly<Record<string, MetricDefinition>>;

function definitionRef(definition: MetricDefinition): MetricDefinitionRef {
  return metricDefinitionRefSchema.parse({
    id: definition.id,
    code: definition.code,
    version: definition.version,
    name: definition.name,
    ownerModule: definition.ownerModule,
    formula: definition.formula,
    unit: definition.unit,
    aggregation: definition.aggregation,
    dimensions: definition.dimensions,
    grain: definition.grain,
    officiality: definition.officiality,
    sourceReport: definition.sourceReport,
  });
}

/** October 2026 is closed; its accounting period is closed as well (SH-02). */
export const closedMonthPeriod = metricPeriodSchema.parse({
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  bucket: "total",
  status: "closed",
  accountingPeriodClosed: true,
});

/** 1 November 2026 is today in the fixture calendar: open, so estimates only. */
export const openDayPeriod = metricPeriodSchema.parse({
  startDate: "2026-11-01",
  endDate: "2026-11-01",
  bucket: "total",
  status: "open",
  accountingPeriodClosed: false,
});

// Figures per day are the report viewer's day model (net sales of one business
// day, features/ws11-reports/mock-day-model.ts), so a metric point and the
// report cell for the same outlet and day are one number (I4,
// tests/ws11-fixture-reconcile.test.mjs).
const netSalesDailyPoints = [
  ["2026-10-25", 7_420_000],
  ["2026-10-26", 5_787_600],
  ["2026-10-27", 6_084_400],
  ["2026-10-28", 6_307_000],
  ["2026-10-29", 6_678_000],
  ["2026-10-30", 8_533_000],
  ["2026-10-31", 9_646_000],
].map(([date, valueIdr]) =>
  metricPointSchema.parse({
    bucketStart: date,
    bucketEnd: date,
    value: { unit: "idr", valueIdr },
    finality: "final",
    comparison: null,
  }),
);

export const netSalesDailySeries = metricSeriesSchema.parse({
  metricCode: "net_sales",
  definition: definitionRef(metricDefinitionByCode.net_sales),
  dimension: null,
  points: netSalesDailyPoints,
});

/** metrics_daily rows for 31 October 2026 (closed, final figures). */
export const metricDailyRows = [
  {
    tenantId: cafeLegendFixtures.tenant.id,
    outletId: cafeLegendFixtures.outlets[0].id,
    metricDate: "2026-10-31",
    metricCode: "net_sales",
    dimension: null,
    value: { unit: "idr", valueIdr: 9_646_000 },
    finality: "final",
    definitionId: "dce874d4-b0a0-4403-b0e3-50b202a52076",
    definitionVersion: 2,
    updatedAt: "2026-11-01T00:05:00.000Z",
  },
  {
    tenantId: cafeLegendFixtures.tenant.id,
    outletId: cafeLegendFixtures.outlets[0].id,
    metricDate: "2026-10-31",
    metricCode: "net_sales",
    dimension: { key: "channel", value: "qr" },
    // QR share of the same day: 4.150.000 / 7.420.000 of 9.646.000.
    value: { unit: "idr", valueIdr: 5_395_000 },
    finality: "final",
    definitionId: "dce874d4-b0a0-4403-b0e3-50b202a52076",
    definitionVersion: 2,
    updatedAt: "2026-11-01T00:05:00.000Z",
  },
].map((row) => metricDailyRowSchema.parse(row));

export const metricQueryRequestFixture = metricQueryRequestSchema.parse({
  metricCodes: ["net_sales", "pax", "food_cost_pct"],
  period: { startDate: "2026-10-01", endDate: "2026-10-31" },
  bucket: "total",
  outletIds: [cafeLegendFixtures.outlets[0].id],
  comparePrevious: true,
  requireFinal: true,
});

// October is the closed month every WS-11 screen shows (report viewer,
// shareholder board, owner income statement): net sales Rp412.800.000, 8.222
// guests, food cost 33,7%. September is the owner insights' month (net sales
// Rp476.000.000, food cost 32,8%).
const netSalesOctober: MetricValue = metricValueSchema.parse({
  unit: "idr",
  valueIdr: 412_800_000,
});
const netSalesSeptember: MetricValue = metricValueSchema.parse({
  unit: "idr",
  valueIdr: 476_000_000,
});
const paxOctober: MetricValue = metricValueSchema.parse({
  unit: "count",
  value: 8_222,
});
const paxSeptember: MetricValue = metricValueSchema.parse({
  unit: "count",
  value: 9_480,
});
const foodCostOctober: MetricValue = metricValueSchema.parse({
  unit: "percent",
  value: "33.7000",
});
const foodCostSeptember: MetricValue = metricValueSchema.parse({
  unit: "percent",
  value: "32.8000",
});

export const queryResponseFixture = metricQueryResponseSchema.parse({
  data: {
    period: closedMonthPeriod,
    outletFilter: {
      kind: "outlets",
      outletIds: [cafeLegendFixtures.outlets[0].id],
    },
    definitions: [
      definitionRef(metricDefinitionByCode.net_sales),
      definitionRef(metricDefinitionByCode.pax),
      definitionRef(metricDefinitionByCode.food_cost_pct),
    ],
    availability: [
      { metricCode: "net_sales", status: "available" },
      { metricCode: "pax", status: "available" },
      { metricCode: "food_cost_pct", status: "available" },
    ],
    series: [
      {
        metricCode: "net_sales",
        definition: definitionRef(metricDefinitionByCode.net_sales),
        dimension: null,
        points: [
          {
            bucketStart: "2026-10-01",
            bucketEnd: "2026-10-31",
            value: netSalesOctober,
            finality: "final",
            comparison: compareMetricValues(netSalesOctober, netSalesSeptember),
          },
        ],
      },
      {
        metricCode: "pax",
        definition: definitionRef(metricDefinitionByCode.pax),
        dimension: null,
        points: [
          {
            bucketStart: "2026-10-01",
            bucketEnd: "2026-10-31",
            value: paxOctober,
            finality: "final",
            comparison: compareMetricValues(paxOctober, paxSeptember),
          },
        ],
      },
      {
        metricCode: "food_cost_pct",
        definition: definitionRef(metricDefinitionByCode.food_cost_pct),
        dimension: null,
        points: [
          {
            bucketStart: "2026-10-01",
            bucketEnd: "2026-10-31",
            value: foodCostOctober,
            finality: "final",
            comparison: compareMetricValues(foodCostOctober, foodCostSeptember),
          },
        ],
      },
    ],
  },
  meta: {
    generatedAt: "2026-11-01T02:15:00.000Z",
    dataThrough: "2026-11-01",
  },
});

export const estimateQueryResponseFixture = metricQueryResponseSchema.parse({
  data: {
    period: openDayPeriod,
    outletFilter: { kind: "all" },
    definitions: [definitionRef(metricDefinitionByCode.net_sales)],
    availability: [{ metricCode: "net_sales", status: "available" }],
    series: [
      {
        metricCode: "net_sales",
        definition: definitionRef(metricDefinitionByCode.net_sales),
        dimension: null,
        points: [
          {
            bucketStart: "2026-11-01",
            bucketEnd: "2026-11-01",
            value: { unit: "idr", valueIdr: 7_420_000 },
            finality: "estimate",
            comparison: null,
          },
        ],
      },
    ],
  },
  meta: {
    generatedAt: "2026-11-01T05:40:00.000Z",
    dataThrough: "2026-11-01",
  },
});

const sortedDefinitions = [...cafeLegendMetricDefinitions].sort((left, right) =>
  left.code.localeCompare(right.code),
);

export const metricDefinitionListPage =
  metricDefinitionListResponseSchema.parse({
    data: sortedDefinitions.slice(0, 3),
    meta: {
      limit: 25,
      nextCursor: encodeCursor([
        sortedDefinitions[2].code,
        sortedDefinitions[2].version,
      ]),
    },
  });

export const metricsAggregatedEventFixture = {
  id: "01JBQ7Z8K0A1B2C3D4E5F6G7HA",
  tenantId: cafeLegendFixtures.tenant.id,
  outletId: cafeLegendFixtures.outlets[0].id,
  name: "metrics.aggregated",
  version: 1,
  aggregateType: "metrics",
  aggregateId: "01JBQ7Z8K0A1B2C3D4E5F6G7H9",
  sequence: 1,
  occurredAt: "2026-10-31T17:05:00.000Z",
  actor: { type: "system" },
  idempotencyKey: "metrics-2026-10-31-bdg-01",
  payloadSchemaRef: "metrics.aggregated.v1",
  payload: {
    outletId: cafeLegendFixtures.outlets[0].id,
    metricDate: "2026-10-31",
    metricCodes: ["net_sales", "pax"],
    pointsWritten: 2,
    finality: "final",
    durationMs: 1_840,
    status: "succeeded",
    errorCode: null,
  },
} satisfies z.input<typeof eventEnvelopeSchema>;

export const metricErrorFixtures = {
  periodNotClosed: apiErrorBody(
    "PERIOD_NOT_CLOSED",
    "Angka resmi hanya tersedia setelah periode ditutup.",
  ),
  metricNotFound: apiErrorBody("METRIC_NOT_FOUND", "Metrik tidak ditemukan."),
  dimensionNotSupported: apiErrorBody(
    "METRIC_DIMENSION_NOT_SUPPORTED",
    "Dimensi tidak didukung oleh metrik ini.",
  ),
};

export const cafeLegendMetricFixtures = {
  definitions: cafeLegendMetricDefinitions,
  definitionByCode: metricDefinitionByCode,
  closedMonthPeriod,
  openDayPeriod,
  netSalesDailySeries,
  dailyRows: metricDailyRows,
  definitionListPage: metricDefinitionListPage,
  queryRequest: metricQueryRequestFixture,
  queryResponse: queryResponseFixture,
  estimateQueryResponse: estimateQueryResponseFixture,
  aggregatedEvent: metricsAggregatedEventFixture,
  errors: metricErrorFixtures,
};
