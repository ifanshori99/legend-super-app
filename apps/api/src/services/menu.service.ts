// Menu back-office services (bead legend-lmk; PRD v1.7 §3 F8 "Master Menu &
// Harga", §6 C menu tables). Categories, stations, items, variants, modifier
// groups/modifiers, combos and item↔group links.
//
// Every function takes the server-minted ScopedTenantContext and runs inside
// `withTenant`, so Postgres RLS applies (`app.tenant_id`/`app.outlet_ids`) on
// top of explicit tenant filters. The tenant never comes from the request
// (TEN-02). Each mutating function re-checks the RBAC permission against the
// target brand/outlet inside the same transaction (service-layer authority,
// not only the route middleware), and outlet-owned records assert the caller's
// outlet reach (TEN-03).
//
// Brand-owned records (categories, items, variants, modifier groups, combos)
// default their brand to the domain-pinned brand; an unpinned tenant with more
// than one brand must name one (the contract's optional `brandId`).
//
// Writes that change master data append an event through the transactional
// outbox in the same transaction (`menu.updated`, `menu_item.updated`). The
// edge down-sync (WS-02) consumes them; a brand/outlet-scoped caller emits the
// event per reachable outlet because the outbox refuses tenant-wide events
// from a non-tenant scope.

import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  categorySchema,
  comboSchema,
  menuItemAdminSchema,
  menuItemSchema,
  menuItemUpdatedEvent,
  menuUpdatedEvent,
  modifierGroupSchema,
  modifierSchema,
  stationSchema,
  variantSchema,
  type Category,
  type Combo,
  type MenuItemAdmin,
  type Modifier,
  type ModifierGroup,
  type Station,
  type Variant,
} from "@starter/shared/menu";
import {
  comboComponents,
  combos,
  coreStorageObjects,
  itemAvailability,
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifiers,
  modifierGroups,
  outlets,
  priceListItems,
  stations,
} from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  MENU_ITEM_PERMISSION,
  MENU_VIEW_PERMISSION,
  appendMenuEvent,
  assertAnyPermission,
  assertBrandPermission,
  assertBrandReadPermission,
  assertOutletPermission,
  assertPermission,
  cursorOf,
  keysetCondition,
  likePattern,
  loadMediaUrls,
  noMediaUrls,
  pageOf,
  readBrandFilter,
  resolveBrand,
  resolveOutlet,
  scopedOutletIds,
  type MenuMediaUrls,
  type Tx,
} from "./menu-internals";

export type { MenuMediaUrls } from "./menu-internals";

// ---------------------------------------------------------------- DTOs

function toCategory(row: typeof menuCategories.$inferSelect): Category {
  return categorySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
  });
}

function toStation(row: typeof stations.$inferSelect): Station {
  return stationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    type: row.type,
    printerDeviceId: row.printerDeviceId,
    targetSeconds: row.targetSeconds,
  });
}

function toMenuItem(
  row: typeof menuItems.$inferSelect,
  mediaUrl: string | null,
): MenuItemAdmin {
  const item = menuItemSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    categoryId: row.categoryId,
    name: row.name,
    description: row.description,
    type: row.type,
    stationId: row.stationId,
    course: row.course,
    recipeId: row.recipeId,
    taxRuleId: row.taxRuleId,
    labels: row.labels,
    allergens: row.allergens,
    mediaId: row.mediaId,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  });
  return menuItemAdminSchema.parse({ ...item, mediaUrl });
}

function toVariant(row: typeof itemVariants.$inferSelect): Variant {
  return variantSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    menuItemId: row.menuItemId,
    name: row.name,
    recipeId: row.recipeId,
  });
}

function toModifierGroup(
  row: typeof modifierGroups.$inferSelect,
): ModifierGroup {
  return modifierGroupSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    minSelect: row.minSelect,
    maxSelect: row.maxSelect,
  });
}

function toModifier(row: typeof modifiers.$inferSelect): Modifier {
  return modifierSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    groupId: row.groupId,
    name: row.name,
    priceIdr: row.priceIdr,
    recipeId: row.recipeId,
    stationId: row.stationId,
  });
}

function toCombo(
  row: typeof combos.$inferSelect,
  components: (typeof comboComponents.$inferSelect)[],
): Combo {
  return comboSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    comboItemId: row.comboItemId,
    components: components.map((component) => ({
      menuItemId: component.menuItemId,
      options: component.options,
      revenueAllocationBp: component.revenueAllocationBp,
    })),
  });
}

// ================================================================ categories

export async function listCategories(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { brandId?: string; search?: string; cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: Category[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const brandIds = await readBrandFilter(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      query.brandId,
      now,
    );
    const cursor = cursorOf(query);
    const where = and(
      eq(menuCategories.tenantId, context.tenant.tenantId),
      isNull(menuCategories.deletedAt),
      brandIds !== null ? inArray(menuCategories.brandId, brandIds) : undefined,
      query.search
        ? ilike(menuCategories.name, likePattern(query.search))
        : undefined,
      cursor
        ? keysetCondition([menuCategories.sortOrder, menuCategories.id], cursor)
        : undefined,
    );
    const rows = await tx
      .select()
      .from(menuCategories)
      .where(where)
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.id))
      .limit(query.limit + 1);
    return pageOf(
      rows,
      query.limit,
      (row) => [row.sortOrder, row.id],
      toCategory,
    );
  });
}

export async function createCategory(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    brandId?: string;
    name: string;
    parentId?: string | null;
    sortOrder?: number;
  },
  now = new Date(),
): Promise<Category> {
  return withTenant(db, context, async (tx) => {
    const brandId = await resolveBrand(tx, context, input.brandId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      brandId,
      now,
    );
    if (input.parentId)
      await requireCategory(tx, context, input.parentId, brandId);
    const sortOrder =
      input.sortOrder ?? (await nextCategorySortOrder(tx, context, brandId));
    const [row] = await tx
      .insert(menuCategories)
      .values({
        tenantId: context.tenant.tenantId,
        brandId,
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder,
      })
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "category", entityId: row.id, operation: "created" },
      now,
    });
    return toCategory(row);
  });
}

async function requireCategory(
  tx: Tx,
  context: ScopedTenantContext,
  categoryId: string,
  brandId?: string,
): Promise<typeof menuCategories.$inferSelect> {
  const [row] = await tx
    .select()
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, context.tenant.tenantId),
        eq(menuCategories.id, categoryId),
        isNull(menuCategories.deletedAt),
        brandId !== undefined ? eq(menuCategories.brandId, brandId) : undefined,
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Kategori tidak ditemukan.");
  return row;
}

export async function updateCategory(
  context: ScopedTenantContext,
  actorUserId: string,
  categoryId: string,
  input: {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
  },
  now = new Date(),
): Promise<Category> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireCategory(tx, context, categoryId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.brandId,
      now,
    );
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === categoryId)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Kategori tidak boleh menjadi induknya sendiri.",
        );
      await requireCategory(tx, context, input.parentId, existing.brandId);
    }
    const [row] = await tx
      .update(menuCategories)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(menuCategories.tenantId, context.tenant.tenantId),
          eq(menuCategories.id, categoryId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "category", entityId: row.id, operation: "updated" },
      now,
    });
    return toCategory(row);
  });
}

export async function deleteCategory(
  context: ScopedTenantContext,
  actorUserId: string,
  categoryId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requireCategory(tx, context, categoryId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.brandId,
      now,
    );
    const [child] = await tx
      .select({ id: menuCategories.id })
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.tenantId, context.tenant.tenantId),
          eq(menuCategories.parentId, categoryId),
          isNull(menuCategories.deletedAt),
        ),
      )
      .limit(1);
    if (child)
      throw new HttpError(
        409,
        "CONFLICT",
        "Kategori masih memiliki subkategori.",
      );
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.categoryId, categoryId),
          isNull(menuItems.deletedAt),
        ),
      )
      .limit(1);
    if (item)
      throw new HttpError(
        409,
        "CONFLICT",
        "Kategori masih memiliki item menu.",
      );
    await tx
      .update(menuCategories)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(menuCategories.tenantId, context.tenant.tenantId),
          eq(menuCategories.id, categoryId),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: categoryId,
      actorUserId,
      payload: {
        entity: "category",
        entityId: categoryId,
        operation: "deleted",
      },
      now,
    });
  });
}

/** Display order (PRD §8 "urutan tampil"): the full ordered id list. */
export async function reorderCategories(
  context: ScopedTenantContext,
  actorUserId: string,
  orderedIds: readonly string[],
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.tenantId, context.tenant.tenantId),
          inArray(menuCategories.id, [...orderedIds]),
          isNull(menuCategories.deletedAt),
        ),
      );
    if (rows.length !== orderedIds.length)
      throw new CoreError("NOT_FOUND", "Kategori tidak ditemukan.");
    const brandIds = new Set(rows.map((row) => row.brandId));
    if (brandIds.size !== 1)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Urutan hanya untuk kategori dari satu brand.",
      );
    const [brandId] = [...brandIds];
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      brandId,
      now,
    );
    for (const [index, id] of orderedIds.entries()) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || row.sortOrder === index) continue;
      await tx
        .update(menuCategories)
        .set({ sortOrder: index, updatedAt: now })
        .where(
          and(
            eq(menuCategories.tenantId, context.tenant.tenantId),
            eq(menuCategories.id, id),
          ),
        );
      await appendMenuEvent(tx, context, menuUpdatedEvent, {
        aggregateId: id,
        actorUserId,
        payload: { entity: "category", entityId: id, operation: "updated" },
        now,
      });
    }
  });
}

// ================================================================ stations

export async function listStations(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { outletId?: string; cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: Station[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const scope = scopedOutletIds(context, query.outletId);
    if (scope.kind === "all")
      await assertPermission(
        tx,
        context,
        actorUserId,
        MENU_VIEW_PERMISSION,
        { type: "tenant" },
        now,
      );
    else
      for (const outletId of scope.outletIds)
        await assertOutletPermission(
          tx,
          context,
          actorUserId,
          MENU_VIEW_PERMISSION,
          outletId,
          now,
        );
    const cursor = cursorOf(query);
    const rows = await tx
      .select()
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          isNull(stations.deletedAt),
          scope.kind === "outlets"
            ? inArray(stations.outletId, [...scope.outletIds])
            : undefined,
          cursor
            ? keysetCondition([stations.name, stations.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(stations.name), asc(stations.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit, (row) => [row.name, row.id], toStation);
  });
}

export async function createStation(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    outletId?: string;
    name: string;
    type: string;
    printerDeviceId?: string | null;
    targetSeconds?: number | null;
  },
  now = new Date(),
): Promise<Station> {
  return withTenant(db, context, async (tx) => {
    const outletId = await resolveOutlet(tx, context, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      outletId,
      now,
    );
    const [row] = await tx
      .insert(stations)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        name: input.name,
        type: input.type,
        printerDeviceId: input.printerDeviceId ?? null,
        targetSeconds: input.targetSeconds ?? null,
      })
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "station", entityId: row.id, operation: "created" },
      now,
    });
    return toStation(row);
  });
}

async function requireStation(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
): Promise<typeof stations.$inferSelect> {
  const [row] = await tx
    .select()
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.id, stationId),
        isNull(stations.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Stasiun tidak ditemukan.");
  return row;
}

export async function updateStation(
  context: ScopedTenantContext,
  actorUserId: string,
  stationId: string,
  input: {
    name?: string;
    type?: string;
    printerDeviceId?: string | null;
    targetSeconds?: number | null;
  },
  now = new Date(),
): Promise<Station> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireStation(tx, context, stationId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.outletId,
      now,
    );
    const [row] = await tx
      .update(stations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.printerDeviceId !== undefined
          ? { printerDeviceId: input.printerDeviceId }
          : {}),
        ...(input.targetSeconds !== undefined
          ? { targetSeconds: input.targetSeconds }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.id, stationId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "station", entityId: row.id, operation: "updated" },
      now,
    });
    return toStation(row);
  });
}

export async function deleteStation(
  context: ScopedTenantContext,
  actorUserId: string,
  stationId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requireStation(tx, context, stationId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.outletId,
      now,
    );
    const [usedItem] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.stationId, stationId),
          isNull(menuItems.deletedAt),
        ),
      )
      .limit(1);
    const [usedModifier] = await tx
      .select({ id: modifiers.id })
      .from(modifiers)
      .where(
        and(
          eq(modifiers.tenantId, context.tenant.tenantId),
          eq(modifiers.stationId, stationId),
          isNull(modifiers.deletedAt),
        ),
      )
      .limit(1);
    if (usedItem || usedModifier)
      throw new HttpError(
        409,
        "CONFLICT",
        "Stasiun masih dipakai item atau modifier.",
      );
    await tx
      .update(stations)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.id, stationId),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: stationId,
      actorUserId,
      payload: { entity: "station", entityId: stationId, operation: "deleted" },
      now,
    });
  });
}

// ================================================================ items

export async function listItems(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    brandId?: string;
    categoryId?: string;
    stationId?: string;
    search?: string;
    status?: "active" | "inactive";
    sort: "display" | "name" | "category";
    cursor?: string;
    limit: number;
  },
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<{
  data: MenuItemAdmin[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const brandIds = await readBrandFilter(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      query.brandId,
      now,
    );
    const cursor = cursorOf(query);
    const order =
      query.sort === "name"
        ? [asc(menuItems.name), asc(menuItems.id)]
        : query.sort === "category"
          ? [
              asc(menuItems.categoryId),
              asc(menuItems.sortOrder),
              asc(menuItems.id),
            ]
          : [asc(menuItems.sortOrder), asc(menuItems.id)];
    const sortColumns =
      query.sort === "name"
        ? [menuItems.name, menuItems.id]
        : query.sort === "category"
          ? [menuItems.categoryId, menuItems.sortOrder, menuItems.id]
          : [menuItems.sortOrder, menuItems.id];
    const rows = await tx
      .select()
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          isNull(menuItems.deletedAt),
          brandIds !== null ? inArray(menuItems.brandId, brandIds) : undefined,
          query.categoryId
            ? eq(menuItems.categoryId, query.categoryId)
            : undefined,
          query.stationId
            ? eq(menuItems.stationId, query.stationId)
            : undefined,
          query.status === "active"
            ? eq(menuItems.isActive, true)
            : query.status === "inactive"
              ? eq(menuItems.isActive, false)
              : undefined,
          query.search
            ? or(
                ilike(menuItems.name, likePattern(query.search)),
                ilike(menuItems.description, likePattern(query.search)),
              )
            : undefined,
          cursor ? keysetCondition(sortColumns, cursor) : undefined,
        ),
      )
      .orderBy(...order)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const mediaUrls = await loadMediaUrls(
      tx,
      context,
      rows.map((row) => row.mediaId).filter((id): id is string => id !== null),
      resolveMediaUrls,
    );
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        toMenuItem(
          row,
          row.mediaId ? (mediaUrls.get(row.mediaId) ?? null) : null,
        ),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                query.sort === "name"
                  ? [last.name, last.id]
                  : query.sort === "category"
                    ? [last.categoryId, last.sortOrder, last.id]
                    : [last.sortOrder, last.id],
              )
            : null,
      },
    };
  });
}

async function requireItem(
  tx: Tx,
  context: ScopedTenantContext,
  itemId: string,
): Promise<typeof menuItems.$inferSelect> {
  const [row] = await tx
    .select()
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        eq(menuItems.id, itemId),
        isNull(menuItems.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Item menu tidak ditemukan.");
  return row;
}

/**
 * Station validation for an item: the station must live in the same tenant and
 * belong to the item's brand (routing stays inside one brand).
 */
async function requireStationOfBrand(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
  brandId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: stations.id, brandId: outlets.brandId })
    .from(stations)
    .innerJoin(
      outlets,
      and(
        eq(outlets.tenantId, stations.tenantId),
        eq(outlets.id, stations.outletId),
      ),
    )
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.id, stationId),
        isNull(stations.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Stasiun tidak ditemukan.");
  if (row.brandId !== brandId)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Stasiun berada di brand lain.",
    );
}

async function requireMedia(
  tx: Tx,
  context: ScopedTenantContext,
  mediaId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: coreStorageObjects.id })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, context.tenant.tenantId),
        eq(coreStorageObjects.id, mediaId),
        eq(coreStorageObjects.purpose, "menu_photo"),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Foto tidak ditemukan.");
}

/** Rows every outlet of the brand starts with, so 86 can be set on day one. */
async function seedAvailability(
  tx: Tx,
  context: ScopedTenantContext,
  itemId: string,
  brandId: string,
  now: Date,
): Promise<void> {
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.brandId, brandId),
      ),
    );
  for (const outlet of rows) {
    // Only outlets the caller may touch; a brand-scoped caller reaches all of
    // them, an outlet-scoped caller only its own. RLS already limits the read.
    if (context.outletScope.kind === "outlets") {
      const reachable = context.outletScope.outletIds.some(
        (id) => id.toLowerCase() === outlet.id.toLowerCase(),
      );
      if (!reachable) continue;
    }
    await tx
      .insert(itemAvailability)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: outlet.id,
        menuItemId: itemId,
        schedule: [],
        status: "available",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

export async function getItem(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<MenuItemAdmin> {
  return withTenant(db, context, async (tx) => {
    const row = await requireItem(tx, context, itemId);
    await assertBrandReadPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      row.brandId,
      now,
    );
    const mediaUrls = row.mediaId
      ? await loadMediaUrls(tx, context, [row.mediaId], resolveMediaUrls)
      : new Map<string, string>();
    return toMenuItem(
      row,
      row.mediaId ? (mediaUrls.get(row.mediaId) ?? null) : null,
    );
  });
}

export async function createItem(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    brandId?: string;
    categoryId: string;
    name: string;
    description: string;
    type: "single" | "combo";
    stationId?: string | null;
    course?: string | null;
    recipeId?: string | null;
    taxRuleId?: string | null;
    labels: string[];
    allergens: string[];
    mediaId?: string | null;
    isActive: boolean;
    sortOrder?: number;
  },
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<MenuItemAdmin> {
  return withTenant(db, context, async (tx) => {
    const brandId = await resolveBrand(tx, context, input.brandId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      brandId,
      now,
    );
    await requireCategory(tx, context, input.categoryId, brandId);
    if (input.stationId)
      await requireStationOfBrand(tx, context, input.stationId, brandId);
    if (input.mediaId) await requireMedia(tx, context, input.mediaId);
    const sortOrder =
      input.sortOrder ??
      (await nextItemSortOrder(tx, context, input.categoryId));
    const [row] = await tx
      .insert(menuItems)
      .values({
        tenantId: context.tenant.tenantId,
        brandId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        type: input.type,
        stationId: input.stationId ?? null,
        course: input.course ?? null,
        recipeId: input.recipeId ?? null,
        taxRuleId: input.taxRuleId ?? null,
        labels: input.labels,
        allergens: input.allergens,
        mediaId: input.mediaId ?? null,
        isActive: input.isActive,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await seedAvailability(tx, context, row.id, brandId, now);
    await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        itemId: row.id,
        categoryId: row.categoryId,
        isActive: row.isActive,
        operation: "created",
      },
      now,
    });
    const mediaUrls = row.mediaId
      ? await loadMediaUrls(tx, context, [row.mediaId], resolveMediaUrls)
      : new Map<string, string>();
    return toMenuItem(
      row,
      row.mediaId ? (mediaUrls.get(row.mediaId) ?? null) : null,
    );
  });
}

export async function updateItem(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  input: {
    categoryId?: string;
    name?: string;
    description?: string;
    type?: "single" | "combo";
    stationId?: string | null;
    course?: string | null;
    recipeId?: string | null;
    taxRuleId?: string | null;
    labels?: string[];
    allergens?: string[];
    mediaId?: string | null;
    isActive?: boolean;
    sortOrder?: number;
  },
  now = new Date(),
  resolveMediaUrls: MenuMediaUrls = noMediaUrls,
): Promise<MenuItemAdmin> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireItem(tx, context, itemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.brandId,
      now,
    );
    if (input.categoryId !== undefined)
      await requireCategory(tx, context, input.categoryId, existing.brandId);
    if (input.stationId !== undefined && input.stationId !== null)
      await requireStationOfBrand(
        tx,
        context,
        input.stationId,
        existing.brandId,
      );
    if (input.mediaId !== undefined && input.mediaId !== null)
      await requireMedia(tx, context, input.mediaId);
    const [row] = await tx
      .update(menuItems)
      .set({
        ...(input.categoryId !== undefined
          ? { categoryId: input.categoryId }
          : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.stationId !== undefined
          ? { stationId: input.stationId }
          : {}),
        ...(input.course !== undefined ? { course: input.course } : {}),
        ...(input.recipeId !== undefined ? { recipeId: input.recipeId } : {}),
        ...(input.taxRuleId !== undefined
          ? { taxRuleId: input.taxRuleId }
          : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.allergens !== undefined
          ? { allergens: input.allergens }
          : {}),
        ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.id, itemId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        itemId: row.id,
        categoryId: row.categoryId,
        isActive: row.isActive,
        operation: "updated",
      },
      now,
    });
    const mediaUrls = row.mediaId
      ? await loadMediaUrls(tx, context, [row.mediaId], resolveMediaUrls)
      : new Map<string, string>();
    return toMenuItem(
      row,
      row.mediaId ? (mediaUrls.get(row.mediaId) ?? null) : null,
    );
  });
}

export async function deleteItem(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requireItem(tx, context, itemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.brandId,
      now,
    );
    const [component] = await tx
      .select({ id: comboComponents.id })
      .from(comboComponents)
      .innerJoin(
        combos,
        and(
          eq(combos.tenantId, comboComponents.tenantId),
          eq(combos.id, comboComponents.comboId),
        ),
      )
      .where(
        and(
          eq(comboComponents.tenantId, context.tenant.tenantId),
          eq(comboComponents.menuItemId, itemId),
          isNull(comboComponents.deletedAt),
          isNull(combos.deletedAt),
        ),
      )
      .limit(1);
    if (component)
      throw new HttpError(
        409,
        "CONFLICT",
        "Item masih dipakai sebagai komponen combo.",
      );
    await tx
      .update(menuItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.id, itemId),
        ),
      );
    await tx
      .update(itemVariants)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(itemVariants.tenantId, context.tenant.tenantId),
          eq(itemVariants.menuItemId, itemId),
          isNull(itemVariants.deletedAt),
        ),
      );
    await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
      aggregateId: itemId,
      actorUserId,
      payload: {
        itemId,
        categoryId: existing.categoryId,
        isActive: false,
        operation: "deleted",
      },
      now,
    });
  });
}

/** Display order inside one category: the full ordered id list. */
export async function reorderItems(
  context: ScopedTenantContext,
  actorUserId: string,
  orderedIds: readonly string[],
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          inArray(menuItems.id, [...orderedIds]),
          isNull(menuItems.deletedAt),
        ),
      );
    if (rows.length !== orderedIds.length)
      throw new CoreError("NOT_FOUND", "Item menu tidak ditemukan.");
    const categoryIds = new Set(rows.map((row) => row.categoryId));
    if (categoryIds.size !== 1)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Urutan hanya untuk item dari satu kategori.",
      );
    const [first] = rows;
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      first.brandId,
      now,
    );
    for (const [index, id] of orderedIds.entries()) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || row.sortOrder === index) continue;
      await tx
        .update(menuItems)
        .set({ sortOrder: index, updatedAt: now })
        .where(
          and(
            eq(menuItems.tenantId, context.tenant.tenantId),
            eq(menuItems.id, id),
          ),
        );
      await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
        aggregateId: id,
        actorUserId,
        payload: {
          itemId: id,
          categoryId: row.categoryId,
          isActive: row.isActive,
          operation: "updated",
        },
        now,
      });
    }
  });
}

export async function getItemModifierGroups(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  now = new Date(),
): Promise<{ groupIds: string[] }> {
  return withTenant(db, context, async (tx) => {
    const item = await requireItem(tx, context, itemId);
    await assertBrandReadPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      item.brandId,
      now,
    );
    const rows = await tx
      .select({ groupId: menuItemModifierGroups.groupId })
      .from(menuItemModifierGroups)
      .where(
        and(
          eq(menuItemModifierGroups.tenantId, context.tenant.tenantId),
          eq(menuItemModifierGroups.menuItemId, itemId),
          isNull(menuItemModifierGroups.deletedAt),
        ),
      )
      .orderBy(
        asc(menuItemModifierGroups.sortOrder),
        asc(menuItemModifierGroups.groupId),
      );
    return { groupIds: rows.map((row) => row.groupId) };
  });
}

export async function setItemModifierGroups(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  groupIds: readonly string[],
  now = new Date(),
): Promise<{ groupIds: string[] }> {
  return withTenant(db, context, async (tx) => {
    const item = await requireItem(tx, context, itemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      item.brandId,
      now,
    );
    const unique = [...new Set(groupIds)];
    if (unique.length !== groupIds.length)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Grup modifier tidak boleh duplikat.",
      );
    if (unique.length > 0) {
      const groups = await tx
        .select({ id: modifierGroups.id })
        .from(modifierGroups)
        .where(
          and(
            eq(modifierGroups.tenantId, context.tenant.tenantId),
            inArray(modifierGroups.id, unique),
            isNull(modifierGroups.deletedAt),
          ),
        );
      if (groups.length !== unique.length)
        throw new CoreError("NOT_FOUND", "Grup modifier tidak ditemukan.");
    }
    const existing = await tx
      .select()
      .from(menuItemModifierGroups)
      .where(
        and(
          eq(menuItemModifierGroups.tenantId, context.tenant.tenantId),
          eq(menuItemModifierGroups.menuItemId, itemId),
        ),
      );
    for (const row of existing) {
      const keep = unique.includes(row.groupId);
      if (!keep && row.deletedAt === null)
        await tx
          .update(menuItemModifierGroups)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(menuItemModifierGroups.tenantId, context.tenant.tenantId),
              eq(menuItemModifierGroups.menuItemId, itemId),
              eq(menuItemModifierGroups.groupId, row.groupId),
            ),
          );
    }
    for (const [index, groupId] of unique.entries()) {
      await tx
        .insert(menuItemModifierGroups)
        .values({
          tenantId: context.tenant.tenantId,
          menuItemId: itemId,
          groupId,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            menuItemModifierGroups.tenantId,
            menuItemModifierGroups.menuItemId,
            menuItemModifierGroups.groupId,
          ],
          set: { deletedAt: null, sortOrder: index, updatedAt: now },
        });
    }
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: itemId,
      actorUserId,
      payload: {
        entity: "item_group_link",
        entityId: itemId,
        operation: "updated",
      },
      now,
    });
    return { groupIds: unique };
  });
}

// ================================================================ variants

export async function listVariants(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  query: { cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: Variant[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const item = await requireItem(tx, context, itemId);
    await assertBrandReadPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      item.brandId,
      now,
    );
    const cursor = cursorOf(query);
    const rows = await tx
      .select()
      .from(itemVariants)
      .where(
        and(
          eq(itemVariants.tenantId, context.tenant.tenantId),
          eq(itemVariants.menuItemId, itemId),
          isNull(itemVariants.deletedAt),
          cursor
            ? keysetCondition([itemVariants.name, itemVariants.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(itemVariants.name), asc(itemVariants.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit, (row) => [row.name, row.id], toVariant);
  });
}

export async function createVariant(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  input: { name: string; recipeId?: string | null },
  now = new Date(),
): Promise<Variant> {
  return withTenant(db, context, async (tx) => {
    const item = await requireItem(tx, context, itemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      item.brandId,
      now,
    );
    const [row] = await tx
      .insert(itemVariants)
      .values({
        tenantId: context.tenant.tenantId,
        menuItemId: itemId,
        name: input.name,
        recipeId: input.recipeId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "variant", entityId: row.id, operation: "created" },
      now,
    });
    return toVariant(row);
  });
}

async function requireVariant(
  tx: Tx,
  context: ScopedTenantContext,
  variantId: string,
  itemId?: string,
): Promise<typeof itemVariants.$inferSelect> {
  const [row] = await tx
    .select()
    .from(itemVariants)
    .where(
      and(
        eq(itemVariants.tenantId, context.tenant.tenantId),
        eq(itemVariants.id, variantId),
        itemId !== undefined ? eq(itemVariants.menuItemId, itemId) : undefined,
        isNull(itemVariants.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Varian tidak ditemukan.");
  return row;
}

export async function updateVariant(
  context: ScopedTenantContext,
  actorUserId: string,
  variantId: string,
  input: { name?: string; recipeId?: string | null },
  now = new Date(),
): Promise<Variant> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireVariant(tx, context, variantId);
    const item = await requireItem(tx, context, existing.menuItemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      item.brandId,
      now,
    );
    const [row] = await tx
      .update(itemVariants)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.recipeId !== undefined ? { recipeId: input.recipeId } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(itemVariants.tenantId, context.tenant.tenantId),
          eq(itemVariants.id, variantId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "variant", entityId: row.id, operation: "updated" },
      now,
    });
    return toVariant(row);
  });
}

export async function deleteVariant(
  context: ScopedTenantContext,
  actorUserId: string,
  variantId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requireVariant(tx, context, variantId);
    const item = await requireItem(tx, context, existing.menuItemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      item.brandId,
      now,
    );
    const [priced] = await tx
      .select({ id: priceListItems.id })
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.variantId, variantId),
          isNull(priceListItems.deletedAt),
        ),
      )
      .limit(1);
    if (priced)
      throw new HttpError(
        409,
        "CONFLICT",
        "Varian masih dipakai di daftar harga.",
      );
    await tx
      .update(itemVariants)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(itemVariants.tenantId, context.tenant.tenantId),
          eq(itemVariants.id, variantId),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: variantId,
      actorUserId,
      payload: { entity: "variant", entityId: variantId, operation: "deleted" },
      now,
    });
  });
}

// ============================================================ modifier groups

export async function listModifierGroups(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { search?: string; cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: ModifierGroup[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      now,
    );
    const cursor = cursorOf(query);
    const rows = await tx
      .select()
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.tenantId, context.tenant.tenantId),
          isNull(modifierGroups.deletedAt),
          query.search
            ? ilike(modifierGroups.name, likePattern(query.search))
            : undefined,
          cursor
            ? keysetCondition([modifierGroups.name, modifierGroups.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(modifierGroups.name), asc(modifierGroups.id))
      .limit(query.limit + 1);
    return pageOf(
      rows,
      query.limit,
      (row) => [row.name, row.id],
      toModifierGroup,
    );
  });
}

async function requireModifierGroup(
  tx: Tx,
  context: ScopedTenantContext,
  groupId: string,
): Promise<typeof modifierGroups.$inferSelect> {
  const [row] = await tx
    .select()
    .from(modifierGroups)
    .where(
      and(
        eq(modifierGroups.tenantId, context.tenant.tenantId),
        eq(modifierGroups.id, groupId),
        isNull(modifierGroups.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Grup modifier tidak ditemukan.");
  return row;
}

export async function createModifierGroup(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { name: string; minSelect: number; maxSelect: number },
  now = new Date(),
): Promise<ModifierGroup> {
  return withTenant(db, context, async (tx) => {
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    const [row] = await tx
      .insert(modifierGroups)
      .values({
        tenantId: context.tenant.tenantId,
        name: input.name,
        minSelect: input.minSelect,
        maxSelect: input.maxSelect,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        entity: "modifier_group",
        entityId: row.id,
        operation: "created",
      },
      now,
    });
    return toModifierGroup(row);
  });
}

export async function updateModifierGroup(
  context: ScopedTenantContext,
  actorUserId: string,
  groupId: string,
  input: { name?: string; minSelect?: number; maxSelect?: number },
  now = new Date(),
): Promise<ModifierGroup> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireModifierGroup(tx, context, groupId);
    const minSelect = input.minSelect ?? existing.minSelect;
    const maxSelect = input.maxSelect ?? existing.maxSelect;
    if (minSelect > maxSelect)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Jumlah maksimum tidak boleh kurang dari minimum.",
      );
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    const [row] = await tx
      .update(modifierGroups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.minSelect !== undefined
          ? { minSelect: input.minSelect }
          : {}),
        ...(input.maxSelect !== undefined
          ? { maxSelect: input.maxSelect }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(modifierGroups.tenantId, context.tenant.tenantId),
          eq(modifierGroups.id, groupId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        entity: "modifier_group",
        entityId: row.id,
        operation: "updated",
      },
      now,
    });
    return toModifierGroup(row);
  });
}

export async function deleteModifierGroup(
  context: ScopedTenantContext,
  actorUserId: string,
  groupId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await requireModifierGroup(tx, context, groupId);
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    const [used] = await tx
      .select({ menuItemId: menuItemModifierGroups.menuItemId })
      .from(menuItemModifierGroups)
      .where(
        and(
          eq(menuItemModifierGroups.tenantId, context.tenant.tenantId),
          eq(menuItemModifierGroups.groupId, groupId),
          isNull(menuItemModifierGroups.deletedAt),
        ),
      )
      .limit(1);
    if (used)
      throw new HttpError(
        409,
        "CONFLICT",
        "Grup modifier masih dipakai item menu.",
      );
    await tx
      .update(modifierGroups)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(modifierGroups.tenantId, context.tenant.tenantId),
          eq(modifierGroups.id, groupId),
        ),
      );
    await tx
      .update(modifiers)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(modifiers.tenantId, context.tenant.tenantId),
          eq(modifiers.groupId, groupId),
          isNull(modifiers.deletedAt),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: groupId,
      actorUserId,
      payload: {
        entity: "modifier_group",
        entityId: groupId,
        operation: "deleted",
      },
      now,
    });
  });
}

// ================================================================ modifiers

export async function listModifiers(
  context: ScopedTenantContext,
  actorUserId: string,
  groupId: string,
  query: { cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: Modifier[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await requireModifierGroup(tx, context, groupId);
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      now,
    );
    const cursor = cursorOf(query);
    const rows = await tx
      .select()
      .from(modifiers)
      .where(
        and(
          eq(modifiers.tenantId, context.tenant.tenantId),
          eq(modifiers.groupId, groupId),
          isNull(modifiers.deletedAt),
          cursor
            ? keysetCondition([modifiers.name, modifiers.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(modifiers.name), asc(modifiers.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit, (row) => [row.name, row.id], toModifier);
  });
}

export async function createModifier(
  context: ScopedTenantContext,
  actorUserId: string,
  groupId: string,
  input: {
    name: string;
    priceIdr: number;
    recipeId?: string | null;
    stationId?: string | null;
  },
  now = new Date(),
): Promise<Modifier> {
  return withTenant(db, context, async (tx) => {
    await requireModifierGroup(tx, context, groupId);
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    if (input.stationId) {
      await requireStation(tx, context, input.stationId);
    }
    const [row] = await tx
      .insert(modifiers)
      .values({
        tenantId: context.tenant.tenantId,
        groupId,
        name: input.name,
        priceIdr: idr(input.priceIdr),
        recipeId: input.recipeId ?? null,
        stationId: input.stationId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "modifier", entityId: row.id, operation: "created" },
      now,
    });
    return toModifier(row);
  });
}

async function requireModifier(
  tx: Tx,
  context: ScopedTenantContext,
  modifierId: string,
): Promise<typeof modifiers.$inferSelect> {
  const [row] = await tx
    .select()
    .from(modifiers)
    .where(
      and(
        eq(modifiers.tenantId, context.tenant.tenantId),
        eq(modifiers.id, modifierId),
        isNull(modifiers.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Modifier tidak ditemukan.");
  return row;
}

export async function updateModifier(
  context: ScopedTenantContext,
  actorUserId: string,
  modifierId: string,
  input: {
    name?: string;
    priceIdr?: number;
    recipeId?: string | null;
    stationId?: string | null;
  },
  now = new Date(),
): Promise<Modifier> {
  return withTenant(db, context, async (tx) => {
    await requireModifier(tx, context, modifierId);
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    if (input.stationId !== undefined && input.stationId !== null)
      await requireStation(tx, context, input.stationId);
    const [row] = await tx
      .update(modifiers)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.priceIdr !== undefined
          ? { priceIdr: idr(input.priceIdr) }
          : {}),
        ...(input.recipeId !== undefined ? { recipeId: input.recipeId } : {}),
        ...(input.stationId !== undefined
          ? { stationId: input.stationId }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(modifiers.tenantId, context.tenant.tenantId),
          eq(modifiers.id, modifierId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "modifier", entityId: row.id, operation: "updated" },
      now,
    });
    return toModifier(row);
  });
}

export async function deleteModifier(
  context: ScopedTenantContext,
  actorUserId: string,
  modifierId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await requireModifier(tx, context, modifierId);
    await assertAnyPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    await tx
      .update(modifiers)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(modifiers.tenantId, context.tenant.tenantId),
          eq(modifiers.id, modifierId),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: modifierId,
      actorUserId,
      payload: {
        entity: "modifier",
        entityId: modifierId,
        operation: "deleted",
      },
      now,
    });
  });
}

// ================================================================ combos

async function loadComboComponents(
  tx: Tx,
  context: ScopedTenantContext,
  comboIds: readonly string[],
): Promise<Map<string, (typeof comboComponents.$inferSelect)[]>> {
  if (comboIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(comboComponents)
    .where(
      and(
        eq(comboComponents.tenantId, context.tenant.tenantId),
        inArray(comboComponents.comboId, [...comboIds]),
        isNull(comboComponents.deletedAt),
      ),
    )
    .orderBy(asc(comboComponents.createdAt), asc(comboComponents.id));
  const map = new Map<string, (typeof comboComponents.$inferSelect)[]>();
  for (const row of rows) {
    const list = map.get(row.comboId) ?? [];
    list.push(row);
    map.set(row.comboId, list);
  }
  return map;
}

export async function listCombos(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { search?: string; cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: Combo[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const brandIds = await readBrandFilter(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      undefined,
      now,
    );
    const cursor = cursorOf(query);
    const rows = await tx
      .select({ combo: combos, name: menuItems.name })
      .from(combos)
      .innerJoin(
        menuItems,
        and(
          eq(menuItems.tenantId, combos.tenantId),
          eq(menuItems.id, combos.comboItemId),
        ),
      )
      .where(
        and(
          eq(combos.tenantId, context.tenant.tenantId),
          isNull(combos.deletedAt),
          brandIds !== null ? inArray(menuItems.brandId, brandIds) : undefined,
          query.search
            ? ilike(menuItems.name, likePattern(query.search))
            : undefined,
          cursor
            ? keysetCondition([menuItems.name, combos.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(menuItems.name), asc(combos.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const components = await loadComboComponents(
      tx,
      context,
      page.map((row) => row.combo.id),
    );
    return {
      data: page.map((row) =>
        toCombo(row.combo, components.get(row.combo.id) ?? []),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && page.length > 0
            ? encodeCursor([page.at(-1)!.name, page.at(-1)!.combo.id])
            : null,
      },
    };
  });
}

async function requireCombo(
  tx: Tx,
  context: ScopedTenantContext,
  comboId: string,
): Promise<typeof combos.$inferSelect> {
  const [row] = await tx
    .select()
    .from(combos)
    .where(
      and(
        eq(combos.tenantId, context.tenant.tenantId),
        eq(combos.id, comboId),
        isNull(combos.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Combo tidak ditemukan.");
  return row;
}

async function validateComponents(
  tx: Tx,
  context: ScopedTenantContext,
  comboItemId: string,
  components: readonly {
    menuItemId: string;
    options: readonly string[];
    revenueAllocationBp: number;
  }[],
): Promise<void> {
  const total = components.reduce(
    (sum, component) => sum + component.revenueAllocationBp,
    0,
  );
  if (total !== 10_000)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Alokasi pendapatan harus berjumlah 100%.",
    );
  const ids = new Set<string>();
  for (const component of components) {
    if (component.menuItemId === comboItemId)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Combo tidak boleh memuat dirinya sendiri.",
      );
    if (ids.has(component.menuItemId))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Item komponen combo tidak boleh duplikat.",
      );
    ids.add(component.menuItemId);
  }
  const wanted = [
    ...new Set([
      ...components.map((component) => component.menuItemId),
      ...components.flatMap((component) => component.options),
    ]),
  ];
  if (wanted.length === 0) return;
  const rows = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        inArray(menuItems.id, wanted),
        isNull(menuItems.deletedAt),
      ),
    );
  if (rows.length !== wanted.length)
    throw new CoreError("NOT_FOUND", "Item komponen tidak ditemukan.");
}

export async function createCombo(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    comboItemId: string;
    components: {
      menuItemId: string;
      options: string[];
      revenueAllocationBp: number;
    }[];
  },
  now = new Date(),
): Promise<Combo> {
  return withTenant(db, context, async (tx) => {
    const comboItem = await requireItem(tx, context, input.comboItemId);
    if (comboItem.type !== "combo")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Item combo harus bertipe combo.",
      );
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      comboItem.brandId,
      now,
    );
    await validateComponents(tx, context, input.comboItemId, input.components);
    const [row] = await tx
      .insert(combos)
      .values({
        tenantId: context.tenant.tenantId,
        comboItemId: input.comboItemId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    for (const component of input.components) {
      await tx.insert(comboComponents).values({
        tenantId: context.tenant.tenantId,
        comboId: row.id,
        menuItemId: component.menuItemId,
        options: component.options,
        revenueAllocationBp: component.revenueAllocationBp,
        createdAt: now,
        updatedAt: now,
      });
    }
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "combo", entityId: row.id, operation: "created" },
      now,
    });
    return toCombo(
      row,
      await loadComboComponents(tx, context, [row.id]).then(
        (map) => map.get(row.id) ?? [],
      ),
    );
  });
}

export async function updateCombo(
  context: ScopedTenantContext,
  actorUserId: string,
  comboId: string,
  input: {
    components: {
      menuItemId: string;
      options: string[];
      revenueAllocationBp: number;
    }[];
  },
  now = new Date(),
): Promise<Combo> {
  return withTenant(db, context, async (tx) => {
    const existing = await requireCombo(tx, context, comboId);
    const comboItem = await requireItem(tx, context, existing.comboItemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      comboItem.brandId,
      now,
    );
    await validateComponents(
      tx,
      context,
      existing.comboItemId,
      input.components,
    );
    await tx
      .update(comboComponents)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(comboComponents.tenantId, context.tenant.tenantId),
          eq(comboComponents.comboId, comboId),
          isNull(comboComponents.deletedAt),
        ),
      );
    for (const component of input.components) {
      await tx.insert(comboComponents).values({
        tenantId: context.tenant.tenantId,
        comboId,
        menuItemId: component.menuItemId,
        options: component.options,
        revenueAllocationBp: component.revenueAllocationBp,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [row] = await tx
      .update(combos)
      .set({ updatedAt: now })
      .where(
        and(
          eq(combos.tenantId, context.tenant.tenantId),
          eq(combos.id, comboId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "combo", entityId: row.id, operation: "updated" },
      now,
    });
    return toCombo(
      row,
      await loadComboComponents(tx, context, [row.id]).then(
        (map) => map.get(row.id) ?? [],
      ),
    );
  });
}

export async function deleteCombo(
  context: ScopedTenantContext,
  actorUserId: string,
  comboId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requireCombo(tx, context, comboId);
    const comboItem = await requireItem(tx, context, existing.comboItemId);
    await assertBrandPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      comboItem.brandId,
      now,
    );
    await tx
      .update(comboComponents)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(comboComponents.tenantId, context.tenant.tenantId),
          eq(comboComponents.comboId, comboId),
          isNull(comboComponents.deletedAt),
        ),
      );
    await tx
      .update(combos)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(combos.tenantId, context.tenant.tenantId),
          eq(combos.id, comboId),
        ),
      );
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: comboId,
      actorUserId,
      payload: { entity: "combo", entityId: comboId, operation: "deleted" },
      now,
    });
  });
}

// ================================================================ sorting

/** Next display position at the end of a brand's categories. */
async function nextCategorySortOrder(
  tx: Tx,
  context: ScopedTenantContext,
  brandId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${menuCategories.sortOrder}), -1)`,
    })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, context.tenant.tenantId),
        eq(menuCategories.brandId, brandId),
        isNull(menuCategories.deletedAt),
      ),
    );
  return Number(row?.last ?? -1) + 1;
}

/** Next display position at the end of one category. */
async function nextItemSortOrder(
  tx: Tx,
  context: ScopedTenantContext,
  categoryId: string,
): Promise<number> {
  const [row] = await tx
    .select({ last: sql<number>`coalesce(max(${menuItems.sortOrder}), -1)` })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        eq(menuItems.categoryId, categoryId),
        isNull(menuItems.deletedAt),
      ),
    );
  return Number(row?.last ?? -1) + 1;
}
