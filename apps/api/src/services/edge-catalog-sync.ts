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
// (updated_at, id) with an opaque cursor and the settle window for rows whose
// commit lags their `updated_at`. Soft-deleted rows travel with `deletedAt`
// (tombstone). Streams that differ from the (updated_at, id) shape:
// - menu_item_modifier_groups: no `id` column; keyset (updated_at,
//   menu_item_id, group_id).
// - recipes: no `deleted_at` (a recipe is deactivated, never deleted). The
//   record carries ALL its lines (`lines`), read in the same statement as the
//   recipe row, so recipe and lines are one snapshot. `recipe_lines` has no
//   `updated_at`: the cloud bumps `recipes.updated_at` whenever lines change.
// - price_lists: the record carries ALL its live items (`items`), read in the
//   same statement as the list row. The cloud bumps `price_lists.updated_at` on
//   every item change (menu-pricing.service, menu-import.service).
// Scope: price_lists are outlet-owned (only the credential's outlet).
// menu_categories, menu_items and recipes are limited to the brand of the
// credential's outlet (`outlets.brand_id`); item_variants and
// menu_item_modifier_groups follow their menu item's brand. modifier_groups and
// modifiers have no brand column: they are tenant-level. Prices are read as the
// stored integer rupiah and passed through untouched.

import {
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
  catalogSyncRecordSchemas,
  type CatalogSyncPage,
  type CatalogSyncQuery,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import {
  CoreError,
  decodeCursor,
  encodeCursor,
  uuidSchema,
  type TenantId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { and, asc, eq, lte, sql, type SQL } from "drizzle-orm";
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
} from "../db/schema/menu.ts";
import { recipes } from "../db/schema/recipe.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";
import { verifiedEdgeNodeSchema } from "./staff-pin-sync.ts";

export { catalogSyncQuerySchema };
export type { CatalogSyncQuery };

/**
 * The puller restarts this far before a stored checkpoint (see
 * `rewindCatalogCursor`). A row's commit can lag its `updated_at` by more than
 * the settle window, so a record may land behind a cursor already handed out.
 * Re-reading the overlap is safe: apply is idempotent.
 */
export const CATALOG_SYNC_OVERLAP_MS = 10 * 60 * 1000;

/** Rows younger than this are held back (see staff-pin-sync "Settle window"). */
export const CATALOG_SYNC_SETTLE_MS = 5_000;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const CURSOR_TAG = "cat1";
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_INVALID_MESSAGE = "Cursor sinkronisasi katalog tidak valid.";

/** Streams whose cloud table has no `id`: the key is two uuids. */
const TWO_KEY_STREAMS: ReadonlySet<CatalogSyncStream> = new Set([
  "menu_item_modifier_groups",
]);

type Mark = { readonly version: string; readonly keys: readonly string[] };

/** True when `error` is the refusal of a malformed catalog cursor (not a record). */
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
  const [tag, version, ...keys] = parts;
  if (
    tag !== CURSOR_TAG ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    keys.length !== keyCount(stream) ||
    !keys.every((key) => uuidSchema.safeParse(key).success)
  )
    throw new CoreError("VALIDATION_ERROR", CURSOR_INVALID_MESSAGE);
  return { version, keys: keys.map(String) };
}

function encodeMark(mark: Mark): string {
  return encodeCursor([CURSOR_TAG, mark.version, ...mark.keys]);
}

/**
 * The cursor moved back by `ms` (microsecond digits kept, keys reset), for the
 * puller's overlap. A cursor of another stream shape or a malformed one throws
 * the cursor error.
 */
export function rewindCatalogCursor(
  stream: CatalogSyncStream,
  cursor: string,
  ms: number,
): string {
  const mark = parseCursor(stream, cursor);
  if (mark === null) return cursor;
  const base = Date.parse(`${mark.version.slice(0, 23)}Z`);
  const earlier = new Date(base - ms).toISOString().slice(0, 23);
  return encodeMark({
    version: `${earlier}${mark.version.slice(23, 26)}Z`,
    keys: mark.keys.map(() => NIL_UUID),
  });
}

/** Exact (microsecond, UTC) text of a timestamp column: the keyset version. */
function versionOf(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `(updated_at, keys...) > (since)` (row comparison), or nothing on a first pull. */
function after(
  updatedAt: AnyPgColumn,
  keys: readonly AnyPgColumn[],
  since: Mark | null,
): SQL | undefined {
  if (since === null) return undefined;
  const columns = sql.join([updatedAt, ...keys], sql`, `);
  const values = sql.join(
    [
      sql`${since.version}::timestamptz`,
      ...since.keys.map((key) => sql`${key}::uuid`),
    ],
    sql`, `,
  );
  return sql`(${columns}) > (${values})`;
}

const iso = (value: Date) => value.toISOString();
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
  readonly version: string;
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
  readonly cutoff: Date;
  readonly since: Mark | null;
  /** Fetch one more than the page to learn `hasMore`. */
  readonly take: number;
};

const scanners: Record<
  CatalogSyncStream,
  (scan: Scan) => Promise<readonly Found[]>
> = {
  async menu_categories({ tx, tenantId, brandId, cutoff, since, take }) {
    const t = menuCategories;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.brandId, brandId),
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.id],
      record: {
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
  async menu_items({ tx, tenantId, brandId, cutoff, since, take }) {
    const t = menuItems;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.brandId, brandId),
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.id],
      record: {
        id: row.id,
        tenantId: row.tenantId,
        brandId: row.brandId,
        categoryId: row.categoryId,
        name: row.name,
        description: row.description,
        type: row.type,
        stationId: row.stationId,
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
  async item_variants({ tx, tenantId, brandId, cutoff, since, take }) {
    const t = itemVariants;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
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
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.id],
      record: {
        id: row.id,
        tenantId: row.tenantId,
        menuItemId: row.menuItemId,
        name: row.name,
        recipeId: row.recipeId,
        ...stamps(row),
      },
    }));
  },
  async modifier_groups({ tx, tenantId, cutoff, since, take }) {
    const t = modifierGroups;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.id],
      record: {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        ...stamps(row),
      },
    }));
  },
  async modifiers({ tx, tenantId, cutoff, since, take }) {
    const t = modifiers;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.id],
      record: {
        id: row.id,
        tenantId: row.tenantId,
        groupId: row.groupId,
        name: row.name,
        priceIdr: row.priceIdr,
        recipeId: row.recipeId,
        stationId: row.stationId,
        ...stamps(row),
      },
    }));
  },
  async menu_item_modifier_groups({
    tx,
    tenantId,
    brandId,
    cutoff,
    since,
    take,
  }) {
    const t = menuItemModifierGroups;
    const rows = await tx
      .select({ row: t, version: versionOf(t.updatedAt) })
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
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.menuItemId, t.groupId], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.menuItemId), asc(t.groupId))
      .limit(take);
    return rows.map(({ row, version }) => ({
      version,
      keys: [row.menuItemId, row.groupId],
      record: {
        tenantId: row.tenantId,
        menuItemId: row.menuItemId,
        groupId: row.groupId,
        sortOrder: row.sortOrder,
        ...stamps(row),
      },
    }));
  },
  async price_lists({ tx, tenantId, outletId, cutoff, since, take }) {
    const t = priceLists;
    const rows = await tx
      .select({
        row: t,
        version: versionOf(t.updatedAt),
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
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version, items }) => ({
      version,
      keys: [row.id],
      record: {
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
  async recipes({ tx, tenantId, brandId, cutoff, since, take }) {
    const t = recipes;
    const rows = await tx
      .select({
        row: t,
        version: versionOf(t.updatedAt),
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
          eq(t.brandId, brandId),
          lte(t.updatedAt, cutoff),
          after(t.updatedAt, [t.id], since),
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(take);
    return rows.map(({ row, version, lines }) => ({
      version,
      keys: [row.id],
      record: {
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

export type ListCatalogRecordsOptions = {
  readonly now?: Date;
  /** Override the settle window (tests); never negative. */
  readonly settleMs?: number;
};

/**
 * One page of one catalog stream changed after `since`, in (updated_at, key)
 * order. Tenant and outlet come only from the arguments (the verified edge
 * credential); `query` carries the stream, the cursor and the limit only.
 */
export async function listCatalogRecordsSince(
  database: typeof appDb,
  input: {
    readonly tenantId: VerifiedEdgeNode["tenantId"];
    readonly outletId: VerifiedEdgeNode["outletId"];
    readonly query: CatalogSyncQuery;
  },
  options: ListCatalogRecordsOptions = {},
): Promise<CatalogSyncPage> {
  const { tenantId, outletId } = verifiedEdgeNodeSchema
    .pick({ tenantId: true, outletId: true })
    .parse({ tenantId: input.tenantId, outletId: input.outletId });
  const { stream, limit } = catalogSyncQuerySchema.parse(input.query);
  const since = parseCursor(stream, input.query.since);
  const now = options.now ?? new Date();
  const settleMs = Math.max(0, options.settleMs ?? CATALOG_SYNC_SETTLE_MS);
  const cutoff = new Date(now.getTime() - settleMs);
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "device" }),
    outletId,
  );

  const rows = await withTenant(database, context, async (tx) => {
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
      cutoff,
      since,
      take: limit + 1,
    });
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark =
    last === undefined
      ? null
      : encodeMark({ version: last.version, keys: last.keys });
  return catalogSyncPageSchema.parse({
    stream,
    records: page.map(({ record }) =>
      catalogSyncRecordSchemas[stream].parse(record),
    ),
    nextCursor: lastMark ?? input.query.since ?? null,
    hasMore: rows.length > limit,
  });
}
