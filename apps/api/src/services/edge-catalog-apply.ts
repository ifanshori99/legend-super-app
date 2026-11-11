// Catalog down-sync, edge side: apply one page of cloud records (bead
// legend-97p; PRD v1.7 §3 F8 Master Menu & Harga, §3 F16 Resep & BOM, §5 "cloud
// wins" for master data). The cloud export is services/edge-catalog-sync.ts;
// the page loop and the checkpoint are edge/catalog-puller.ts, which calls
// this inside the same transaction that moves the checkpoint.
//
// - Runs in the caller's transaction (`tx`): a failure anywhere rolls the whole
//   page back, so there is never a half-applied page.
// - Every record must be of `tenantId`; one bad record refuses the whole page.
// - Idempotent upsert by key (id; menu_item_modifier_groups: tenant, item,
//   group). Cloud wins: a record overwrites the local row, EXCEPT when the
//   local row carries a newer `updated_at` than the record (a replayed older
//   page, a rewound cursor or reversed order must never put an old price or a
//   revived row over a newer one). Equal timestamps: the record wins.
// - Tombstones: a record with `deletedAt` is stored as such (the edge reads
//   filter `deleted_at IS NULL`), also when the row was not local yet.
// - Money is copied as received: `priceIdr` is the integer rupiah, `quantity`
//   and `theoreticalCostIdr` the exact decimal string. No conversion.
// - Optional references the edge may not hold are stored as null, never
//   refused: menu_items / modifiers `station_id` (stations are not in the
//   catalog), recipes `output_item_id` (the edge has no inventory items; counted
//   in `nulledRefs`), menu_categories `parent_id` (a parent that is neither
//   local nor on the page yet: written null and reported in `deferredParents`
//   so the puller can run `repairCategoryParents` once the stream is read).
//   Required references (brand, category, price list, item, variant, recipe,
//   uom, ...) are never nulled: the foreign key refuses the page and the
//   checkpoint does not move. A price list item never loses its variant.
// - recipes.updated_by (a user the edge may not hold yet) is TRANSIENT: the
//   page is refused with `CatalogMissingRefError` (code CATALOG_MISSING_REF),
//   the checkpoint stays, a later pull succeeds once people are synced.
// - A recipe record carries its full `lines`; a price list record its full
//   `items`. Header and children are replaced in one go: the header is upserted
//   (same `updated_at` guard), then, only when it was applied, the local
//   children that are not in the record are deleted and the rest upserted. A
//   stale record (local header newer) touches no child, so two versions never
//   mix and a header never exists without its children.
// - Each (tenant, stream) apply takes a transaction advisory lock first, so two
//   concurrent pulls do not race on the same millisecond timestamp.
// - No audit, no outbox: this mirrors cloud state; an event would echo back.
import {
  catalogSyncRecordSchemas,
  type CatalogSyncRecordOf,
  type CatalogSyncStream,
  type MenuCategorySyncRecord,
} from "@starter/shared/edge";
import { CoreError, type TenantId } from "@starter/shared/core";
import { and, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { inventoryItems } from "../db/schema/inventory.ts";
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
  /** Records left alone: the local row is newer. */
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
  /** The record's version: the repair only completes that very write. */
  readonly updatedAt: Date;
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

/** Same excluded-row version as the incoming record: older local = overwritten. */
const excludedUpdatedAt = sql`excluded.updated_at`;

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

type Versioned = { readonly updatedAt: string };

/** Oldest first, so a later record of the same row lands last. */
function byVersion<T extends Versioned>(
  records: readonly T[],
  tie: (record: T) => string,
): T[] {
  return [...records].sort(
    (a, b) =>
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
      tie(a).localeCompare(tie(b)),
  );
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
 * Serializes applies of one (tenant, stream): two pulls running together must
 * not decide on the same millisecond timestamp at once. Held to commit.
 */
export async function lockCatalogStream(
  tx: Tx,
  tenantId: string,
  stream: CatalogSyncStream,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-catalog-sync:${tenantId}:${stream}`.toLowerCase()}, 0))`,
  );
}

/**
 * Pass after the menu_categories stream was read in full: sets the parent that
 * was written null while it was missing, now that it exists locally. Only a row
 * still at the version of the deferred record and still without parent is
 * touched (a newer record or a local change wins). Returns rows repaired.
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
          eq(t.updatedAt, pair.updatedAt),
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
      let applied = 0;
      const deferredParents: DeferredCategoryParent[] = [];
      for (const r of parentsFirst(byVersion(parsed, (x) => x.id))) {
        const parentId =
          r.parentId !== null &&
          (inPage.has(r.parentId) || known.has(r.parentId))
            ? r.parentId
            : null;
        if (r.parentId !== null && parentId === null)
          deferredParents.push({
            id: r.id,
            parentId: r.parentId,
            updatedAt: date(r.updatedAt),
          });
        const values = {
          tenantId: r.tenantId,
          brandId: r.brandId,
          name: r.name,
          parentId,
          sortOrder: r.sortOrder,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
          })
          .returning({ id: t.id });
        applied += rows.length;
      }
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
      let applied = 0;
      let nulledRefs = 0;
      for (const r of byVersion(parsed, (x) => x.id)) {
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
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
          })
          .returning({ id: t.id });
        applied += rows.length;
        if (
          rows.length > 0 &&
          r.stationId !== null &&
          !stationIds.has(r.stationId)
        )
          nulledRefs += 1;
      }
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
      let applied = 0;
      for (const r of byVersion(parsed, (x) => x.id)) {
        const values = {
          tenantId: r.tenantId,
          menuItemId: r.menuItemId,
          name: r.name,
          recipeId: r.recipeId,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
          })
          .returning({ id: t.id });
        applied += rows.length;
      }
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
      let applied = 0;
      for (const r of byVersion(parsed, (x) => x.id)) {
        const values = {
          tenantId: r.tenantId,
          name: r.name,
          minSelect: r.minSelect,
          maxSelect: r.maxSelect,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
          })
          .returning({ id: t.id });
        applied += rows.length;
      }
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
      let applied = 0;
      let nulledRefs = 0;
      for (const r of byVersion(parsed, (x) => x.id)) {
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
        };
        const rows = await tx
          .insert(t)
          .values({ id: r.id, ...values })
          .onConflictDoUpdate({
            target: t.id,
            set: values,
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
          })
          .returning({ id: t.id });
        applied += rows.length;
        if (
          rows.length > 0 &&
          r.stationId !== null &&
          !stationIds.has(r.stationId)
        )
          nulledRefs += 1;
      }
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
      for (const r of byVersion(
        parsed,
        (x) => `${x.menuItemId}:${x.groupId}`,
      )) {
        const values = {
          sortOrder: r.sortOrder,
          createdAt: date(r.createdAt),
          updatedAt: date(r.updatedAt),
          deletedAt: dateOrNull(r.deletedAt),
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
            setWhere: lte(t.updatedAt, excludedUpdatedAt),
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
  let applied = 0;
  let deleted = 0;
  for (const r of byVersion(parsed, (x) => x.id)) {
    const values = {
      tenantId: r.tenantId,
      outletId: r.outletId,
      channel: r.channel,
      effectiveFrom: r.effectiveFrom,
      createdAt: date(r.createdAt),
      updatedAt: date(r.updatedAt),
      deletedAt: dateOrNull(r.deletedAt),
    };
    const rows = await tx
      .insert(t)
      .values({ id: r.id, ...values })
      .onConflictDoUpdate({
        target: t.id,
        set: values,
        setWhere: lte(t.updatedAt, excludedUpdatedAt),
      })
      .returning({ id: t.id });
    applied += rows.length;
    // Header skipped (local newer): its items stay with that newer version.
    if (rows.length === 0) continue;
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
        .onConflictDoUpdate({ target: priceListItems.id, set: itemValues });
    }
  }
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

  // updated_by: a user the edge does not hold yet is transient (people
  // snapshot brings it): refuse the page so the checkpoint stays.
  const authors = [...new Set(parsed.map((r) => r.updatedBy))];
  if (authors.length > 0) {
    const rows = await tx
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, authors));
    const known = new Set(rows.map((row) => row.id));
    if (authors.some((id) => !known.has(id)))
      throw new CatalogMissingRefError();
  }
  // output_item_id: the edge may not hold inventory items. Permanent: null.
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

  let applied = 0;
  let deleted = 0;
  let nulledRefs = 0;
  for (const r of byVersion(parsed, (x) => x.id)) {
    const outputItemId =
      r.outputItemId !== null && knownOutputs.has(r.outputItemId)
        ? r.outputItemId
        : null;
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
      updatedBy: r.updatedBy,
      createdAt: date(r.createdAt),
      updatedAt: date(r.updatedAt),
    };
    const rows = await tx
      .insert(t)
      .values({ id: r.id, ...values })
      .onConflictDoUpdate({
        target: t.id,
        set: values,
        setWhere: lte(t.updatedAt, excludedUpdatedAt),
      })
      .returning({ id: t.id });
    applied += rows.length;
    // Header skipped (local newer): its lines stay with that newer version.
    if (rows.length === 0) continue;
    if (r.outputItemId !== null && outputItemId === null) nulledRefs += 1;
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
  }
  return tally(applied, parsed.length, { deleted, nulledRefs });
}
