// KDS routing and ticket lifecycle (bead legend-4d5; PRD v1.7 §3 F12 "KDS,
// Expo & Pickup Display"; contract @starter/shared/kitchen).
//
// - KDS-01: a POS or QR fire routes each fired line to the station of its menu
//   item inside the fire transaction (`routeFiredItemsToKitchen`), one ticket
//   per station per fire. The menu names a station TYPE that each outlet
//   resolves to its own station (legend-s2dh); a rule that cannot be resolved
//   in the order's outlet fails the whole fire (no line silently vanishes).
// - KDS-02: every ticket change appends one gapless per-station feed row
//   (kds-support.ts `appendStationFeed`); displays resume from their cursor.
// - KDS-03: voiding a fired POS line voids its ticket line in the same
//   transaction; a ticket whose lines are all voided is cancelled. A void on
//   the KDS stays kitchen-only (the bill changes only through an approved POS
//   void) but appends an `order.kitchen_voided` order event so the cashier
//   sees it.
// - KDS-04: every status change writes an append-only status change row with
//   time, actor and source.
//
// Lock order: `orders` row, then ticket rows (ordered by station, id), then
// station cursor rows. The POS paths already hold the `orders` row; a KDS void
// takes it before its ticket, so two writers never wait on each other in a
// cycle.

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
import { AccessError } from "@starter/shared/access";
import type { PrintPaperWidth, PrintPayload } from "@starter/shared/pos";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  toIsoDateTime,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  userIdSchema,
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
  type StationSummary,
  type KitchenTicketAction,
  type KitchenTicketDetail,
  type KitchenTicketItem,
  type KitchenTicketStatus,
} from "@starter/shared/kitchen";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  facilityLinkedOrders,
  menuItems,
  outlets,
  stations,
} from "../db/schema/index.ts";
import {
  kitchenStationFeed,
  kitchenTicketItems,
  kitchenTickets,
} from "../db/schema/kds.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  appendOrderEvent,
  businessDateFor,
  loadOutlet,
} from "./pos-order-support.ts";
import {
  notifyQrKitchenVoid,
  notifyUnroutedQrLines,
} from "./kds-staff-alerts.ts";
import {
  actorSource,
  appendKitchenEvent,
  appendStationFeed,
  assertFeedResumable,
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
import {
  assertStationPermission,
  permittedStationIds,
  stationScopeCondition,
} from "./station-access.ts";
import { stationTicketPayload } from "./kds-print.service.ts";

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
const ticketMoved = () =>
  new CoreError(
    "CONFLICT",
    "Tiket dapur dipindah ke stasiun lain; muat ulang lalu coba lagi.",
  );

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

/**
 * By-id paths: a ticket (or line) of a station outside the caller's reach
 * answers exactly like an unknown id, so the status code cannot be used to
 * probe which ids exist. Runs before any lock is taken.
 */
async function assertTicketStationPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  stationId: string,
  now: Date,
  notFound: () => CoreError,
): Promise<void> {
  try {
    await assertStationPermission(
      tx,
      context,
      actorUserId,
      PROCESS,
      stationId,
      now,
    );
  } catch (error) {
    if (error instanceof AccessError && error.code === "PERMISSION_DENIED")
      throw notFound();
    throw error;
  }
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
 * App-level guard (the DB trigger `kitchen_tickets_breakfast_paid` is the
 * backstop): a facility breakfast order (channel 'facility' or a linked row)
 * reaches the kitchen only after its payment was verified.
 */
async function assertBreakfastPaid(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<void> {
  const [order] = await tx
    .select({ channel: orders.channel })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  const [linked] = await tx
    .select({
      status: facilityLinkedOrders.status,
      paidAt: facilityLinkedOrders.paidAt,
    })
    .from(facilityLinkedOrders)
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, tenantId),
        eq(facilityLinkedOrders.orderId, orderId),
      ),
    )
    .limit(1);
  if (order?.channel !== "facility" && !linked) return;
  // Only `fired` (paid_at set) passes: the fire path flips paid -> fired
  // before it routes, so a merely `paid` row must not reach the kitchen.
  if (linked && linked.paidAt !== null && linked.status === "fired") return;
  throw new HttpError(
    409,
    "BREAKFAST_NOT_PAID",
    "The breakfast order is not paid yet.",
  );
}

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
    /**
     * `fail` (POS, default): a line whose station cannot be resolved rolls
     * the fire back, so the cashier sees it before anything happens. `skip`
     * (QR, possibly after the guest paid): such lines stay unrouted and are
     * audited (`kitchen_ticket.unrouted`) instead of failing the order.
     */
    onUnresolved?: "fail" | "skip";
  },
): Promise<{ ticketIds: string[]; unroutedItemIds: string[] }> {
  const outletId = outletIdSchema.parse(input.outletId);
  if (input.itemIds.length === 0) return { ticketIds: [], unroutedItemIds: [] };
  const tenantId = context.tenant.tenantId;
  await assertBreakfastPaid(tx, tenantId, input.orderId);
  const rows = await tx
    .select({
      item: orderItems,
      overrideStationId: menuItems.stationId,
      stationType: menuItems.stationType,
    })
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
        or(isNotNull(menuItems.stationType), isNotNull(menuItems.stationId)),
        isNull(kitchenTicketItems.id),
      ),
    )
    .orderBy(asc(orderItems.id));
  if (rows.length === 0) return { ticketIds: [], unroutedItemIds: [] };

  const skipUnresolved = input.onUnresolved === "skip";
  const resolved = await resolveStations(
    tx,
    context,
    outletId,
    rows,
    skipUnresolved,
  );
  const byStation = new Map<string, (typeof rows)[number]["item"][]>();
  const unroutedItemIds: string[] = [];
  for (const row of rows) {
    const { item } = row;
    const stationId = resolved.get(stationRuleKey(row));
    if (stationId === undefined) {
      if (!skipUnresolved) throw new Error("Station resolution missed");
      unroutedItemIds.push(item.id);
      continue;
    }
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
    const { businessDate, ticketNo } = await nextKitchenTicketNo(
      tx,
      context,
      outletId,
      now,
    );
    const [ticket] = await tx
      .insert(kitchenTickets)
      .values({
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        orderId: input.orderId,
        stationId,
        fireBatchId,
        businessDate,
        ticketNo,
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
  if (unroutedItemIds.length > 0)
    await auditKitchen(
      tx,
      context,
      {
        action: "kitchen_ticket.unrouted",
        ticket: { id: input.orderId, outletId },
        objectType: "order",
        actor: input.actor,
        before: null,
        after: { orderId: input.orderId, itemIds: unroutedItemIds },
        reason: "Stasiun dapur untuk menu ini belum diatur di outlet ini.",
      },
      now,
    );
  // QR orders only; once per (order, line) however often routing is re-run.
  await notifyUnroutedQrLines(tx, context, {
    outletId,
    orderId: input.orderId,
    itemIds: unroutedItemIds,
    now,
  });
  return { ticketIds, unroutedItemIds };
}

/**
 * Takes the ticket-number lock of the outlet's business day: one advisory
 * lock per (tenant, outlet, business day), held to the end of the caller's
 * transaction (re-taking it in the same transaction is free). Returns the
 * business day the lock covers.
 *
 * LOCK ORDER RULE (deadlock, legend-tzyj2): take the ticket-number lock
 * BEFORE any station-feed lock (`appendStationFeed`, the cursor row of a
 * station). A POS fire takes ticket-no then feed; a path that voids kitchen
 * items first (feed lock) and routes after (ticket-no lock) would close the
 * cycle against it. Such a path calls this function first, then voids.
 */
export async function lockKitchenTicketNo(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<string> {
  const tenantId = context.tenant.tenantId;
  const businessDate = businessDateFor(
    await loadOutlet(tx, context, outletId),
    now,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kitchen-ticket-no:${tenantId}:${outletId}:${businessDate}`}, 0))`,
  );
  return businessDate;
}

/**
 * Next ticket number of the outlet's business day (pickup.service.ts
 * pattern): the ticket-number lock (`lockKitchenTicketNo`), then `max + 1`.
 * The lock lasts to the end of the caller's transaction, so two concurrent
 * fires never read the same max, and a repeat call in the same transaction
 * sees the tickets inserted so far.
 */
async function nextKitchenTicketNo(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<{ businessDate: string; ticketNo: number }> {
  const tenantId = context.tenant.tenantId;
  const businessDate = await lockKitchenTicketNo(tx, context, outletId, now);
  const [top] = await tx
    .select({
      max: sql<number | null>`max(${kitchenTickets.ticketNo})`.mapWith(Number),
    })
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, tenantId),
        eq(kitchenTickets.outletId, outletId),
        eq(kitchenTickets.businessDate, businessDate),
      ),
    );
  return { businessDate, ticketNo: (top?.max ?? 0) + 1 };
}

type StationRule = {
  overrideStationId: string | null;
  stationType: string | null;
};

const stationRuleKey = (rule: StationRule) =>
  `${rule.overrideStationId ?? ""}|${rule.stationType ?? ""}`;

/**
 * Menu routing rule -> station that receives the ticket in `outletId`
 * (bead legend-s2dh). A menu item is brand level and names a station TYPE;
 * each outlet resolves it to its own live station of that type (first by
 * name, id). The item's `station_id` is only an override inside that
 * station's outlet: elsewhere it is ignored (and usually invisible under
 * outlet RLS). A legacy row with an override but no type falls back to the
 * override's type when the caller can see it. An inactive target falls back to
 * the first active station by display order, name, id (or itself if none exist).
 * Nothing resolves => CONFLICT,
 * so the fire rolls back instead of losing the line.
 */
async function resolveStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  rules: readonly StationRule[],
  skipUnresolved = false,
): Promise<Map<string, string>> {
  const tenantId = context.tenant.tenantId;
  const overrideIds = [
    ...new Set(
      rules.flatMap((rule) =>
        rule.overrideStationId === null ? [] : [rule.overrideStationId],
      ),
    ),
  ];
  const overrides =
    overrideIds.length === 0
      ? []
      : await tx
          .select()
          .from(stations)
          .where(
            and(
              eq(stations.tenantId, tenantId),
              inArray(stations.id, overrideIds),
            ),
          );
  const overrideById = new Map(overrides.map((row) => [row.id, row]));
  const [fallback] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        eq(stations.isActive, true),
        isNull(stations.deletedAt),
      ),
    )
    .orderBy(asc(stations.displayOrder), asc(stations.name), asc(stations.id))
    .limit(1);
  const byType = new Map<string, { id: string; isActive: boolean } | null>();
  const stationOfType = async (type: string) => {
    if (!byType.has(type)) {
      const [found] = await tx
        .select({ id: stations.id, isActive: stations.isActive })
        .from(stations)
        .where(
          and(
            eq(stations.tenantId, tenantId),
            eq(stations.outletId, outletId),
            eq(stations.type, type),
            isNull(stations.deletedAt),
          ),
        )
        .orderBy(asc(stations.name), asc(stations.id))
        .limit(1);
      byType.set(type, found ?? null);
    }
    return byType.get(type) ?? null;
  };
  const result = new Map<string, string>();
  for (const rule of rules) {
    const key = stationRuleKey(rule);
    if (result.has(key)) continue;
    const override =
      rule.overrideStationId === null
        ? undefined
        : overrideById.get(rule.overrideStationId);
    if (
      override &&
      override.outletId === outletId &&
      override.deletedAt === null
    ) {
      result.set(
        key,
        override.isActive ? override.id : (fallback?.id ?? override.id),
      );
      continue;
    }
    const type = rule.stationType ?? override?.type ?? null;
    const stationId = type === null ? null : await stationOfType(type);
    if (stationId === null) {
      if (skipUnresolved) continue;
      throw unresolvedStation();
    }
    result.set(
      key,
      stationId.isActive ? stationId.id : (fallback?.id ?? stationId.id),
    );
  }
  return result;
}

type OrderRef = Pick<typeof orders.$inferSelect, "id" | "outletId">;

/**
 * Locks the ticket's order row before any ticket row (the POS lock order), so
 * a KDS void can append the order event the cashier reads.
 */
async function lockOrderOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<OrderRef> {
  const [order] = await tx
    .select({ id: orders.id, outletId: orders.outletId })
    .from(orders)
    .where(
      and(eq(orders.tenantId, context.tenant.tenantId), eq(orders.id, orderId)),
    )
    .for("update");
  if (!order) throw ticketNotFound();
  return order;
}

/**
 * KDS void -> POS notice. The bill is untouched (voiding a billed line needs
 * an approved POS void); the cashier reads this event on the order.
 */
async function notifyPosOfKitchenVoid(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: OrderRef;
    ticket: TicketRow;
    orderItemIds: readonly string[];
    ticketCancelled: boolean;
    reason: string | null;
    actor: KdsActor;
    now: Date;
  },
): Promise<void> {
  await appendOrderEvent(tx, context, {
    order: input.order,
    type: "order.kitchen_voided",
    payload: {
      ticketId: input.ticket.id,
      stationId: input.ticket.stationId,
      orderItemIds: [...input.orderItemIds],
      ticketCancelled: input.ticketCancelled,
      reason: input.reason,
    },
    caller: {
      userId: userIdSchema.parse(input.actor.userId),
      deviceId: input.actor.deviceId,
    },
    now: input.now,
  });
  // QR orders have no cashier screen: tell the table's waiter (or KDS managers).
  await notifyQrKitchenVoid(tx, context, {
    order: input.order,
    ticketId: input.ticket.id,
    stationId: input.ticket.stationId,
    orderItemIds: input.orderItemIds,
    ticketCancelled: input.ticketCancelled,
    reason: input.reason,
    now: input.now,
  });
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
    // Permission first, on an unlocked read: a denied user must never queue
    // behind (or hold) the order and ticket locks of a busy kitchen.
    const unlocked = await readTicket(tx, context, outletId, ticketId, false);
    await assertTicketStationPermission(
      tx,
      context,
      actor.userId,
      unlocked.stationId,
      now,
      ticketNotFound,
    );
    const order =
      action === "void"
        ? await lockOrderOf(tx, context, unlocked.orderId)
        : null;
    const ticket = await readTicket(tx, context, outletId, ticketId, true);
    // The check above covered the station read before locking; refuse if the
    // ticket moved meanwhile instead of acting on a station never checked.
    if (ticket.stationId !== unlocked.stationId) throw ticketMoved();
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
    const voidedLines: string[] = [];
    // Line statuses before the change (ticket row is locked, so these cannot
    // move under us): every action writes one audit row per moved line.
    const linesBefore = await tx
      .select({
        orderItemId: kitchenTicketItems.orderItemId,
        status: kitchenTicketItems.status,
      })
      .from(kitchenTicketItems)
      .where(ticketFilter)
      .orderBy(kitchenTicketItems.orderItemId);
    const lineMoves: {
      orderItemId: string;
      from: KitchenItemStatus;
      to: KitchenItemStatus;
    }[] = [];
    for (const line of linesBefore) {
      const from = line.status as KitchenItemStatus;
      const to: KitchenItemStatus | null =
        action === "start"
          ? from === "queued"
            ? "in_progress"
            : null
          : action === "bump"
            ? from === "queued" || from === "in_progress"
              ? "ready"
              : null
            : action === "recall"
              ? from === "ready"
                ? "in_progress"
                : null
              : from === "served" || from === "voided"
                ? null
                : "voided";
      if (to) lineMoves.push({ orderItemId: line.orderItemId, from, to });
    }
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
          // The line is being redone, so its old ready time no longer holds.
          readyAt: null,
          recalledCount: sql`${kitchenTicketItems.recalledCount} + 1`,
          updatedAt: now,
        })
        .where(and(ticketFilter, eq(kitchenTicketItems.status, "ready")));
    } else {
      patch.cancelledAt = now;
      const voided = await tx
        .update(kitchenTicketItems)
        .set({ status: "voided", voidedAt: now, updatedAt: now })
        .where(
          and(
            ticketFilter,
            notInArray(kitchenTicketItems.status, ["served", "voided"]),
          ),
        )
        .returning({ orderItemId: kitchenTicketItems.orderItemId });
      voidedLines.push(...voided.map((line) => line.orderItemId));
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
    for (const move of lineMoves)
      await recordStatusChange(tx, context, {
        ticket,
        orderItemId: move.orderItemId,
        fromStatus: before,
        toStatus: next,
        itemFromStatus: move.from,
        itemToStatus: move.to,
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
    if (order)
      await notifyPosOfKitchenVoid(tx, context, {
        order,
        ticket,
        orderItemIds: voidedLines.sort(),
        ticketCancelled: true,
        reason,
        actor,
        now,
      });
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
    // Permission on an unlocked read first: a caller without access never
    // takes or waits on the ticket row lock.
    const unlocked = await readTicket(tx, context, outletId, ticketId, false);
    await assertTicketStationPermission(
      tx,
      context,
      actor.userId,
      unlocked.stationId,
      now,
      ticketNotFound,
    );
    const ticket = await readTicket(tx, context, outletId, ticketId, true);
    if (ticket.stationId !== unlocked.stationId) throw ticketMoved();
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
      .select({
        ticketId: kitchenTicketItems.ticketId,
        orderId: kitchenTicketItems.orderId,
      })
      .from(kitchenTicketItems)
      .where(
        and(
          eq(kitchenTicketItems.tenantId, tenantId),
          eq(kitchenTicketItems.outletId, outletId),
          eq(kitchenTicketItems.id, itemId),
        ),
      );
    if (!found) throw itemNotFound();
    // Permission first, on an unlocked read: a denied user must never queue
    // behind (or hold) the order and ticket locks of a busy kitchen.
    const unlocked = await readTicket(
      tx,
      context,
      outletId,
      found.ticketId,
      false,
    );
    await assertTicketStationPermission(
      tx,
      context,
      actor.userId,
      unlocked.stationId,
      now,
      itemNotFound,
    );
    // Then order row (void only), ticket row, and the line: the ticket-action order.
    const order =
      action === "void" ? await lockOrderOf(tx, context, found.orderId) : null;
    const ticket = await readTicket(
      tx,
      context,
      outletId,
      found.ticketId,
      true,
    );
    // Refuse if the ticket moved between the permission check and the lock.
    if (ticket.stationId !== unlocked.stationId) throw ticketMoved();
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
    // The line is being redone, so its old ready time no longer holds.
    else if (action === "recall") patch.readyAt = null;
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
    if (order)
      await notifyPosOfKitchenVoid(tx, context, {
        order,
        ticket,
        orderItemIds: [item.orderItemId],
        ticketCancelled: ticketAfter === "cancelled",
        reason: null,
        actor,
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
    await assertTicketStationPermission(
      tx,
      context,
      actor.userId,
      ticket.stationId,
      now,
      ticketNotFound,
    );
    const [detail] = await ticketDetails(tx, context, [ticket]);
    if (!detail) throw ticketNotFound();
    return detail;
  });
}

/** P1: the ticket as ESC/POS bytes for the tablet's own printer. */
export async function getKitchenTicketPrint(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  ticketId: string,
  paperWidth: PrintPaperWidth,
  now: Date,
  /** The tablet prints this ticket again: the bytes carry the banner. */
  reprint = false,
): Promise<PrintPayload> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    const ticket = await readTicket(tx, context, outletId, ticketId, false);
    await assertTicketStationPermission(
      tx,
      context,
      actor.userId,
      ticket.stationId,
      now,
      ticketNotFound,
    );
    const [detail] = await ticketDetails(tx, context, [ticket]);
    if (!detail) throw ticketNotFound();
    const [station] = await tx
      .select({ name: stations.name })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          eq(stations.id, ticket.stationId),
        ),
      );
    return stationTicketPayload(
      detail,
      station?.name ?? "Dapur",
      paperWidth,
      reprint,
    );
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
 * legend-tsp5: open-ticket count (new, in progress, recalled) of every active
 * station of the outlet the caller may process. A station-only caller sees only
 * their own stations; a station with no open ticket reports 0.
 */
export async function getStationSummary(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  now: Date,
): Promise<StationSummary> {
  const outletId = outletIdSchema.parse(outletRef);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    // An outlet of another tenant (or an unknown one) answers 404, not an
    // empty 200, so the status cannot be used to probe which outlets exist.
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const permitted = await permittedStationIds(
      tx,
      context,
      actor.userId,
      PROCESS,
      now,
    );
    const rows = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          isNull(stations.deletedAt),
          stationScopeCondition(stations.id, permitted),
        ),
      )
      .orderBy(asc(stations.id));
    const open = await tx
      .select({
        stationId: kitchenTickets.stationId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(kitchenTickets)
      .where(
        and(
          eq(kitchenTickets.tenantId, context.tenant.tenantId),
          eq(kitchenTickets.outletId, outletId),
          inArray(kitchenTickets.status, ["new", "in_progress", "recalled"]),
          stationScopeCondition(kitchenTickets.stationId, permitted),
        ),
      )
      .groupBy(kitchenTickets.stationId);
    const countOf = new Map(open.map((row) => [row.stationId, row.count]));
    return {
      tenantId: context.tenant.tenantId,
      outletId: outletId as StationSummary["outletId"],
      generatedAt: toIsoDateTime(now),
      stations: rows.map((row) => ({
        stationId: row.id as StationSummary["stations"][number]["stationId"],
        openTickets: countOf.get(row.id) ?? 0,
      })),
    };
  });
}

/**
 * KDS-02 resync: changes after `afterSequence`, collapsed to the latest
 * sequence per ticket, oldest first, one page of KITCHEN_FEED_PAGE_LIMIT
 * tickets. Each entry carries the ticket's current state. Throws 409
 * KDS_RESYNC_REQUIRED when `afterSequence` cannot be resumed (see
 * assertFeedResumable); `options.maxLag` lowers the lag limit for tests.
 */
export async function readStationFeed(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletRef: string,
  stationId: string,
  afterSequence: number,
  now: Date,
  options: { maxLag?: number } = {},
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
    // `afterSequence` is client input: refuse a cursor that cannot resume so
    // the screen reloads its snapshot instead of silently missing changes.
    await assertFeedResumable(
      tx,
      context,
      stationId,
      afterSequence,
      options.maxLag,
    );
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
    // READ COMMITTED: a prune can commit between the check above and this
    // read and remove rows right after `afterSequence`. Re-check so a hole is
    // a resync, never a silently skipped change (KDS-02).
    await assertFeedResumable(
      tx,
      context,
      stationId,
      afterSequence,
      options.maxLag,
    );
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
