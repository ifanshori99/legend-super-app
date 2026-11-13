// Menu pricing and availability services (bead legend-lmk; PRD v1.7 §3 F8
// "Harga per Kanal" and "Ketersediaan", §6 C price_lists / price_list_items /
// item_availability).
//
// Price versions are outlet-owned and channel-specific with an effective date;
// the grid is one replaceable set (the contract's `setPriceListItems`). An 86
// toggle changes the availability status through the contract's transition
// table and broadcasts through the outbox — a client idempotency key makes a
// retry a no-op instead of a second event (PRD §8 "Ketersediaan").
//
// Price changes are sell-price sensitive (permission tag `sell_price`), so they
// also write an audit row (PRD §3.7, §6 B audit_logs) in the same transaction.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  businessDateOf,
  createUlid,
  CoreError,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  availabilitySchema,
  itemRestoredEvent,
  itemSoldOutEvent,
  MENU_PHOTO_REQUIRED_MESSAGE,
  menuErrorHttpStatus,
  menuItemPhotoMissing,
  menuUpdatedEvent,
  priceListItemSchema,
  priceListSchema,
  priceListUpdatedEvent,
  transitionAvailability,
  type Availability,
  type MenuChannel,
  type PriceList,
  type PriceListItem,
} from "@starter/shared/menu";
import {
  domainEventOutbox,
  itemAvailability,
  itemVariants,
  menuItems,
  outlets,
  priceListItems,
  priceLists,
} from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { appendOutbox } from "./core-outbox";
import { markHppStale } from "./hpp-invalidate";
import { restoreExpiredSoldOut } from "./menu-availability";
import { outletBusinessDayClock } from "./outlet-clock";
import {
  EVENT_DESTINATION,
  MENU_PRICE_MANAGE_PERMISSION,
  MENU_VIEW_PERMISSION,
  appendMenuEvent,
  assertOutletPermission,
  assertPermission,
  cursorOf,
  keysetCondition,
  nextSequence,
  pageOf,
  resolveOutlet,
  scopedOutletIds,
  type Tx,
} from "./menu-internals";

const PRICE_VIEW = "menu.price.view" as const;
const PRICE_MANAGE = MENU_PRICE_MANAGE_PERMISSION;
const AVAILABILITY_VIEW = MENU_VIEW_PERMISSION;
const AVAILABILITY_TOGGLE = "menu.availability.toggle" as const;

function toPriceList(row: typeof priceLists.$inferSelect): PriceList {
  return priceListSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    channel: row.channel,
    effectiveFrom: row.effectiveFrom,
  });
}

function toPriceListItem(
  row: typeof priceListItems.$inferSelect,
): PriceListItem {
  return priceListItemSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    priceListId: row.priceListId,
    itemId: row.itemId,
    variantId: row.variantId,
    priceIdr: row.priceIdr,
  });
}

function toAvailability(
  row: typeof itemAvailability.$inferSelect,
): Availability {
  return availabilitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    menuItemId: row.menuItemId,
    schedule: row.schedule,
    dailyLimit: row.dailyLimit,
    soldOutUntil: row.soldOutUntil?.toISOString() ?? null,
    status: row.status,
  });
}

async function requirePriceList(
  tx: Tx,
  context: ScopedTenantContext,
  priceListId: string,
): Promise<typeof priceLists.$inferSelect> {
  const [row] = await tx
    .select()
    .from(priceLists)
    .where(
      and(
        eq(priceLists.tenantId, context.tenant.tenantId),
        eq(priceLists.id, priceListId),
        isNull(priceLists.deletedAt),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Daftar harga tidak ditemukan.");
  return row;
}

async function requireAvailability(
  tx: Tx,
  context: ScopedTenantContext,
  availabilityId: string,
  forUpdate = false,
): Promise<typeof itemAvailability.$inferSelect> {
  const statement = tx
    .select()
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.id, availabilityId),
        isNull(itemAvailability.deletedAt),
      ),
    );
  // The 86 toggle locks the row so two devices cannot both read "available"
  // and each apply a transition.
  const [row] = forUpdate ? await statement.for("update") : await statement;
  if (!row)
    throw new CoreError("NOT_FOUND", "Ketersediaan item tidak ditemukan.");
  return row;
}

/**
 * The request a client idempotency key is bound to. A retry may replay only the
 * same availability, action and deadline; the same key on a different request
 * is a reuse (409 IDEMPOTENCY_KEY_REUSED), never a silent replay of the other
 * request's outcome.
 */
function availabilityRequestFingerprint(input: {
  availabilityId: string;
  menuItemId: string;
  outletId: string;
  action: "sell_out" | "restore";
  soldOutUntil: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.availabilityId,
        input.menuItemId,
        input.outletId,
        input.action,
        input.soldOutUntil,
      ]),
    )
    .digest("hex");
}

async function auditPriceChange(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    outletId: string;
    priceListId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    now: Date;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: "price_list.updated",
      objectType: "price_list",
      objectId: input.priceListId,
      reason: null,
      maskedChanges: { before: input.before, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    },
    [],
  );
}

// ------------------------------------------------------------- price lists

export async function listPriceLists(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    outletId?: string;
    channel?: PriceList["channel"];
    cursor?: string;
    limit: number;
  },
  now = new Date(),
): Promise<{
  data: PriceList[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const scope = scopedOutletIds(context, query.outletId);
    if (scope.kind === "all")
      await assertPermission(
        tx,
        context,
        actorUserId,
        PRICE_VIEW,
        { type: "tenant" },
        now,
      );
    else
      for (const outletId of scope.outletIds)
        await assertOutletPermission(
          tx,
          context,
          actorUserId,
          PRICE_VIEW,
          outletId,
          now,
        );
    const cursor = cursorOf(query);
    const rows = await tx
      .select()
      .from(priceLists)
      .where(
        and(
          eq(priceLists.tenantId, context.tenant.tenantId),
          isNull(priceLists.deletedAt),
          scope.kind === "outlets"
            ? inArray(priceLists.outletId, [...scope.outletIds])
            : undefined,
          query.channel ? eq(priceLists.channel, query.channel) : undefined,
          cursor
            ? keysetCondition(
                [priceLists.effectiveFrom, priceLists.id],
                cursor,
                "desc",
              )
            : undefined,
        ),
      )
      .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id))
      .limit(query.limit + 1);
    return pageOf(
      rows,
      query.limit,
      (row) => [row.effectiveFrom, row.id],
      toPriceList,
    );
  });
}

export async function createPriceList(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    outletId?: string;
    channel: PriceList["channel"];
    effectiveFrom: string;
  },
  now = new Date(),
): Promise<PriceList> {
  return withTenant(db, context, async (tx) => {
    const outletId = await resolveOutlet(tx, context, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_MANAGE,
      outletId,
      now,
    );
    const [duplicate] = await tx
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.tenantId, context.tenant.tenantId),
          eq(priceLists.outletId, outletId),
          eq(priceLists.channel, input.channel),
          eq(priceLists.effectiveFrom, input.effectiveFrom),
          isNull(priceLists.deletedAt),
        ),
      )
      .limit(1);
    if (duplicate)
      throw new HttpError(
        409,
        "CONFLICT",
        "Daftar harga untuk kanal dan tanggal itu sudah ada.",
      );
    const [row] = await tx
      .insert(priceLists)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        channel: input.channel,
        effectiveFrom: input.effectiveFrom,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await markHppStale(tx, { tenantId: context.tenant.tenantId, outletId });
    await appendMenuEvent(tx, context, priceListUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        priceListId: row.id,
        outletId,
        channel: row.channel,
        effectiveFrom: row.effectiveFrom,
        operation: "created",
      },
      affects: { kind: "outlet", outletId },
      now,
    });
    await auditPriceChange(tx, context, {
      actorUserId,
      outletId,
      priceListId: row.id,
      before: null,
      after: {
        channel: row.channel,
        effectiveFrom: row.effectiveFrom,
        entries: 0,
      },
      now,
    });
    return toPriceList(row);
  });
}

export async function updatePriceList(
  context: ScopedTenantContext,
  actorUserId: string,
  priceListId: string,
  input: { effectiveFrom?: string },
  now = new Date(),
): Promise<PriceList> {
  return withTenant(db, context, async (tx) => {
    const existing = await requirePriceList(tx, context, priceListId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_MANAGE,
      existing.outletId,
      now,
    );
    if (
      input.effectiveFrom !== undefined &&
      input.effectiveFrom !== existing.effectiveFrom
    ) {
      const [duplicate] = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(
          and(
            eq(priceLists.tenantId, context.tenant.tenantId),
            eq(priceLists.outletId, existing.outletId),
            eq(priceLists.channel, existing.channel),
            eq(priceLists.effectiveFrom, input.effectiveFrom),
            isNull(priceLists.deletedAt),
            ne(priceLists.id, priceListId),
          ),
        )
        .limit(1);
      if (duplicate)
        throw new HttpError(
          409,
          "CONFLICT",
          "Daftar harga untuk kanal dan tanggal itu sudah ada.",
        );
    }
    const [row] = await tx
      .update(priceLists)
      .set({
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: input.effectiveFrom }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(priceLists.tenantId, context.tenant.tenantId),
          eq(priceLists.id, priceListId),
        ),
      )
      .returning();
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      outletId: row.outletId,
    });
    await appendMenuEvent(tx, context, priceListUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        priceListId: row.id,
        outletId: row.outletId,
        channel: row.channel,
        effectiveFrom: row.effectiveFrom,
        operation: "updated",
      },
      affects: { kind: "outlet", outletId: row.outletId },
      now,
    });
    await auditPriceChange(tx, context, {
      actorUserId,
      outletId: row.outletId,
      priceListId: row.id,
      before: { effectiveFrom: existing.effectiveFrom },
      after: { effectiveFrom: row.effectiveFrom },
      now,
    });
    return toPriceList(row);
  });
}

export async function deletePriceList(
  context: ScopedTenantContext,
  actorUserId: string,
  priceListId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const existing = await requirePriceList(tx, context, priceListId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_MANAGE,
      existing.outletId,
      now,
    );
    await tx
      .update(priceListItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.priceListId, priceListId),
          isNull(priceListItems.deletedAt),
        ),
      );
    await tx
      .update(priceLists)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(priceLists.tenantId, context.tenant.tenantId),
          eq(priceLists.id, priceListId),
        ),
      );
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      outletId: existing.outletId,
    });
    await appendMenuEvent(tx, context, priceListUpdatedEvent, {
      aggregateId: priceListId,
      actorUserId,
      payload: {
        priceListId,
        outletId: existing.outletId,
        channel: existing.channel,
        effectiveFrom: existing.effectiveFrom,
        operation: "deleted",
      },
      affects: { kind: "outlet", outletId: existing.outletId },
      now,
    });
    await auditPriceChange(tx, context, {
      actorUserId,
      outletId: existing.outletId,
      priceListId,
      before: {
        channel: existing.channel,
        effectiveFrom: existing.effectiveFrom,
      },
      after: null,
      now,
    });
  });
}

export async function listPriceListItems(
  context: ScopedTenantContext,
  actorUserId: string,
  priceListId: string,
  query: { cursor?: string; limit: number },
  now = new Date(),
): Promise<{
  data: PriceListItem[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const list = await requirePriceList(tx, context, priceListId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_VIEW,
      list.outletId,
      now,
    );
    const cursor = cursorOf(query);
    const rows = await tx
      .select({ row: priceListItems, name: menuItems.name })
      .from(priceListItems)
      .innerJoin(
        menuItems,
        and(
          eq(menuItems.tenantId, priceListItems.tenantId),
          eq(menuItems.id, priceListItems.itemId),
        ),
      )
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.priceListId, priceListId),
          isNull(priceListItems.deletedAt),
          cursor
            ? keysetCondition([menuItems.name, priceListItems.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(menuItems.name), asc(priceListItems.id))
      .limit(query.limit + 1);
    return pageOf(
      rows.map((entry) => entry.row),
      query.limit,
      (row) => [row.itemId, row.id],
      toPriceListItem,
    );
  });
}

/**
 * Saves the complete price grid in one write (contract: the body is the whole
 * entry list). Entries missing from the body are tombstoned, so the edge learns
 * that a price was withdrawn.
 */
export async function setPriceListItems(
  context: ScopedTenantContext,
  actorUserId: string,
  priceListId: string,
  entries: readonly {
    itemId: string;
    variantId: string | null;
    priceIdr: number;
  }[],
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const list = await requirePriceList(tx, context, priceListId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_MANAGE,
      list.outletId,
      now,
    );
    const [outlet] = await tx
      .select({ brandId: outlets.brandId })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, list.outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const keys = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.itemId}:${entry.variantId ?? "-"}`;
      if (keys.has(key))
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Item atau varian muncul lebih dari sekali.",
        );
      keys.add(key);
    }
    const itemIds = [...new Set(entries.map((entry) => entry.itemId))];
    if (itemIds.length > 0) {
      const items = await tx
        .select({ id: menuItems.id, categoryId: menuItems.categoryId })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, context.tenant.tenantId),
            eq(menuItems.brandId, outlet.brandId),
            inArray(menuItems.id, itemIds),
            isNull(menuItems.deletedAt),
          ),
        );
      if (items.length !== itemIds.length)
        throw new CoreError("NOT_FOUND", "Item menu tidak ditemukan.");
      const itemById = new Map(items.map((item) => [item.id, item]));
      const variantIds = entries
        .map((entry) => entry.variantId)
        .filter((id): id is string => id !== null);
      if (variantIds.length > 0) {
        const variants = await tx
          .select({ id: itemVariants.id, menuItemId: itemVariants.menuItemId })
          .from(itemVariants)
          .where(
            and(
              eq(itemVariants.tenantId, context.tenant.tenantId),
              inArray(itemVariants.id, [...new Set(variantIds)]),
              isNull(itemVariants.deletedAt),
            ),
          );
        if (variants.length !== new Set(variantIds).size)
          throw new CoreError("NOT_FOUND", "Varian tidak ditemukan.");
        for (const entry of entries) {
          if (!entry.variantId) continue;
          const variant = variants.find((row) => row.id === entry.variantId);
          if (!variant || variant.menuItemId !== entry.itemId)
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "Varian tidak cocok dengan itemnya.",
            );
        }
      }
      void itemById;
    }
    const existing = await tx
      .select()
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.priceListId, priceListId),
          isNull(priceListItems.deletedAt),
        ),
      );
    for (const row of existing) {
      const key = `${row.itemId}:${row.variantId ?? "-"}`;
      if (keys.has(key)) continue;
      await tx
        .update(priceListItems)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(priceListItems.tenantId, context.tenant.tenantId),
            eq(priceListItems.id, row.id),
          ),
        );
    }
    for (const entry of entries) {
      const live = existing.find(
        (row) =>
          row.itemId === entry.itemId &&
          (row.variantId ?? null) === entry.variantId,
      );
      if (live) {
        await tx
          .update(priceListItems)
          .set({
            priceIdr: idr(entry.priceIdr),
            deletedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(priceListItems.tenantId, context.tenant.tenantId),
              eq(priceListItems.id, live.id),
            ),
          );
      } else {
        await tx.insert(priceListItems).values({
          tenantId: context.tenant.tenantId,
          priceListId,
          itemId: entry.itemId,
          variantId: entry.variantId,
          priceIdr: idr(entry.priceIdr),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await tx
      .update(priceLists)
      .set({ updatedAt: now })
      .where(
        and(
          eq(priceLists.tenantId, context.tenant.tenantId),
          eq(priceLists.id, priceListId),
        ),
      );
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      outletId: list.outletId,
    });
    await appendMenuEvent(tx, context, priceListUpdatedEvent, {
      aggregateId: priceListId,
      actorUserId,
      payload: {
        priceListId,
        outletId: list.outletId,
        channel: list.channel,
        effectiveFrom: list.effectiveFrom,
        operation: "items_replaced",
      },
      affects: { kind: "outlet", outletId: list.outletId },
      now,
    });
    await auditPriceChange(tx, context, {
      actorUserId,
      outletId: list.outletId,
      priceListId,
      before: { entries: existing.length },
      after: { entries: entries.length },
      now,
    });
  });
}

// ------------------------------------------------------- channel resolution

export type ChannelPriceEntry = {
  itemId: string;
  variantId: string | null;
  priceIdr: number;
  updatedAt: Date;
};

export type ChannelPriceGrid = {
  outletId: string;
  channel: MenuChannel;
  /** Business date in the outlet time zone that picked the list. */
  businessDate: string;
  priceList: typeof priceLists.$inferSelect | null;
  entries: ChannelPriceEntry[];
};

/**
 * The price version in force for one channel on `businessDate`: the latest list
 * whose `effectiveFrom` is not after that date (PRD §8 "Harga per Kanal" —
 * nominal per channel with an effective date). No list means the channel sells
 * nothing, because a price only exists inside a list; the guest read already
 * behaves that way, and order services (legend-e2x, legend-kk7) resolve through
 * this same function.
 */
export async function effectivePriceList(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    channel: MenuChannel;
    businessDate: string;
  },
): Promise<typeof priceLists.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(priceLists)
    .where(
      and(
        eq(priceLists.tenantId, context.tenant.tenantId),
        eq(priceLists.outletId, input.outletId),
        eq(priceLists.channel, input.channel),
        lte(priceLists.effectiveFrom, input.businessDate),
        isNull(priceLists.deletedAt),
      ),
    )
    .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id))
    .limit(1);
  return row ?? null;
}

/** Effective channel prices, optionally narrowed to a set of items. */
export async function readChannelPriceGrid(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    channel: MenuChannel;
    businessDate: string;
    itemIds?: readonly string[];
  },
): Promise<ChannelPriceGrid> {
  const priceList = await effectivePriceList(tx, context, input);
  if (!priceList)
    return {
      outletId: input.outletId,
      channel: input.channel,
      businessDate: input.businessDate,
      priceList: null,
      entries: [],
    };
  const itemFilter =
    input.itemIds === undefined
      ? undefined
      : input.itemIds.length === 0
        ? sql`false`
        : inArray(priceListItems.itemId, [...input.itemIds]);
  const rows = await tx
    .select({
      itemId: priceListItems.itemId,
      variantId: priceListItems.variantId,
      priceIdr: priceListItems.priceIdr,
      updatedAt: priceListItems.updatedAt,
    })
    .from(priceListItems)
    .where(
      and(
        eq(priceListItems.tenantId, context.tenant.tenantId),
        eq(priceListItems.priceListId, priceList.id),
        isNull(priceListItems.deletedAt),
        itemFilter,
      ),
    )
    .orderBy(asc(priceListItems.itemId), asc(priceListItems.id));
  return {
    outletId: input.outletId,
    channel: input.channel,
    businessDate: input.businessDate,
    priceList,
    entries: rows,
  };
}

/**
 * Staff/order-path read of the effective channel grid, scoped and gated:
 * `menu.price.view` at the outlet, business date from the outlet's own time
 * zone and business-day cutoff (owner Q39). The POS/ojol order services call this instead of trusting a client
 * price (PRD §8; ORD-05).
 */
export async function resolveChannelPrices(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId?: string; channel: MenuChannel },
  now = new Date(),
): Promise<ChannelPriceGrid> {
  return withTenant(db, context, async (tx) => {
    const outletId = await resolveOutlet(tx, context, input.outletId);
    const [outlet] = await tx
      .select({
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      PRICE_VIEW,
      outletId,
      now,
    );
    return readChannelPriceGrid(tx, context, {
      outletId,
      channel: input.channel,
      businessDate: businessDateOf(now, outletBusinessDayClock(outlet)),
    });
  });
}

// ------------------------------------------------------------- availability

export async function listAvailability(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    outletId?: string;
    status?: Availability["status"];
    cursor?: string;
    limit: number;
  },
  now = new Date(),
): Promise<{
  data: Availability[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const scope = scopedOutletIds(context, query.outletId);
    if (scope.kind === "all")
      await assertPermission(
        tx,
        context,
        actorUserId,
        AVAILABILITY_VIEW,
        { type: "tenant" },
        now,
      );
    else
      for (const outletId of scope.outletIds)
        await assertOutletPermission(
          tx,
          context,
          actorUserId,
          AVAILABILITY_VIEW,
          outletId,
          now,
        );
    const cursor = cursorOf(query);
    // The 86 board is where a deadline is observed: persist the restore and
    // broadcast `item.restored` in this transaction, so QR/POS/ojol learn that
    // the item sells again without an operator touching it (PRD §8).
    await restoreExpiredSoldOut(tx, context, {
      actorUserId,
      now,
      outletIds: scope.kind === "outlets" ? scope.outletIds : undefined,
    });
    const rows = await tx
      .select({ row: itemAvailability, name: menuItems.name })
      .from(itemAvailability)
      .innerJoin(
        menuItems,
        and(
          eq(menuItems.tenantId, itemAvailability.tenantId),
          eq(menuItems.id, itemAvailability.menuItemId),
        ),
      )
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          isNull(itemAvailability.deletedAt),
          isNull(menuItems.deletedAt),
          scope.kind === "outlets"
            ? inArray(itemAvailability.outletId, [...scope.outletIds])
            : undefined,
          query.status ? eq(itemAvailability.status, query.status) : undefined,
          cursor
            ? keysetCondition([menuItems.name, itemAvailability.id], cursor)
            : undefined,
        ),
      )
      .orderBy(asc(menuItems.name), asc(itemAvailability.id))
      .limit(query.limit + 1);
    return pageOf(
      rows.map((entry) => entry.row),
      query.limit,
      (row) => [row.menuItemId, row.id],
      toAvailability,
    );
  });
}

export async function updateAvailability(
  context: ScopedTenantContext,
  actorUserId: string,
  availabilityId: string,
  input: {
    schedule?: Availability["schedule"];
    dailyLimit?: number | null;
    soldOutUntil?: string | null;
  },
  now = new Date(),
): Promise<Availability> {
  return withTenant(db, context, async (tx) => {
    // Lock the row: `source` below depends on the status read here.
    const existing = await requireAvailability(
      tx,
      context,
      availabilityId,
      true,
    );
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      AVAILABILITY_TOGGLE,
      existing.outletId,
      now,
    );
    const [row] = await tx
      .update(itemAvailability)
      .set({
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.dailyLimit !== undefined
          ? { dailyLimit: input.dailyLimit }
          : {}),
        ...(input.soldOutUntil !== undefined
          ? {
              soldOutUntil:
                input.soldOutUntil === null
                  ? null
                  : new Date(input.soldOutUntil),
              ...(existing.status === "sold_out"
                ? { source: "staff" as const }
                : {}),
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, availabilityId),
        ),
      )
      .returning();
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      payload: {
        entity: "availability",
        entityId: row.id,
        operation: "updated",
      },
      affects: { kind: "outlet", outletId: existing.outletId },
      now,
    });
    return toAvailability(row);
  });
}

/**
 * 86 toggle. `transitionAvailability` is the contract's single state machine;
 * an action that the current status does not allow is a conflict, and a reused
 * idempotency key replays the recorded outcome instead of emitting a second
 * event (PRD §8 "Ketersediaan" broadcast to every channel). The key is bound to
 * the request fingerprint, so the same key on a different availability, action
 * or deadline is a reuse (409), not a replay.
 */
export async function setAvailabilityStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  availabilityId: string,
  input: {
    action: "sell_out" | "restore";
    soldOutUntil?: string | null;
    idempotencyKey: string;
  },
  now = new Date(),
): Promise<Availability> {
  return withTenant(db, context, async (tx) => {
    // A retry may arrive while the first request is still committing: the key
    // lock makes it wait, then observe the recorded outcome instead of emitting
    // a second event (two requests, one key, one event). The row lock then
    // serialises the state transition of one availability row.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`menu-86:${context.tenant.tenantId}:${input.idempotencyKey}`}))`,
    );
    const existing = await requireAvailability(
      tx,
      context,
      availabilityId,
      true,
    );
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      AVAILABILITY_TOGGLE,
      existing.outletId,
      now,
    );
    const expected =
      input.action === "sell_out" ? "item.sold_out" : "item.restored";
    const soldOutUntil =
      input.action === "sell_out" && input.soldOutUntil !== undefined
        ? input.soldOutUntil === null
          ? null
          : new Date(input.soldOutUntil)
        : null;
    const fingerprint = availabilityRequestFingerprint({
      availabilityId,
      menuItemId: existing.menuItemId,
      outletId: existing.outletId,
      action: input.action,
      soldOutUntil: soldOutUntil?.toISOString() ?? null,
    });
    const [recorded] = await tx
      .select({ event: domainEventOutbox.event })
      .from(domainEventOutbox)
      .where(
        and(
          eq(domainEventOutbox.tenantId, context.tenant.tenantId),
          sql`${domainEventOutbox.event}->>'idempotencyKey' = ${input.idempotencyKey}`,
        ),
      )
      .limit(1);
    if (recorded) {
      if (recorded.event.name !== expected)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai aksi lain.",
        );
      const stored = recorded.event.payload;
      const recordedFingerprint = availabilityRequestFingerprint({
        availabilityId: String(stored.availabilityId ?? ""),
        menuItemId: String(stored.itemId ?? ""),
        outletId: String(stored.outletId ?? ""),
        action: input.action,
        soldOutUntil:
          stored.soldOutUntil === undefined || stored.soldOutUntil === null
            ? null
            : String(stored.soldOutUntil),
      });
      if (recordedFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai permintaan lain.",
        );
      return toAvailability(existing);
    }
    let next: Availability["status"];
    // Q23: restoring an item republishes it (the 86-side publish switch), so
    // the post-restore state must pass the same photo rule as an activation —
    // hence `isActive: true`: the caller is asking for the item to be sold
    // again. Checked after the idempotency replay above, so a recorded retry
    // keeps answering with its recorded outcome.
    if (input.action === "restore") {
      const [item] = await tx
        .select({ mediaId: menuItems.mediaId })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, context.tenant.tenantId),
            eq(menuItems.id, existing.menuItemId),
            isNull(menuItems.deletedAt),
          ),
        );
      if (!item) throw new CoreError("NOT_FOUND", "Item menu tidak ditemukan.");
      if (menuItemPhotoMissing({ isActive: true, mediaId: item.mediaId }))
        throw new HttpError(
          menuErrorHttpStatus.MENU_PHOTO_REQUIRED,
          "MENU_PHOTO_REQUIRED",
          MENU_PHOTO_REQUIRED_MESSAGE,
        );
    }
    try {
      next = transitionAvailability(existing.status, input.action);
    } catch {
      throw new HttpError(
        409,
        "CONFLICT",
        "Status ketersediaan tidak mendukung aksi ini.",
      );
    }
    const [row] = await tx
      .update(itemAvailability)
      .set({
        status: next,
        soldOutUntil,
        source: next === "sold_out" ? "staff" : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, availabilityId),
        ),
      )
      .returning();
    const definition =
      input.action === "sell_out" ? itemSoldOutEvent : itemRestoredEvent;
    // The event carries the client key: a retry must not emit a second event.
    const outletId = existing.outletId;
    {
      // The aggregate is the availability row (one item at one outlet), not
      // the menu item: the outbox keeps every event of an aggregate on one
      // outlet (app.enforce_outbox_aggregate_outlet), so keying on the item
      // made the same item's 86 at a second outlet fail (legend-0gvh, Opus
      // review). The payload still names the item for consumers.
      const sequence = await nextSequence(
        tx,
        context.tenant.tenantId,
        definition.entry.aggregateType,
        existing.id,
      );
      const event = definition.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        name: definition.name,
        version: definition.version,
        aggregateType: definition.entry.aggregateType,
        aggregateId: existing.id,
        sequence,
        occurredAt: now.toISOString(),
        actor: { type: "user", id: actorUserId },
        deviceId: null,
        idempotencyKey: input.idempotencyKey,
        payloadSchemaRef: definition.payloadSchemaRef,
        payload:
          input.action === "sell_out"
            ? {
                itemId: existing.menuItemId,
                availabilityId: row.id,
                outletId,
                soldOutUntil: row.soldOutUntil?.toISOString() ?? null,
              }
            : {
                itemId: existing.menuItemId,
                availabilityId: row.id,
                outletId,
              },
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: EVENT_DESTINATION,
        direction: null,
        peerId: null,
      });
    }
    return toAvailability(row);
  });
}
