// Derivations shared by the API, web app and export worker (WS-11 CT, bead
// legend-mmjb; DASH-01/DASH-02/DASH-04). No Node or browser API here, so the
// same functions run in every runtime.

import type { MetricDefinition } from "../metrics/index.ts";
import { metricSourceReportPath } from "../metrics/index.ts";
import type { MetricSourceReportParams } from "../metrics/index.ts";
import type {
  ReportDefinition,
  ReportDefinitionRef,
  ReportFamily,
} from "./reports.ts";
import { reportByCode } from "./catalog.ts";
import type { DashboardTile } from "./dashboards.ts";
import type { ReportBuilderQuery } from "./builder.ts";
import type { ReportErrorCode } from "./errors.ts";
import type { ReportExport } from "./exports.ts";

/** DASH-01: the catalog route for a report code, or null when unknown. */
export function reportPathForCode(code: string): string | null {
  return reportByCode(code)?.route ?? null;
}

/** The source report a tile drills into; null for list/hand-built tiles. */
export function dashboardTileReport(
  tile: DashboardTile,
): ReportDefinition | null {
  if (tile.kind === "personal_share") return null;
  if (tile.reportCode === null) return null;
  return reportByCode(tile.reportCode) ?? null;
}

/**
 * DASH-01 drill-down path: the tile's source report with the same period,
 * outlet filter and group-by the tile shows (DASH-02). Null when the tile is
 * not backed by a report. Throws when the catalog is inconsistent, which the
 * contract test rules out.
 */
export function dashboardTilePath(
  tile: DashboardTile,
  params: MetricSourceReportParams,
): string | null {
  const report = dashboardTileReport(tile);
  if (report === null) return null;
  return metricSourceReportPath(
    { reportCode: report.code, route: report.route },
    params,
  );
}

/** Minimal reference for embedding a catalog entry in a run or saved report. */
export function reportRefOf(report: ReportDefinition): ReportDefinitionRef {
  return {
    code: report.code,
    name: report.name,
    family: report.family,
    metrics: [...report.metrics],
    dimensions: [...report.dimensions],
    containsPersonalData: report.containsPersonalData,
    closedPeriodOnly: report.closedPeriodOnly,
    route: report.route,
  };
}

/** Reports the caller may see, given the permission codes it holds (RBAC). */
export function reportsForPermissions(
  reports: readonly ReportDefinition[],
  permissions: ReadonlySet<string>,
): readonly ReportDefinition[] {
  return reports.filter((report) =>
    report.requiredPermissions.every((permission) =>
      permissions.has(permission),
    ),
  );
}

/** Reports of one family, in catalog order. */
export function filterReportsByFamily(
  reports: readonly ReportDefinition[],
  family: ReportFamily,
): readonly ReportDefinition[] {
  return reports.filter((report) => report.family === family);
}

export type ReportBuilderCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: ReportErrorCode;
      readonly field: string;
    };

function isMetricMap(
  value: ReadonlyMap<string, MetricDefinition> | readonly MetricDefinition[],
): value is ReadonlyMap<string, MetricDefinition> {
  return typeof (value as { get?: unknown }).get === "function";
}

function metricRegistryMap(
  registry: ReadonlyMap<string, MetricDefinition> | readonly MetricDefinition[],
): ReadonlyMap<string, MetricDefinition> {
  if (isMetricMap(registry)) return registry;
  return new Map(registry.map((metric) => [metric.code, metric]));
}

/**
 * DASH-01/DASH-02 for the builder: every metric must be in the registry, and
 * every group-by/filter key must be declared by *all* selected metrics, so the
 * builder cannot offer a split the source report cannot produce. Returns a
 * stable error code instead of throwing; the API maps it to 400/404.
 */
export function checkReportBuilderQuery(
  query: ReportBuilderQuery,
  registry: ReadonlyMap<string, MetricDefinition> | readonly MetricDefinition[],
): ReportBuilderCheck {
  const metrics = metricRegistryMap(registry);
  const definitions: MetricDefinition[] = [];
  for (const [index, code] of query.metricCodes.entries()) {
    const definition = metrics.get(code);
    if (definition === undefined)
      return {
        ok: false,
        code: "REPORT_NOT_FOUND",
        field: `metricCodes.${index}`,
      };
    definitions.push(definition);
  }
  for (const [index, key] of query.groupBy.entries())
    if (!definitions.every((definition) => definition.dimensions.includes(key)))
      return {
        ok: false,
        code: "REPORT_FILTER_NOT_SUPPORTED",
        field: `groupBy.${index}`,
      };
  for (const [index, filter] of query.filters.entries())
    if (
      !definitions.every((definition) =>
        definition.dimensions.includes(filter.key),
      )
    )
      return {
        ok: false,
        code: "REPORT_FILTER_NOT_SUPPORTED",
        field: `filters.${index}`,
      };
  return { ok: true };
}

/**
 * DASH-04 at the job level: true only when the export may be queued or
 * generated without a new approval. The resource schema makes this
 * unrepresentable, so the helper exists for UI affordances and tests.
 */
export function reportExportNeedsApproval(
  job: Pick<ReportExport, "containsPersonalData" | "approvalRequestId">,
): boolean {
  return job.containsPersonalData && job.approvalRequestId === null;
}
