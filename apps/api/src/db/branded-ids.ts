import { eq, inArray, type Column, type SQL } from "drizzle-orm";

/**
 * A column whose application-side value is a string subtype: a branded UUID
 * (`TenantId`, `OutletId`, `PayrollRunId`, ...) or a ULID column.
 */
type StringIdColumn = Column & { readonly _: { readonly data: string } };

/**
 * `eq(column, id)` for a branded ID column when `id` is already a verified ID
 * that TypeScript only sees as `string` (event payload, loose service type).
 * Type-only: it emits exactly the SQL `eq` emits. Prefer typing the value as
 * the brand upstream; use this where that is not possible, instead of an
 * `as never` cast at the call site (bead legend-izy5l).
 */
export function eqId<C extends StringIdColumn>(column: C, id: string): SQL {
  return eq(column, id as never);
}

/** `inArray(column, ids)` for a branded ID column; same rules as `eqId`. */
export function inArrayIds<C extends StringIdColumn>(
  column: C,
  ids: readonly string[],
): SQL {
  return inArray(column, ids as never[]);
}
