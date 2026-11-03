// Static catalog view of the facility & WFC reports (WS-09 FE, bead
// legend-zx8k; PRD v1.7 §3 F25 "Laporan" and "Pengukuran WFC"). The hub reads
// the shared report catalog directly instead of calling GET /api/reports: the
// six definitions are global contract rows (TEN-07), so a visit renders without
// a request and without loading/error states. Codes stay in one list so the hub
// and the mock runs cannot drift apart.
import { reportByCode, type ReportDefinition } from "@starter/shared/dashboard";

/** The facility-family reports this build gives a screen (catalog order). */
export const FACILITY_REPORT_CODES = [
  "facility.revenue",
  "facility.revpash",
  "facility.occupancy",
  "facility.subscriptions",
  "facility.wifi",
  "facility.fnb_conversion",
] as const;

export type FacilityReportCode = (typeof FACILITY_REPORT_CODES)[number];

/**
 * The catalog rows for this hub, missing codes skipped. A catalog that lost a
 * code (contract drift) must not crash the page: the hub shows the rest and,
 * when nothing resolves, its empty guard.
 */
export function facilityReportDefinitions(): readonly ReportDefinition[] {
  const reports: ReportDefinition[] = [];
  for (const code of FACILITY_REPORT_CODES) {
    const report = reportByCode(code);
    if (report !== undefined) reports.push(report);
  }
  return reports;
}

/** How many of the six codes the catalog could not resolve. */
export function missingFacilityReportCount(): number {
  return FACILITY_REPORT_CODES.length - facilityReportDefinitions().length;
}
