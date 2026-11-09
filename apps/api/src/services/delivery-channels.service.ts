// Delivery channel state and menu sync (bead legend-5bn3, slice D2; PRD v1.7
// §3.23 "Integrasi Ojek Online", F20, D12; contract @starter/shared/delivery
// endpoints.ts). One `delivery_channels` row per outlet and platform.
//
// - Open/close and menu sync push to the platform through the `DeliveryChannel`
//   adapter (delivery-ports.ts). The row is locked FOR UPDATE first, so two
//   clicks or a click and the sync consumer never interleave. A failed adapter
//   call on open/close rolls the state change back (fail closed: the screen
//   never shows a store open that the platform did not open).
// - A failed menu sync is recorded on the row (`syncStatus` error, a fixed
//   message, never the adapter's raw error) and then reported as 502.
// - Reopening a channel does not push the menu: a channel left `stale`/`error`
//   while closed (86, menu change) is pushed by the relay sweep
//   (`syncStaleDeliveryChannels`, worker-main.ts) on its next tick.
// - The menu pushed is the platform's own price list (`price_lists.channel` =
//   platform) joined to active menu items of the outlet's brand, with the 86
//   flag of this outlet. Prices come from the price list, never from a client.
// - Permission is checked by the route (requireOutletPermission); this module
//   only enforces the outlet scope of the caller's context.
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  assertOutletInScope,
  businessDateOf,
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { DeliveryRequest } from "@starter/shared/adapters";
import {
  deliveryErrorHttpStatus,
  deliveryErrorMessages,
  deliveryMenuSyncResultSchema,
  type DeliveryChannel,
  type DeliveryMenuSyncResult,
  type DeliveryPlatform,
  type SetDeliveryChannelStateInput,
} from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliveryChannels } from "../db/schema/delivery.ts";
import { itemAvailability, menuItems, outlets } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { deliveryChannelAdapterFor } from "./delivery-ports.ts";
import {
  toDeliveryChannel,
  type DeliveryChannelRow,
} from "./delivery-store.ts";
import { readChannelPriceGrid } from "./menu-pricing.service.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import type { Tx } from "./permission-resolver.ts";

type Json = DeliveryRequest["payload"];

function unknownChannel(): HttpError {
  return new HttpError(
    deliveryErrorHttpStatus.DELIVERY_CHANNEL_UNKNOWN,
    "DELIVERY_CHANNEL_UNKNOWN",
    deliveryErrorMessages.DELIVERY_CHANNEL_UNKNOWN,
  );
}

/** The channel row of this tenant, outlet and platform, locked FOR UPDATE. */
export async function lockDeliveryChannel(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  platform: DeliveryPlatform,
): Promise<DeliveryChannelRow | null> {
  const [row] = await tx
    .select()
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.tenantId, context.tenant.tenantId),
        eq(deliveryChannels.outletId, outletId as OutletId),
        eq(deliveryChannels.platform, platform),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/** Items of this outlet that are 86 right now (flag set and not expired). */
export async function soldOutItemIds(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<Set<string>> {
  const rows = await tx
    .select({ itemId: itemAvailability.menuItemId })
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.outletId, outletId),
        eq(itemAvailability.status, "sold_out"),
        isNull(itemAvailability.deletedAt),
        or(
          isNull(itemAvailability.soldOutUntil),
          gt(itemAvailability.soldOutUntil, now),
        ),
      ),
    );
  return new Set(rows.map((row) => row.itemId));
}

/**
 * The menu as the platform should see it: active items of the outlet's brand
 * that have a price in the platform's effective price list. Sold-out items stay
 * in the list, flagged, so the platform shows them as unavailable.
 */
async function buildMenuPayload(
  tx: Tx,
  context: ScopedTenantContext,
  channel: DeliveryChannelRow,
  now: Date,
): Promise<{ payload: Json; pushed: number; soldOut: number }> {
  const [outlet] = await tx
    .select({
      brandId: outlets.brandId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, channel.outletId),
      ),
    );
  if (!outlet) throw unknownChannel();
  const grid = await readChannelPriceGrid(tx, context, {
    outletId: channel.outletId,
    channel: channel.platform,
    businessDate: businessDateOf(now, outletBusinessDayClock(outlet)),
  });
  const itemIds = [...new Set(grid.entries.map((entry) => entry.itemId))];
  const items = itemIds.length
    ? await tx
        .select({ id: menuItems.id, name: menuItems.name })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, context.tenant.tenantId),
            eq(menuItems.brandId, outlet.brandId),
            eq(menuItems.isActive, true),
            isNull(menuItems.deletedAt),
            inArray(menuItems.id, itemIds),
          ),
        )
        .orderBy(
          asc(menuItems.sortOrder),
          asc(menuItems.name),
          asc(menuItems.id),
        )
    : [];
  const soldOutIds = await soldOutItemIds(tx, context, channel.outletId, now);
  const payloadItems = items.map((item) => ({
    itemId: item.id,
    name: item.name,
    soldOut: soldOutIds.has(item.id),
    prices: grid.entries
      .filter((entry) => entry.itemId === item.id)
      .map((entry) => ({
        variantId: entry.variantId,
        priceIdr: entry.priceIdr,
      })),
  }));
  return {
    payload: { storeExternalId: channel.storeExternalId, items: payloadItems },
    pushed: payloadItems.length,
    soldOut: payloadItems.filter((item) => item.soldOut).length,
  };
}

/** Fixed, secret-free `sync_error` of a failed menu push (never adapter text). */
export const DELIVERY_MENU_SYNC_ERROR =
  "Sinkron menu gagal di platform. Coba lagi.";

export type MenuSyncOutcome =
  | { ok: true; result: DeliveryMenuSyncResult }
  | { ok: false; channel: DeliveryChannel };

/**
 * Push the menu on a locked channel row and record the outcome on the row.
 * Never throws: a failed menu build (in a savepoint), adapter call or record
 * is the `ok: false` outcome, so the caller can commit the recorded error.
 */
export async function pushDeliveryMenu(
  tx: Tx,
  context: ScopedTenantContext,
  channel: DeliveryChannelRow,
  now: Date,
): Promise<MenuSyncOutcome> {
  let menu: Awaited<ReturnType<typeof buildMenuPayload>> | null = null;
  try {
    const built = await tx.transaction((savepoint) =>
      buildMenuPayload(savepoint, context, channel, now),
    );
    await deliveryChannelAdapterFor(channel.platform).execute(context, {
      tenantId: context.tenant.tenantId,
      outletId: channel.outletId,
      reference: `sync_menu:${channel.id}:${now.getTime()}`,
      channel: channel.platform,
      action: "sync_menu",
      payload: built.payload,
    });
    menu = built;
  } catch {
    menu = null;
  }
  const failed: DeliveryChannelRow = {
    ...channel,
    syncStatus: "error",
    syncError: DELIVERY_MENU_SYNC_ERROR,
    updatedAt: now,
  };
  const pushed = menu;
  let row: DeliveryChannelRow;
  try {
    [row] = await tx.transaction((savepoint) =>
      savepoint
        .update(deliveryChannels)
        .set(
          pushed !== null
            ? {
                syncStatus: "ok",
                lastSyncedAt: now,
                syncError: null,
                menuItemCount: pushed.pushed,
                soldOutItemCount: pushed.soldOut,
                updatedAt: now,
              }
            : {
                syncStatus: failed.syncStatus,
                syncError: failed.syncError,
                updatedAt: now,
              },
        )
        .where(
          and(
            eq(deliveryChannels.tenantId, context.tenant.tenantId),
            eq(deliveryChannels.id, channel.id),
          ),
        )
        .returning(),
    );
  } catch {
    return { ok: false, channel: toDeliveryChannel(failed) };
  }
  const dto = toDeliveryChannel(row);
  if (pushed === null) return { ok: false, channel: dto };
  return {
    ok: true,
    result: deliveryMenuSyncResultSchema.parse({
      channel: dto,
      pushedItemCount: pushed.pushed,
      soldOutItemCount: pushed.soldOut,
    }),
  };
}

// ---- Service surface ------------------------------------------------------

export async function listDeliveryChannels(
  context: ScopedTenantContext,
  outletId: string,
): Promise<DeliveryChannel[]> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(deliveryChannels)
      .where(
        and(
          eq(deliveryChannels.tenantId, context.tenant.tenantId),
          eq(deliveryChannels.outletId, outletId as OutletId),
        ),
      )
      .orderBy(asc(deliveryChannels.platform));
    return rows.map(toDeliveryChannel);
  });
}

export async function setDeliveryChannelState(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  platform: DeliveryPlatform,
  input: SetDeliveryChannelStateInput,
  now = new Date(),
): Promise<DeliveryChannel> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const existing = await lockDeliveryChannel(tx, context, outletId, platform);
    if (!existing) throw unknownChannel();
    const closedUntil = input.isOpen
      ? null
      : input.closedUntil
        ? new Date(input.closedUntil)
        : null;
    const closedReason = input.isOpen ? null : (input.closedReason ?? null);
    const [row] = await tx
      .update(deliveryChannels)
      .set({ isOpen: input.isOpen, closedUntil, closedReason, updatedAt: now })
      .where(
        and(
          eq(deliveryChannels.tenantId, context.tenant.tenantId),
          eq(deliveryChannels.id, existing.id),
        ),
      )
      .returning();
    // Fail closed: an adapter error rolls the update back.
    try {
      await deliveryChannelAdapterFor(platform).execute(context, {
        tenantId: context.tenant.tenantId,
        outletId: existing.outletId,
        reference: `${input.isOpen ? "open" : "close"}:${existing.id}:${now.getTime()}`,
        channel: platform,
        action: input.isOpen ? "open" : "close",
        payload: {
          storeExternalId: row.storeExternalId,
          closedUntil: closedUntil?.toISOString() ?? null,
          closedReason,
        },
      });
    } catch {
      throw new HttpError(
        502,
        "BAD_GATEWAY",
        "Platform tidak merespons perubahan status toko. Coba lagi.",
      );
    }
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "delivery_channel.state_changed",
        objectType: "delivery_channel",
        objectId: existing.id,
        reason: closedReason,
        maskedChanges: {
          before: {
            platform,
            isOpen: existing.isOpen,
            closedUntil: existing.closedUntil?.toISOString() ?? null,
          },
          after: {
            platform,
            isOpen: row.isOpen,
            closedUntil: row.closedUntil?.toISOString() ?? null,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [],
    );
    return toDeliveryChannel(row);
  });
}

export async function syncDeliveryChannelMenu(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  platform: DeliveryPlatform,
  now = new Date(),
): Promise<DeliveryMenuSyncResult> {
  assertOutletInScope(context.outletScope, outletId);
  // The outcome (including a recorded failure) commits; the 502 follows it.
  const outcome = await withTenant(db, context, async (tx) => {
    const existing = await lockDeliveryChannel(tx, context, outletId, platform);
    if (!existing) throw unknownChannel();
    const pushed = await pushDeliveryMenu(tx, context, existing, now);
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "delivery_channel.menu_synced",
        objectType: "delivery_channel",
        objectId: existing.id,
        reason: null,
        maskedChanges: {
          before: { platform, syncStatus: existing.syncStatus },
          after: {
            platform,
            syncStatus: pushed.ok ? "ok" : "error",
            pushedItemCount: pushed.ok ? pushed.result.pushedItemCount : null,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [],
    );
    return pushed;
  });
  if (!outcome.ok)
    throw new HttpError(
      502,
      "BAD_GATEWAY",
      "Platform tidak menerima sinkron menu. Coba lagi.",
    );
  return outcome.result;
}
