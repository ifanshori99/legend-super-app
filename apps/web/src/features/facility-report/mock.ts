// Facility & WFC report runs for mock mode (`VITE_API_MOCK=true`), so the six
// facility report screens and the hub work with no API (docs/frontend.md "Typed
// endpoints and mock mode"). Runs register through the shared run owner
// (`lib/mock/handlers/report-runs.ts`): this file never registers
// POST /api/reports/run itself (bead legend-jzud, one owner per endpoint).
//
// The numbers start from the owner board's open day (1 Nov 2026): 18 shower
// sessions and Rp1.350.000 shower revenue, 56,25% booth utilization, 23 active
// subscriptions, 11 of 18 sessions with F&B, 210 Wi-Fi sessions and 42,7 GB of
// quota, plus the four zone rows of facility.revpash (owner-dashboard
// fixtures). Every split divides those totals with fixed weights and every
// period scales the same day model by weekday, so the unsplit run, its splits
// and the owner board's tiles agree (DASH-02). Figures are mock-only, plausible
// Cafe Legend numbers; nothing is predicted.
//
// The owner dashboard already serves six unsplit/zone runs for the open day
// (same keys); those stay its own and are skipped here, exactly like
// ws11-reports/mock.ts skips the owner board keys instead of re-registering
// them with different rounding.
//
// Loaded in Node by tests that import this file with relative `.ts` paths:
// bare package imports and relative `.ts` paths only, no `@/` alias.
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendFacilityFixtures } from "@starter/shared/facility";
import {
  cafeLegendManagementLayoutFixture,
  ownerDashboardBoardRuns,
  reportByCode,
  reportMetricByCode,
  type ReportDefinition,
  type ReportResult,
} from "@starter/shared/dashboard";
import { metricDefinitionRefSchema } from "@starter/shared/metrics";
import { registerMockReportRuns } from "../../lib/mock/handlers/report-runs.ts";
import {
  namedPresets,
  resolvePreset,
  type DateRange,
} from "../ws11-reports/lib.ts";
import { FACILITY_REPORT_CODES } from "./lib.ts";

const outlet = cafeLegendFixtures.outlets[0];
const BUSINESS_DATE = cafeLegendManagementLayoutFixture.businessDate;
const MONTH_START = `${BUSINESS_DATE.slice(0, 7)}-01`;
const GENERATED_AT = "2026-11-01T04:40:00.000Z";

// ---- Day model ---------------------------------------------------------------

/** Monday .. Sunday; the business day (Sunday 1 Nov 2026) is 1. */
const WEEKDAY_FACTOR = [0.78, 0.82, 0.85, 0.9, 1.15, 1.3, 1] as const;

/**
 * Opening hours of the coffee shop floor (08.00–21.00) and a demand curve whose
 * mean is exactly 1, so an hourly average reads back as the day figure.
 */
const HOURS = [
  "08",
  "09",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
] as const;
const HOUR_WEIGHTS = [
  0.7, 0.75, 0.85, 0.95, 1.2, 1.3, 1.1, 0.9, 0.9, 1, 1.25, 1.3, 1.05, 0.75,
] as const;

function eachDay(range: DateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.startDate}T00:00:00Z`);
  const end = new Date(`${range.endDate}T00:00:00Z`);
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Volume of the period as a multiple of the open business day. */
function periodFactor(range: DateRange): number {
  let factor = 0;
  for (const day of eachDay(range)) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    factor += WEEKDAY_FACTOR[weekday] ?? 1;
  }
  return factor;
}

// ---- Facility model ----------------------------------------------------------
//
// PRD §3 shower "Laporan" asks for utilization per bilik and per hour, but the
// catalog's only facility-scoped dimension is `facility`. The mock therefore
// labels the four shower booths with their area and bilik code from the facility
// fixtures ("Area Pria · P1" … "Area Wanita · W2"), and keeps true facility rows
// for subscriptions and Wi-Fi, which are sold per facility.

const showerFacility = cafeLegendFacilityFixtures.facilities.find(
  (facility) => facility.type === "shower",
);
const wfcFacility = cafeLegendFacilityFixtures.facilities.find(
  (facility) => facility.type === "coworking",
);
if (showerFacility === undefined || wfcFacility === undefined)
  throw new Error("Facility fixtures lost the shower or WFC facility");

const areaName = new Map(
  cafeLegendFacilityFixtures.areas.map((area) => [area.id, area.name]),
);

type BoothBase = {
  sessions: number;
  revenueIdr: number;
  occupancyPct: number;
  fnbSessions: number;
};

/** Open-day figures per bilik; the four add up to the owner board totals. */
const BOOTH_BASE: Readonly<Record<string, BoothBase>> = Object.freeze({
  P1: { sessions: 6, revenueIdr: 480_000, occupancyPct: 68.75, fnbSessions: 4 },
  P2: {
    sessions: 5,
    revenueIdr: 400_000,
    occupancyPct: 59.375,
    fnbSessions: 3,
  },
  W1: {
    sessions: 4,
    revenueIdr: 290_000,
    occupancyPct: 53.125,
    fnbSessions: 2,
  },
  W2: { sessions: 3, revenueIdr: 180_000, occupancyPct: 43.75, fnbSessions: 2 },
});

type Booth = BoothBase & { label: string };

const SHOWER_BOOTHS: readonly Booth[] =
  cafeLegendFacilityFixtures.units.flatMap((unit) => {
    if (unit.facilityId !== showerFacility.id) return [];
    const base = BOOTH_BASE[unit.code];
    if (base === undefined) return [];
    return [
      {
        ...base,
        label: `${areaName.get(unit.areaId) ?? "Area"} · ${unit.code}`,
      },
    ];
  });

type FacilityProduct = {
  name: string;
  subscriptions: number;
  revenueIdr: number;
  wifiSessions: number;
  wifiQuotaGb: number;
};

/** Subscriptions and Wi-Fi are facility products, not booth minutes. */
const FACILITY_PRODUCTS: readonly FacilityProduct[] = [
  {
    name: showerFacility.name,
    subscriptions: 18,
    revenueIdr: 1_050_000,
    wifiSessions: 60,
    wifiQuotaGb: 10.2,
  },
  {
    name: wfcFacility.name,
    subscriptions: 5,
    revenueIdr: 300_000,
    wifiSessions: 150,
    wifiQuotaGb: 32.5,
  },
];

/**
 * Seat inventory and open-day RevPASH/occupancy per floor zone. The four rows
 * and their figures are the owner board's `facility.revpash` fixture; seat
 * counts make the unsplit rate a seat-weighted average instead of an average of
 * averages.
 */
const ZONES = [
  {
    name: "Indoor Reguler",
    seats: 64,
    revpashIdr: 18_500,
    occupancyPct: 68.75,
  },
  { name: "Taman Outdoor", seats: 56, revpashIdr: 9_200, occupancyPct: 42.5 },
  {
    name: "Private Room Nusantara",
    seats: 24,
    revpashIdr: 26_400,
    occupancyPct: 75,
  },
  { name: "WFC Corner", seats: 24, revpashIdr: 12_800, occupancyPct: 55 },
] as const;

const ZONE_SEATS = ZONES.reduce((total, zone) => total + zone.seats, 0);

function zoneAverage(pick: (zone: (typeof ZONES)[number]) => number): number {
  return (
    ZONES.reduce((total, zone) => total + pick(zone) * zone.seats, 0) /
    ZONE_SEATS
  );
}

const BASE_REVPASH_IDR = Math.round(zoneAverage((zone) => zone.revpashIdr));
const BASE_SEAT_OCCUPANCY_PCT = zoneAverage((zone) => zone.occupancyPct);

/** Open-day totals the splits divide (owner-dashboard fixtures). */
const BASE = Object.freeze({
  sessions: 18,
  revenueIdr: 1_350_000,
  occupancyPct: 56.25,
  fnbSessions: 11,
  activeSubscriptions: 23,
  wifiSessions: 210,
  wifiQuotaGb: 42.7,
});

function share(value: number, factor: number): number {
  return Math.round(value * factor);
}

function ratioPct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator * 100) / denominator;
}

// ---- Rows --------------------------------------------------------------------

type Raw = Readonly<Record<string, number | null>>;
type RowSeed = {
  dims: readonly (readonly [string, string])[];
  raw: Raw;
};

function totalRaw(reportCode: string, factor: number): Raw {
  switch (reportCode) {
    case "facility.revenue":
      return {
        shower_revenue: share(BASE.revenueIdr, factor),
        shower_sessions: share(BASE.sessions, factor),
      };
    case "facility.revpash":
      return {
        revpash: BASE_REVPASH_IDR,
        seat_occupancy_pct: BASE_SEAT_OCCUPANCY_PCT,
      };
    case "facility.occupancy":
      return {
        shower_occupancy_pct: BASE.occupancyPct,
        shower_sessions: share(BASE.sessions, factor),
      };
    case "facility.subscriptions":
      // `active_subscriptions` aggregates as `latest`, not a daily sum.
      return {
        active_subscriptions: BASE.activeSubscriptions,
        shower_revenue: share(BASE.revenueIdr, factor),
      };
    case "facility.wifi":
      return {
        wifi_quota_used: BASE.wifiQuotaGb * factor,
        wifi_sessions: share(BASE.wifiSessions, factor),
      };
    case "facility.fnb_conversion":
      return {
        shower_fnb_conversion_pct: ratioPct(BASE.fnbSessions, BASE.sessions),
        shower_sessions_with_fnb: share(BASE.fnbSessions, factor),
      };
    default:
      return {};
  }
}

function boothRows(reportCode: string, factor: number): RowSeed[] | null {
  switch (reportCode) {
    case "facility.revenue":
      return SHOWER_BOOTHS.map((booth) => ({
        dims: [["facility", booth.label]],
        raw: {
          shower_revenue: share(booth.revenueIdr, factor),
          shower_sessions: share(booth.sessions, factor),
        },
      }));
    case "facility.occupancy":
      return SHOWER_BOOTHS.map((booth) => ({
        dims: [["facility", booth.label]],
        raw: {
          shower_occupancy_pct: booth.occupancyPct,
          shower_sessions: share(booth.sessions, factor),
        },
      }));
    case "facility.fnb_conversion":
      return SHOWER_BOOTHS.map((booth) => ({
        dims: [["facility", booth.label]],
        raw: {
          shower_fnb_conversion_pct: ratioPct(
            booth.fnbSessions,
            booth.sessions,
          ),
          shower_sessions_with_fnb: share(booth.fnbSessions, factor),
        },
      }));
    case "facility.subscriptions":
      return FACILITY_PRODUCTS.map((product) => ({
        dims: [["facility", product.name]],
        raw: {
          active_subscriptions: product.subscriptions,
          shower_revenue: share(product.revenueIdr, factor),
        },
      }));
    case "facility.wifi":
      return FACILITY_PRODUCTS.map((product) => ({
        dims: [["facility", product.name]],
        raw: {
          wifi_quota_used: product.wifiQuotaGb * factor,
          wifi_sessions: share(product.wifiSessions, factor),
        },
      }));
    default:
      return null;
  }
}

function zoneRows(): RowSeed[] {
  return ZONES.map((zone) => ({
    dims: [["zone", zone.name]],
    raw: {
      revpash: zone.revpashIdr,
      seat_occupancy_pct: zone.occupancyPct,
    },
  }));
}

function hourRows(): RowSeed[] {
  return HOURS.map((hour, index) => {
    const weight = HOUR_WEIGHTS[index] ?? 1;
    const occupancy = Math.min(
      100,
      zoneAverage((zone) => zone.occupancyPct * weight),
    );
    return {
      dims: [["hour", hour]],
      raw: {
        revpash: Math.round(zoneAverage((zone) => zone.revpashIdr * weight)),
        seat_occupancy_pct: occupancy,
      },
    };
  });
}

function rowsFor(
  report: ReportDefinition,
  groupBy: string | null,
  range: DateRange,
): RowSeed[] | null {
  const factor = periodFactor(range);
  if (groupBy === null)
    return [{ dims: [], raw: totalRaw(report.code, factor) }];
  if (groupBy === "outlet")
    return [
      { dims: [["outlet", outlet.name]], raw: totalRaw(report.code, factor) },
    ];
  if (groupBy === "facility") return boothRows(report.code, factor);
  if (groupBy === "zone")
    return report.code === "facility.revpash" ? zoneRows() : null;
  if (groupBy === "hour")
    return report.code === "facility.revpash" ? hourRows() : null;
  return null;
}

// ---- Metric cells ------------------------------------------------------------

// Plain wire values; the mock runtime validates them against the branded
// schema, so no brand is faked here.
type Cell =
  | { unit: "idr"; valueIdr: number }
  | { unit: "count"; value: number }
  | { unit: "seconds"; value: number }
  | { unit: "percent"; value: string }
  | { unit: "decimal"; value: string }
  | null;

function cellFor(metricCode: string, raw: Raw): Cell {
  const definition = reportMetricByCode.get(metricCode);
  const value = raw[metricCode] ?? null;
  if (definition === undefined || value === null) return null;
  const rounded = Math.round(value);
  switch (definition.unit) {
    case "idr":
      return { unit: "idr", valueIdr: rounded };
    case "count":
      return { unit: "count", value: rounded };
    case "seconds":
      return { unit: "seconds", value: rounded };
    case "percent":
    case "decimal":
      return { unit: definition.unit, value: value.toFixed(4) };
  }
}

function metricRef(code: string) {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No registry row for report metric ${code}`);
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

type LooseRow = {
  dimensions: { key: string; value: string }[];
  values: { metricCode: string; value: Cell; finality: "final" | "estimate" }[];
};

function buildRun(
  report: ReportDefinition,
  groupBy: string | null,
  range: DateRange,
): ReportResult | null {
  const seeds = rowsFor(report, groupBy, range);
  if (seeds === null) return null;
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;
  const refs = report.metrics.map(metricRef);
  const rows: LooseRow[] = seeds.map((seed) => ({
    dimensions: seed.dims.map(([key, value]) => ({ key, value })),
    values: refs.map((ref) => {
      // SH-02: final only for a closed period, and for closed-period-only
      // figures only once the books of that period are closed.
      const official =
        closed &&
        (accountingClosed ||
          (ref.officiality !== "closed_period_only" &&
            !report.closedPeriodOnly));
      return {
        metricCode: ref.code,
        value: cellFor(ref.code, seed.raw),
        finality: official ? ("final" as const) : ("estimate" as const),
      };
    }),
  }));
  return {
    reportCode: report.code,
    period: {
      startDate: range.startDate,
      endDate: range.endDate,
      bucket: "total",
      status: closed ? "closed" : "open",
      accountingPeriodClosed: accountingClosed,
    },
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: refs,
    groupBy: groupBy === null ? [] : [groupBy],
    rows,
    generatedAt: GENERATED_AT,
    rowLimit: 100,
  } as unknown as ReportResult;
}

// ---- Run registration --------------------------------------------------------

function runKey(result: ReportResult): string {
  return `${result.reportCode}|${result.groupBy.join(",")}|${result.period.startDate}|${result.period.endDate}`;
}

/** Runs another owner already serves (the owner board's open-day tiles). */
const OTHER_OWNERS = new Set(
  Object.values(ownerDashboardBoardRuns).map((run) => runKey(run)),
);

/** Date ranges of the presets a report offers; identical ranges collapse. */
function periodsOf(report: ReportDefinition): DateRange[] {
  const seen = new Set<string>();
  const periods: DateRange[] = [];
  for (const preset of namedPresets(report)) {
    const range = resolvePreset(preset, BUSINESS_DATE);
    if (range === null) continue;
    const key = `${range.startDate}|${range.endDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    periods.push(range);
  }
  return periods;
}

/** Every preset (deduped) x every split of the six facility reports, minus the
 * runs the owner dashboard owns. */
export function buildFacilityRuns(): ReportResult[] {
  const runs: ReportResult[] = [];
  for (const code of FACILITY_REPORT_CODES) {
    const report = reportByCode(code);
    if (report === undefined) continue;
    for (const range of periodsOf(report))
      for (const groupBy of [null, ...report.dimensions]) {
        const run = buildRun(report, groupBy, range);
        if (run !== null && !OTHER_OWNERS.has(runKey(run))) runs.push(run);
      }
  }
  return runs;
}

registerMockReportRuns(
  Object.fromEntries(buildFacilityRuns().map((run) => [runKey(run), run])),
);
