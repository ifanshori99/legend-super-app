// Catalog down-sync cloud -> outlet edge (bead legend-97p; PRD v1.7 §3 F8
// Master Menu & Harga, §3 F16 Resep & BOM, §5 "cloud wins" for master data).
//
// Export (cloud only, `GET /api/edge-sync/catalog?stream=...`; not under
// /api/edge, which the EDGE_MODE guard serves only on an edge node). Same
// contract as the device export (services/edge-device-sync.ts): the caller is
// an edge node authenticated by its own credential; tenant and outlet come only
// from the verified credential, never from the query. Read-only: nothing here
// writes to the cloud.
//
// One stream per table (shared `CATALOG_SYNC_STREAMS`). Keyset paging on
// (sync_txid, key) with an opaque cursor. `sync_txid` is the id of the cloud
// transaction that last wrote the row (set by a trigger). A row is sent only
// when `sync_txid < pg_snapshot_xmin(pg_current_snapshot())`: no transaction
// older than that can still commit, so a row can never appear behind a cursor
// already handed out (no settle window, no overlap, no rewind). Soft-deleted
// rows travel with `deletedAt` (tombstone). Streams that differ from the
// (sync_txid, id) shape:
// - menu_item_modifier_groups: no `id` column; keyset (sync_txid,
//   menu_item_id, group_id).
// - recipes: no `deleted_at` (a recipe is deactivated, never deleted). The
//   record carries ALL its lines (`lines`), read in the same statement as the
//   recipe row, so recipe and lines are one snapshot. `recipe_lines` has no
//   `sync_txid`: the cloud touches `recipes` whenever lines change, so the
//   record carries the recipe's `syncTxid`.
// - price_lists: the record carries ALL its live items (`items`), read in the
//   same statement as the list row. The cloud touches `price_lists` on every
//   item change (menu-pricing.service, menu-import.service, menu.service
//   deleteItem), so the record carries the list's `syncTxid`.
// - inventory_items: no `deleted_at` (inactive = `isActive` false).
// - printers (legend-fbf4v): the cloud deletes a printer for good, so a
//   deletion is a row of `edge_printer_tombstones` (written by trigger) served
//   as a record with `deletedAt`; live rows and markers are merged in
//   (sync_txid, id) order. Edge-measured status never travels.
// Scope: price_lists, stations and printers are outlet-owned (only the
// credential's outlet). menu_categories and menu_items are limited to the brand
// of the credential's outlet (`outlets.brand_id`); item_variants and
// menu_item_modifier_groups follow their menu item's brand. modifier_groups,
// modifiers and inventory_items have no brand column: they are tenant-level.
// recipes are tenant-level too (legend-2uqcd): a modifier or an item of this
// brand may use a recipe of another brand, so every edge gets all recipes of
// the tenant (the other brands arrive with the master snapshot). Only for an
// edge that negotiated protocol 3: an older edge has no brand check for them
// (FK failure, permanent CATALOG_PULL_FAILED), so it keeps the credential's
// brand only.
// Prices are read as the stored integer rupiah and passed through untouched.

import {
  CATALOG_PROTOCOL_VERSION,
  CATALOG_STATION_KDS_FIELDS_MIN_VERSION,
  STATION_KDS_FIELDS,
  catalogSyncCloudPageSchema,
  catalogSyncQuerySchema,
  catalogSyncCloudRecordSchemas,
  type CatalogSyncPage,
  type CatalogSyncQuery,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import {
  CoreError,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  uuidSchema,
  type TenantId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { createHash } from "node:crypto";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { db as appDb } from "../db/index.ts";
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
import { inventoryItems } from "../db/schema/inventory.ts";
import {
  edgePrinters,
  edgePrinterTombstones,
} from "../db/schema/edge-print.ts";
import { recipes } from "../db/schema/recipe.ts";
import { promotions, vouchers } from "../db/schema/crm-promo.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { isCatalogDeliveryRefusedTx } from "./edge-queue.service.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";
import { verifiedEdgeNodeSchema } from "./staff-pin-sync.ts";

export { catalogSyncQuerySchema };
export type { CatalogSyncQuery };

const CURSOR_TAG = "cat2";
/** Largest bigint: a cursor txid beyond it cannot be a real `sync_txid`. */
const TXID_MAX = 9223372036854775807n;
const TXID_PATTERN = /^\d{1,19}$/;
const CURSOR_INVALID_MESSAGE = "Cursor sinkronisasi katalog tidak valid.";

/**
 * legend-3k41y: streams whose rows are filtered by the outlet's brand. A node
 * whose outlet brand moved is refused these (fail closed); the other streams
 * are tenant-level or outlet-scoped and keep flowing.
 */
export const BRAND_DEPENDENT_CATALOG_STREAMS: ReadonlySet<CatalogSyncStream> =
  new Set([
    "menu_categories",
    "menu_items",
    "recipes",
    "item_variants",
    "menu_item_modifier_groups",
  ]);

/** Streams whose cloud table has no `id`: the key is two uuids. */
const TWO_KEY_STREAMS: ReadonlySet<CatalogSyncStream> = new Set([
  "menu_item_modifier_groups",
]);

type Mark = { readonly txid: string; readonly keys: readonly string[] };

/**
 * True when `error` is the refusal of a malformed catalog cursor (not a
 * record). An old `cat1` (time-based) cursor is refused the same way.
 */
export function isCatalogSyncCursorError(error: unknown): boolean {
  return (
    error instanceof CoreError &&
    error.code === "VALIDATION_ERROR" &&
    error.message === CURSOR_INVALID_MESSAGE
  );
}

function keyCount(stream: CatalogSyncStream): number {
  return TWO_KEY_STREAMS.has(stream) ? 2 : 1;
}

function parseCursor(
  stream: CatalogSyncStream,
  cursor: string | undefined,
): Mark | null {
  if (cursor === undefined) return null;
  let parts: unknown[];
  try {
    parts = decodeCursor(cursor);
  } catch {
    throw new CoreError("VALIDATION_ERROR", CURSOR_INVALID_MESSAGE);
  }
  const [tag, txid, ...keys] = parts;
  if (
    tag !== CURSOR_TAG ||
    typeof txid !== "string" ||
    !TXID_PATTERN.test(txid) ||
    BigInt(txid) > TXID_MAX ||
    keys.length !== keyCount(stream) ||
    !keys.every((key) => uuidSchema.safeParse(key).success)
  )
    throw new CoreError("VALIDATION_ERROR", CURSOR_INVALID_MESSAGE);
  return { txid, keys: keys.map(String) };
}

function encodeMark(mark: Mark): string {
  return encodeCursor([CURSOR_TAG, mark.txid, ...mark.keys]);
}

/** Exact decimal text of a `sync_txid` column: the keyset version. */
function txidOf(column: AnyPgColumn): SQL<string> {
  return sql<string>`${column}::text`;
}

/**
 * Commit-safe bound: every transaction with an id below the snapshot's xmin is
 * finished, so no row with a lower `sync_txid` can still appear.
 */
const SAFE_TXID = sql`pg_snapshot_xmin(pg_current_snapshot())::text::bigint`;

/** `sync_txid < safe bound`: only rows that can no longer be overtaken. */
function committed(syncTxid: AnyPgColumn): SQL {
  return sql`${syncTxid} < ${SAFE_TXID}`;
}

/** `(sync_txid, keys...) > (since)` (row comparison), or nothing on a first pull. */
function after(
  syncTxid: AnyPgColumn,
  keys: readonly AnyPgColumn[],
  since: Mark | null,
): SQL | undefined {
  if (since === null) return undefined;
  const columns = sql.join([syncTxid, ...keys], sql`, `);
  const values = sql.join(
    [sql`${since.txid}::bigint`, ...since.keys.map((key) => sql`${key}::uuid`)],
    sql`, `,
  );
  return sql`(${columns}) > (${values})`;
}

/**
 * A station id only when that station belongs to the credential's outlet (same
 * tenant; a tombstoned station still counts), else null: the edge never waits
 * for another outlet's station, which is never synced to it.
 */
function outletStationId(
  tenantId: AnyPgColumn,
  stationId: AnyPgColumn,
  outletId: string,
): SQL<string | null> {
  return sql<string | null>`case when exists (
    select 1 from stations st
    where st.tenant_id = ${tenantId}
      and st.id = ${stationId}
      and st.outlet_id = ${outletId}::uuid
  ) then ${stationId} else null end`;
}

const iso = (value: Date) => value.toISOString();

/** The stream never carries a code hash (brief 533 B1). */
function withoutCodeHash<T extends { codeHash: unknown }>(
  row: T,
): Omit<T, "codeHash"> {
  const copy: Partial<T> = { ...row };
  delete copy.codeHash;
  return copy as Omit<T, "codeHash">;
}

/**
 * Irreversible stand-in for `promotions.code_hash` on the promotions stream
 * (SHA-256 of the promotion id under a fixed prefix). Deterministic, so a
 * re-export never churns; it is not derived from the code, and no code can
 * hash to it by accident, so it can never match a presented code.
 */
function promoCodeRef(promotionId: string): string {
  return createHash("sha256")
    .update(`edge-promo-code-ref:v1:${promotionId}`, "utf8")
    .digest("hex");
}
const stamps = (row: {
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  deletedAt: row.deletedAt === null ? null : iso(row.deletedAt),
});

type Found = {
  readonly txid: string;
  readonly keys: readonly string[];
  readonly record: unknown;
};
type Transaction = Parameters<Parameters<typeof appDb.transaction>[0]>[0];
type Scan = {
  readonly tx: Transaction;
  readonly tenantId: TenantId;
  readonly outletId: string;
  /** `outlets.brand_id` of the credential's outlet. */
  readonly brandId: string;
  readonly since: Mark | null;
  /** Fetch one more than the page to learn `hasMore`. */
  readonly take: number;
  /**
   * Negotiated protocol of the request: undefined for an edge that did not
   * ask (it predates versioning). `recipes` is tenant-wide from 3 on.
   */
  readonly protocolVersion: number | undefined;
};

const scanners: Record<
  CatalogSyncStream,
  (scan: Scan) => Promise<readonly Found[]>
> = {
  async stations({ tx, tenantId, outletId, since, take }) {
    const t = stations;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.outletId, outletId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        name: row.name,
        type: row.type,
        printerDeviceId: row.printerDeviceId,
        targetSeconds: row.targetSeconds,
        displayOrder: row.displayOrder,
        isActive: row.isActive,
        autoPrintFallback: row.autoPrintFallback,
        ...stamps(row),
      },
    }));
  },
  async printers({ tx, tenantId, outletId, since, take }) {
    // Live rows and deletion markers (the cloud deletes a printer for good) are
    // two tables read as one stream in (sync_txid, id) order: each side is cut
    // at `take`, then merged, so the merged head is exactly the union's head.
    const live = edgePrinters;
    const gone = edgePrinterTombstones;
    const printerOutletId = outletIdSchema.parse(outletId);
    const [liveRows, goneRows] = await Promise.all([
      tx
        .select({ row: live, txid: txidOf(live.syncTxid) })
        .from(live)
        .where(
          and(
            eq(live.tenantId, tenantId),
            eq(live.outletId, printerOutletId),
            committed(live.syncTxid),
            after(live.syncTxid, [live.id], since),
          ),
        )
        .orderBy(asc(live.syncTxid), asc(live.id))
        .limit(take),
      tx
        .select({ row: gone, txid: txidOf(gone.syncTxid) })
        .from(gone)
        .where(
          and(
            eq(gone.tenantId, tenantId),
            eq(gone.outletId, printerOutletId),
            committed(gone.syncTxid),
            after(gone.syncTxid, [gone.id], since),
          ),
        )
        .orderBy(asc(gone.syncTxid), asc(gone.id))
        .limit(take),
    ]);
    const found: Found[] = [
      ...liveRows.map(({ row, txid }) => ({
        txid,
        keys: [row.id],
        // Runtime state (status, lastSeenAt, offlineSince) stays on the edge.
        record: {
          syncTxid: txid,
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          label: row.label,
          role: row.role,
          stationId: row.stationId,
          transport: row.transport,
          host: row.host,
          port: row.port,
          devicePath: row.devicePath,
          paperWidth: row.paperWidth,
          fallbackPrinterId: row.fallbackPrinterId,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
          deletedAt: null,
        },
      })),
      ...goneRows.map(({ row, txid }) => ({
        txid,
        keys: [row.id],
        record: {
          syncTxid: txid,
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          deletedAt: iso(row.deletedAt),
        },
      })),
    ];
    return found
      .sort((a, b) => {
        const x = BigInt(a.txid);
        const y = BigInt(b.txid);
        if (x !== y) return x < y ? -1 : 1;
        return a.keys[0] < b.keys[0] ? -1 : a.keys[0] > b.keys[0] ? 1 : 0;
      })
      .slice(0, take);
  },
  async inventory_items({ tx, tenantId, since, take }) {
    const t = inventoryItems;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        category: row.category,
        type: row.type,
        baseUomId: row.baseUomId,
        isPerishable: row.isPerishable,
        isActive: row.isActive,
        parMin: row.parMin,
        parMax: row.parMax,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      },
    }));
  },
  async menu_categories({ tx, tenantId, brandId, since, take }) {
    const t = menuCategories;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.brandId, brandId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        brandId: row.brandId,
        name: row.name,
        parentId: row.parentId,
        sortOrder: row.sortOrder,
        ...stamps(row),
      },
    }));
  },
  async menu_items({ tx, tenantId, outletId, brandId, since, take }) {
    const t = menuItems;
    const rows = await tx
      .select({
        row: t,
        txid: txidOf(t.syncTxid),
        stationId: outletStationId(t.tenantId, t.stationId, outletId),
      })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.brandId, brandId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid, stationId }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        brandId: row.brandId,
        categoryId: row.categoryId,
        name: row.name,
        description: row.description,
        type: row.type,
        stationId,
        stationType: row.stationType,
        course: row.course,
        recipeId: row.recipeId,
        taxRuleId: row.taxRuleId,
        labels: row.labels,
        allergens: row.allergens,
        mediaId: row.mediaId,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        ...stamps(row),
      },
    }));
  },
  async item_variants({ tx, tenantId, brandId, since, take }) {
    const t = itemVariants;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .innerJoin(
        menuItems,
        and(eq(menuItems.tenantId, t.tenantId), eq(menuItems.id, t.menuItemId)),
      )
      .where(
        and(
          eq(t.tenantId, tenantId),
          // Variants follow their item: another brand's item never leaves.
          eq(menuItems.brandId, brandId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        menuItemId: row.menuItemId,
        name: row.name,
        recipeId: row.recipeId,
        ...stamps(row),
      },
    }));
  },
  async modifier_groups({ tx, tenantId, since, take }) {
    const t = modifierGroups;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        ...stamps(row),
      },
    }));
  },
  async modifiers({ tx, tenantId, outletId, since, take }) {
    const t = modifiers;
    const rows = await tx
      .select({
        row: t,
        txid: txidOf(t.syncTxid),
        stationId: outletStationId(t.tenantId, t.stationId, outletId),
      })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid, stationId }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        groupId: row.groupId,
        name: row.name,
        priceIdr: row.priceIdr,
        recipeId: row.recipeId,
        stationId,
        ...stamps(row),
      },
    }));
  },
  async menu_item_modifier_groups({ tx, tenantId, brandId, since, take }) {
    const t = menuItemModifierGroups;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .innerJoin(
        menuItems,
        and(eq(menuItems.tenantId, t.tenantId), eq(menuItems.id, t.menuItemId)),
      )
      .where(
        and(
          eq(t.tenantId, tenantId),
          // Links follow their item: another brand's item never leaves.
          eq(menuItems.brandId, brandId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.menuItemId, t.groupId], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.menuItemId), asc(t.groupId))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.menuItemId, row.groupId],
      record: {
        syncTxid: txid,
        tenantId: row.tenantId,
        menuItemId: row.menuItemId,
        groupId: row.groupId,
        sortOrder: row.sortOrder,
        ...stamps(row),
      },
    }));
  },
  async price_lists({ tx, tenantId, outletId, since, take }) {
    const t = priceLists;
    const rows = await tx
      .select({
        row: t,
        txid: txidOf(t.syncTxid),
        // Same statement as the list row: one snapshot, so `items` always
        // matches the list version it travels with. Only live items. Outer
        // columns are qualified by hand (the inner table has the same names).
        items: sql<unknown[]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', pli.id,
            'tenantId', pli.tenant_id,
            'priceListId', pli.price_list_id,
            'itemId', pli.item_id,
            'variantId', pli.variant_id,
            'priceIdr', pli.price_idr,
            'createdAt', to_char(pli.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'updatedAt', to_char(pli.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) order by pli.id)
          from price_list_items pli
          where pli.tenant_id = "price_lists"."tenant_id"
            and pli.price_list_id = "price_lists"."id"
            and pli.deleted_at is null
        ), '[]'::jsonb)`,
      })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.outletId, outletId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid, items }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        channel: row.channel,
        effectiveFrom: row.effectiveFrom,
        items,
        ...stamps(row),
      },
    }));
  },
  async promotions({ tx, tenantId, outletId, since, take }) {
    const t = promotions;
    // Never filter inactive/outlet-ineligible headers: revocations must arrive.
    // Child state is read in the same statement so one parent version is whole.
    const rows = await tx
      .select({
        row: t,
        txid: txidOf(t.syncTxid),
        outletOverrides: sql<unknown[]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'outletId', po.outlet_id,
            'enabled', po.enabled,
            'updatedBy', po.updated_by,
            'updatedAt', po.updated_at
          ) order by po.outlet_id)
          from promotion_outlets po
          where po.tenant_id = "promotions"."tenant_id"
            and po.promotion_id = "promotions"."id"
            and po.outlet_id = ${outletId}::uuid
        ), '[]'::jsonb)`,
        stackingSettings: sql<unknown>`(
          select jsonb_build_object(
            'stackingPolicy', ps.stacking_policy,
            'updatedBy', ps.updated_by,
            'updatedAt', ps.updated_at,
            'syncTxid', ps.sync_txid::text
          ) from promo_settings ps
          where ps.tenant_id = "promotions"."tenant_id"
        )`,
      })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(
      ({
        row: { codeHash, ...row },
        txid,
        outletOverrides,
        stackingSettings,
      }) => ({
        txid,
        keys: [row.id],
        record: {
          ...row,
          codeRef: codeHash === null ? null : promoCodeRef(row.id),
          outletId,
          syncTxid: txid,
          startsAt: iso(row.startsAt),
          endsAt: row.endsAt === null ? null : iso(row.endsAt),
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
          outletOverrides,
          stackingSettings,
        },
      }),
    );
  },
  async vouchers({ tx, tenantId, since, take }) {
    const t = vouchers;
    const rows = await tx
      .select({ row: t, txid: txidOf(t.syncTxid) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid }) => ({
      txid,
      keys: [row.id],
      record: {
        ...withoutCodeHash(row),
        syncTxid: txid,
        validFrom: iso(row.validFrom),
        validUntil: row.validUntil === null ? null : iso(row.validUntil),
        issuedAt: iso(row.issuedAt),
        redeemedAt: row.redeemedAt === null ? null : iso(row.redeemedAt),
      },
    }));
  },
  async recipes({ tx, tenantId, brandId, since, take, protocolVersion }) {
    const allTenant = protocolVersion !== undefined && protocolVersion >= 3;
    const t = recipes;
    const rows = await tx
      .select({
        row: t,
        txid: txidOf(t.syncTxid),
        // Same statement as the recipe row: one snapshot, so `lines` always
        // matches the recipe version it travels with. Outer columns are
        // qualified by hand (the inner table has the same column names).
        lines: sql<unknown[]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', rl.id,
            'tenantId', rl.tenant_id,
            'recipeId', rl.recipe_id,
            'sortOrder', rl.sort_order,
            'componentType', rl.component_type,
            'componentId', rl.component_id,
            'quantity', rl.quantity::text,
            'uomId', rl.uom_id,
            'wastePctBp', rl.waste_pct_bp
          ) order by rl.sort_order, rl.id)
          from recipe_lines rl
          where rl.tenant_id = "recipes"."tenant_id"
            and rl.recipe_id = "recipes"."id"
        ), '[]'::jsonb)`,
      })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          allTenant ? undefined : eq(t.brandId, brandId),
          committed(t.syncTxid),
          after(t.syncTxid, [t.id], since),
        ),
      )
      .orderBy(asc(t.syncTxid), asc(t.id))
      .limit(take);
    return rows.map(({ row, txid, lines }) => ({
      txid,
      keys: [row.id],
      record: {
        syncTxid: txid,
        id: row.id,
        tenantId: row.tenantId,
        brandId: row.brandId,
        name: row.name,
        outputItemId: row.outputItemId,
        yieldQuantity: row.yieldQuantity,
        yieldUomId: row.yieldUomId,
        version: row.version,
        isActive: row.isActive,
        theoreticalCostIdr: row.theoreticalCostIdr,
        updatedBy: row.updatedBy,
        lines,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      },
    }));
  },
};

/**
 * The page version for an edge that understands up to `requested`: the lower
 * of that and this cloud's own. A newer edge gets this cloud's version (it
 * decides whether it can read it); an older one gets its own. Version 3
 * widens the recipe stream to every brand and adds the KDS station fields.
 * A v2 edge or one without the parameter keeps its brand-filtered recipes
 * and station shape without the KDS fields.
 */
export function negotiateCatalogProtocolVersion(requested: number): number {
  return Math.min(requested, CATALOG_PROTOCOL_VERSION);
}

/**
 * One page of one catalog stream changed after `since`, in (sync_txid, key)
 * order. Tenant and outlet come only from the arguments (the verified edge
 * credential); `query` carries the stream, the cursor and the limit only.
 */
export async function listCatalogRecordsForNode(
  database: typeof appDb,
  input: VerifiedEdgeNode & { readonly query: CatalogSyncQuery },
): Promise<CatalogSyncPage> {
  const node = verifiedEdgeNodeSchema.parse({
    tenantId: input.tenantId,
    outletId: input.outletId,
    edgeNodeId: input.edgeNodeId,
  });
  const query = catalogSyncQuerySchema.parse(input.query);
  const context = outletContext(
    establishTenantContext({
      tenantId: node.tenantId,
      brandId: null,
      source: "device",
    }),
    node.outletId,
  );
  return withTenant(database, context, async (tx) => {
    if (
      BRAND_DEPENDENT_CATALOG_STREAMS.has(query.stream) &&
      (await isCatalogDeliveryRefusedTx(tx, node))
    )
      throw new CoreError(
        "FORBIDDEN",
        "Edge node diblokir: brand outlet berubah, provisi ulang node.",
      );
    return listCatalogRecordsSinceTx(tx, { ...node, query });
  });
}

/** Trusted internal scanner; authenticated HTTP delivery uses the node guard above. */
export async function listCatalogRecordsSince(
  database: typeof appDb,
  input: {
    readonly tenantId: VerifiedEdgeNode["tenantId"];
    readonly outletId: VerifiedEdgeNode["outletId"];
    readonly query: CatalogSyncQuery;
  },
): Promise<CatalogSyncPage> {
  const { tenantId, outletId } = verifiedEdgeNodeSchema
    .pick({ tenantId: true, outletId: true })
    .parse({ tenantId: input.tenantId, outletId: input.outletId });
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "device" }),
    outletId,
  );

  return withTenant(database, context, (tx) =>
    listCatalogRecordsSinceTx(tx, input),
  );
}

/** Internal scanner shared with the cloud publisher in its cursor transaction. */
export async function listCatalogRecordsSinceTx(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  input: {
    readonly tenantId: VerifiedEdgeNode["tenantId"];
    readonly outletId: VerifiedEdgeNode["outletId"];
    readonly query: CatalogSyncQuery;
  },
): Promise<CatalogSyncPage> {
  const { tenantId, outletId } = verifiedEdgeNodeSchema
    .pick({ tenantId: true, outletId: true })
    .parse({ tenantId: input.tenantId, outletId: input.outletId });
  const { stream, limit, protocolVersion } = catalogSyncQuerySchema.parse(
    input.query,
  );
  const since = parseCursor(stream, input.query.since);
  const rows = await (async () => {
    // Fail closed: an inactive tenant or a closed / unknown outlet syncs nothing.
    const [tenantRow] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [outletRow] = await tx
      .select({ status: outlets.status, brandId: outlets.brandId })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .limit(1);
    if (
      tenantRow?.status !== "active" ||
      !outletRow ||
      outletRow.status === "closed"
    )
      throw new CoreError(
        "FORBIDDEN",
        "Edge node tidak dapat menyinkronkan outlet ini.",
      );
    return scanners[stream]({
      tx,
      tenantId,
      outletId,
      brandId: outletRow.brandId,
      since,
      take: limit + 1,
      protocolVersion:
        protocolVersion === undefined
          ? undefined
          : negotiateCatalogProtocolVersion(protocolVersion),
    });
  })();

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark =
    last === undefined
      ? null
      : encodeMark({ txid: last.txid, keys: last.keys });
  const stamped =
    protocolVersion === undefined
      ? undefined
      : negotiateCatalogProtocolVersion(protocolVersion);
  const full = catalogSyncCloudPageSchema.parse({
    // Only an edge that asked: an older edge's strict page schema would
    // refuse the field and stop syncing.
    ...(stamped === undefined ? {} : { protocolVersion: stamped }),
    stream,
    records: page.map(({ record }) =>
      catalogSyncCloudRecordSchemas[stream].parse(record),
    ),
    nextCursor: lastMark ?? input.query.since ?? null,
    hasMore: rows.length > limit,
  });
  // Station KDS fields (v3) only for an edge that asked for v3 or newer. An
  // older edge (v2 or no parameter) has a strict station schema without them.
  if (
    full.stream === "stations" &&
    (stamped ?? 0) < CATALOG_STATION_KDS_FIELDS_MIN_VERSION
  ) {
    return {
      ...full,
      records: full.records.map((record) => {
        const legacy: Record<string, unknown> = { ...record };
        for (const field of STATION_KDS_FIELDS) delete legacy[field];
        return legacy;
      }),
    } as unknown as CatalogSyncPage;
  }
  return full;
}
