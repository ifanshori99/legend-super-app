// OPS-04 sold-out write-through (bead legend-5zkp; PRD v1.7 §3 F45
// "Operasional Harian", §8 "Ketersediaan"). When a breakdown ticket marks a
// machine broken, every menu item mapped to that equipment stops selling
// (`item.sold_out`); when the machine is repaired, exactly the items THIS
// equipment disabled are restored (`item.restored`). A manual 86 is never
// lifted by a maintenance transition: the equipment row records its own
// `disabled_item_ids` and only those are restored.
//
// The caller owns the transaction (the equipment/maintenance service updates
// the ticket and the equipment status in it). This service therefore writes
// `item_availability` directly and must NOT call menu-pricing
// `setAvailabilityStatus`, which opens its own transaction and would break
// that atomicity. The events still use the menu catalog definitions and the
// menu outbox helper: `item.sold_out` / `item.restored` belong to the menu
// domain, so they go to the cloud-sync destination with the availability row
// as aggregate (the outbox keeps one aggregate on one outlet).
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  itemRestoredEvent,
  itemSoldOutEvent,
  type AvailabilityStatus,
} from "@starter/shared/menu";
import type { EquipmentStatus } from "@starter/shared/operations";
import { equipment } from "../db/schema/operations.ts";
import { itemAvailability, menuItems } from "../db/schema/menu.ts";
import { appendOutbox } from "./core-outbox.ts";
import { EVENT_DESTINATION, nextSequence } from "./menu-internals.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

/** The equipment row as the caller already loaded it, before the transition. */
export type EquipmentAvailabilityRow = {
  id: string;
  outletId: OutletId;
  name: string;
  status: EquipmentStatus;
  linkedMenuItemIds: string[];
  disabledItemIds: string[];
};

/**
 * The minimum envelope surface of a catalog-bound menu event
 * (`defineDomainEvent`), so both 86 definitions share one writer without
 * depending on their distinct zod payload types.
 */
type AvailabilityEventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

/** Valid UUIDs, deduplicated, in caller order (TEN-02: ids are untrusted). */
function validIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    const parsed = uuidSchema.safeParse(id);
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

/** Menu items that still exist (a soft-deleted item is no longer sellable). */
async function liveMenuItems(
  tx: OperationsTx,
  context: ScopedTenantContext,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        inArray(menuItems.id, [...ids]),
        isNull(menuItems.deletedAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

type LockedAvailabilityRow = {
  id: string;
  menuItemId: string;
  status: AvailabilityStatus;
  soldOutUntil: Date | null;
};

/**
 * The active availability row for one item at the outlet, creating the
 * default (available, no schedule, no limit) row when the outlet never sold
 * the item before. `onConflictDoNothing` tolerates a concurrent create: the
 * partial unique index allows one active row per (tenant, outlet, item).
 */
async function ensureAvailabilityRow(
  tx: OperationsTx,
  context: ScopedTenantContext,
  outletId: OutletId,
  menuItemId: string,
  now: Date,
): Promise<LockedAvailabilityRow | null> {
  const [inserted] = await tx
    .insert(itemAvailability)
    .values({
      tenantId: context.tenant.tenantId,
      outletId,
      menuItemId,
      status: "available",
      schedule: [],
      dailyLimit: null,
      soldOutUntil: null,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({
      id: itemAvailability.id,
      menuItemId: itemAvailability.menuItemId,
      status: itemAvailability.status,
      soldOutUntil: itemAvailability.soldOutUntil,
    });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({
      id: itemAvailability.id,
      menuItemId: itemAvailability.menuItemId,
      status: itemAvailability.status,
      soldOutUntil: itemAvailability.soldOutUntil,
    })
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.outletId, outletId),
        eq(itemAvailability.menuItemId, menuItemId),
        isNull(itemAvailability.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  return existing ?? null;
}

/**
 * Appends one menu event with the same envelope the 86 toggle writes
 * (menu-pricing.service.ts): the catalog definition, a race-safe sequence per
 * aggregate and the cloud-sync destination. The aggregate is the availability
 * row so the outbox's aggregate-outlet invariant holds across outlets.
 */
async function appendAvailabilityEvent(
  tx: OperationsTx,
  context: ScopedTenantContext,
  definition: AvailabilityEventDefinition,
  input: {
    availabilityId: string;
    outletId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.availabilityId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.availabilityId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.availabilityId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Syncs menu availability with an equipment status transition, inside the
 * caller's transaction. Returns the menu item ids whose availability changed.
 *
 * - broken (was not broken): mapped items become `sold_out` with no deadline
 *   and the equipment records them in `disabled_item_ids`. An item another
 *   broken machine already holds is co-held (recorded, no second event); a
 *   manual 86 is never recorded (a timed one loses its deadline so it cannot
 *   lapse while the machine is down);
 * - repaired/retired (was broken): the items in `disabled_item_ids` that are
 *   still sold out with no deadline and that no other broken machine holds
 *   are restored, then the bookkeeping is cleared;
 * - anything else (including broken -> broken): no write, no event, so a sweep
 *   or retry cannot emit a second sold-out broadcast.
 */
export async function syncEquipmentAvailability(
  tx: OperationsTx,
  context: ScopedTenantContext,
  actorUserId: string,
  current: EquipmentAvailabilityRow,
  previousStatus: EquipmentStatus,
  now: Date = new Date(),
): Promise<string[]> {
  assertTrustedScopedContext(context);
  if (current.status === "broken" && previousStatus !== "broken")
    return markLinkedItemsSoldOut(tx, context, actorUserId, current, now);
  if (previousStatus === "broken" && current.status !== "broken")
    return restoreEquipmentDisabledItems(
      tx,
      context,
      actorUserId,
      current,
      now,
    );
  return [];
}

/**
 * Locks the active availability rows of these items at the outlet, in id
 * order. Every OPS-04 transition (breakdown, repair, retire) and the manual 86
 * toggle (menu-pricing `requireAvailability(..., true)`) take this row lock, so
 * two machines sharing an item serialise on it: whichever runs second reads
 * the other's committed status and bookkeeping (READ COMMITTED re-snapshots
 * per statement), never a stale view in which both think the other still
 * holds the item.
 */
async function lockAvailabilityRows(
  tx: OperationsTx,
  context: ScopedTenantContext,
  outletId: OutletId,
  menuItemIds: readonly string[],
): Promise<Map<string, LockedAvailabilityRow>> {
  if (menuItemIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: itemAvailability.id,
      menuItemId: itemAvailability.menuItemId,
      status: itemAvailability.status,
      soldOutUntil: itemAvailability.soldOutUntil,
    })
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.outletId, outletId),
        inArray(itemAvailability.menuItemId, [...menuItemIds]),
        isNull(itemAvailability.deletedAt),
      ),
    )
    .orderBy(asc(itemAvailability.id))
    .for("update");
  return new Map(rows.map((row) => [row.menuItemId, row]));
}

/**
 * Items (among `menuItemIds`) that ANOTHER out-of-service machine at the
 * outlet still holds sold out through its own `disabled_item_ids` (the
 * bookkeeping is cleared on restore, so membership means "still holding"). Read after the
 * availability rows are locked, so the answer is current for those items.
 */
async function heldByOtherBrokenEquipment(
  tx: OperationsTx,
  context: ScopedTenantContext,
  current: EquipmentAvailabilityRow,
  menuItemIds: readonly string[],
): Promise<Set<string>> {
  if (menuItemIds.length === 0) return new Set();
  const others = await tx
    .select({ disabledItemIds: equipment.disabledItemIds })
    .from(equipment)
    .where(
      and(
        eq(equipment.tenantId, context.tenant.tenantId),
        eq(equipment.outletId, current.outletId),
        // A machine under maintenance after a breakdown keeps its items until
        // `complete_maintenance` (operations-equipment availabilityStatus).
        inArray(equipment.status, ["broken", "under_maintenance"]),
        ne(equipment.id, current.id),
      ),
    );
  const wanted = new Set(menuItemIds);
  const held = new Set<string>();
  for (const other of others)
    for (const id of other.disabledItemIds) if (wanted.has(id)) held.add(id);
  return held;
}

async function markLinkedItemsSoldOut(
  tx: OperationsTx,
  context: ScopedTenantContext,
  actorUserId: string,
  current: EquipmentAvailabilityRow,
  now: Date,
): Promise<string[]> {
  const linked = validIds(current.linkedMenuItemIds);
  if (linked.length === 0) return [];
  const live = await liveMenuItems(tx, context, linked);
  // A deleted menu item cannot sell, so it neither becomes sold out nor joins
  // the equipment's bookkeeping.
  const itemIds = linked.filter((id) => live.has(id));
  if (itemIds.length === 0) return [];

  const byItem = await lockAvailabilityRows(
    tx,
    context,
    current.outletId,
    itemIds,
  );
  const alreadySoldOut = itemIds.filter(
    (id) => byItem.get(id)?.status === "sold_out",
  );
  const heldByOthers = await heldByOtherBrokenEquipment(
    tx,
    context,
    current,
    alreadySoldOut,
  );

  // Items this equipment now holds sold out. A co-held item (another broken
  // machine already sold it out) joins the bookkeeping without a second
  // broadcast, so the item stays sold out until the LAST machine is repaired.
  const held: string[] = [];
  const changed: { menuItemId: string; availabilityId: string }[] = [];
  for (const menuItemId of itemIds) {
    const row =
      byItem.get(menuItemId) ??
      (await ensureAvailabilityRow(
        tx,
        context,
        current.outletId,
        menuItemId,
        now,
      ));
    if (!row) continue;
    if (row.status === "sold_out") {
      if (heldByOthers.has(menuItemId)) {
        held.push(menuItemId);
        continue;
      }
      // A manual 86 is never taken over: it stays out of the bookkeeping so
      // the repair never lifts it. A TIMED manual 86 would however lapse
      // (reads treat a passed `soldOutUntil` as available, and
      // `restoreExpiredSoldOut` persists it) while the machine is still
      // broken, so its deadline is dropped: the item stays sold out until
      // staff lift it, still not owned by this equipment.
      const until = row.soldOutUntil;
      if (until === null) continue;
      if (until.getTime() > now.getTime()) {
        await tx
          .update(itemAvailability)
          .set({ soldOutUntil: null, updatedAt: now })
          .where(
            and(
              eq(itemAvailability.tenantId, context.tenant.tenantId),
              eq(itemAvailability.id, row.id),
            ),
          );
        changed.push({ menuItemId, availabilityId: row.id });
        continue;
      }
      // A deadline that already passed is effectively available: fall
      // through and sell it out as this equipment's own.
    }
    await tx
      .update(itemAvailability)
      .set({ status: "sold_out", soldOutUntil: null, updatedAt: now })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, row.id),
        ),
      );
    held.push(menuItemId);
    changed.push({ menuItemId, availabilityId: row.id });
  }

  if (held.length > 0) {
    const disabledItemIds = validIds([...current.disabledItemIds, ...held]);
    await tx
      .update(equipment)
      .set({ disabledItemIds, updatedAt: now })
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.outletId, current.outletId),
          eq(equipment.id, current.id),
        ),
      );
  }

  for (const entry of changed)
    await appendAvailabilityEvent(tx, context, itemSoldOutEvent, {
      availabilityId: entry.availabilityId,
      outletId: current.outletId,
      actorUserId,
      payload: {
        itemId: entry.menuItemId,
        availabilityId: entry.availabilityId,
        outletId: current.outletId,
        soldOutUntil: null,
      },
      now,
    });
  return changed.map((entry) => entry.menuItemId);
}

async function restoreEquipmentDisabledItems(
  tx: OperationsTx,
  context: ScopedTenantContext,
  actorUserId: string,
  current: EquipmentAvailabilityRow,
  now: Date,
): Promise<string[]> {
  const disabled = validIds(current.disabledItemIds);
  const live = await liveMenuItems(tx, context, disabled);
  const candidates = disabled.filter((id) => live.has(id));

  const byItem = await lockAvailabilityRows(
    tx,
    context,
    current.outletId,
    candidates,
  );
  // Another machine that is still broken holds these items too: the repair of
  // this one must not put them back on sale.
  const heldByOthers = await heldByOtherBrokenEquipment(
    tx,
    context,
    current,
    candidates,
  );

  const changed: { menuItemId: string; availabilityId: string }[] = [];
  for (const menuItemId of candidates) {
    const row = byItem.get(menuItemId);
    // Only a row this equipment sold out is restored. A row already restored
    // by an operator stays as it is, and so does a row an operator re-86'd
    // with a deadline (the equipment only ever writes `soldOutUntil = null`).
    if (!row || row.status !== "sold_out" || row.soldOutUntil !== null)
      continue;
    if (heldByOthers.has(menuItemId)) continue;
    await tx
      .update(itemAvailability)
      .set({ status: "available", soldOutUntil: null, updatedAt: now })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, row.id),
        ),
      );
    changed.push({ menuItemId, availabilityId: row.id });
  }

  // The transition is over: even a row an operator already restored must not
  // stay in the bookkeeping, or a later repair would try to lift a manual 86.
  await tx
    .update(equipment)
    .set({ disabledItemIds: [], updatedAt: now })
    .where(
      and(
        eq(equipment.tenantId, context.tenant.tenantId),
        eq(equipment.outletId, current.outletId),
        eq(equipment.id, current.id),
      ),
    );

  for (const entry of changed)
    await appendAvailabilityEvent(tx, context, itemRestoredEvent, {
      availabilityId: entry.availabilityId,
      outletId: current.outletId,
      actorUserId,
      payload: {
        itemId: entry.menuItemId,
        availabilityId: entry.availabilityId,
        outletId: current.outletId,
      },
      now,
    });
  return changed.map((entry) => entry.menuItemId);
}
