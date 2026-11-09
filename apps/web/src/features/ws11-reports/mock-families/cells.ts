// Shared building blocks of the per-family mock modules (`mock-families/*.ts`):
// the derived-figure spec and the metric cell shapes. Relative `.ts` imports
// only; tests/ws11-reports.test.mjs loads `../mock.ts` in Node.
import type { AtomKey } from "../mock-day-model.ts";

export type DerivedSpec = {
  from: AtomKey;
  ratio?: number;
  /** Amount on the open business day; scaled by weekday for other days. */
  snapshot?: number;
};

// Plain wire values; the registry and the node test validate them against the
// branded schema, so no brand is faked here.
export type Cell = {
  unit: string;
  valueIdr?: number;
  value?: number | string;
} | null;

export function decimal4(numerator: number, denominator: number): string {
  return ((numerator * 100) / denominator).toFixed(4);
}

export const ratio = (num: number, den: number) =>
  den === 0 ? null : { unit: "percent" as const, value: decimal4(num, den) };
export const idr = (valueIdr: number) => ({ unit: "idr" as const, valueIdr });
export const count = (value: number) => ({ unit: "count" as const, value });
