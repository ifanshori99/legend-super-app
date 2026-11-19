// Blind stock count read visibility (stock opname T1, review K round 2). A
// blind count must not leak its system quantity through the plain inventory
// reads: while a blind count is open (draft/counting/pending_approval/approved)
// the stock balance, ledger, batch, alert and suggestion rows of its
// (location, item) pairs are hidden from EVERYONE, approvers included. An
// approver who is not a counter reads the system quantity only through the
// count detail after submit, which records them in `viewer_ids` so they can
// never enter a line if the count goes back to counting. Posted/cancelled
// counts hide nothing. The filter is SQL (NOT EXISTS), so pagination stays
// consistent.

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** Statuses in which a blind count still protects its quantities. */
export const OPEN_BLIND_STATUSES = [
  "draft",
  "counting",
  "pending_approval",
  "approved",
] as const;

/** Pure counterpart of the SQL filter for ONE count. */
export function isBlindHidden(count: {
  blind: boolean;
  status: string;
}): boolean {
  return (
    count.blind &&
    (OPEN_BLIND_STATUSES as readonly string[]).includes(count.status)
  );
}

/**
 * SQL predicate to AND into the WHERE of a stock read: true when the row's
 * (location, item) pair is NOT in an open blind count. Pass the read table's
 * location and item columns.
 */
export function blindCountHiddenFilter(pair: {
  locationId: AnyColumn;
  inventoryItemId: AnyColumn;
}): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM stock_counts sc
    JOIN stock_count_lines scl
      ON scl.tenant_id = sc.tenant_id AND scl.stock_count_id = sc.id
    WHERE sc.blind
      AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')
      AND sc.location_id = ${pair.locationId}
      AND scl.inventory_item_id = ${pair.inventoryItemId}
  )`;
}

/**
 * The `location:item` keys of open blind counts at one outlet, for reads that
 * build their rows in JS (purchase suggestions) instead of one SQL query.
 */
export async function hiddenBlindPairs(
  tx: { execute: (query: SQL) => Promise<{ rows: unknown[] }> },
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
      AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')`);
  return new Set(
    (
      result.rows as Array<{ location_id: string; inventory_item_id: string }>
    ).map((row) => `${row.location_id}:${row.inventory_item_id}`),
  );
}

/**
 * True when the (location, item) pair sits in an open blind count that `userId`
 * counts (creator, the append-only `counter_ids` history, or a line counter;
 * same set as `counterIds` in inventory-count.service.ts). Stock-out movements
 * of such a pair are refused before any stock check, so the answer never
 * depends on the hidden quantity.
 */
export async function isBlindCountCounterOfPair(
  tx: { execute: (query: SQL) => Promise<{ rows: unknown[] }> },
  input: { locationId: string; inventoryItemId: string; userId: string },
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1
    FROM stock_counts sc
    JOIN stock_count_lines scl
      ON scl.tenant_id = sc.tenant_id AND scl.stock_count_id = sc.id
    WHERE sc.blind
      AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')
      AND sc.location_id = ${input.locationId}::uuid
      AND scl.inventory_item_id = ${input.inventoryItemId}::uuid
      AND (
        lower(sc.counted_by) = lower(${input.userId})
        OR EXISTS (
          SELECT 1 FROM unnest(sc.counter_ids) AS cid
          WHERE lower(cid) = lower(${input.userId})
        )
        OR EXISTS (
          SELECT 1 FROM stock_count_lines mine
          WHERE mine.tenant_id = sc.tenant_id
            AND mine.stock_count_id = sc.id
            AND lower(mine.counted_by) = lower(${input.userId})
        )
      )
    LIMIT 1`);
  return result.rows.length > 0;
}
