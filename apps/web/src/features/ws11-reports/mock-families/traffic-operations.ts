// Traffic and operations families of the report viewer mock: counts of the
// kitchen and floor and the mock-only serving time. The catalog has no
// traffic or operations report yet, so no run is served for them.
import type { Atoms } from "../mock-day-model.ts";
import { count, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  failedItems: { from: "tx", ratio: 3 / 96 },
  remakes: { from: "tx", ratio: 4 / 96 },
  comps: { from: "tx", ratio: 2 / 96 },
  queue: { from: "net", snapshot: 12 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

/** Mock-only average: nothing in the day model moves it. */
const AVERAGE_SERVING_SECONDS = 780;

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
    case "avg_serving_time":
      return { unit: "seconds", value: AVERAGE_SERVING_SECONDS };
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = { traffic: [], operations: [] } as const;
