// Traffic and operations families of the report viewer mock: counts of the
// kitchen and floor, plus mock-only averages nothing in the day model moves
// (serving time, dwell time, turnover, occupancy).
import type { Atoms } from "../mock-day-model.ts";
import { count, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  failedItems: { from: "tx", ratio: 3 / 96 },
  remakes: { from: "tx", ratio: 4 / 96 },
  comps: { from: "tx", ratio: 2 / 96 },
  queue: { from: "net", snapshot: 12 },
  waiterCalls: { from: "tx", ratio: 9 / 96 },
  apologyVouchers: { from: "tx", ratio: 1 / 96 },
  offlineDevices: { from: "net", snapshot: 2 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

/** Mock-only average: nothing in the day model moves it. */
const AVERAGE_SERVING_SECONDS = 780;
const AVERAGE_DWELL_MINUTES = "52.0000";
const TABLE_TURNOVER = "1.8400";
const TABLE_OCCUPANCY_PCT = "62.5000";

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "failed_item_count":
      return count(atoms.failedItems);
    case "remake_count":
      return count(atoms.remakes);
    case "comp_count":
      return count(atoms.comps);
    case "order_queue_count":
      return count(atoms.queue);
    case "waiter_call_count":
      return count(atoms.waiterCalls);
    case "apology_voucher_count":
      return count(atoms.apologyVouchers);
    case "device_offline_count":
      return count(atoms.offlineDevices);
    case "avg_dwell_minutes":
      return { unit: "decimal", value: AVERAGE_DWELL_MINUTES };
    case "table_turnover":
      return { unit: "decimal", value: TABLE_TURNOVER };
    case "table_occupancy_pct":
      return { unit: "percent", value: TABLE_OCCUPANCY_PCT };
    case "avg_serving_time":
      return { unit: "seconds", value: AVERAGE_SERVING_SECONDS };
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  traffic: [
    "traffic.pax",
    "traffic.by_zone",
    "traffic.new_vs_returning",
    "traffic.dwell_time",
    "traffic.peak_hours",
  ],
  operations: [
    "operations.table_turnover",
    "operations.occupancy",
    "operations.kitchen_queue",
    "operations.serving_time",
    "operations.waiter_calls",
    "operations.failed_items",
    "operations.remake_comp",
    "operations.devices",
    "operations.alerts",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "apology_voucher_count",
  "avg_spend_per_pax",
  "device_offline_count",
  "failed_item_count",
  "table_occupancy_pct",
]);
