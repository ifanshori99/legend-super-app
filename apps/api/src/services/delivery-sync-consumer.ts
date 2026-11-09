// Outbox consumer of the delivery channel framework (bead legend-5bn3, slice
// D2; PRD v1.7 §3.23, §5 Sinkronisasi). Wired once in worker-main.ts, inside
// the consumption transaction, cloud only (an edge node never calls a
// platform).
//
// - `item.sold_out` / `item.restored` (86): every OPEN channel of the event's
//   outlet gets a `sold_out` adapter call. The adapter reference is the event id
//   plus platform, so an outbox replay repeats the same call (idempotent). An
//   adapter failure never fails the outbox event (the same consumption carries
//   the 86 to POS/KDS/QR): the channel is marked `syncStatus` error with a fixed
//   message, in a savepoint, and the sweep pushes its full menu (86 flags
//   included). A closed/paused channel is marked `stale` instead; the sweep
//   pushes it once it is open again.
// - `price_list.updated` (of a platform channel), `menu.updated`,
//   `menu_item.updated`: debounced `sync_menu`. The channel is marked `stale`;
//   it is pushed at once only when its last sync is older than the debounce
//   window. Inside the window the stale mark stays and
//   `syncStaleDeliveryChannels` (the trailing edge, run by the relay sweep in
//   worker-main.ts) pushes it. A failed menu sync is recorded on the channel
//   (`syncStatus` error) and never throws. Menu changes are brand-scoped: the
//   event's outlet is only the brand's first outlet (or null), so the channels
//   of every outlet of the brand are marked/pushed.
// - Other events: ignored.
import { and, eq, inArray, lte, or, isNull } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  deliveryPlatformSchema,
  type DeliveryPlatform,
} from "@starter/shared/delivery";
import { itemRestoredEvent, itemSoldOutEvent } from "@starter/shared/menu";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliveryChannels } from "../db/schema/delivery.ts";
import { outlets } from "../db/schema/index.ts";
import { logger } from "../lib/logger.ts";
import { deliveryChannelAdapterFor } from "./delivery-ports.ts";
import {
  pushDeliveryMenu,
  soldOutItemIds,
} from "./delivery-channels.service.ts";
import { outletsAffectedByEvent } from "./menu-print.service.ts";
import type { DeliveryChannelRow } from "./delivery-store.ts";
import type { Tx } from "./permission-resolver.ts";

/** A menu change inside this window of the last sync waits for the sweep. */
export const DELIVERY_SYNC_DEBOUNCE_MS = 60_000;

/** Fixed, secret-free `sync_error` of a refused 86 push (never adapter text). */
export const DELIVERY_SOLD_OUT_SYNC_ERROR =
  "Status stok habis gagal dikirim ke platform. Menu akan dikirim ulang.";

const MENU_CHANGE_EVENTS = ["menu.updated", "menu_item.updated"] as const;

/**
 * Channels of the given outlets (`"tenant"`: every channel of the tenant),
 * locked FOR UPDATE.
 */
async function channelsOfOutlets(
  tx: Tx,
  context: ScopedTenantContext,
  outletIds: readonly OutletId[] | "tenant",
  platforms?: readonly DeliveryPlatform[],
): Promise<DeliveryChannelRow[]> {
  if (outletIds !== "tenant" && outletIds.length === 0) return [];
  return tx
    .select()
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.tenantId, context.tenant.tenantId),
        outletIds === "tenant"
          ? undefined
          : inArray(deliveryChannels.outletId, [...outletIds]),
        platforms ? inArray(deliveryChannels.platform, [...platforms]) : undefined,
      ),
    )
    .orderBy(deliveryChannels.outletId, deliveryChannels.platform)
    .for("update");
}

/**
 * A DB write after an adapter call, in a savepoint: a failing write rolls back
 * only itself and is logged, never failing the outbox event.
 */
async function writeInSavepoint(
  tx: Tx,
  channel: DeliveryChannelRow,
  write: (savepoint: Tx) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      await write(savepoint);
    });
  } catch {
    logger.error(
      { job: "delivery_sync", channelId: channel.id, platform: channel.platform },
      "delivery channel sync state could not be recorded",
    );
  }
}

/**
 * Outlets a brand-scoped menu event affects. The event's outlet is only the
 * brand's first outlet (menu-internals.ts), so the brand is resolved from the
 * payload (menu-print.service.ts) or from that outlet; a null outlet with an
 * unresolved payload is shared menu data, so every channel of the tenant.
 */
async function outletsOfMenuEvent(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
): Promise<readonly OutletId[] | "tenant"> {
  const affected = await outletsAffectedByEvent(tx, event);
  if (affected.length > 0) return affected as OutletId[];
  if (!event.outletId) return "tenant";
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, event.outletId),
      ),
    );
  if (!outlet) return [event.outletId];
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.brandId, outlet.brandId),
      ),
    );
  return rows.map((row) => row.id as OutletId);
}

async function markStale(
  tx: Tx,
  context: ScopedTenantContext,
  channel: DeliveryChannelRow,
  now: Date,
): Promise<void> {
  if (channel.syncStatus === "stale") return;
  await tx
    .update(deliveryChannels)
    .set({ syncStatus: "stale", syncError: null, updatedAt: now })
    .where(
      and(
        eq(deliveryChannels.tenantId, context.tenant.tenantId),
        eq(deliveryChannels.id, channel.id),
      ),
    );
}

async function deliverSoldOut(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
  outletId: OutletId,
  now: Date,
): Promise<void> {
  const soldOut = event.name === "item.sold_out";
  const { itemId, soldOutUntil } = soldOut
    ? itemSoldOutEvent.payloadSchema.parse(event.payload)
    : {
        ...itemRestoredEvent.payloadSchema.parse(event.payload),
        soldOutUntil: null,
      };
  const channels = await channelsOfOutlets(tx, context, [outletId]);
  if (channels.length === 0) return;
  const count = (await soldOutItemIds(tx, context, outletId, now)).size;
  for (const channel of channels) {
    // Closed/paused: the platform hides the store; the sweep pushes the full
    // menu (86 flags included) once the channel is open again.
    if (!channel.isOpen) {
      await markStale(tx, context, channel, now);
      continue;
    }
    let refused = false;
    try {
      await deliveryChannelAdapterFor(channel.platform).execute(context, {
        tenantId: context.tenant.tenantId,
        outletId,
        reference: `sold_out:${event.id}:${channel.platform}`,
        channel: channel.platform,
        action: "sold_out",
        payload: {
          storeExternalId: channel.storeExternalId,
          itemId,
          soldOut,
          soldOutUntil,
        },
      });
    } catch {
      refused = true;
    }
    await writeInSavepoint(tx, channel, (savepoint) =>
      savepoint
        .update(deliveryChannels)
        .set(
          refused
            ? {
                syncStatus: "error",
                syncError: DELIVERY_SOLD_OUT_SYNC_ERROR,
                updatedAt: now,
              }
            : { soldOutItemCount: count, updatedAt: now },
        )
        .where(
          and(
            eq(deliveryChannels.tenantId, context.tenant.tenantId),
            eq(deliveryChannels.id, channel.id),
          ),
        ),
    );
  }
}

async function deliverMenuChange(
  tx: Tx,
  context: ScopedTenantContext,
  outletIds: readonly OutletId[] | "tenant",
  platforms: readonly DeliveryPlatform[] | undefined,
  now: Date,
): Promise<void> {
  for (const channel of await channelsOfOutlets(
    tx,
    context,
    outletIds,
    platforms,
  )) {
    const settled =
      channel.lastSyncedAt !== null &&
      now.getTime() - channel.lastSyncedAt.getTime() <
        DELIVERY_SYNC_DEBOUNCE_MS;
    if (!channel.isOpen || settled) await markStale(tx, context, channel, now);
    else await pushDeliveryMenu(tx, context, channel, now);
  }
}

export async function deliverDeliveryChannelEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<void> {
  if (event.name === "item.sold_out" || event.name === "item.restored") {
    if (!event.outletId) return;
    return deliverSoldOut(tx, context, event, event.outletId, now);
  }
  if (event.name === "price_list.updated") {
    if (!event.outletId) return;
    const platform = deliveryPlatformSchema.safeParse(event.payload.channel);
    if (!platform.success) return;
    return deliverMenuChange(tx, context, [event.outletId], [platform.data], now);
  }
  if ((MENU_CHANGE_EVENTS as readonly string[]).includes(event.name)) {
    const outletIds = await outletsOfMenuEvent(tx, context, event);
    return deliverMenuChange(tx, context, outletIds, undefined, now);
  }
}

/**
 * Trailing edge of the debounce: pushes every open channel of the tenant that
 * is `stale` (or errored) and past the window. Returns the number pushed.
 * Run by the relay sweep in worker-main.ts (cloud only).
 */
export async function syncStaleDeliveryChannels(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERY_SYNC_DEBOUNCE_MS);
  return withTenant(db, context, async (tx) => {
    const due = await tx
      .select()
      .from(deliveryChannels)
      .where(
        and(
          eq(deliveryChannels.tenantId, context.tenant.tenantId),
          eq(deliveryChannels.isOpen, true),
          inArray(deliveryChannels.syncStatus, ["stale", "error"]),
          or(
            isNull(deliveryChannels.lastSyncedAt),
            lte(deliveryChannels.lastSyncedAt, cutoff),
          ),
        ),
      )
      .for("update");
    for (const channel of due) await pushDeliveryMenu(tx, context, channel, now);
    return due.length;
  });
}
