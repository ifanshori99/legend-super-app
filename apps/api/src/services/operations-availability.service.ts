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
import { and, eq, inArray, isNull } from "drizzle-orm";
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
): Promise<{ id: string; status: AvailabilityStatus } | null> {
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
      status: itemAvailability.status,
    });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({
      id: itemAvailability.id,
      status: itemAvailability.status,
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
    .limit(1);
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
 *   and the equipment records them in `disabled_item_ids`;
 * - repaired (was broken): only the items in `disabled_item_ids` that are
 *   still sold out are restored, then the bookkeeping is cleared;
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

  const existing = await tx
    .select({
      id: itemAvailability.id,
      menuItemId: itemAvailability.menuItemId,
      status: itemAvailability.status,
    })
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.outletId, current.outletId),
        inArray(itemAvailability.menuItemId, itemIds),
        isNull(itemAvailability.deletedAt),
      ),
    );
  const byItem = new Map(existing.map((row) => [row.menuItemId, row]));

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
    // Already sold out (manual 86 or a previous breakdown): leave it alone, so
    // the repair never lifts a state this equipment did not set.
    if (row.status === "sold_out") continue;
    await tx
      .update(itemAvailability)
      .set({ status: "sold_out", soldOutUntil: null, updatedAt: now })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, row.id),
        ),
      );
    changed.push({ menuItemId, availabilityId: row.id });
  }
  if (changed.length === 0) return [];

  const disabledItemIds = validIds([
    ...current.disabledItemIds,
    ...changed.map((entry) => entry.menuItemId),
  ]);
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

  const rows =
    candidates.length === 0
      ? []
      : await tx
          .select({
            id: itemAvailability.id,
            menuItemId: itemAvailability.menuItemId,
            status: itemAvailability.status,
          })
          .from(itemAvailability)
          .where(
            and(
              eq(itemAvailability.tenantId, context.tenant.tenantId),
              eq(itemAvailability.outletId, current.outletId),
              inArray(itemAvailability.menuItemId, candidates),
              isNull(itemAvailability.deletedAt),
            ),
          );
  const byItem = new Map(rows.map((row) => [row.menuItemId, row]));

  const changed: { menuItemId: string; availabilityId: string }[] = [];
  for (const menuItemId of candidates) {
    const row = byItem.get(menuItemId);
    // Only a row this equipment sold out is restored. A row already restored
    // by an operator (or a sold-out row that was never in the bookkeeping)
    // stays as it is.
    if (!row || row.status !== "sold_out") continue;
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
