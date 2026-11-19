// Catalog membership after a cloud restore (card legend-7r7q6, second opinion
// 1197 finding R2). A complete multi-page snapshot touches every row the
// restored cloud still has (the edge reset set `sync_txid = 0` on all rows
// first, then the replay restamped the received ones). A row that is still at
// `sync_txid = 0` is therefore absent from the cloud: switch it off. Never
// DELETE: an offline sale that already references the row stays valid.
//
// Call only from the tx that applies the LAST page of a rewound snapshot, never
// from an incremental page or a partial (maxPages) pull.
import { getTableName, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { CatalogSyncStream } from "@starter/shared/edge";
import { inventoryItems } from "../db/schema/inventory.ts";
import {
  itemVariants,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  priceLists,
  stations,
} from "../db/schema/menu.ts";
import { recipes } from "../db/schema/recipe.ts";
import type { Tx } from "./menu-internals.ts";

type Switch = {
  readonly table: PgTable;
  /** `is_active = false` when the table has the flag, else `deleted_at = at`. */
  readonly mode: "flag" | "tombstone";
  readonly hasUpdatedAt: boolean;
};

/**
 * Streams with a safe off-switch column. Skipped on purpose: printers
 * (removal is a versioned tombstone table), promotions and vouchers (no
 * is_active/deleted_at pair safe to flip locally) and
 * menu_item_modifier_groups (a link row without either column).
 */
const SWITCHES: Readonly<Partial<Record<CatalogSyncStream, Switch>>> = {
  menu_items: { table: menuItems, mode: "flag", hasUpdatedAt: true },
  item_variants: { table: itemVariants, mode: "tombstone", hasUpdatedAt: true },
  inventory_items: {
    table: inventoryItems,
    mode: "flag",
    hasUpdatedAt: false,
  },
  stations: { table: stations, mode: "flag", hasUpdatedAt: true },
  menu_categories: {
    table: menuCategories,
    mode: "tombstone",
    hasUpdatedAt: true,
  },
  modifier_groups: {
    table: modifierGroups,
    mode: "tombstone",
    hasUpdatedAt: true,
  },
  modifiers: { table: modifiers, mode: "tombstone", hasUpdatedAt: true },
  price_lists: { table: priceLists, mode: "tombstone", hasUpdatedAt: true },
  recipes: { table: recipes, mode: "flag", hasUpdatedAt: false },
};

/**
 * Deactivates the tenant's still-active rows of `stream` that the full
 * snapshot did not touch (`sync_txid = 0`). Returns the number of rows
 * switched off; 0 for a stream without a safe off-switch.
 */
export async function deactivateAbsentCatalogRows(
  tx: Tx,
  input: {
    readonly tenantId: string;
    readonly stream: CatalogSyncStream;
    readonly at: Date | string;
  },
): Promise<number> {
  const rule = SWITCHES[input.stream];
  if (!rule) return 0;
  const at = typeof input.at === "string" ? input.at : input.at.toISOString();
  const table = sql.identifier(getTableName(rule.table));
  const assignments: SQL[] =
    rule.mode === "flag"
      ? [sql`is_active = false`]
      : [sql`deleted_at = ${at}::timestamptz`];
  if (rule.hasUpdatedAt) assignments.push(sql`updated_at = ${at}::timestamptz`);
  const stillOn =
    rule.mode === "flag" ? sql`is_active = true` : sql`deleted_at IS NULL`;
  // Keep sync_txid = 0 (the stamp trigger would write a local id that hides a
  // later cloud record for the same row).
  await tx.execute(sql`SELECT set_config('legend.skip_sync_txid', 'on', true)`);
  const result = await tx.execute(
    sql`UPDATE ${table} SET ${sql.join(assignments, sql`, `)}
        WHERE tenant_id = ${input.tenantId}::uuid
          AND sync_txid = 0
          AND ${stillOn}`,
  );
  return result.rowCount ?? 0;
}
