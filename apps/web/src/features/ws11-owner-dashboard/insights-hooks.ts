// Data access of the part-2 sections: each section runs only the reports it
// shows, and only while its tab is mounted (bead legend-gb03).
import type { ReportRunInput } from "@starter/shared/dashboard";
import { combineReports, useReportRuns, type BoardReport } from "./hooks";

export type NamedRuns<K extends string> = {
  runs: Record<K, BoardReport>;
  /** Any failure, then any wait, then empty, otherwise ready. */
  all: BoardReport;
};

/** Runs a fixed set of named reports; the key set must not change per render. */
export function useNamedRuns<K extends string>(
  inputs: Record<K, ReportRunInput>,
): NamedRuns<K> {
  const keys = Object.keys(inputs) as K[];
  const reports = useReportRuns(keys.map((key) => inputs[key]));
  const runs = {} as Record<K, BoardReport>;
  keys.forEach((key, index) => {
    runs[key] = reports[index] as BoardReport;
  });
  return { runs, all: combineReports(reports) };
}
