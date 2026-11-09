// Facility family of the report viewer mock: nothing here. The facility
// report's run is registered by `features/facility-report/mock.ts`.
import type { Cell, DerivedSpec } from "./cells.ts";

export const derived = {} as const satisfies Record<string, DerivedSpec>;

export function cellFor(): Cell | undefined {
  return undefined;
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = { facility: [] } as const;
