// Catalog down-sync, edge side: apply one page of cloud records (bead
// legend-97p, legend-24318; PRD v1.7 §3 F8 Master Menu & Harga, §3 F16 Resep &
// BOM, §5 "cloud wins" for master data). The cloud export is
// services/edge-catalog-sync.ts; the page loop and the checkpoint are
// edge/catalog-puller.ts, which calls this inside the same transaction that
// moves the checkpoint.
//
// - Runs in the caller's transaction (`tx`): a failure anywhere rolls the whole
//   page back, so there is never a half-applied page.
// - Every record must be of `tenantId`; one bad record refuses the whole page.
// - Idempotent upsert by key (id; menu_item_modifier_groups: tenant, item,
//   group). Version = the record's `syncTxid` (the cloud transaction that last
//   wrote the row). Cloud wins: a record replaces the local row when its
//   `syncTxid` is greater than the stored `sync_txid` OR its `updatedAt` is
//   later than the stored `updated_at`; when neither is newer (equal = the same
//   write again) it is left alone. So a replayed page, two pulls returning in
//   reverse order or a rewound cursor never put an old price or a revived row
//   over a newer one. The `updated_at` half exists for edge rows whose
//   `sync_txid` was stamped locally (bootstrap, migration default): that local
//   transaction id can be larger than the cloud's and must not block the
//   cloud's newer data forever.
// - The edge writes the cloud's `sync_txid`, so every apply (and the parent
//   repair) first runs `set_config('legend.skip_sync_txid', 'on', true)`, local
//   to the transaction, which makes the stamp trigger leave the value alone.
// - Tombstones: a record with `deletedAt` is stored as such (the edge reads
//   filter `deleted_at IS NULL`), also when the row was not local yet. In a
//   page the tombstones are applied before the live rows, and before a live row
//   of a stream with a live unique key (stations outlet+name, price_lists
//   outlet+channel+effective_from, item_variants item+name, modifiers
//   group+name) is written, any other live local row holding that key is
//   soft-deleted (cloud wins), unless that row is newer than the record.
// - Money is copied as received: `priceIdr` is the integer rupiah, `quantity`
//   and `theoreticalCostIdr` the exact decimal string. No conversion.
// - Optional references the edge may not hold are stored as null, never
//   refused: menu_items / modifiers `station_id` (null only when that station is
//   not local, counted in `nulledRefs`), recipes `output_item_id` and
//   `updated_by` (the author may be an HQ user the edge never got; counted in
//   `nulledRefs`), menu_categories `parent_id` (a parent that is neither
//   local nor on the page yet: written null and reported in `deferredParents`
//   so the puller can persist it and run `repairCategoryParents` later).
//   Required references (brand, category, price list, item, variant, recipe,
//   uom, ...) are never nulled: the foreign key refuses the page and the
//   checkpoint does not move. A price list item never loses its variant.
// - inventory_items.base_uom_id (required, uoms arrive through the master
//   sync) not local yet is TRANSIENT: the page is refused with
//   `CatalogMissingRefError` (code CATALOG_MISSING_REF), the checkpoint stays.
// - A recipe record carries its full `lines`; a price list record its full
//   `items`. Header and children are replaced in one go: the header is upserted
//   (same version guard), then, only when it was applied, the local children
//   that are not in the record are deleted and the rest upserted. A stale
//   record touches no child, so two versions never mix and a header never
//   exists without its children.
// - Each (tenant, stream) apply takes a transaction advisory lock first, so two
//   concurrent pulls do not interleave.
// - No audit, no outbox: this mirrors cloud state; an event would echo back.
import {
  catalogSyncRecordSchemas,
  type CatalogSyncRecordOf,
  type CatalogSyncStream,
  type MenuCategorySyncRecord,
} from "@starter/shared/edge";
import { CoreError, type TenantId } from "@starter/shared/core";
import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { inventoryItems, uoms } from "../db/schema/inventory.ts";
import { user } from "../db/schema/user.ts";
import {
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  priceListItems,
  priceLists,
  stations,
} from "../db/schema/menu.ts";
import { recipeLines, recipes } from "../db/schema/recipe.ts";
import type { Tx } from "./menu-internals.ts";

export type CatalogApplyResult = {
  /** Rows inserted or updated (children of recipes / price lists excluded). */
  readonly applied: number;
  /** Records left alone: the local row is as new or newer. */
  readonly skipped: number;
  /** recipes / price_lists: local children removed because the cloud dropped them. */
  readonly deleted: number;
  /** Optional references stored as null because the edge lacks the target. */
  readonly nulledRefs: number;
  /** menu_categories: parent links written null, to repair after the stream. */
  readonly deferredParents: readonly DeferredCategoryParent[];
};

export type DeferredCategoryParent = {
  readonly id: string;
  readonly parentId: string;
  /** The record's `syncTxid`: the repair only completes that very write. */
  readonly syncTxid: string;
};

/** A required-later reference is not on this edge yet; retry on a later pull. */
export class CatalogMissingRefError extends Error {
  readonly code = "CATALOG_MISSING_REF";

  constructor() {
    super("Catalog record refers to a row this edge does not have yet.");
    this.name = "CatalogMissingRefError";
  }
}

export type ApplyCatalogRecordsInput<
  S extends CatalogSyncStream = CatalogSyncStream,
> = {
  readonly tenantId: TenantId;
  readonly stream: S;
  readonly records: readonly unknown[];
};

function refuse(message: string): never {
  throw new CoreError("VALIDATION_ERROR", message);
}

const date = (iso: string): Date => new Date(iso);
const dateOrNull = (iso: string | null): Date | null =>
  iso === null ? null : new Date(iso);

/**
 * ON CONFLICT guard: the write lands only over a row that is older in txid or
 * in `updated_at` (see the header). Equal on both = the same write: skipped.
 */
const olderThanExcluded = (t: {
  readonly syncTxid: AnyPgColumn;
  readonly updatedAt: AnyPgColumn;
}): SQL =>
  sql`(${t.syncTxid} < excluded.sync_txid OR ${t.updatedAt} < excluded.updated_at)`;

type Parsed<S extends CatalogSyncStream> = CatalogSyncRecordOf<S>[];

function parseRecords<S extends CatalogSyncStream>(
  stream: S,
  tenantId: string,
  records: readonly unknown[],
  keyOf: (record: CatalogSyncRecordOf<S>) => string,
): Parsed<S> {
  const schema = catalogSyncRecordSchemas[stream];
  const wanted = tenantId.toLowerCase();
  const seen = new Set<string>();
  const parsed: Parsed<S> = records.map((raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) refuse("Catalog record has an unknown shape.");
    return result.data as CatalogSyncRecordOf<S>;
  });
  for (const record of parsed) {
    if (record.tenantId.toLowerCase() !== wanted)
      refuse("Catalog record belongs to another tenant.");
    const key = keyOf(record).toLowerCase();
    if (seen.has(key)) refuse("Catalog page repeats a record.");
    seen.add(key);
  }
  return parsed;
}

type Stamped = {
  readonly syncTxid: string;
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
};

/**
 * Apply order: tombstones first (they free their unique keys), then oldest
 * version first, so a later record of the same key lands last.
 */
function inApplyOrder<T extends Stamped>(
  records: readonly T[],
  tie: (record: T) => string,
): T[] {
  const rank = (record: T) =>
    record.deletedAt !== undefined && record.deletedAt !== null ? 0 : 1;
  return [...records].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const x = BigInt(a.syncTxid);
    const y = BigInt(b.syncTxid);
    if (x !== y) return x < y ? -1 : 1;
    return tie(a).localeCompare(tie(b));
  });
}

/** A table with the columns every versioned catalog table shares. */
type Versioned = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly deletedAt: AnyPgColumn;
  readonly syncTxid: AnyPgColumn;
  readonly updatedAt: AnyPgColumn;
};
type Unversioned = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly syncTxid: AnyPgColumn;
  readonly updatedAt: AnyPgColumn;
};

type StoredVersion = { readonly txid: bigint; readonly updatedMs: bigint };

/** Version (`sync_txid`, `updated_at` in whole ms) of the local rows among `ids`. */
async function storedVersions(
  tx: Tx,
  table: Unversioned,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, StoredVersion>> {
  const out = new Map<string, StoredVersion>();
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await tx.execute(
    sql`SELECT ${table.id}::text AS id, ${table.syncTxid}::text AS sync_txid, floor(extract(epoch FROM ${table.updatedAt}) * 1000)::bigint::text AS updated_ms FROM ${table} WHERE ${table.tenantId} = ${tenantId}::uuid AND ${table.id} IN (${list})`,
  );
  for (const row of result.rows)
    out.set(String(row.id).toLowerCase(), {
      txid: BigInt(String(row.sync_txid)),
      updatedMs: BigInt(String(row.updated_ms)),
    });
  return out;
}

/**
 * Frees a live unique key for `self` (a live record about to be written):
 * every other live local row on the key is soft-deleted (cloud wins) and true
 * is returned. When such a row is newer than `self` (greater txid AND not
 * older `updated_at`: the mirror of the accept rule), nothing is deleted and
 * false is returned: `self` is the stale one and is left out (its newer
 * version arrives later in the stream).
 */
async function claimUniqueKey(
  tx: Tx,
  table: Versioned,
  tenantId: string,
  self: {
    readonly id: string;
    readonly syncTxid: string;
    readonly updatedAt: string;
  },
  sameKey: SQL,
): Promise<boolean> {
  const clash = sql`${table.tenantId} = ${tenantId}::uuid AND ${table.deletedAt} IS NULL AND ${table.id} <> ${self.id}::uuid AND ${sameKey}`;
  const newer = await tx.execute(
    sql`SELECT 1 AS found FROM ${table} WHERE ${clash} AND ${table.syncTxid} > ${self.syncTxid}::bigint AND ${table.updatedAt} >= ${self.updatedAt}::timestamptz LIMIT 1`,
  );
  if (newer.rows.length > 0) return false;
  await tx.execute(sql`UPDATE ${table} SET deleted_at = now() WHERE ${clash}`);
  return true;
}

/**
 * Writes `ordered` one by one: a record that is not newer than the local row
 * (neither `syncTxid` greater nor `updatedAt` later) is skipped; a live record on a unique key claims the key
 * first. `write` upserts (and, for documents, replaces the children) and tells
 * whether the row was written. Returns the rows written.
 */
async function applyOrdered<R extends Stamped & { readonly id: string }>(
  tx: Tx,
  table: Versioned | Unversioned,
  tenantId: string,
  ordered: readonly R[],
  hooks: {
    readonly sameKey?: (record: R) => SQL;
    readonly write: (record: R) => Promise<boolean>;
  },
): Promise<number> {
  const stored = await storedVersions(
    tx,
    table,
    tenantId,
    ordered.map((record) => record.id),
  );
  let applied = 0;
  for (const record of ordered) {
    const have = stored.get(record.id.toLowerCase());
    if (
      have !== undefined &&
      have.txid >= BigInt(record.syncTxid) &&
      have.updatedMs >= BigInt(Date.parse(record.updatedAt))
    )
      continue;
    if (
      hooks.sameKey !== undefined &&
      (record.deletedAt === undefined || record.deletedAt === null) &&
      !(await claimUniqueKey(
        tx,
        table as Versioned,
        tenantId,
        record,
        hooks.sameKey(record),
      ))
    )
      continue;
    if (await hooks.write(record)) applied += 1;
  }
  return applied;
}

/** Ids of `table` rows (any state) among `ids`, for optional references. */
async function localIds(
  tx: Tx,
  table: typeof stations | typeof menuCategories,
  tenantId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, [...ids])));
  return new Set(rows.map((row) => row.id));
}

function tally(
  applied: number,
  total: number,
  extra: {
    deleted?: number;
    nulledRefs?: number;
    deferredParents?: readonly DeferredCategoryParent[];
  } = {},
): CatalogApplyResult {
  return {
    applied,
    skipped: total - applied,
    deleted: extra.deleted ?? 0,
    nulledRefs: extra.nulledRefs ?? 0,
    deferredParents: extra.deferredParents ?? [],
  };
}

/**
 * Serializes applies of one (tenant, stream) (held to commit) and tells the
 * `sync_txid` trigger to keep the stamps this transaction writes (the cloud's
 * value, local to the transaction). Only for edge-side catalog writes.
 */
export async function lockCatalogStream(
  tx: Tx,
  tenantId: string,
  stream: CatalogSyncStream,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-catalog-sync:${tenantId}:${stream}`.toLowerCase()}, 0))`,
  );
  await tx.execute(sql`SELECT set_config('legend.skip_sync_txid', 'on', true)`);
}

/** Pairs whose parent is still missing locally, for the child still at that version. */
export async function unresolvedCategoryParents(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly pairs: readonly DeferredCategoryParent[];
  },
): Promise<DeferredCategoryParent[]> {
  const t = menuCategories;
  const known = await localIds(tx, t, input.tenantId, [
    ...new Set(input.pairs.map((pair) => pair.parentId)),
  ]);
  const open = input.pairs.filter(
    (pair) => !known.has(pair.parentId) && pair.parentId !== pair.id,
  );
  if (open.length === 0) return [];
  const rows = await tx
    .select({ id: t.id, syncTxid: t.syncTxid, parentId: t.parentId })
    .from(t)
    .where(
      and(
        eq(t.tenantId, input.tenantId),
        inArray(t.id, [...new Set(open.map((pair) => pair.id))]),
      ),
    );
  const current = new Map(rows.map((row) => [row.id, row]));
  return open.filter((pair) => {
    const row = current.get(pair.id);
    return (
      row !== undefined &&
      row.parentId === null &&
      BigInt(row.syncTxid) === BigInt(pair.syncTxid)
    );
  });
}

/**
 * Pass after the menu_categories stream was read: sets the parent that was
 * written null while it was missing, now that it exists locally. Only a row
 * still at the version (`sync_txid`) of the deferred record and still without
 * parent is touched (a newer record or a local change wins). Returns rows
 * repaired.
 */
export async function repairCategoryParents(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly pairs: readonly DeferredCategoryParent[];
  },
): Promise<number> {
  await lockCatalogStream(tx, input.tenantId, "menu_categories");
  const t = menuCategories;
  const known = await localIds(tx, t, input.tenantId, [
    ...new Set(input.pairs.map((pair) => pair.parentId)),
  ]);
  let repaired = 0;
  for (const pair of input.pairs) {
    if (!known.has(pair.parentId) || pair.parentId === pair.id) continue;
    const rows = await tx
      .update(t)
      .set({ parentId: pair.parentId })
      .where(
        and(
          eq(t.tenantId, input.tenantId),
          eq(t.id, pair.id),
          isNull(t.parentId),
          eq(t.syncTxid, pair.syncTxid),
        ),
      )
      .returning({ id: t.id });
    repaired += rows.length;
  }
  return repaired;
}

/** Parents first, so the self-referencing foreign key holds row by row. */
function parentsFirst(
  records: readonly MenuCategorySyncRecord[],
): MenuCategorySyncRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: MenuCategorySyncRecord[] = [];
  const visit = (record: MenuCategorySyncRecord): void => {
    if (done.has(record.id) || visiting.has(record.id)) return;
    visiting.add(record.id);
    const parent =
      record.parentId === null ? undefined : byId.get(record.parentId);
    if (parent) visit(parent);
    visiting.delete(record.id);
    done.add(record.id);
    out.push(record);
  };
  for (const record of records) visit(record);
  return out;
}

/**
 * Edge side: ingests one page of one catalog stream (see the header). `tx`
 * must be a tenant transaction (`withTenant`) of this edge node's scope.
 */
export async function applyCatalogRecords(
  tx: Tx,
  input: ApplyCatalogRecordsInput,
): Promise<CatalogApplyResult> {
  const { tenantId } = input;
  await lockCatalogStream(tx, tenantId, input.stream);
  switch (input.stream) {
    case "stations": {
      const t = stations;
      const parsed = parseRecords(
        "stations",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          sameKey: (r) =>
            sql`${t.outletId} = ${r.outletId}::uuid AND ${t.name} = ${r.name}`,
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              outletId: r.outletId,
              name: r.name,
              type: r.type,
              printerDeviceId: r.printerDeviceId,
              targetSeconds: r.targetSeconds,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
    }

    case "inventory_items": {
      const t = inventoryItems;
      const parsed = parseRecords(
        "inventory_items",
        tenantId,
        input.records,
        (r) => r.id,
      );
      // base_uom_id is required: uoms come with the master sync. Not local
      // yet is transient, never null.
      const uomIds = [...new Set(parsed.map((r) => r.baseUomId))];
      if (uomIds.length > 0) {
        const rows = await tx
          .select({ id: uoms.id })
          .from(uoms)
          .where(and(eq(uoms.tenantId, tenantId), inArray(uoms.id, uomIds)));
        const known = new Set(rows.map((row) => row.id));
        if (uomIds.some((id) => !known.has(id)))
          throw new CatalogMissingRefError();
      }
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              name: r.name,
              category: r.category,
              type: r.type,
              baseUomId: r.baseUomId,
              isPerishable: r.isPerishable,
              isActive: r.isActive,
              parMin: r.parMin,
              parMax: r.parMax,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
    }

    case "menu_categories": {
      const t = menuCategories;
      const parsed = parseRecords(
        "menu_categories",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const inPage = new Set(parsed.map((r) => r.id));
      const outside = [
        ...new Set(
          parsed.flatMap((r) =>
            r.parentId !== null && !inPage.has(r.parentId) ? [r.parentId] : [],
          ),
        ),
      ];
      const known = await localIds(tx, t, tenantId, outside);
      const deferredParents: DeferredCategoryParent[] = [];
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        parentsFirst(inApplyOrder(parsed, (x) => x.id)),
        {
          write: async (r) => {
            const parentId =
              r.parentId !== null &&
              (inPage.has(r.parentId) || known.has(r.parentId))
                ? r.parentId
                : null;
            const values = {
              tenantId: r.tenantId,
              brandId: r.brandId,
              name: r.name,
              parentId,
              sortOrder: r.sortOrder,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            if (rows.length > 0 && r.parentId !== null && parentId === null)
              deferredParents.push({
                id: r.id,
                parentId: r.parentId,
                syncTxid: r.syncTxid,
              });
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length, { deferredParents });
    }

    case "menu_items": {
      const t = menuItems;
      const parsed = parseRecords(
        "menu_items",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const stationIds = await localIds(tx, stations, tenantId, [
        ...new Set(parsed.flatMap((r) => (r.stationId ? [r.stationId] : []))),
      ]);
      let nulledRefs = 0;
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              brandId: r.brandId,
              categoryId: r.categoryId,
              name: r.name,
              description: r.description,
              type: r.type,
              stationId:
                r.stationId !== null && stationIds.has(r.stationId)
                  ? r.stationId
                  : null,
              stationType: r.stationType,
              course: r.course,
              recipeId: r.recipeId,
              taxRuleId: r.taxRuleId,
              labels: r.labels,
              allergens: r.allergens,
              mediaId: r.mediaId,
              isActive: r.isActive,
              sortOrder: r.sortOrder,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            if (
              rows.length > 0 &&
              r.stationId !== null &&
              !stationIds.has(r.stationId)
            )
              nulledRefs += 1;
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length, { nulledRefs });
    }

    case "item_variants": {
      const t = itemVariants;
      const parsed = parseRecords(
        "item_variants",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          sameKey: (r) =>
            sql`${t.menuItemId} = ${r.menuItemId}::uuid AND ${t.name} = ${r.name}`,
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              menuItemId: r.menuItemId,
              name: r.name,
              recipeId: r.recipeId,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
    }

    case "modifier_groups": {
      const t = modifierGroups;
      const parsed = parseRecords(
        "modifier_groups",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              name: r.name,
              minSelect: r.minSelect,
              maxSelect: r.maxSelect,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
    }

    case "modifiers": {
      const t = modifiers;
      const parsed = parseRecords(
        "modifiers",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const stationIds = await localIds(tx, stations, tenantId, [
        ...new Set(parsed.flatMap((r) => (r.stationId ? [r.stationId] : []))),
      ]);
      let nulledRefs = 0;
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (x) => x.id),
        {
          sameKey: (r) =>
            sql`${t.groupId} = ${r.groupId}::uuid AND ${t.name} = ${r.name}`,
          write: async (r) => {
            const values = {
              tenantId: r.tenantId,
              groupId: r.groupId,
              name: r.name,
              priceIdr: r.priceIdr,
              recipeId: r.recipeId,
              stationId:
                r.stationId !== null && stationIds.has(r.stationId)
                  ? r.stationId
                  : null,
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              deletedAt: dateOrNull(r.deletedAt),
              syncTxid: r.syncTxid,
            };
            const rows = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: olderThanExcluded(t),
              })
              .returning({ id: t.id });
            if (
              rows.length > 0 &&
              r.stationId !== null &&
              !stationIds.has(r.stationId)
            )
              nulledRefs += 1;
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length, { nulledRefs });
    }

    case "menu_item_modifier_groups": {
      const t = menuItemModifierGroups;
      const parsed = parseRecords(
        "menu_item_modifier_groups",
        tenantId,
        input.records,
        (r) => `${r.menuItemId}:${r.groupId}`,
      );
      let applied = 0;
      for (const r of inApplyOrder(
        parsed,
        (x) => `${x.menuItemId}:${x.groupId}`,
      )) {
        const values = {
          sortOrder: r.sortOrder,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
          syncTxid: r.syncTxid,
        };
        const rows = await tx
          .insert(t)
          .values({
            tenantId: r.tenantId,
            menuItemId: r.menuItemId,
            groupId: r.groupId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [t.tenantId, t.menuItemId, t.groupId],
            set: values,
            setWhere: olderThanExcluded(t),
          })
          .returning({ menuItemId: t.menuItemId });
        applied += rows.length;
      }
      return tally(applied, parsed.length);
    }

    case "price_lists": {
      const parsed = parseRecords(
        "price_lists",
        tenantId,
        input.records,
        (r) => r.id,
      );
      return applyPriceLists(tx, tenantId, parsed);
    }

    case "recipes": {
      const parsed = parseRecords(
        "recipes",
        tenantId,
        input.records,
        (r) => r.id,
      );
      return applyRecipes(tx, tenantId, parsed);
    }
  }
}

async function applyPriceLists(
  tx: Tx,
  tenantId: TenantId,
  parsed: Parsed<"price_lists">,
): Promise<CatalogApplyResult> {
  const t = priceLists;
  const wanted = tenantId.toLowerCase();
  for (const r of parsed)
    for (const item of r.items) {
      if (item.tenantId.toLowerCase() !== wanted)
        refuse("Catalog record belongs to another tenant.");
      if (item.priceListId.toLowerCase() !== r.id.toLowerCase())
        refuse("Price list item belongs to another price list.");
    }
  let deleted = 0;
  const applied = await applyOrdered(
    tx,
    t,
    tenantId,
    inApplyOrder(parsed, (x) => x.id),
    {
      sameKey: (r) =>
        sql`${t.outletId} = ${r.outletId}::uuid AND ${t.channel} = ${r.channel} AND ${t.effectiveFrom} = ${r.effectiveFrom}::date`,
      write: async (r) => {
        const values = {
          tenantId: r.tenantId,
          outletId: r.outletId,
          channel: r.channel,
          effectiveFrom: r.effectiveFrom,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
          syncTxid: r.syncTxid,
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: olderThanExcluded(t),
          })
          .returning({ id: t.id });
        // Header skipped (local as new or newer): its items stay with it.
        if (rows.length === 0) return false;
        const ids = r.items.map((item) => item.id);
        const gone = await tx
          .delete(priceListItems)
          .where(
            and(
              eq(priceListItems.tenantId, tenantId),
              eq(priceListItems.priceListId, r.id),
              ids.length === 0 ? undefined : notInArray(priceListItems.id, ids),
            ),
          )
          .returning({ id: priceListItems.id });
        deleted += gone.length;
        for (const item of r.items) {
          const itemValues = {
            tenantId: item.tenantId,
            priceListId: item.priceListId,
            itemId: item.itemId,
            variantId: item.variantId,
            // Exactly the cloud integer: no conversion, no rounding.
            priceIdr: item.priceIdr,
            createdAt: date(item.createdAt),
            updatedAt: date(item.updatedAt),
            deletedAt: null,
          };
          await tx
            .insert(priceListItems)
            .values({ id: item.id, ...itemValues })
            .onConflictDoUpdate({
              target: priceListItems.id,
              set: itemValues,
            });
        }
        return true;
      },
    },
  );
  return tally(applied, parsed.length, { deleted });
}

async function applyRecipes(
  tx: Tx,
  tenantId: TenantId,
  parsed: Parsed<"recipes">,
): Promise<CatalogApplyResult> {
  const t = recipes;
  const wanted = tenantId.toLowerCase();
  for (const r of parsed)
    for (const line of r.lines) {
      if (line.tenantId.toLowerCase() !== wanted)
        refuse("Catalog record belongs to another tenant.");
      if (line.recipeId.toLowerCase() !== r.id.toLowerCase())
        refuse("Recipe line belongs to another recipe.");
    }

  // updated_by: the author may be an HQ user this edge never got (the people
  // snapshot is per outlet). Permanent: null (counted), never a stalled page.
  const authors = [...new Set(parsed.map((r) => r.updatedBy))];
  const knownAuthors = new Set<string>();
  if (authors.length > 0) {
    const rows = await tx
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, authors));
    for (const row of rows) knownAuthors.add(row.id);
  }
  // output_item_id: stays null only when that item is not local (inventory_items
  // now arrive through their own stream). Permanent: null.
  const outputIds = [
    ...new Set(parsed.flatMap((r) => (r.outputItemId ? [r.outputItemId] : []))),
  ];
  const knownOutputs = new Set<string>();
  if (outputIds.length > 0) {
    const rows = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.tenantId, tenantId),
          inArray(inventoryItems.id, outputIds),
        ),
      );
    for (const row of rows) knownOutputs.add(row.id);
  }

  let deleted = 0;
  let nulledRefs = 0;
  const applied = await applyOrdered(
    tx,
    t,
    tenantId,
    inApplyOrder(parsed, (x) => x.id),
    {
      write: async (r) => {
        const outputItemId =
          r.outputItemId !== null && knownOutputs.has(r.outputItemId)
            ? r.outputItemId
            : null;
        const updatedBy = knownAuthors.has(r.updatedBy) ? r.updatedBy : null;
        const values = {
          tenantId,
          brandId: r.brandId,
          name: r.name,
          outputItemId,
          yieldQuantity: r.yieldQuantity,
          yieldUomId: r.yieldUomId,
          version: r.version,
          isActive: r.isActive,
          theoreticalCostIdr: r.theoreticalCostIdr,
          updatedBy,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          syncTxid: r.syncTxid,
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: olderThanExcluded(t),
          })
          .returning({ id: t.id });
        // Header skipped (local as new or newer): its lines stay with it.
        if (rows.length === 0) return false;
        if (r.outputItemId !== null && outputItemId === null) nulledRefs += 1;
        if (updatedBy === null) nulledRefs += 1;
        const ids = r.lines.map((line) => line.id);
        const gone = await tx
          .delete(recipeLines)
          .where(
            and(
              eq(recipeLines.tenantId, tenantId),
              eq(recipeLines.recipeId, r.id),
              ids.length === 0 ? undefined : notInArray(recipeLines.id, ids),
            ),
          )
          .returning({ id: recipeLines.id });
        deleted += gone.length;
        for (const line of r.lines) {
          const lineValues = {
            tenantId,
            recipeId: line.recipeId,
            sortOrder: line.sortOrder,
            componentType: line.componentType,
            componentId: line.componentId,
            quantity: line.quantity,
            uomId: line.uomId,
            wastePctBp: line.wastePctBp,
          };
          await tx
            .insert(recipeLines)
            .values({ id: line.id, ...lineValues })
            .onConflictDoUpdate({ target: recipeLines.id, set: lineValues });
        }
        return true;
      },
    },
  );
  return tally(applied, parsed.length, { deleted, nulledRefs });
}
