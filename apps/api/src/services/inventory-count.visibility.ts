// Blind stock count read visibility (stock opname T1). A blind count must not
// leak its system quantity through the plain inventory reads: while a blind
// count is open (draft/counting/pending_approval/approved) the stock balance,
// ledger and batch rows of its (location, item) pairs are hidden from
//   - anyone who is in that count's counter set (creator, the append-only
//     `counter_ids` history, or any line counter), and
//   - anyone without `inventory.adjustment.approve` at the outlet.
// An approver who is not a counter sees everything. Posted/cancelled counts
// hide nothing. The filter is SQL (NOT EXISTS), so pagination stays consistent.

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** Who is reading; `canApprove` = `inventory.adjustment.approve` at the outlet. */
export type BlindViewer = { userId: string; canApprove: boolean };

/** Statuses in which a blind count still protects its quantities. */
export const OPEN_BLIND_STATUSES = [
  "draft",
  "counting",
  "pending_approval",
  "approved",
] as const;

/**
 * Pure counterpart of the SQL filter for ONE count: true when `viewer` must not
 * see the stock rows of that count's pairs. `lineCounterIds` are the
 * `counted_by` values of its lines; ids compare case-insensitively.
 */
export function isBlindHiddenFor(
  viewer: BlindViewer,
  count: {
    blind: boolean;
    status: string;
    countedBy: string;
    counterIds: readonly string[];
  },
  lineCounterIds: readonly (string | null)[] = [],
): boolean {
  if (!count.blind) return false;
  if (!(OPEN_BLIND_STATUSES as readonly string[]).includes(count.status))
    return false;
  if (!viewer.canApprove) return true;
  const me = viewer.userId.toLowerCase();
  return (
    count.countedBy.toLowerCase() === me ||
    count.counterIds.some((id) => id.toLowerCase() === me) ||
    lineCounterIds.some((id) => id !== null && id.toLowerCase() === me)
  );
}

/** True (SQL) when `viewer` must not see the pairs of count `sc`. */
function viewerIsCounterSql(viewer: BlindViewer): SQL {
  const me = viewer.userId.toLowerCase();
  return viewer.canApprove
    ? sql`(
        lower(sc.counted_by) = ${me}::text
        OR EXISTS (SELECT 1 FROM unnest(sc.counter_ids) AS c(id) WHERE lower(c.id) = ${me}::text)
        OR EXISTS (
          SELECT 1 FROM stock_count_lines mine
          WHERE mine.tenant_id = sc.tenant_id
            AND mine.stock_count_id = sc.id
            AND lower(mine.counted_by) = ${me}::text
        )
      )`
    : sql`true`;
}

/**
 * SQL predicate to AND into the WHERE of a stock read: true when the row's
 * (location, item) pair is NOT hidden from `viewer`. Pass the read table's
 * location and item columns (balances, ledger, batches).
 */
export function blindCountHiddenFilter(
  viewer: BlindViewer,
  pair: { locationId: AnyColumn; inventoryItemId: AnyColumn },
): SQL {
  const viewerIsCounter = viewerIsCounterSql(viewer);
  return sql`NOT EXISTS (
    SELECT 1
    FROM stock_counts sc
    JOIN stock_count_lines scl
      ON scl.tenant_id = sc.tenant_id AND scl.stock_count_id = sc.id
    WHERE sc.blind
      AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')
      AND sc.location_id = ${pair.locationId}
      AND scl.inventory_item_id = ${pair.inventoryItemId}
      AND ${viewerIsCounter}
  )`;
}

/**
 * The `location:item` keys hidden from `viewer` at one outlet, for reads that
 * build their rows in JS (purchase suggestions) instead of one SQL query.
 */
export async function hiddenBlindPairs(
  tx: { execute: (query: SQL) => Promise<{ rows: unknown[] }> },
  viewer: BlindViewer,
  outletId: string,
): Promise<Set<string>> {
  const result = await tx.execute(sql`
    SELECT DISTINCT sc.location_id::text AS location_id,
           scl.inventory_item_id::text AS inventory_item_id
    FROM stock_counts sc
    JOIN stock_count_lines scl
      ON scl.tenant_id = sc.tenant_id AND scl.stock_count_id = sc.id
    WHERE sc.blind
      AND sc.outlet_id = ${outletId}::uuid
      AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')
      AND ${viewerIsCounterSql(viewer)}`);
  return new Set(
    (
      result.rows as Array<{ location_id: string; inventory_item_id: string }>
    ).map((row) => `${row.location_id}:${row.inventory_item_id}`),
  );
}
