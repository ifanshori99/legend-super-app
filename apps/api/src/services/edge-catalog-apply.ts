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
//   wrote the row). Cloud wins: a record replaces the local row only when its
//   `syncTxid` is strictly greater than the stored `sync_txid`; equal or lower
//   is left alone (a replayed page, two pulls returning in reverse order or a
//   rewound cursor never put an old price or a revived row over a newer one).
//   `updated_at` is copied but never compared (no clock-skew risk). A local row
//   stamped by a local transaction (bootstrap, migration default) is not
//   comparable with the cloud's ids: before the first HTTP or event apply,
//   `ensureCatalogStreamInitialized` calls `resetCatalogSyncTxid` once and
//   records a durable marker. Later cursor rewinds may reset HTTP-only copies,
//   while versions backed by successfully held link events are preserved.
// - The edge writes the cloud's `sync_txid`, so every apply (and the parent
//   repair) first runs `set_config('legend.skip_sync_txid', 'on', true)`, local
//   to the transaction, which makes the stamp trigger leave the value alone.
// - printers (legend-fbf4v) are the exception to the tombstone rule below: the
//   cloud deletes them for good, so a deletion record removes the local row
//   (see applyPrinters).
// - Tombstones: a record with `deletedAt` is stored as such (the edge reads
//   filter `deleted_at IS NULL`), also when the row was not local yet. In a
//   page the tombstones are applied before the live rows, and before a live row
//   of a stream with a live unique key (stations outlet+name, price_lists
//   outlet+channel+effective_from, item_variants item+name, modifiers
//   group+name) is written, any other live local row holding that key is
//   soft-deleted (cloud wins), unless that row is newer than the record.
// - Money is copied as received: `priceIdr` is the integer rupiah, `quantity`
//   and `theoreticalCostIdr` the exact decimal string. No conversion.
// - Optional references: recipes `updated_by` (the author may be an HQ user the
//   edge never got) is stored null and counted in `nulledRefs`;
//   menu_categories `parent_id` (a parent that is neither local nor on the page
//   yet) is written null and reported in `deferredParents`, so the puller can
//   persist it and run `repairCategoryParents` later. The same holds for a
//   printers `fallback_printer_id` (`deferredFallbacks`, `repairPrinterFallbacks`).
//   Required references (brand, category, price list, item, variant, recipe,
//   uom, ...) are never nulled: the foreign key refuses the page and the
//   checkpoint does not move. A price list item never loses its variant.
// - TRANSIENT references: a menu_items / modifiers `station_id`, a recipes
//   `output_item_id` or an inventory_items `base_uom_id` that is not local yet
//   (stations and inventory items have their own streams, uoms come with the
//   master sync) refuses the page with `CatalogMissingRefError` (code
//   CATALOG_MISSING_REF); the checkpoint stays and a later pull retries. The
//   cloud only sends the credential outlet's station ids (null otherwise).
//   A recipes `brand_id` that is not local yet (recipes are tenant-wide, but
//   the other brands arrive with the master snapshot, legend-2uqcd) is
//   transient too: `CatalogMissingRefError`, retried after the next master sync.
// - A recipe record carries its full `lines`; a price list record its full
//   `items` (a tombstoned list: none, its local items are removed). Header and
//   children are replaced in one go: the header is upserted
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
import {
  CoreError,
  idr,
  outletIdSchema,
  userIdSchema,
  type TenantId,
} from "@starter/shared/core";
import { defaultPromoStackingPolicy } from "@starter/shared/crm";
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
import {
  edgePrintJobs,
  edgePrinterDeleteVersions,
  edgePrinters,
} from "../db/schema/edge-print.ts";
import { brands } from "../db/schema/platform-org.ts";
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
import {
  edgeVoucherCatalog,
  promotionOutlets,
  promotions,
  promoSettings,
} from "../db/schema/crm-promo.ts";
import type { Tx } from "./menu-internals.ts";
import { catalogRecordIdFromKeys } from "../lib/edge-catalog-identity.ts";

export type CatalogApplyResult = {
  /** Rows inserted or updated (children of recipes / price lists excluded). */
  readonly applied: number;
  /** Records left alone: the local row is as new or newer. */
  readonly skipped: number;
  /** recipes / price_lists: local children removed because the cloud dropped them; printers: rows removed by a deletion record. */
  readonly deleted: number;
  /** Optional references stored as null because the edge lacks the target. */
  readonly nulledRefs: number;
  /** menu_categories: parent links written null, to repair after the stream. */
  readonly deferredParents: readonly DeferredCategoryParent[];
  /** printers: fallback links written null, to repair after the stream. */
  readonly deferredFallbacks: readonly DeferredPrinterFallback[];
};

export type DeferredCategoryParent = {
  readonly id: string;
  readonly parentId: string;
  /** The record's `syncTxid`: the repair only completes that very write. */
  readonly syncTxid: string;
};

/** A printer whose fallback is not on this edge yet (`parentId` = the fallback printer). */
export type DeferredPrinterFallback = DeferredCategoryParent;

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
const userIdOrNull = (id: string | null) =>
  id === null ? null : userIdSchema.parse(id);

/**
 * ON CONFLICT guard: the write lands only over a row with a strictly lower
 * `sync_txid` (see the header). Equal = the same write: skipped.
 */
const olderThanExcluded = (t: { readonly syncTxid: AnyPgColumn }): SQL =>
  sql`${t.syncTxid} < excluded.sync_txid`;

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
};
type Unversioned = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly syncTxid: AnyPgColumn;
};

/** `sync_txid` of the local rows among `ids` (lower-case id -> stamp). */
async function storedSyncTxids(
  tx: Tx,
  table: Unversioned,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await tx.execute(
    sql`SELECT ${table.id}::text AS id, ${table.syncTxid}::text AS sync_txid FROM ${table} WHERE ${table.tenantId} = ${tenantId}::uuid AND ${table.id} IN (${list})`,
  );
  for (const row of result.rows)
    out.set(String(row.id).toLowerCase(), BigInt(String(row.sync_txid)));
  return out;
}

/**
 * Frees a live unique key for `self` (a live record about to be written):
 * every other live local row on the key is soft-deleted (cloud wins) and true
 * is returned. When such a row has a greater txid than `self`, nothing is
 * deleted and false is returned: `self` is the stale one and is left out (its
 * newer version arrives later in the stream).
 */
async function claimUniqueKey(
  tx: Tx,
  table: Versioned,
  tenantId: string,
  self: { readonly id: string; readonly syncTxid: string },
  sameKey: SQL,
): Promise<boolean> {
  const clash = sql`${table.tenantId} = ${tenantId}::uuid AND ${table.deletedAt} IS NULL AND ${table.id} <> ${self.id}::uuid AND ${sameKey}`;
  const newer = await tx.execute(
    sql`SELECT 1 AS found FROM ${table} WHERE ${clash} AND ${table.syncTxid} > ${self.syncTxid}::bigint LIMIT 1`,
  );
  if (newer.rows.length > 0) return false;
  await tx.execute(sql`UPDATE ${table} SET deleted_at = now() WHERE ${clash}`);
  return true;
}

/**
 * Writes `ordered` one by one: a record whose `syncTxid` is not greater than
 * the local row's is skipped; a live record on a unique key claims the key
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
  const stored = await storedSyncTxids(
    tx,
    table,
    tenantId,
    ordered.map((record) => record.id),
  );
  let applied = 0;
  for (const record of ordered) {
    const have = stored.get(record.id.toLowerCase());
    if (have !== undefined && have >= BigInt(record.syncTxid)) continue;
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
  table: typeof stations | typeof menuCategories | typeof edgePrinters,
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
    deferredFallbacks?: readonly DeferredPrinterFallback[];
  } = {},
): CatalogApplyResult {
  return {
    applied,
    skipped: total - applied,
    deleted: extra.deleted ?? 0,
    nulledRefs: extra.nulledRefs ?? 0,
    deferredParents: extra.deferredParents ?? [],
    deferredFallbacks: extra.deferredFallbacks ?? [],
  };
}

/** Promotion documents must name this edge's single outlet, including removals. */
async function requirePromotionOutlet(tx: Tx, outletId: string): Promise<void> {
  const result = await tx.execute(
    sql`SELECT current_setting('app.outlet_ids', true) AS outlet_ids`,
  );
  let ids: unknown;
  try {
    ids = JSON.parse(String(result.rows[0]?.outlet_ids ?? "null"));
  } catch {
    refuse("Catalog promotion has no outlet scope.");
  }
  if (
    !Array.isArray(ids) ||
    ids.length !== 1 ||
    typeof ids[0] !== "string" ||
    ids[0].toLowerCase() !== outletId.toLowerCase()
  )
    refuse("Catalog promotion belongs to another outlet.");
}

export const STREAM_TABLES: Readonly<Record<CatalogSyncStream, PgTable>> = {
  stations,
  printers: edgePrinters,
  inventory_items: inventoryItems,
  menu_categories: menuCategories,
  modifier_groups: modifierGroups,
  modifiers,
  menu_items: menuItems,
  item_variants: itemVariants,
  menu_item_modifier_groups: menuItemModifierGroups,
  price_lists: priceLists,
  recipes,
  promotions,
  vouchers: edgeVoucherCatalog,
};

/** Highest successfully held event version, scoped to this receiving node. */
async function heldCatalogEventVersions(
  tx: Tx,
  tenantId: TenantId,
  edgeNodeId: string,
): Promise<ReadonlyMap<string, bigint>> {
  // Mirrors heldReceipt in edge/db-link-store.ts, including successful
  // supervisor replays. Importing that transport here would create a cycle.
  const receipts = await tx.execute(
    sql`SELECT i.aggregate_id, MAX(i.aggregate_sequence)::text AS sequence
        FROM edge_inbound_events i
        WHERE i.tenant_id = ${tenantId}::uuid
          AND i.edge_node_id = ${edgeNodeId}::uuid
          AND i.direction = 'cloud_to_edge'
          AND i.kind = 'master_data'
          AND i.aggregate_type = 'catalog_record'
          AND (i.outcome = 'applied' OR (i.outcome = 'conflict' AND EXISTS (
            SELECT 1 FROM edge_sync_conflicts c
            JOIN edge_sync_conflict_resolutions r
              ON r.tenant_id = c.tenant_id AND r.conflict_id = c.id
              AND r.outcome = 'applied'
            WHERE c.tenant_id = i.tenant_id AND c.edge_node_id = i.edge_node_id
              AND c.direction = i.direction AND c.event_id = i.event_id
          )))
        GROUP BY i.aggregate_id`,
  );
  return new Map(
    receipts.rows.map((row) => [
      String(row.aggregate_id),
      BigInt(String(row.sequence)),
    ]),
  );
}

/** Full-page validation precedes filtering, including stale duplicate keys. */
export async function filterCatalogRecordsAfterEvents(
  tx: Tx,
  input: ApplyCatalogRecordsInput & { readonly edgeNodeId: string },
): Promise<readonly unknown[]> {
  const records = parseRecords(
    input.stream,
    input.tenantId,
    input.records,
    (record) =>
      catalogRecordIdFromKeys(
        input.stream,
        "id" in record ? [record.id] : [record.menuItemId, record.groupId],
      ),
  );
  const held = await heldCatalogEventVersions(
    tx,
    input.tenantId,
    input.edgeNodeId,
  );
  return records.filter((record) => {
    const id = catalogRecordIdFromKeys(
      input.stream,
      "id" in record ? [record.id] : [record.menuItemId, record.groupId],
    );
    const version = held.get(id);
    // A held printer tombstone has no local row to guard an upsert. Receipt
    // versions therefore protect absent documents as well as existing ones.
    return version === undefined || BigInt(record.syncTxid) > version;
  });
}

/**
 * A full HTTP pull may reset HTTP-only versions after a cloud restore. Rows
 * backed by held link events keep their current version, so an older HTTP
 * snapshot cannot undo them. The caller holds the same stream apply lock.
 */
export async function resetCatalogSyncTxid(
  tx: Tx,
  tenantId: TenantId,
  stream: CatalogSyncStream,
  edgeNodeId: string,
): Promise<void> {
  await lockCatalogStream(tx, tenantId, stream);
  const held = await heldCatalogEventVersions(tx, tenantId, edgeNodeId);
  const protectedKeys: string[][] = [];
  if (held.size > 0) {
    const columns =
      stream === "menu_item_modifier_groups"
        ? sql`menu_item_id::text AS key1, group_id::text AS key2`
        : sql`id::text AS key1`;
    const stored = await tx.execute(
      sql`SELECT ${columns} FROM ${STREAM_TABLES[stream]} WHERE tenant_id = ${tenantId}::uuid`,
    );
    for (const row of stored.rows) {
      const keys =
        stream === "menu_item_modifier_groups"
          ? [String(row.key1), String(row.key2)]
          : [String(row.key1)];
      if (held.has(catalogRecordIdFromKeys(stream, keys)))
        protectedKeys.push(keys);
    }
  }
  const mayReset =
    protectedKeys.length === 0
      ? sql`true`
      : stream === "menu_item_modifier_groups"
        ? sql`NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(protectedKeys.map(([itemId, groupId]) => ({ item_id: itemId, group_id: groupId })))}::jsonb)
              AS kept(item_id uuid, group_id uuid)
            WHERE kept.item_id = target.menu_item_id AND kept.group_id = target.group_id
          )`
        : sql`NOT (target.id = ANY(${`{${protectedKeys.map(([id]) => id).join(",")}}`}::uuid[]))`;
  await tx.execute(
    sql`UPDATE ${STREAM_TABLES[stream]} AS target SET sync_txid = 0 WHERE target.tenant_id = ${tenantId}::uuid AND target.sync_txid <> 0 AND ${mayReset}`,
  );
  if (stream === "printers") {
    // Same rule for the deletion versions of removed printers.
    const kept = await tx.execute(
      sql`SELECT printer_id::text AS id FROM ${edgePrinterDeleteVersions} WHERE tenant_id = ${tenantId}::uuid`,
    );
    const heldIds = kept.rows
      .map((row) => String(row.id))
      .filter((id) => held.has(catalogRecordIdFromKeys(stream, [id])));
    await tx.execute(
      sql`UPDATE ${edgePrinterDeleteVersions} AS target SET version = 0 WHERE target.tenant_id = ${tenantId}::uuid AND target.version <> 0 AND NOT (target.printer_id = ANY(${`{${heldIds.join(",")}}`}::uuid[]))`,
    );
  }
  if (stream === "promotions" && protectedKeys.length === 0)
    await tx.execute(
      sql`UPDATE ${promoSettings} SET sync_txid = 0 WHERE tenant_id = ${tenantId}::uuid AND sync_txid <> 0`,
    );
}

/** A station a record names must be local (its own stream): transient otherwise. */
function requireStations(
  records: readonly { readonly stationId: string | null }[],
  known: ReadonlySet<string>,
): void {
  if (records.some((r) => r.stationId !== null && !known.has(r.stationId)))
    throw new CatalogMissingRefError();
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

/** Pairs whose fallback printer is still missing locally, for the printer still at that version. */
export async function unresolvedPrinterFallbacks(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly pairs: readonly DeferredPrinterFallback[];
  },
): Promise<DeferredPrinterFallback[]> {
  const t = edgePrinters;
  // A retired printer is not a usable fallback: it stays unresolved.
  const parentIds = [...new Set(input.pairs.map((pair) => pair.parentId))];
  const known = new Set(
    parentIds.length === 0
      ? []
      : (
          await tx
            .select({ id: t.id })
            .from(t)
            .where(
              and(
                eq(t.tenantId, input.tenantId),
                inArray(t.id, parentIds),
                isNull(t.retiredAt),
              ),
            )
        ).map((row) => row.id),
  );
  const open = input.pairs.filter(
    (pair) => !known.has(pair.parentId) && pair.parentId !== pair.id,
  );
  if (open.length === 0) return [];
  const rows = await tx
    .select({
      id: t.id,
      syncTxid: t.syncTxid,
      fallbackPrinterId: t.fallbackPrinterId,
    })
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
      row.fallbackPrinterId === null &&
      BigInt(row.syncTxid) === BigInt(pair.syncTxid)
    );
  });
}

/**
 * Pass after the printers stream was read: sets the fallback that was written
 * null while its target was missing, now that the target exists locally (same
 * outlet). Only a printer still at the version (`sync_txid`) of the deferred
 * record and still without fallback is touched (a newer record wins). Returns
 * rows repaired.
 */
export async function repairPrinterFallbacks(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly pairs: readonly DeferredPrinterFallback[];
  },
): Promise<number> {
  await lockCatalogStream(tx, input.tenantId, "printers");
  const t = edgePrinters;
  let repaired = 0;
  for (const pair of input.pairs) {
    if (pair.parentId === pair.id) continue;
    const rows = await tx
      .update(t)
      .set({ fallbackPrinterId: pair.parentId })
      .where(
        and(
          eq(t.tenantId, input.tenantId),
          eq(t.id, pair.id),
          isNull(t.fallbackPrinterId),
          eq(t.syncTxid, pair.syncTxid),
          sql`EXISTS (SELECT 1 FROM edge_printers fb WHERE fb.tenant_id = ${t.tenantId} AND fb.outlet_id = ${t.outletId} AND fb.id = ${pair.parentId}::uuid AND fb.retired_at IS NULL)`,
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
    case "promotions": {
      const t = promotions;
      const parsed = parseRecords(
        "promotions",
        tenantId,
        input.records,
        (r) => r.id,
      );
      for (const record of parsed) {
        await requirePromotionOutlet(tx, record.outletId);
        if (
          record.outletOverrides.some(
            (override) =>
              override.outletId.toLowerCase() !== record.outletId.toLowerCase(),
          )
        )
          refuse("Catalog promotion switch belongs to another outlet.");
      }
      let deleted = 0;
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (r) => r.id),
        {
          write: async (r) => {
            const values = {
              tenantId,
              name: r.name,
              description: r.description,
              status: r.status,
              // Never the real hash: the stream carries only the irreversible ref.
              codeHash: r.codeRef,
              voucherRequired: r.voucherRequired,
              startsAt: date(r.startsAt),
              endsAt: dateOrNull(r.endsAt),
              conditions: r.conditions,
              benefit: r.benefit,
              stackGroup: r.stackGroup,
              stackable: r.stackable,
              priority: r.priority,
              quotaTotal: r.quotaTotal,
              quotaPerCustomer: r.quotaPerCustomer,
              budgetIdr: r.budgetIdr,
              outletScope: r.outletScope,
              createdBy: userIdOrNull(r.createdBy),
              updatedBy: userIdOrNull(r.updatedBy),
              createdAt: date(r.createdAt),
              updatedAt: date(r.updatedAt),
              syncTxid: r.syncTxid,
            };
            const written = await tx
              .insert(t)
              .values({ id: r.id, ...values, usesTotal: 0, spentIdr: idr(0) })
              .onConflictDoUpdate({
                target: t.id,
                // Counters belong to this edge's financial applications. A
                // catalog import must never reset or replay consumption. The
                // cloud may lower a quota or budget below what this edge
                // already used offline: store max(cloud, local) so the
                // `uses_total <= quota_total` / `spent_idr <= budget_idr`
                // constraints never block the sync, and the exhausted promo
                // stays unusable (an unlimited cloud value stays unlimited).
                set: {
                  ...values,
                  quotaTotal: sql`CASE WHEN excluded.quota_total IS NULL THEN NULL ELSE GREATEST(excluded.quota_total, ${t.usesTotal}) END`,
                  budgetIdr: sql`CASE WHEN excluded.budget_idr IS NULL THEN NULL ELSE GREATEST(excluded.budget_idr, ${t.spentIdr}) END`,
                },
                setWhere: and(eq(t.tenantId, tenantId), olderThanExcluded(t)),
              })
              .returning({ id: t.id });
            if (written.length === 0) return false;

            const removed = await tx
              .delete(promotionOutlets)
              .where(
                and(
                  eq(promotionOutlets.tenantId, tenantId),
                  eq(promotionOutlets.promotionId, r.id),
                  eq(
                    promotionOutlets.outletId,
                    outletIdSchema.parse(r.outletId),
                  ),
                ),
              )
              .returning({ outletId: promotionOutlets.outletId });
            deleted += removed.length;
            for (const override of r.outletOverrides)
              await tx.insert(promotionOutlets).values({
                tenantId,
                promotionId: r.id,
                outletId: outletIdSchema.parse(override.outletId),
                enabled: override.enabled,
                updatedBy: userIdOrNull(override.updatedBy),
                updatedAt: date(override.updatedAt),
              });

            // The tenant policy has its own version: a late page for another
            // promotion must not restore an older, more permissive policy.
            // No settings means the restrictive default, persisted as a
            // versioned tombstone so an older policy cannot be resurrected.
            const settings =
              r.stackingSettings === null
                ? {
                    stackingPolicy: defaultPromoStackingPolicy,
                    updatedBy: null,
                    updatedAt: date(r.updatedAt),
                    syncTxid: r.syncTxid,
                  }
                : {
                    stackingPolicy: r.stackingSettings.stackingPolicy,
                    updatedBy: userIdOrNull(r.stackingSettings.updatedBy),
                    updatedAt: date(r.stackingSettings.updatedAt),
                    syncTxid: r.stackingSettings.syncTxid,
                  };
            await tx
              .insert(promoSettings)
              .values({ tenantId, ...settings })
              .onConflictDoUpdate({
                target: promoSettings.tenantId,
                set: settings,
                setWhere: olderThanExcluded(promoSettings),
              });
            return true;
          },
        },
      );
      return tally(applied, parsed.length, { deleted });
    }

    case "vouchers": {
      const t = edgeVoucherCatalog;
      const parsed = parseRecords(
        "vouchers",
        tenantId,
        input.records,
        (r) => r.id,
      );
      const applied = await applyOrdered(
        tx,
        t,
        tenantId,
        inApplyOrder(parsed, (r) => r.id),
        {
          write: async (r) => {
            // This is read-only catalog metadata, never an independently
            // redeemable voucher. Preserve the holder and every cloud field
            // without manufacturing customer records or unbinding the code.
            const values = { tenantId, payload: r, syncTxid: r.syncTxid };
            const written = await tx
              .insert(t)
              .values({ id: r.id, ...values })
              .onConflictDoUpdate({
                target: t.id,
                set: values,
                setWhere: and(eq(t.tenantId, tenantId), olderThanExcluded(t)),
              })
              .returning({ id: t.id });
            return written.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
    }

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

    case "printers": {
      const parsed = parseRecords(
        "printers",
        tenantId,
        input.records,
        (r) => r.id,
      );
      return applyPrinters(tx, tenantId, parsed);
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
              tenantId,
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
      requireStations(parsed, stationIds);
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
              stationId: r.stationId,
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
            return rows.length > 0;
          },
        },
      );
      return tally(applied, parsed.length);
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
      requireStations(parsed, stationIds);
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
              stationId: r.stationId,
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

/**
 * `printers` (legend-fbf4v). Live records are upserted first (oldest first),
 * deletion records last, so a printer that stops being another's fallback in
 * the same page is released before it is removed. The edge-measured runtime
 * state (`status`, `last_seen_at`, `offline_since`) is never written: a cloud
 * update keeps what the print agent measured. The fallback link is written in a
 * second pass, once every printer of the page exists; a fallback this edge does
 * not have yet is stored as null (counted in `nulledRefs`: a printer without
 * fallback still prints) and reported in `deferredFallbacks`, so the puller
 * can persist it and run `repairPrinterFallbacks` once the target arrives. A deletion removes the printer, but one that has
 * print jobs here (the jobs are evidence and point at it) stays with
 * `retired_at` set (edge-owned, never in the cloud record); the print store no
 * longer lists it. A live record with the same id clears `retired_at`.
 * The deletion version is durable (legend-3k41y): a kept row takes it as its
 * `sync_txid`, a removed one leaves it in `edge_printer_delete_versions`, so a
 * live record with a version at or below it (HTTP or event) never brings the
 * printer back; only a newer one does.
 */
async function applyPrinters(
  tx: Tx,
  tenantId: TenantId,
  parsed: Parsed<"printers">,
): Promise<CatalogApplyResult> {
  const t = edgePrinters;
  const live = inApplyOrder(
    parsed.filter((r) => r.deletedAt === null),
    (x) => x.id,
  );
  const gone = inApplyOrder(
    parsed.filter((r) => r.deletedAt !== null),
    (x) => x.id,
  );
  const written: { id: string; fallback: string; syncTxid: string }[] = [];
  let deleted = 0;
  let applied = await applyOrdered(tx, t, tenantId, live, {
    write: async (r) => {
      if (!("label" in r)) return false;
      const values = {
        tenantId,
        outletId: outletIdSchema.parse(r.outletId),
        label: r.label,
        role: r.role,
        stationId: r.stationId,
        transport: r.transport,
        host: r.host,
        port: r.port,
        devicePath: r.devicePath,
        paperWidth: r.paperWidth,
        // Second pass (below): the target may be later in this page.
        fallbackPrinterId: null,
        // A live cloud record brings a retired printer back.
        retiredAt: null,
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt),
        syncTxid: r.syncTxid,
      };
      // A deleted printer stays deleted for a version at or below its deletion.
      const barred = await tx
        .select({ id: edgePrinterDeleteVersions.printerId })
        .from(edgePrinterDeleteVersions)
        .where(
          and(
            eq(edgePrinterDeleteVersions.tenantId, tenantId),
            eq(edgePrinterDeleteVersions.printerId, r.id),
            sql`${edgePrinterDeleteVersions.version} >= ${r.syncTxid}::bigint`,
          ),
        );
      if (barred.length > 0) return false;
      const rows = await tx
        .insert(t)
        .values({ id: r.id, ...values })
        .onConflictDoUpdate({
          target: t.id,
          set: values,
          setWhere: and(eq(t.tenantId, tenantId), olderThanExcluded(t)),
        })
        .returning({ id: t.id });
      if (rows.length === 0) return false;
      if (r.fallbackPrinterId !== null)
        written.push({
          id: r.id,
          fallback: r.fallbackPrinterId,
          syncTxid: r.syncTxid,
        });
      return true;
    },
  });
  let nulledRefs = 0;
  const deferredFallbacks: DeferredPrinterFallback[] = [];
  for (const link of written) {
    const linked = await tx
      .update(t)
      .set({ fallbackPrinterId: link.fallback })
      .where(
        and(
          eq(t.tenantId, tenantId),
          eq(t.id, link.id),
          // Only the write that put this record there (a newer one wins).
          sql`${t.syncTxid} = ${link.syncTxid}::bigint`,
          sql`EXISTS (SELECT 1 FROM edge_printers fb WHERE fb.tenant_id = ${t.tenantId} AND fb.outlet_id = ${t.outletId} AND fb.id = ${link.fallback}::uuid AND fb.retired_at IS NULL)`,
        ),
      )
      .returning({ id: t.id });
    if (linked.length === 0) {
      nulledRefs += 1;
      // Whether the target is missing or a newer write won, the repair only
      // completes this very version and only when the target exists.
      deferredFallbacks.push({
        id: link.id,
        parentId: link.fallback,
        syncTxid: link.syncTxid,
      });
    }
  }
  applied += await applyOrdered(tx, t, tenantId, gone, {
    write: async (r) => {
      const outletId = outletIdSchema.parse(r.outletId);
      const hasJobs = sql`EXISTS (SELECT 1 FROM ${edgePrintJobs} j WHERE j.tenant_id = ${t.tenantId} AND j.outlet_id = ${t.outletId} AND (j.printer_id = ${t.id} OR j.original_printer_id = ${t.id}))`;
      const version = BigInt(r.syncTxid);
      // Whatever happens to the row, the deletion version outlives it.
      const remember = () =>
        tx
          .insert(edgePrinterDeleteVersions)
          .values({ tenantId, outletId, printerId: r.id, version })
          .onConflictDoUpdate({
            target: [
              edgePrinterDeleteVersions.tenantId,
              edgePrinterDeleteVersions.printerId,
            ],
            set: {
              version: sql`GREATEST(${edgePrinterDeleteVersions.version}, excluded.version)`,
            },
          });
      const [current] = await tx
        .select({ syncTxid: t.syncTxid })
        .from(t)
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.outletId, outletId),
            eq(t.id, r.id),
          ),
        );
      if (current === undefined) {
        // Nothing local to remove, but an older live record must not land later.
        await remember();
        return false;
      }
      // A row at the tombstone's version or newer wins (also a replayed tombstone).
      if (BigInt(current.syncTxid) >= version) return false;
      await tx
        .update(t)
        .set({ fallbackPrinterId: null })
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.outletId, outletId),
            eq(t.fallbackPrinterId, r.id),
          ),
        );
      // `hasJobs` stays in a WHERE (a select list would drop the table qualifier).
      const withJobs = await tx
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.outletId, outletId),
            eq(t.id, r.id),
            hasJobs,
          ),
        );
      if (withJobs.length > 0) {
        // The jobs are evidence and point at it: keep the row, take it out of use.
        await tx
          .update(t)
          .set({
            retiredAt: sql`COALESCE(${t.retiredAt}, now())`,
            // The deletion version, so an older live record stays refused.
            syncTxid: r.syncTxid,
          })
          .where(
            and(
              eq(t.tenantId, tenantId),
              eq(t.outletId, outletId),
              eq(t.id, r.id),
            ),
          );
        return true;
      }
      await tx
        .delete(t)
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.outletId, outletId),
            eq(t.id, r.id),
          ),
        );
      await remember();
      deleted += 1;
      return true;
    },
  });
  return tally(applied, parsed.length, {
    deleted,
    nulledRefs,
    deferredFallbacks,
  });
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
        // A deleted list keeps no price at all: whatever items the record
        // carries, the local items go and none is written (a price must never
        // stay readable under a deleted list).
        const items = r.deletedAt === null ? r.items : [];
        const ids = items.map((item) => item.id);
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
        for (const item of items) {
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
  // output_item_id: inventory items arrive through their own stream; one that
  // is not local yet is transient (the page is refused, the checkpoint stays).
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
    if (outputIds.some((id) => !knownOutputs.has(id)))
      throw new CatalogMissingRefError();
  }
  // brand_id: recipes of every brand of the tenant arrive, but only the
  // credential's brand is local from bootstrap; the others come with the master
  // snapshot. A brand not local yet is transient, not a permanent refusal.
  const brandIds = [...new Set(parsed.map((r) => r.brandId))];
  if (brandIds.length > 0) {
    const rows = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.tenantId, tenantId), inArray(brands.id, brandIds)));
    const knownBrands = new Set(rows.map((row) => row.id));
    if (brandIds.some((id) => !knownBrands.has(id)))
      throw new CatalogMissingRefError();
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
        const updatedBy = knownAuthors.has(r.updatedBy) ? r.updatedBy : null;
        const values = {
          tenantId,
          brandId: r.brandId,
          name: r.name,
          outputItemId: r.outputItemId,
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
