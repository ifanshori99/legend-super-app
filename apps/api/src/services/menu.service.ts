// Menu back-office services (bead legend-lmk; PRD v1.7 §3 F8 "Master Menu &
// Harga", §6 C menu tables). Categories, stations, items, variants, modifier
// groups/modifiers, combos and item↔group links.
//
// Every function takes the server-minted ScopedTenantContext and runs inside
// `withTenant`, so Postgres RLS applies on top of explicit tenant filters:
// `app.tenant_id` on every menu table, and `app.outlet_ids` on the outlet-owned
// ones (stations, price_lists, item_availability; migration 0032, legend-tjey). The tenant never comes from the request
// (TEN-02). Each mutating function re-checks the RBAC permission against the
// target brand/outlet inside the same transaction (service-layer authority,
// not only the route middleware), and outlet-owned records assert the caller's
// outlet reach (TEN-03).
//
// Brand-owned records (categories, items, variants, combos) default their brand
// to the domain-pinned brand; an unpinned tenant with more than one brand must
// name one (the contract's optional `brandId`). Modifier groups and modifiers
// are tenant-shared (no brand column), so their writes need tenant/brand scope.
//
// Writes that change master data append an event through the transactional
// outbox in the same transaction (`menu.updated`, `menu_item.updated`). The
// edge down-sync (WS-02) consumes them, routed by the affected record: a
// brand-owned change reaches every outlet of its brand, outlet-owned data only
// its outlet, and tenant-shared data the whole tenant (or, for a narrower
// caller, every outlet it can address — the outbox refuses an outlet outside
// the caller's scope).

import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  idr,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  categorySchema,
  comboSchema,
  MENU_PHOTO_REQUIRED_MESSAGE,
  menuErrorHttpStatus,
  menuItemAdminSchema,
  menuItemPhotoMissing,
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
  devices,
  itemAvailability,
  itemVariants,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  modifiers,
  modifierGroups,
  outlets,
  priceListItems,
  priceLists,
  recipes,
  stations,
} from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { markHppStale } from "./hpp-invalidate";
import {
  MENU_ITEM_PERMISSION,
  MENU_PRICE_MANAGE_PERMISSION,
  MENU_VIEW_PERMISSION,
  appendMenuEvent,
  assertAnyPermission,
  assertBrandPermission,
  assertBrandReadPermission,
  assertOutletPermission,
  assertSharedMasterDataPermission,
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
import {
  assertStationPermission,
  permittedStationIds,
  stationScopeCondition,
} from "./station-access";

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
    updatedAt: row.updatedAt.toISOString(),
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
    stationType: row.stationType,
    course: row.course,
    recipeId: row.recipeId,
    taxRuleId: row.taxRuleId,
    labels: row.labels,
    allergens: row.allergens,
    mediaId: row.mediaId,
    isActive: row.isActive,
    isBreakfast: row.isBreakfast,
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
      affects: { kind: "brand", brandId },
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
      affects: { kind: "brand", brandId: existing.brandId },
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
      affects: { kind: "brand", brandId: existing.brandId },
      now,
    });
  });
}

/**
 * Display order (PRD §8 "urutan tampil"): id at index i gets sortOrder i.
 * Ids outside the list keep their sortOrder; unchanged rows emit no event.
 */
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
        affects: { kind: "brand", brandId },
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
    // TEN-03: a requested outlet outside the caller's reach is refused.
    const scope = scopedOutletIds(context, query.outletId);
    const cursor = cursorOf(query);
    // Station-bound resource: a KDS/floor grant that reaches this outlet for a
    // narrower station scope must only see its own station(s) (legend-fsb7).
    // `permittedStationIds` is the permission + scope check for the list too:
    // an outlet/brand/tenant grant reaches every station it contains, a
    // station grant only its own.
    const stationIds = await permittedStationIds(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      now,
    );
    // An empty reach becomes `false` in the filter: no rows (fail closed).
    const rows = await tx
      .select()
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          isNull(stations.deletedAt),
          stationScopeCondition(stations.id, stationIds),
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

/**
 * legend-e087: a station's printer must be an active printer device of the
 * station's own outlet and tenant. Unknown, other-outlet, other-tenant,
 * non-printer and revoked all give the same error (no existence oracle).
 */
async function assertStationPrinter(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  printerDeviceId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.tenantId, context.tenant.tenantId),
        eq(devices.outletId, outletIdSchema.parse(outletId)),
        eq(devices.id, printerDeviceId),
        eq(devices.type, "printer"),
        eq(devices.status, "active"),
        isNull(devices.revokedAt),
      ),
    )
    // Share lock: a concurrent revoke waits for this transaction, so it cannot
    // slip between the check and the station write.
    .for("share");
  if (!row)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Printer tidak valid untuk outlet ini.",
    );
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
    if (input.printerDeviceId)
      await assertStationPrinter(tx, context, outletId, input.printerDeviceId);
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
      affects: { kind: "outlet", outletId },
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
    expectedUpdatedAt?: string;
  },
  now = new Date(),
): Promise<Station> {
  // legend-4xai (Codex 159): a printer change from a stale form must not win
  // over a newer one, so any printerDeviceId (null included) needs the
  // station version the form was loaded at.
  if (input.printerDeviceId !== undefined && !input.expectedUpdatedAt)
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "expectedUpdatedAt wajib dikirim bersama printerDeviceId.",
    );
  const expectedAt = input.expectedUpdatedAt
    ? new Date(input.expectedUpdatedAt)
    : null;
  const stale = () =>
    new HttpError(
      409,
      "CONFLICT",
      "Stasiun sudah diubah orang lain. Muat ulang lalu coba lagi.",
    );
  return withTenant(db, context, async (tx) => {
    const existing = await requireStation(tx, context, stationId);
    // Station-bound config (target time, printer binding): the caller must
    // reach this station for the permission, not merely its outlet
    // (legend-fsb7). A station-scoped grant manages its own station only.
    await assertStationPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.id,
      now,
    );
    // Early stale check before any other validation: a stale form that
    // still names a since-revoked printer gets 409, not 422. The
    // conditional WHERE below stays the real guard.
    if (expectedAt && existing.updatedAt.getTime() !== expectedAt.getTime())
      throw stale();
    // Name and type decide which station of the outlet KDS routing picks
    // (first active station of a type, by name): changing them moves tickets
    // between stations, so it is outlet configuration, not this station's
    // own (legend-cot3). A station-scoped grant keeps target time and printer.
    // Only a real change is written: a form echoing the stored values (the
    // web form trims the name) needs no outlet grant, and an echo can never
    // overwrite a concurrent rename by an outlet manager.
    const nameChanged =
      input.name !== undefined && input.name.trim() !== existing.name.trim();
    const typeChanged =
      input.type !== undefined && input.type !== existing.type;
    if (nameChanged || typeChanged)
      await assertOutletPermission(
        tx,
        context,
        actorUserId,
        MENU_ITEM_PERMISSION,
        existing.outletId,
        now,
      );
    // legend-e087: only a changed, non-null printer is validated and written
    // (null counts as a value). An echo of the stored value (e.g. revoked
    // since) must not block saving target time, and can never overwrite a
    // concurrent change of the printer by a manager.
    const printerChanged =
      input.printerDeviceId !== undefined &&
      (input.printerDeviceId?.toLowerCase() ?? null) !==
        (existing.printerDeviceId?.toLowerCase() ?? null);
    if (printerChanged && input.printerDeviceId)
      await assertStationPrinter(
        tx,
        context,
        existing.outletId,
        input.printerDeviceId,
      );
    const [row] = await tx
      .update(stations)
      .set({
        ...(nameChanged ? { name: input.name } : {}),
        ...(typeChanged ? { type: input.type } : {}),
        ...(printerChanged ? { printerDeviceId: input.printerDeviceId } : {}),
        ...(input.targetSeconds !== undefined
          ? { targetSeconds: input.targetSeconds }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.id, stationId),
          // The real guard: the row's own version, re-checked by Postgres
          // after any row lock wait. Column has microseconds, JS has ms.
          ...(expectedAt
            ? [
                sql`date_trunc('milliseconds', ${stations.updatedAt}) = ${expectedAt.toISOString()}::timestamptz`,
              ]
            : []),
        ),
      )
      .returning();
    if (!row) throw stale();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "station", entityId: row.id, operation: "updated" },
      affects: { kind: "outlet", outletId: existing.outletId },
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
    // Station target first, so another or unknown station answers the same
    // station denial as updateStation (legend-fsb7). Removing a station also
    // changes KDS routing for the whole outlet, so it needs the outlet
    // permission too, like createStation (legend-cot3).
    await assertStationPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      existing.id,
      now,
    );
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
      affects: { kind: "outlet", outletId: existing.outletId },
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
    // A station filter is a station-bound read: the caller must reach that
    // station itself, never only its outlet (legend-fsb7).
    if (query.stationId)
      await assertStationPermission(
        tx,
        context,
        actorUserId,
        MENU_VIEW_PERMISSION,
        query.stationId,
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
): Promise<string> {
  const [row] = await tx
    .select({ id: stations.id, brandId: outlets.brandId, type: stations.type })
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
  return row.type;
}

/** Q23: an item without a photo can never be active (published). */
function throwPhotoRequired(): never {
  throw new HttpError(
    menuErrorHttpStatus.MENU_PHOTO_REQUIRED,
    "MENU_PHOTO_REQUIRED",
    MENU_PHOTO_REQUIRED_MESSAGE,
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

/**
 * A recipe a menu row points at must belong to the caller's tenant. The
 * composite FK (tenant_id, recipe_id) enforces it in the database; this check
 * turns the violation into a 404 instead of a 500 (legend-3kdd). Recipes are
 * brand-scoped (the edge only receives them for outlets of that brand), so a
 * menu item or variant also needs a recipe of its own brand: pass `brandId`.
 * Modifiers are tenant-level and pass none.
 */
async function requireRecipe(
  tx: Tx,
  context: ScopedTenantContext,
  recipeId: string,
  brandId?: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.tenantId, context.tenant.tenantId),
        eq(recipes.id, recipeId),
        brandId ? eq(recipes.brandId, brandId) : undefined,
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Resep tidak ditemukan.");
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
    stationType?: MenuItemAdmin["stationType"];
    course?: string | null;
    recipeId?: string | null;
    taxRuleId?: string | null;
    labels: string[];
    allergens: string[];
    mediaId?: string | null;
    isActive: boolean;
    isBreakfast?: boolean;
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
    const stationTypeOfStation = input.stationId
      ? await requireStationOfBrand(tx, context, input.stationId, brandId)
      : null;
    if (input.mediaId) await requireMedia(tx, context, input.mediaId);
    if (input.recipeId)
      await requireRecipe(tx, context, input.recipeId, brandId);
    // Q23: every item needs a photo. Creating one as active without a photo is
    // the publish action and is refused; without `isActive` it is a draft.
    if (menuItemPhotoMissing(input)) throwPhotoRequired();
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
        stationType: input.stationType ?? stationTypeOfStation,
        course: input.course ?? null,
        recipeId: input.recipeId ?? null,
        taxRuleId: input.taxRuleId ?? null,
        labels: input.labels,
        allergens: input.allergens,
        mediaId: input.mediaId ?? null,
        isActive: input.isActive,
        isBreakfast: input.isBreakfast ?? false,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await markHppStale(tx, { tenantId: context.tenant.tenantId, brandId });
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
      affects: { kind: "brand", brandId },
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
    stationType?: MenuItemAdmin["stationType"];
    course?: string | null;
    recipeId?: string | null;
    taxRuleId?: string | null;
    labels?: string[];
    allergens?: string[];
    mediaId?: string | null;
    isActive?: boolean;
    isBreakfast?: boolean;
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
    const stationTypeOfStation =
      input.stationId !== undefined && input.stationId !== null
        ? await requireStationOfBrand(
            tx,
            context,
            input.stationId,
            existing.brandId,
          )
        : null;
    if (input.mediaId !== undefined && input.mediaId !== null)
      await requireMedia(tx, context, input.mediaId);
    if (input.recipeId !== undefined && input.recipeId !== null)
      await requireRecipe(tx, context, input.recipeId, existing.brandId);
    // Q23: activation and photo removal are the two writes that could publish
    // an item without a photo. Check the state *after* this patch, so
    // "mediaId + isActive in one request" is allowed. A legacy active item
    // without a photo stays editable (only these two explicit writes fail) and
    // can never be re-activated.
    const resultIsActive = input.isActive ?? existing.isActive;
    const resultMediaId =
      input.mediaId !== undefined ? input.mediaId : existing.mediaId;
    if (
      menuItemPhotoMissing({
        isActive: resultIsActive,
        mediaId: resultMediaId,
      }) &&
      (input.isActive === true || input.mediaId === null)
    )
      throwPhotoRequired();
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
        // An explicit type wins; otherwise a new station carries its type, and
        // clearing the station clears the type too (a stale type would keep
        // routing the item by type after the owner unassigned the station).
        ...(input.stationType !== undefined
          ? { stationType: input.stationType }
          : stationTypeOfStation !== null
            ? { stationType: stationTypeOfStation }
            : input.stationId === null
              ? { stationType: null }
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
        ...(input.isBreakfast !== undefined
          ? { isBreakfast: input.isBreakfast }
          : {}),
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
    if (input.recipeId !== undefined)
      await markHppStale(tx, {
        tenantId: context.tenant.tenantId,
        brandId: existing.brandId,
      });
    await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        itemId: row.id,
        categoryId: row.categoryId,
        isActive: row.isActive,
        operation: "updated",
      },
      affects: { kind: "brand", brandId: existing.brandId },
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
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      brandId: existing.brandId,
    });
    // A deleted item must not keep a price on any outlet: the edge receives
    // price lists as whole documents, so the parent list is touched too (its
    // `updated_at` and `sync_txid` move) and the edge drops the item's prices.
    const unpriced = await tx
      .update(priceListItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.itemId, itemId),
          isNull(priceListItems.deletedAt),
        ),
      )
      .returning({ priceListId: priceListItems.priceListId });
    const touchedListIds = [
      ...new Set(unpriced.map((entry) => entry.priceListId)),
    ];
    if (touchedListIds.length > 0)
      await tx
        .update(priceLists)
        .set({ updatedAt: now })
        .where(
          and(
            eq(priceLists.tenantId, context.tenant.tenantId),
            inArray(priceLists.id, touchedListIds),
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
      affects: { kind: "brand", brandId: existing.brandId },
      now,
    });
  });
}

/**
 * Display order inside one category: id at index i gets sortOrder i. Ids
 * outside the list keep their sortOrder; unchanged rows emit no event.
 */
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
        affects: { kind: "brand", brandId: first.brandId },
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
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      brandId: item.brandId,
    });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: itemId,
      actorUserId,
      payload: {
        entity: "item_group_link",
        entityId: itemId,
        operation: "updated",
      },
      affects: { kind: "brand", brandId: item.brandId },
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
    if (input.recipeId)
      await requireRecipe(tx, context, input.recipeId, item.brandId);
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
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      brandId: item.brandId,
    });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "variant", entityId: row.id, operation: "created" },
      affects: { kind: "brand", brandId: item.brandId },
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
    if (input.recipeId !== undefined && input.recipeId !== null)
      await requireRecipe(tx, context, input.recipeId, item.brandId);
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
    if (input.recipeId !== undefined)
      await markHppStale(tx, {
        tenantId: context.tenant.tenantId,
        brandId: item.brandId,
      });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "variant", entityId: row.id, operation: "updated" },
      affects: { kind: "brand", brandId: item.brandId },
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
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      brandId: item.brandId,
    });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: variantId,
      actorUserId,
      payload: { entity: "variant", entityId: variantId, operation: "deleted" },
      affects: { kind: "brand", brandId: item.brandId },
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
    await assertSharedMasterDataPermission(
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
      affects: { kind: "shared" },
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
    await assertSharedMasterDataPermission(
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
      affects: { kind: "shared" },
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
    await assertSharedMasterDataPermission(
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
    await markHppStale(tx, { tenantId: context.tenant.tenantId });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: groupId,
      actorUserId,
      payload: {
        entity: "modifier_group",
        entityId: groupId,
        operation: "deleted",
      },
      affects: { kind: "shared" },
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
    await assertSharedMasterDataPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    await assertSharedMasterDataPermission(
      tx,
      context,
      actorUserId,
      MENU_PRICE_MANAGE_PERMISSION,
      now,
    );
    if (input.stationId) {
      await requireStation(tx, context, input.stationId);
    }
    if (input.recipeId) await requireRecipe(tx, context, input.recipeId);
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
    await markHppStale(tx, { tenantId: context.tenant.tenantId });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "modifier", entityId: row.id, operation: "created" },
      affects: { kind: "shared" },
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
    await assertSharedMasterDataPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      now,
    );
    // A modifier price is shared by every outlet, so changing it needs the
    // sell-price permission on the same tenant/brand reach.
    if (input.priceIdr !== undefined)
      await assertSharedMasterDataPermission(
        tx,
        context,
        actorUserId,
        MENU_PRICE_MANAGE_PERMISSION,
        now,
      );
    if (input.stationId !== undefined && input.stationId !== null)
      await requireStation(tx, context, input.stationId);
    if (input.recipeId !== undefined && input.recipeId !== null)
      await requireRecipe(tx, context, input.recipeId);
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
    if (input.recipeId !== undefined || input.priceIdr !== undefined)
      await markHppStale(tx, { tenantId: context.tenant.tenantId });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: { entity: "modifier", entityId: row.id, operation: "updated" },
      affects: { kind: "shared" },
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
    await assertSharedMasterDataPermission(
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
    await markHppStale(tx, { tenantId: context.tenant.tenantId });
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: modifierId,
      actorUserId,
      payload: {
        entity: "modifier",
        entityId: modifierId,
        operation: "deleted",
      },
      affects: { kind: "shared" },
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
      affects: { kind: "brand", brandId: comboItem.brandId },
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
      affects: { kind: "brand", brandId: comboItem.brandId },
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
      affects: { kind: "brand", brandId: comboItem.brandId },
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
