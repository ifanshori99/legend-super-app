// KDS routing and ticket lifecycle (bead legend-4d5; PRD v1.7 §3 F12 "KDS,
// Expo & Pickup Display"; contract @starter/shared/kitchen).
//
// - KDS-01: a POS fire routes each fired line to the station of its menu item
//   inside the fire transaction (`routeFiredItemsToKitchen`), one ticket per
//   station per fire. A mapped station that cannot be resolved in the order's
//   outlet fails the whole fire (fail closed: no line silently vanishes).
// - KDS-02: every ticket change appends one gapless per-station feed row
//   (kds-support.ts `appendStationFeed`); displays resume from their cursor.
// - KDS-03: voiding a fired POS line voids its ticket line in the same
//   transaction; a ticket whose lines are all voided is cancelled.
// - KDS-04: every status change writes an append-only status change row with
//   time, actor and source.
//
// Lock order: the POS paths already hold the `orders` row; ticket rows are
// locked (ordered by id) before any station cursor row, so two writers never
// wait on each other in a cycle.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  toIsoDateTime,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  canTransitionKitchenTicket,
  KITCHEN_FEED_PAGE_LIMIT,
  transitionKitchenItem,
  transitionKitchenTicket,
  type KitchenItemAction,
  type KitchenItemStatus,
  type KitchenStationFeed,
  type KitchenStationSnapshot,
  type KitchenTicketAction,
  type KitchenTicketDetail,
  type KitchenTicketItem,
  type KitchenTicketStatus,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { menuItems, stations } from "../db/schema/index.ts";
import {
  kitchenStationFeed,
  kitchenTicketItems,
  kitchenTickets,
} from "../db/schema/kds.ts";
import { orderItems } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  actorSource,
  appendKitchenEvent,
  appendStationFeed,
  auditKitchen,
  freshTicketDetail,
  itemStatusOf,
  readStationCursor,
  recordStatusChange,
  ticketDetails,
  ticketItemDto,
  ticketStatusOf,
  type KdsActor,
  type TicketItemRow,
  type TicketRow,
} from "./kds-support.ts";
import type { Tx } from "./menu-internals.ts";
import { assertStationPermission } from "./station-access.ts";

export type { KdsActor };

const PROCESS = "kds.ticket.process";
/** Bumped tickets stay on the station snapshot this long (recall window). */
const DONE_VISIBLE_MS = 30 * 60 * 1000;

const ticketNotFound = () =>
  new CoreError("NOT_FOUND", "Tiket dapur tidak ditemukan.");
const itemNotFound = () =>
  new CoreError("NOT_FOUND", "Item tiket dapur tidak ditemukan.");
const stationNotFound = () =>
  new CoreError("NOT_FOUND", "Stasiun dapur tidak ditemukan di outlet ini.");
const ticketCancelled = () =>
  new CoreError("CONFLICT", "Tiket dapur sudah dibatalkan.");

const TICKET_ACTION_LABEL: Record<KitchenTicketAction, string> = {
  start: "mulai",
  bump: "selesai",
  recall: "panggil ulang",
  void: "batal",
};
const ITEM_ACTION_LABEL: Record<KitchenItemAction, string> = {
  start: "mulai",
  ready: "siap",
  serve: "saji",
  recall: "panggil ulang",
  void: "batal",
};

function nextTicketStatus(
  status: KitchenTicketStatus,
  action: KitchenTicketAction,
): KitchenTicketStatus {
  try {
    return transitionKitchenTicket(status, action);
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError(
        "CONFLICT",
        `Tiket dapur tidak bisa di-${TICKET_ACTION_LABEL[action]} dari status ini.`,
      );
    throw error;
  }
}

function nextItemStatus(
  status: KitchenItemStatus,
  action: KitchenItemAction,
): KitchenItemStatus {
  try {
    return transitionKitchenItem(status, action);
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError(
        "CONFLICT",
        `Item dapur tidak bisa di-${ITEM_ACTION_LABEL[action]} dari status ini.`,
      );
    throw error;
  }
}

/** Ticket row of this tenant + outlet, optionally locked FOR UPDATE. */
async function readTicket(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  ticketId: string,
  lock: boolean,
): Promise<TicketRow> {
  assertOutletInScope(context.outletScope, outletId);
  const query = tx
    .select()
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, context.tenant.tenantId),
        eq(kitchenTickets.outletId, outletId),
        eq(kitchenTickets.id, ticketId),
      ),
    );
  const [ticket] = lock ? await query.for("update") : await query;
  if (!ticket) throw ticketNotFound();
  return ticket;
}

/** Station must be an active station of this outlet (after the permission check). */
async function assertStationInOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  stationId: string,
): Promise<void> {
  const [station] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.outletId, outletId),
        eq(stations.id, stationId),
        isNull(stations.deletedAt),
      ),
    );
  if (!station) throw stationNotFound();
}

// ---- Routing (KDS-01) -------------------------------------------------------------

/**
 * Routes fired order lines to their stations in the CALLER's transaction.
 * Lines whose menu item has no station are not kitchen items; lines already
 * routed are skipped (unique order_item_id), so firing twice never doubles.
 */
export async function routeFiredItemsToKitchen(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    orderId: string;
    itemIds: readonly string[];
    actor: KdsActor | null;
    now: Date;
  },
): Promise<{ ticketIds: string[] }> {
  const outletId = outletIdSchema.parse(input.outletId);
  if (input.itemIds.length === 0) return { ticketIds: [] };
  const tenantId = context.tenant.tenantId;
  const rows = await tx
    .select({ item: orderItems, mappedStationId: menuItems.stationId })
    .from(orderItems)
    .innerJoin(
      menuItems,
      and(
        eq(menuItems.tenantId, orderItems.tenantId),
        eq(menuItems.id, orderItems.menuItemId),
      ),
    )
    .leftJoin(
      kitchenTicketItems,
      and(
        eq(kitchenTicketItems.tenantId, orderItems.tenantId),
        eq(kitchenTicketItems.orderItemId, orderItems.id),
      ),
    )
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.outletId, outletId),
        eq(orderItems.orderId, input.orderId),
        inArray(orderItems.id, [...input.itemIds]),
        ne(orderItems.status, "voided"),
        isNotNull(menuItems.stationId),
        isNull(kitchenTicketItems.id),
      ),
    )
    .orderBy(asc(orderItems.id));
  if (rows.length === 0) return { ticketIds: [] };

  const resolved = await resolveStations(
    tx,
    context,
    outletId,
    rows.flatMap(({ mappedStationId }) =>
      mappedStationId === null ? [] : [mappedStationId],
    ),
  );
  const byStation = new Map<string, (typeof rows)[number]["item"][]>();
  for (const { item, mappedStationId } of rows) {
    const stationId = resolved.get(mappedStationId ?? "");
    if (stationId === undefined) throw new Error("Station resolution missed");
    const list = byStation.get(stationId) ?? [];
    list.push(item);
    byStation.set(stationId, list);
  }

  const now = input.now;
  const fireBatchId = createUlid(now.getTime());
  const source = input.actor === null ? "system" : "user";
  const ticketIds: string[] = [];
  // Sorted station order = sorted cursor lock order across concurrent fires.
  for (const stationId of [...byStation.keys()].sort()) {
    const items = byStation.get(stationId) ?? [];
    const [ticket] = await tx
      .insert(kitchenTickets)
      .values({
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        orderId: input.orderId,
        stationId,
        fireBatchId,
        status: "new",
        priority: 0,
        firedAt: now,
        printedFallback: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!ticket) throw new Error("Kitchen ticket insert returned no row");
    await tx.insert(kitchenTicketItems).values(
      items.map((item) => ({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: ticket.outletId,
        ticketId: ticket.id,
        orderId: input.orderId,
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        name: item.name,
        quantity: item.quantity,
        course: item.course,
        modifiers: item.modifiers.map((modifier) => modifier.name),
        note: item.note,
        status: "queued",
        firedAt: now,
        recalledCount: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await recordStatusChange(tx, context, {
      ticket,
      orderItemId: null,
      fromStatus: null,
      toStatus: "new",
      source,
      actor: input.actor,
      reason: null,
      now,
    });
    await appendStationFeed(tx, context, {
      outletId: ticket.outletId,
      stationId,
      ticketId: ticket.id,
      now,
    });
    await appendKitchenEvent(tx, context, "kitchen_ticket.created", {
      ticket,
      payload: {
        outletId: ticket.outletId,
        ticketId: ticket.id,
        orderId: ticket.orderId,
        stationId,
        status: "new",
        priority: 0,
        itemCount: items.length,
      },
      actor: input.actor,
      now,
    });
    await auditKitchen(
      tx,
      context,
      {
        action: "kitchen_ticket.created",
        ticket,
        actor: input.actor,
        before: null,
        after: {
          id: ticket.id,
          status: "new",
          orderId: ticket.orderId,
          stationId,
          itemIds: items.map((item) => item.id),
        },
      },
      now,
    );
    ticketIds.push(ticket.id);
  }
  return { ticketIds };
}

/**
 * Mapped station -> station that receives the ticket in `outletId`: itself if
 * active in this outlet, else the active station of the same type there
 * (first by name, id). None ⇒ CONFLICT so the fire rolls back.
 */
async function resolveStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  mappedIds: readonly string[],
): Promise<Map<string, string>> {
  const tenantId = context.tenant.tenantId;
  const unique = [...new Set(mappedIds)];
  const mapped = await tx
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, tenantId), inArray(stations.id, unique)));
  const byId = new Map(mapped.map((station) => [station.id, station]));
  const byType = new Map<string, string | null>();
  const result = new Map<string, string>();
  for (const id of unique) {
    const station = byId.get(id);
    // Outlet RLS hides a mapped station of another outlet from an
    // outlet-scoped caller, so its type (and the fallback) is unknown here:
    // fail closed until menus carry a per-outlet station mapping.
    if (!station) throw unresolvedStation();
    if (station.outletId === outletId && station.deletedAt === null) {
      result.set(id, station.id);
      continue;
    }
    if (!byType.has(station.type)) {
      const [fallback] = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(
          and(
            eq(stations.tenantId, tenantId),
            eq(stations.outletId, outletId),
            eq(stations.type, station.type),
            isNull(stations.deletedAt),
          ),
        )
        .orderBy(asc(stations.name), asc(stations.id))
        .limit(1);
      byType.set(station.type, fallback?.id ?? null);
    }
    const fallbackId = byType.get(station.type) ?? null;
    if (fallbackId === null) throw unresolvedStation();
    result.set(id, fallbackId);
  }
  return result;
}

/** True while the ticket still has a line that is not voided. */
async function hasLiveLines(
  tx: Tx,
  context: ScopedTenantContext,
  ticketId: string,
): Promise<boolean> {
  const [live] = await tx
    .select({ id: kitchenTicketItems.id })
    .from(kitchenTicketItems)
    .where(
      and(
        eq(kitchenTicketItems.tenantId, context.tenant.tenantId),
        eq(kitchenTicketItems.ticketId, ticketId),
        ne(kitchenTicketItems.status, "voided"),
      ),
    )
    .limit(1);
  return live !== undefined;
}

const unresolvedStation = () =>
  new CoreError(
    "CONFLICT",
    "Stasiun dapur untuk menu ini belum diatur di outlet ini.",
  );

// ---- POS void (KDS-03) --------------------------------------------------------------

/**
 * Voids the ticket lines of voided POS lines in the CALLER's transaction and
 * cancels a ticket once all its lines are voided.
 */
export async function cancelKitchenItemsForVoidedLines(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    orderId: string;
    itemIds: readonly string[];
    reason: string;
    actor: KdsActor | null;
    now: Date;
  },
): Promise<void> {
  const outletId = outletIdSchema.parse(input.outletId);
  if (input.itemIds.length === 0) return;
  const tenantId = context.tenant.tenantId;
  const now = input.now;
  const reason = input.reason.trim().slice(0, 200) || "Dibatalkan di kasir";
  const lineFilter = and(
    eq(kitchenTicketItems.tenantId, tenantId),
    eq(kitchenTicketItems.orderId, input.orderId),
    inArray(kitchenTicketItems.orderItemId, [...input.itemIds]),
    notInArray(kitchenTicketItems.status, ["voided", "served"]),
  );
  const touched = await tx
    .selectDistinct({ ticketId: kitchenTicketItems.ticketId })
    .from(kitchenTicketItems)
    .where(lineFilter);
  if (touched.length === 0) return;
  // Lock every touched ticket (id order) before any cursor row.
  const tickets = await tx
    .select()
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, tenantId),
        eq(kitchenTickets.outletId, outletId),
        inArray(
          kitchenTickets.id,
          touched.map((row) => row.ticketId),
        ),
      ),
    )
    .orderBy(asc(kitchenTickets.id))
    .for("update");
  const source = input.actor === null ? "system" : actorSource(input.actor);
  // Station cursors are taken in station order (same as routing), so two
  // voids spanning the same stations cannot deadlock on the cursor rows.
  tickets.sort(
    (a, b) =>
      a.stationId.localeCompare(b.stationId) || a.id.localeCompare(b.id),
  );
  for (const ticket of tickets) {
    const lines = await tx
      .select({
        id: kitchenTicketItems.id,
        orderItemId: kitchenTicketItems.orderItemId,
        status: kitchenTicketItems.status,
      })
      .from(kitchenTicketItems)
      .where(and(lineFilter, eq(kitchenTicketItems.ticketId, ticket.id)))
      .for("update");
    if (lines.length === 0) continue;
    await tx
      .update(kitchenTicketItems)
      .set({ status: "voided", voidedAt: now, updatedAt: now })
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          inArray(
            kitchenTicketItems.id,
            lines.map((line) => line.id),
          ),
        ),
      );
    const before = ticketStatusOf(ticket);
    const [live] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(kitchenTicketItems)
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.ticketId, ticket.id),
          ne(kitchenTicketItems.status, "voided"),
        ),
      );
    const cancel =
      Number(live?.count ?? 0) === 0 &&
      canTransitionKitchenTicket(before, "void");
    const after: KitchenTicketStatus = cancel ? "cancelled" : before;
    if (cancel)
      await tx
        .update(kitchenTickets)
        .set({ status: after, cancelledAt: now, updatedAt: now })
        .where(
          and(
            eq(kitchenTickets.tenantId, tenantId),
            eq(kitchenTickets.id, ticket.id),
          ),
        );
    for (const line of lines)
      await recordStatusChange(tx, context, {
        ticket,
        orderItemId: line.orderItemId,
        fromStatus: before,
        toStatus: after,
        itemFromStatus: itemStatusOf(line),
        itemToStatus: "voided",
        source,
        actor: input.actor,
        reason,
        now,
      });
    if (cancel) {
      await recordStatusChange(tx, context, {
        ticket,
        orderItemId: null,
        fromStatus: before,
        toStatus: after,
        source,
        actor: input.actor,
        reason,
        now,
      });
      await appendKitchenEvent(tx, context, "kitchen_ticket.voided", {
        ticket,
        payload: {
          outletId: ticket.outletId,
          ticketId: ticket.id,
          orderId: ticket.orderId,
          stationId: ticket.stationId,
          status: "cancelled",
          reason,
        },
        actor: input.actor,
        now,
      });
    }
    await appendStationFeed(tx, context, {
      outletId: ticket.outletId,
      stationId: ticket.stationId,
      ticketId: ticket.id,
      now,
    });
  }
}

// ---- Ticket actions ---------------------------------------------------------------

/** POST start / bump / recall / void on one ticket (own transaction). */
export async function applyKitchenTicketAction(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  ticketId: string,
  action: "start" | "bump" | "recall" | "void",
  input: { reason?: string },
  now: Date,
): Promise<KitchenTicketDetail> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const ticket = await readTicket(tx, context, outletId, ticketId, true);
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      ticket.stationId,
      now,
    );
    const reason = input.reason?.trim() || null;
    if ((action === "recall" || action === "void") && reason === null)
      throw new CoreError("VALIDATION_ERROR", "Alasan wajib diisi.");
    const before = ticketStatusOf(ticket);
    const next = nextTicketStatus(before, action);
    const ticketFilter = and(
      eq(kitchenTicketItems.tenantId, tenantId),
      eq(kitchenTicketItems.ticketId, ticket.id),
    );
    const patch: Partial<typeof kitchenTickets.$inferInsert> = {
      status: next,
      updatedAt: now,
    };
    if (action === "start") {
      patch.startedAt = ticket.startedAt ?? now;
      await tx
        .update(kitchenTicketItems)
        .set({ status: "in_progress", startedAt: now, updatedAt: now })
        .where(and(ticketFilter, eq(kitchenTicketItems.status, "queued")));
    } else if (action === "bump") {
      patch.startedAt = ticket.startedAt ?? now;
      patch.doneAt = now;
      await tx
        .update(kitchenTicketItems)
        .set({ status: "ready", startedAt: now, readyAt: now, updatedAt: now })
        .where(and(ticketFilter, eq(kitchenTicketItems.status, "queued")));
      await tx
        .update(kitchenTicketItems)
        .set({ status: "ready", readyAt: now, updatedAt: now })
        .where(and(ticketFilter, eq(kitchenTicketItems.status, "in_progress")));
    } else if (action === "recall") {
      await tx
        .update(kitchenTicketItems)
        .set({
          status: "in_progress",
          recalledCount: sql`${kitchenTicketItems.recalledCount} + 1`,
          updatedAt: now,
        })
        .where(and(ticketFilter, eq(kitchenTicketItems.status, "ready")));
    } else {
      patch.cancelledAt = now;
      await tx
        .update(kitchenTicketItems)
        .set({ status: "voided", voidedAt: now, updatedAt: now })
        .where(
          and(
            ticketFilter,
            notInArray(kitchenTicketItems.status, ["served", "voided"]),
          ),
        );
    }
    const [updated] = await tx
      .update(kitchenTickets)
      .set(patch)
      .where(
        and(
          eq(kitchenTickets.tenantId, tenantId),
          eq(kitchenTickets.id, ticket.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Kitchen ticket update returned no row");
    await recordStatusChange(tx, context, {
      ticket,
      orderItemId: null,
      fromStatus: before,
      toStatus: next,
      source: actorSource(actor),
      actor,
      reason,
      now,
    });
    await appendStationFeed(tx, context, {
      outletId: ticket.outletId,
      stationId: ticket.stationId,
      ticketId: ticket.id,
      now,
    });
    const base = {
      outletId: ticket.outletId,
      ticketId: ticket.id,
      orderId: ticket.orderId,
      stationId: ticket.stationId,
    };
    const startedAt = toIsoDateTime(updated.startedAt ?? now);
    const event = {
      start: {
        name: "kitchen_ticket.started",
        payload: { ...base, status: "in_progress", startedAt },
      },
      bump: {
        name: "kitchen_ticket.bumped",
        payload: {
          ...base,
          status: "done",
          startedAt,
          doneAt: toIsoDateTime(now),
        },
      },
      recall: {
        name: "kitchen_ticket.recalled",
        payload: { ...base, status: "recalled", reason },
      },
      void: {
        name: "kitchen_ticket.voided",
        payload: { ...base, status: "cancelled", reason },
      },
    } as const;
    await appendKitchenEvent(tx, context, event[action].name, {
      ticket,
      payload: event[action].payload,
      actor,
      now,
    });
    await auditKitchen(
      tx,
      context,
      {
        action: event[action].name,
        ticket,
        actor,
        before: { id: ticket.id, status: before },
        after: { id: ticket.id, status: next },
        reason,
      },
      now,
    );
    return freshTicketDetail(tx, context, ticket.id);
  });
}

/** PATCH priority (0..9); refused on a cancelled ticket. */
export async function setKitchenTicketPriority(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  ticketId: string,
  priority: number,
  now: Date,
): Promise<KitchenTicketDetail> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    const ticket = await readTicket(tx, context, outletId, ticketId, true);
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      ticket.stationId,
      now,
    );
    if (ticketStatusOf(ticket) === "cancelled") throw ticketCancelled();
    await tx
      .update(kitchenTickets)
      .set({ priority, updatedAt: now })
      .where(
        and(
          eq(kitchenTickets.tenantId, context.tenant.tenantId),
          eq(kitchenTickets.id, ticket.id),
        ),
      );
    await appendStationFeed(tx, context, {
      outletId: ticket.outletId,
      stationId: ticket.stationId,
      ticketId: ticket.id,
      now,
    });
    await auditKitchen(
      tx,
      context,
      {
        action: "kitchen_ticket.priority_set",
        ticket,
        actor,
        before: { id: ticket.id, priority: ticket.priority },
        after: { id: ticket.id, priority },
      },
      now,
    );
    return freshTicketDetail(tx, context, ticket.id);
  });
}

/** PATCH one ticket line's status (start / ready / serve / recall / void). */
export async function applyKitchenItemAction(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  itemId: string,
  action: KitchenItemAction,
  now: Date,
): Promise<KitchenTicketItem> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    assertOutletInScope(context.outletScope, outletId);
    const [found] = await tx
      .select({ ticketId: kitchenTicketItems.ticketId })
      .from(kitchenTicketItems)
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.outletId, outletId),
          eq(kitchenTicketItems.id, itemId),
        ),
      );
    if (!found) throw itemNotFound();
    // Ticket row first, then the line: same lock order as ticket actions.
    const ticket = await readTicket(
      tx,
      context,
      outletId,
      found.ticketId,
      true,
    );
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      ticket.stationId,
      now,
    );
    const [item] = await tx
      .select()
      .from(kitchenTicketItems)
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.id, itemId),
        ),
      )
      .for("update");
    if (!item) throw itemNotFound();
    const ticketBefore = ticketStatusOf(ticket);
    if (ticketBefore === "cancelled") throw ticketCancelled();
    // A bumped ticket only serves or voids its lines; redoing a line goes
    // through the ticket recall, so ticket and lines never drift apart.
    if (ticketBefore === "done" && action !== "serve" && action !== "void")
      throw new CoreError(
        "CONFLICT",
        "Tiket sudah selesai; panggil ulang tiketnya dulu.",
      );
    const itemBefore = itemStatusOf(item);
    const itemNext = nextItemStatus(itemBefore, action);
    const patch: Partial<TicketItemRow> = { status: itemNext, updatedAt: now };
    if (action === "start") patch.startedAt = now;
    else if (action === "ready") patch.readyAt = now;
    else if (action === "serve") patch.servedAt = now;
    else if (action === "void") patch.voidedAt = now;
    const [updatedItem] = await tx
      .update(kitchenTicketItems)
      .set({
        ...patch,
        ...(action === "recall"
          ? { recalledCount: sql`${kitchenTicketItems.recalledCount} + 1` }
          : {}),
      })
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.id, item.id),
        ),
      )
      .returning();
    if (!updatedItem) throw new Error("Kitchen item update returned no row");

    let ticketAfter: KitchenTicketStatus = ticketBefore;
    // Starting a line starts a waiting (new or recalled) ticket.
    if (
      (ticketBefore === "new" || ticketBefore === "recalled") &&
      action === "start"
    ) {
      ticketAfter = nextTicketStatus(ticketBefore, "start");
      const startedAt = ticket.startedAt ?? now;
      await tx
        .update(kitchenTickets)
        .set({ status: ticketAfter, startedAt, updatedAt: now })
        .where(
          and(
            eq(kitchenTickets.tenantId, tenantId),
            eq(kitchenTickets.id, ticket.id),
          ),
        );
      await recordStatusChange(tx, context, {
        ticket,
        orderItemId: null,
        fromStatus: ticketBefore,
        toStatus: ticketAfter,
        source: actorSource(actor),
        actor,
        reason: null,
        now,
      });
      await appendKitchenEvent(tx, context, "kitchen_ticket.started", {
        ticket,
        payload: {
          outletId: ticket.outletId,
          ticketId: ticket.id,
          orderId: ticket.orderId,
          stationId: ticket.stationId,
          status: "in_progress",
          startedAt: toIsoDateTime(startedAt),
        },
        actor,
        now,
      });
    }
    await recordStatusChange(tx, context, {
      ticket,
      orderItemId: item.orderItemId,
      fromStatus: ticketBefore,
      toStatus: ticketAfter,
      itemFromStatus: itemBefore,
      itemToStatus: itemNext,
      source: actorSource(actor),
      actor,
      reason: null,
      now,
    });
    // KDS-03: voiding the last live line cancels the ticket, as a POS void does.
    if (
      action === "void" &&
      canTransitionKitchenTicket(ticketAfter, "void") &&
      !(await hasLiveLines(tx, context, ticket.id))
    ) {
      const reason = "Semua item tiket dibatalkan di KDS.";
      const cancelledFrom = ticketAfter;
      ticketAfter = nextTicketStatus(cancelledFrom, "void");
      await tx
        .update(kitchenTickets)
        .set({ status: ticketAfter, cancelledAt: now, updatedAt: now })
        .where(
          and(
            eq(kitchenTickets.tenantId, tenantId),
            eq(kitchenTickets.id, ticket.id),
          ),
        );
      await recordStatusChange(tx, context, {
        ticket,
        orderItemId: null,
        fromStatus: cancelledFrom,
        toStatus: ticketAfter,
        source: actorSource(actor),
        actor,
        reason,
        now,
      });
      await appendKitchenEvent(tx, context, "kitchen_ticket.voided", {
        ticket,
        payload: {
          outletId: ticket.outletId,
          ticketId: ticket.id,
          orderId: ticket.orderId,
          stationId: ticket.stationId,
          status: "cancelled",
          reason,
        },
        actor,
        now,
      });
    }
    await appendStationFeed(tx, context, {
      outletId: ticket.outletId,
      stationId: ticket.stationId,
      ticketId: ticket.id,
      now,
    });
    return ticketItemDto(updatedItem);
  });
}

// ---- Reads ------------------------------------------------------------------------

/** GET one ticket (guarded on its station). */
export async function getKitchenTicketDetail(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  ticketId: string,
  now: Date,
): Promise<KitchenTicketDetail> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    const ticket = await readTicket(tx, context, outletId, ticketId, false);
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      ticket.stationId,
      now,
    );
    const [detail] = await ticketDetails(tx, context, [ticket]);
    if (!detail) throw ticketNotFound();
    return detail;
  });
}

/**
 * KDS-02 step 1: open tickets on a station (plus tickets bumped in the last
 * 30 minutes) and the cursor. The cursor is read BEFORE the tickets, so any
 * change the snapshot misses is after the cursor and comes through the feed.
 */
export async function listStationTickets(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  stationId: string,
  now: Date,
): Promise<KitchenStationSnapshot> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      stationId,
      now,
    );
    await assertStationInOutlet(tx, context, outletId, stationId);
    const sequence = await readStationCursor(tx, context, stationId);
    const tickets = await tx
      .select()
      .from(kitchenTickets)
      .where(
        and(
          eq(kitchenTickets.tenantId, context.tenant.tenantId),
          eq(kitchenTickets.outletId, outletId),
          eq(kitchenTickets.stationId, stationId),
          or(
            inArray(kitchenTickets.status, ["new", "in_progress", "recalled"]),
            and(
              eq(kitchenTickets.status, "done"),
              gte(
                kitchenTickets.doneAt,
                new Date(now.getTime() - DONE_VISIBLE_MS),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        desc(kitchenTickets.priority),
        asc(kitchenTickets.firedAt),
        asc(kitchenTickets.id),
      );
    return {
      tenantId: context.tenant.tenantId,
      outletId: outletId as KitchenStationSnapshot["outletId"],
      stationId: stationId as KitchenStationSnapshot["stationId"],
      sequence,
      generatedAt: toIsoDateTime(now),
      tickets: await ticketDetails(tx, context, tickets),
    };
  });
}

/**
 * KDS-02 resync: changes after `afterSequence`, collapsed to the latest
 * sequence per ticket, oldest first, one page of KITCHEN_FEED_PAGE_LIMIT
 * tickets. Each entry carries the ticket's current state.
 */
export async function readStationFeed(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  stationId: string,
  afterSequence: number,
  now: Date,
): Promise<KitchenStationFeed> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    await assertStationPermission(
      tx,
      context,
      actor.userId,
      PROCESS,
      stationId,
      now,
    );
    await assertStationInOutlet(tx, context, outletId, stationId);
    const latest = sql<number>`max(${kitchenStationFeed.sequence})`.mapWith(
      Number,
    );
    const rows = await tx
      .select({ ticketId: kitchenStationFeed.ticketId, sequence: latest })
      .from(kitchenStationFeed)
      .where(
        and(
          eq(kitchenStationFeed.tenantId, context.tenant.tenantId),
          eq(kitchenStationFeed.outletId, outletId),
          eq(kitchenStationFeed.stationId, stationId),
          gt(kitchenStationFeed.sequence, afterSequence),
        ),
      )
      .groupBy(kitchenStationFeed.ticketId)
      .orderBy(asc(latest))
      .limit(KITCHEN_FEED_PAGE_LIMIT + 1);
    const hasMore = rows.length > KITCHEN_FEED_PAGE_LIMIT;
    const page = rows.slice(0, KITCHEN_FEED_PAGE_LIMIT);
    const toSequence = page.at(-1)?.sequence ?? afterSequence;
    const tickets =
      page.length === 0
        ? []
        : await tx
            .select()
            .from(kitchenTickets)
            .where(
              and(
                eq(kitchenTickets.tenantId, context.tenant.tenantId),
                inArray(
                  kitchenTickets.id,
                  page.map((row) => row.ticketId),
                ),
              ),
            );
    const details = new Map(
      (await ticketDetails(tx, context, tickets)).map((detail) => [
        detail.id as string,
        detail,
      ]),
    );
    return {
      stationId: stationId as KitchenStationFeed["stationId"],
      afterSequence,
      toSequence,
      hasMore,
      entries: page.map((row) => {
        const ticket = details.get(row.ticketId);
        if (!ticket) throw new Error("Feed ticket vanished");
        return { sequence: row.sequence, ticket };
      }),
    };
  });
}

/** Realtime relay entry point; same guards as the HTTP feed. */
export const readStationFeedForRealtime = readStationFeed;
