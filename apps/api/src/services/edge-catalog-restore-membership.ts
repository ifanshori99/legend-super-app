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
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  priceLists,
  stations,
} from "../db/schema/menu.ts";
import { promotions } from "../db/schema/crm-promo.ts";
import { recipes } from "../db/schema/recipe.ts";
import type { Tx } from "./menu-internals.ts";

type Switch = {
  readonly table: PgTable;
  /**
   * `is_active = false` when the table has the flag, `deleted_at = at` for a
   * tombstone, `status = 'paused'` for promotions.
   */
  readonly mode: "flag" | "tombstone" | "status";
  readonly hasUpdatedAt: boolean;
};

/**
 * Streams with a safe off-switch column. Skipped on purpose: printers
 * (removal is a versioned tombstone table) and vouchers (a voucher of a fixed
 * value can exist without a promotion, crm-promo-engine.ts; it stays safe
 * because the edge refuses every voucher code, see promo-gate.ts
 * `assertEdgePromoCodeAllowed`). menu_item_modifier_groups is a link row
 * with `deleted_at`: a link the restored cloud no longer has is tombstoned.
 *
 * promotions: the promo engine only applies `status = 'active'` rows, so a
 * promotion the restored cloud no longer has must leave `active` or it keeps
 * giving discounts offline (money rule: limit discounts). `paused` is used, not
 * `ended` (final in the cloud lifecycle) and never DELETE; a later cloud record
 * for the same id overwrites it.
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
  menu_item_modifier_groups: {
    table: menuItemModifierGroups,
    mode: "tombstone",
    hasUpdatedAt: true,
  },
  price_lists: { table: priceLists, mode: "tombstone", hasUpdatedAt: true },
  recipes: { table: recipes, mode: "flag", hasUpdatedAt: false },
  promotions: { table: promotions, mode: "status", hasUpdatedAt: true },
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
      : rule.mode === "status"
        ? [sql`status = 'paused'`]
        : [sql`deleted_at = ${at}::timestamptz`];
  if (rule.hasUpdatedAt) assignments.push(sql`updated_at = ${at}::timestamptz`);
  const stillOn =
    rule.mode === "flag"
      ? sql`is_active = true`
      : rule.mode === "status"
        ? sql`status = 'active'`
        : sql`deleted_at IS NULL`;
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
