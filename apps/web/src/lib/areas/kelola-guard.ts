// Guard of the kelola area for one URL path (legend-5bjh). The area needs
// dashboard.management.view; the one exception is the shareholder-linked
// aggregate reports, which a report.aggregate.view holder (the shareholder)
// may open without it. /kelola, /audit and every other report keep the area
// guard. Presentation only: the API re-checks, and the report page guard
// (features/ws11-reports/guard.ts) still runs on the route itself.
import {
  AGGREGATE_VIEW_REPORT_CODES,
  REPORT_AGGREGATE_VIEW_PERMISSION,
  reportRouteForCode,
} from "@starter/shared/dashboard";
import type { PermissionCode } from "@starter/shared/access";
import { AREAS, type AreaGuard } from "./definitions.ts";

const AGGREGATE_REPORT_PATHS: ReadonlySet<string> = new Set(
  AGGREGATE_VIEW_REPORT_CODES.map(reportRouteForCode),
);

export function isAggregateReportPath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return AGGREGATE_REPORT_PATHS.has(path);
}

export function kelolaGuardForPath(pathname: string): AreaGuard {
  const guard = AREAS.kelola.guard;
  if (guard.kind !== "permission" || !isAggregateReportPath(pathname))
    return guard;
  return {
    ...guard,
    anyOf: [...guard.anyOf, REPORT_AGGREGATE_VIEW_PERMISSION as PermissionCode],
  };
}
