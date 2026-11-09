// HR families (attendance, payroll, performance) of the report viewer mock.
// Payroll cost itself is the finance family's labor line.
import type { Atoms } from "../mock-day-model.ts";
import { count, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  late: { from: "tx", ratio: 3 / 96 },
  overtimeTenths: { from: "tx", ratio: 65 / 96 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

/** Mock-only average: nothing in the day model moves it. */
const CHECKLIST_COMPLIANCE_PCT = "87.5000";

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "attendance_late_count":
      return count(atoms.late);
    case "overtime_hours":
      return { unit: "decimal", value: (atoms.overtimeTenths / 10).toFixed(4) };
    case "checklist_compliance_pct":
      return { unit: "percent", value: CHECKLIST_COMPLIANCE_PCT };
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  attendance: [
    "attendance.by_station",
    "attendance.daily",
    "attendance.late",
    "attendance.overtime",
  ],
  payroll: [
    "payroll.cost_trend",
    "payroll.gross",
    "payroll.labor_cost",
    "payroll.overtime",
  ],
  performance: [
    "performance.checklist",
    "performance.employee",
    "performance.service_quality",
    "performance.station",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "attendance_late_count",
  "checklist_compliance_pct",
  "failed_item_count",
  "overtime_hours",
]);
