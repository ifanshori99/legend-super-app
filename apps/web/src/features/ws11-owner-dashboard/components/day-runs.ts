// Shared by the "today" sections: the run of each tile's source report over the
// dashboard's monitoring day, keyed by the tile's catalog key.
import type {
  DashboardLayout,
  ReportRunInput,
} from "@starter/shared/dashboard";
import { tileReportCode } from "../board";
import { insightRunInput, insightTile, monitoringDay } from "../insights";

export function dayRunsFor(
  layout: DashboardLayout,
  keys: Readonly<Record<string, string>>,
  fallbackReports: Readonly<Record<string, string>>,
): Record<string, ReportRunInput> {
  const out: Record<string, ReportRunInput> = {};
  for (const name of Object.keys(keys)) {
    const tile = insightTile(layout, keys[name] as string);
    const code =
      (tile === null ? null : tileReportCode(tile)) ??
      (fallbackReports[name] as string);
    out[name] = insightRunInput(layout, code, monitoringDay(layout));
  }
  return out;
}
