// Report catalog contract (WS-11 CT, bead legend-mmjb; PRD v1.7 §3.36
// "Laporan" — 100+ standard reports — and the shared metric layer in §5).
//
// One definition per standard report, keyed by a stable dotted code. Every
// report lists the metric codes it displays, so each number on the report is
// the registry row a dashboard tile cites (DASH-01) and a tile and its source
// report filter identically (DASH-02). Report routes are derived from the code
// (`sales.per_hour` → `/reports/sales/per-hour`), never hand-written, so the
// catalog cannot drift from the drill-down links.
//
// The catalog is global (like `metric_definitions`): it carries no tenant id,
// and tenant-specific choices are settings, never a copied definition
// (TEN-07). Saved reports, schedules and exports are tenant-scoped and live in
// `builder.ts` / `exports.ts`.

import { cursorPageQuerySchema, cursorPageSchema, z } from "../core/index.ts";
import {
  METRIC_BUCKETS,
  metricBucketSchema,
  metricCodeSchema,
  metricDimensionKeySchema,
  metricOwnerModuleSchema,
  reportCodeSchema,
} from "../metrics/index.ts";
import type { MetricOwnerModule, ReportCode } from "../metrics/index.ts";
import { permissionCodeSchema } from "../access/index.ts";

// ---- Vocabulary ------------------------------------------------------------

/** Report families named in PRD §3.36 plus the modules that feed dashboards. */
export const REPORT_FAMILIES = [
  "sales",
  "traffic",
  "menu",
  "payments",
  "tax",
  "inventory",
  "cogs",
  "purchasing",
  "finance",
  "loyalty",
  "crm",
  "reservation",
  "delivery",
  "attendance",
  "payroll",
  "performance",
  "facility",
  "operations",
] as const;
export const reportFamilySchema = z.enum(REPORT_FAMILIES);
export type ReportFamily = z.infer<typeof reportFamilySchema>;

/**
 * Period presets the viewer and the report builder offer (PRD §3.36). The
 * server resolves them against the outlet's business date and time zone; the
 * client never sends a guessed "today" (D-CORE business dates).
 */
export const REPORT_PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "year_to_date",
  "custom",
] as const;
export const reportPeriodPresetSchema = z.enum(REPORT_PERIOD_PRESETS);
export type ReportPeriodPreset = z.infer<typeof reportPeriodPresetSchema>;

/** Export formats in PRD §3.36 "Ekspor". */
export const REPORT_EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export const reportExportFormatSchema = z.enum(REPORT_EXPORT_FORMATS);
export type ReportExportFormat = z.infer<typeof reportExportFormatSchema>;

const reportRouteSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (route) => route.startsWith("/") && !/[?#]/.test(route),
    "Report routes are app-relative paths without a query or fragment",
  );

/**
 * The one drill-down route for a report code (DASH-01). Dashes keep URLs
 * readable while codes stay lower_snake_case; the mapping is injective because
 * code segments contain no dots and the code itself is unique.
 */
export function reportRouteForCode(code: ReportCode | string): string {
  return `/reports/${code.split(".").join("/").replaceAll("_", "-")}`;
}

// ---- Definition ------------------------------------------------------------

const reportDefinitionBaseSchema = z.strictObject({
  code: reportCodeSchema,
  name: z.string().min(1).max(150),
  description: z.string().min(1).max(500),
  family: reportFamilySchema,
  /** Module that owns the source data, filtered in the viewer. */
  ownerModule: metricOwnerModuleSchema,
  /** Metric codes this report displays; every number traces to a definition. */
  metrics: z.array(metricCodeSchema).min(1).max(12),
  /** Dimension keys the report can group or filter by. */
  dimensions: z.array(metricDimensionKeySchema).max(6),
  defaultBucket: metricBucketSchema,
  periodPresets: z.array(reportPeriodPresetSchema).min(1).max(11),
  defaultPeriod: reportPeriodPresetSchema,
  /** Permissions the caller must all hold to run the report (RBAC). */
  requiredPermissions: z.array(permissionCodeSchema).min(1).max(4),
  /**
   * True when rows identify a person (employee or customer). Such a report may
   * be viewed with its own permission, but any export needs an approved
   * request (DASH-04).
   */
  containsPersonalData: z.boolean(),
  /**
   * True for statutory/financial reports whose figures are official only for
   * closed accounting periods (SH-02). The server labels an open-period run
   * `estimate` and refuses `requireFinal` answers (metrics PERIOD_NOT_CLOSED).
   */
  closedPeriodOnly: z.boolean(),
  exportFormats: z.array(reportExportFormatSchema).min(1).max(3),
  route: reportRouteSchema,
});

export const reportDefinitionSchema = reportDefinitionBaseSchema.superRefine(
  (report, ctx) => {
    for (const [field, values] of [
      ["metrics", report.metrics],
      ["dimensions", report.dimensions],
      ["periodPresets", report.periodPresets],
      ["exportFormats", report.exportFormats],
    ] as const)
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: "custom",
          message: `Report ${field} repeat an entry`,
          path: [field],
        });
    if (!report.periodPresets.includes(report.defaultPeriod))
      ctx.addIssue({
        code: "custom",
        message: "defaultPeriod must be one of periodPresets",
        path: ["defaultPeriod"],
      });
    if (report.route !== reportRouteForCode(report.code))
      ctx.addIssue({
        code: "custom",
        message: `Report route must be ${reportRouteForCode(report.code)}`,
        path: ["route"],
      });
    // A report whose rows identify a person can never be exported as a
    // silently-anonymous file: CSV is the always-safe format, but the personal
    // flag is what gates the export at the server (DASH-04).
    if (report.containsPersonalData && !report.exportFormats.includes("csv"))
      ctx.addIssue({
        code: "custom",
        message: "Personal-data reports must support CSV export",
        path: ["exportFormats"],
      });
  },
);
export type ReportDefinition = Readonly<z.infer<typeof reportDefinitionSchema>>;

/** Minimal reference embedded in tiles, runs and saved reports. */
export const reportDefinitionRefSchema = reportDefinitionBaseSchema.pick({
  code: true,
  name: true,
  family: true,
  metrics: true,
  dimensions: true,
  containsPersonalData: true,
  closedPeriodOnly: true,
  route: true,
});
export type ReportDefinitionRef = z.infer<typeof reportDefinitionRefSchema>;

// ---- Catalog listing -------------------------------------------------------

/** GET /api/reports — catalog browsing for the viewer and report builder. */
export const reportCatalogQuerySchema = cursorPageQuerySchema
  .extend({
    family: reportFamilySchema.optional(),
    ownerModule: metricOwnerModuleSchema.optional(),
    search: z.string().min(1).max(80).optional(),
  })
  .strict();
export type ReportCatalogQuery = z.infer<typeof reportCatalogQuerySchema>;

export const reportCatalogPageSchema = cursorPageSchema(reportDefinitionSchema);
export type ReportCatalogPage = z.infer<typeof reportCatalogPageSchema>;

/** Bucket values a report row may use; `total` is the whole period. */
export const REPORT_BUCKETS = METRIC_BUCKETS;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];

/** Family metadata shared by the catalog, fixtures and the viewer chrome. */
export const REPORT_FAMILY_INFO = {
  sales: { ownerModule: "pos", label: "Penjualan" },
  traffic: { ownerModule: "pos", label: "Kunjungan" },
  menu: { ownerModule: "menu", label: "Menu" },
  payments: { ownerModule: "payments", label: "Pembayaran" },
  tax: { ownerModule: "accounting", label: "Pajak" },
  inventory: { ownerModule: "inventory", label: "Inventori" },
  cogs: { ownerModule: "inventory", label: "HPP" },
  purchasing: { ownerModule: "inventory", label: "Purchasing" },
  finance: { ownerModule: "accounting", label: "Keuangan" },
  loyalty: { ownerModule: "loyalty", label: "Loyalty" },
  crm: { ownerModule: "crm", label: "CRM" },
  reservation: { ownerModule: "reservation", label: "Reservasi" },
  delivery: { ownerModule: "crm", label: "Delivery" },
  attendance: { ownerModule: "hris", label: "Absensi" },
  payroll: { ownerModule: "payroll", label: "Payroll" },
  performance: { ownerModule: "operations", label: "Kinerja" },
  facility: { ownerModule: "facility", label: "Fasilitas" },
  operations: { ownerModule: "operations", label: "Operasional" },
} as const satisfies Record<
  ReportFamily,
  { ownerModule: MetricOwnerModule; label: string }
>;
