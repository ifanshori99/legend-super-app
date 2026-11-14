// Shared plumbing of the KDS service (bead legend-4d5; PRD v1.7 §3 F12 "KDS,
// Expo & Pickup Display"; KDS-01..KDS-04; contract @starter/shared/kitchen):
// the per-station change feed and its wake-up signal, the append-only status
// change log, the transactional outbox (kitchen contract events only), audit
// and the contract DTOs.
//
// Feed (KDS-02): every change to a ticket appends one `kitchen_station_feed`
// row. Its sequence comes from `kitchen_station_cursors` via an upsert that
// takes the station's cursor row lock, so writers on one station serialize
// and sequences commit in order with no gap. A `pg_notify` carrying ids only
// (delivered at commit, same rule as qr-order-realtime-signal.ts) wakes the
// realtime relay, which re-reads the feed under each socket's own identity.
//
// Resume and pruning: a client cursor is untrusted. `assertFeedResumable`
// refuses (409 KDS_RESYNC_REQUIRED) a cursor ahead of the station, too far
// behind it, or whose following rows are gone; the client reloads the
// snapshot. Old rows are pruned from `appendStationFeed` now and then.

import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  toIsoDateTime,
  ulidToUuid,
  uuidSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  KDS_RESYNC_REQUIRED,
  KITCHEN_FEED_MAX_LAG,
  KITCHEN_FEED_RETENTION_HOURS,
  kitchenEvents,
  kitchenItemStatusSchema,
  kitchenTicketDetailSchema,
  kitchenTicketItemSchema,
  kitchenTicketStatusSchema,
  type KitchenEventName,
  type KitchenItemStatus,
  type KitchenTicketDetail,
  type KitchenTicketItem,
  type KitchenTicketStatus,
} from "@starter/shared/kitchen";
import { HttpError } from "../lib/http-error.ts";
import type { OrderChannel, ServiceType } from "@starter/shared/pos";
import {
  domainEventOutbox,
  orders,
  tables,
  tableSessions,
} from "../db/schema/index.ts";
import {
  kitchenStationCursors,
  kitchenStationFeed,
  kitchenTicketItems,
  kitchenTickets,
  kitchenTicketStatusChanges,
} from "../db/schema/kds.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { Tx } from "./menu-internals.ts";
import { posPriceChannel } from "./pos-order-pricing.ts";

export type TicketRow = typeof kitchenTickets.$inferSelect;
export type TicketItemRow = typeof kitchenTicketItems.$inferSelect;

/** Who acts on a ticket: the verified session user and, if any, the device. */
export type KdsActor = { userId: string; deviceId: string | null };

export const KDS_WAKE_CHANNEL = "legend_kds_wakeup";

/** NOTIFY payload: identifiers only, never ticket contents. */
export const kdsWakeSignalSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  stationId: uuidSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type KdsWakeSignal = z.infer<typeof kdsWakeSignalSchema>;

/**
 * Prune the station feed when the new sequence is a multiple of this: often
 * enough to bound the table, rare enough to cost one range delete per 500
 * changes instead of one per change.
 */
const FEED_PRUNE_EVERY = 500;

/**
 * The client must reload the snapshot (409 `KDS_RESYNC_REQUIRED`). `sequence`
 * is the station's current cursor, which the realtime relay sends in its
 * `resync` frame; the HTTP error body carries only code and message.
 */
export class KdsResyncRequiredError extends HttpError {
  constructor(public readonly sequence: number) {
    super(
      409,
      KDS_RESYNC_REQUIRED,
      "Kursor tidak dapat dilanjutkan. Muat ulang tiket stasiun lalu sambungkan lagi.",
    );
    this.name = "KdsResyncRequiredError";
  }
}

const EVENT_DESTINATION = "cloud-sync";
const AUDIT_SAFE_FIELDS = [
  "id",
  "status",
  "orderId",
  "stationId",
  "priority",
  "itemCount",
  "itemIds",
  "reason",
];
/** Contract max for one modifier name / note (kitchen schemas `name`). */
const TEXT_MAX = 150;

/**
 * Appends one feed row for `ticketId` on its station in the caller's
 * transaction and queues the wake-up signal. Returns the new sequence.
 */
export async function appendStationFeed(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; stationId: string; ticketId: string; now: Date },
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  // The upsert takes the cursor row lock: the next writer on this station
  // waits until this transaction ends, so sequences are gapless and commit
  // in order.
  const [cursor] = await tx
    .insert(kitchenStationCursors)
    .values({
      tenantId,
      outletId: outletIdSchema.parse(input.outletId),
      stationId: input.stationId,
      lastSequence: 1,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [kitchenStationCursors.tenantId, kitchenStationCursors.stationId],
      set: {
        lastSequence: sql`${kitchenStationCursors.lastSequence} + 1`,
        updatedAt: input.now,
      },
    })
    .returning({ lastSequence: kitchenStationCursors.lastSequence });
  if (!cursor) throw new Error("Station cursor upsert returned no row");
  const sequence = Number(cursor.lastSequence);
  await tx.insert(kitchenStationFeed).values({
    id: createUlid(input.now.getTime()),
    tenantId,
    outletId: outletIdSchema.parse(input.outletId),
    stationId: input.stationId,
    sequence,
    ticketId: input.ticketId,
    occurredAt: input.now,
  });
  if (sequence % FEED_PRUNE_EVERY === 0)
    await pruneStationFeed(tx, context, input.stationId, sequence);
  const signal = kdsWakeSignalSchema.parse({
    tenantId,
    outletId: input.outletId,
    stationId: input.stationId,
    sequence,
  });
  await tx.execute(
    sql`SELECT pg_notify(${KDS_WAKE_CHANNEL}, ${JSON.stringify(signal)})`,
  );
  return sequence;
}

/**
 * Deletes feed rows that are both older than the retention and more than
 * KITCHEN_FEED_MAX_LAG behind `newest` (a cursor that far back resyncs anyway,
 * so nobody can need them). Runs under the cursor row lock taken by the
 * caller. The age test uses the database clock, the same as the append-only
 * trigger on the table: an app clock that drifts can never make the trigger
 * refuse the delete and fail a fire. The range scan uses the unique
 * (tenant, station, sequence) index.
 */
async function pruneStationFeed(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
  newest: number,
): Promise<void> {
  await tx
    .delete(kitchenStationFeed)
    .where(
      and(
        eq(kitchenStationFeed.tenantId, context.tenant.tenantId),
        eq(kitchenStationFeed.stationId, stationId),
        lt(kitchenStationFeed.sequence, newest - KITCHEN_FEED_MAX_LAG),
        sql`${kitchenStationFeed.occurredAt} < now() - make_interval(hours => ${KITCHEN_FEED_RETENTION_HOURS})`,
      ),
    );
}

/**
 * Throws KdsResyncRequiredError unless the feed can continue from `after`:
 * not ahead of the station cursor, at most `maxLag` behind it, and the row
 * right after it (`after + 1`) still exists. `after` comes from the client,
 * so it is never trusted. A station with no cursor row counts as sequence 0.
 */
export async function assertFeedResumable(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
  after: number,
  maxLag: number = KITCHEN_FEED_MAX_LAG,
): Promise<void> {
  const current = await readStationCursor(tx, context, stationId);
  if (after > current || current - after > maxLag)
    throw new KdsResyncRequiredError(current);
  if (after === current) return;
  const [oldest] = await tx
    .select({
      sequence: sql<number>`min(${kitchenStationFeed.sequence})`.mapWith(
        Number,
      ),
    })
    .from(kitchenStationFeed)
    .where(
      and(
        eq(kitchenStationFeed.tenantId, context.tenant.tenantId),
        eq(kitchenStationFeed.stationId, stationId),
      ),
    );
  // `min` is null (mapped to 0) only when every row is gone: also a gap.
  if (!oldest || oldest.sequence === 0 || oldest.sequence > after + 1)
    throw new KdsResyncRequiredError(current);
}

/** The station cursor (0 before the first change), read in the caller's tx. */
export async function readStationCursor(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
): Promise<number> {
  const [row] = await tx
    .select({ lastSequence: kitchenStationCursors.lastSequence })
    .from(kitchenStationCursors)
    .where(
      and(
        eq(kitchenStationCursors.tenantId, context.tenant.tenantId),
        eq(kitchenStationCursors.stationId, stationId),
      ),
    );
  return Number(row?.lastSequence ?? 0);
}

/** KDS-04: one append-only status change row (ticket or per item). */
export async function recordStatusChange(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    ticket: Pick<TicketRow, "id" | "outletId" | "orderId" | "stationId">;
    orderItemId: string | null;
    fromStatus: KitchenTicketStatus | null;
    toStatus: KitchenTicketStatus;
    itemFromStatus?: KitchenItemStatus | null;
    itemToStatus?: KitchenItemStatus | null;
    source: "user" | "device" | "system";
    actor: KdsActor | null;
    reason: string | null;
    now: Date;
  },
): Promise<void> {
  await tx.insert(kitchenTicketStatusChanges).values({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.ticket.outletId,
    ticketId: input.ticket.id,
    orderId: input.ticket.orderId,
    stationId: input.ticket.stationId,
    orderItemId: input.orderItemId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    itemFromStatus: input.itemFromStatus ?? null,
    itemToStatus: input.itemToStatus ?? null,
    source: input.source,
    actorId: input.source === "system" ? null : (input.actor?.userId ?? null),
    deviceId: input.actor?.deviceId ?? null,
    reason: input.reason,
    occurredAt: input.now,
  });
}

/** `device` when a KDS device acted, otherwise the signed-in user. */
export function actorSource(actor: KdsActor): "user" | "device" {
  return actor.deviceId === null ? "user" : "device";
}

/**
 * One kitchen contract event (kitchen/events.ts) on the transactional outbox,
 * in the caller's transaction; aggregate = the ticket, gapless per ticket
 * (the caller holds the ticket row lock or just inserted the ticket).
 */
export async function appendKitchenEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: KitchenEventName,
  input: {
    ticket: Pick<TicketRow, "id" | "outletId">;
    payload: Record<string, unknown>;
    actor: KdsActor | null;
    now: Date;
  },
): Promise<void> {
  const definition = kitchenEvents[name];
  const aggregateType = definition.entry.aggregateType;
  const aggregateUuid = ulidToUuid(input.ticket.id);
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateUuid),
      ),
    );
  const sequence = Number(row?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.ticket.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType,
    aggregateId: input.ticket.id,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor:
      input.actor === null
        ? { type: "system" }
        : { type: "user", id: input.actor.userId },
    deviceId: input.actor?.deviceId ?? null,
    idempotencyKey: `${definition.name}:${input.ticket.id}:${sequence}`.slice(
      0,
      100,
    ),
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

export async function auditKitchen(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    ticket: Pick<TicketRow, "id" | "outletId">;
    /** Audited object; default the ticket. */
    objectType?: "kitchen_ticket" | "order";
    actor: KdsActor | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.ticket.outletId,
      actorType: input.actor === null ? "system" : "user",
      actorId: input.actor?.userId ?? null,
      deviceId: input.actor?.deviceId ?? null,
      action: input.action,
      objectType: input.objectType ?? "kitchen_ticket",
      objectId: input.ticket.id,
      reason: input.reason ?? null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, AUDIT_SAFE_FIELDS),
        after:
          input.after === null
            ? null
            : maskAuditChanges(input.after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- DTOs ---------------------------------------------------------------------

export function ticketStatusOf(row: Pick<TicketRow, "status">) {
  return kitchenTicketStatusSchema.parse(row.status);
}

export function itemStatusOf(row: Pick<TicketItemRow, "status">) {
  return kitchenItemStatusSchema.parse(row.status);
}

const iso = (value: Date | null): string | null =>
  value === null ? null : toIsoDateTime(value);

/** Contract text: trimmed, empty -> null, capped at the contract length. */
function contractText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, TEXT_MAX);
}

export function ticketItemDto(row: TicketItemRow): KitchenTicketItem {
  return kitchenTicketItemSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    ticketId: row.ticketId,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    name: row.name,
    quantity: row.quantity,
    course: contractText(row.course),
    modifiers: row.modifiers
      .map((modifier) => contractText(modifier))
      .filter((modifier): modifier is string => modifier !== null),
    note: contractText(row.note),
    status: row.status,
    firedAt: toIsoDateTime(row.firedAt),
    startedAt: iso(row.startedAt),
    readyAt: iso(row.readyAt),
    servedAt: iso(row.servedAt),
    recalledCount: row.recalledCount,
  });
}

/** What the KDS header reads from the ticket's order (legend-rutl). */
type OrderHeader = Pick<KitchenTicketDetail, "tableLabel" | "channel">;

function ticketDetailDto(
  row: TicketRow,
  items: readonly TicketItemRow[],
  header: OrderHeader,
): KitchenTicketDetail {
  return kitchenTicketDetailSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    orderId: row.orderId,
    stationId: row.stationId,
    ticketNo: row.ticketNo,
    status: row.status,
    priority: row.priority,
    firedAt: toIsoDateTime(row.firedAt),
    startedAt: iso(row.startedAt),
    doneAt: iso(row.doneAt),
    servedAt: iso(row.servedAt),
    printedFallback: row.printedFallback,
    tableLabel: header.tableLabel,
    channel: header.channel,
    items: items.map(ticketItemDto),
  });
}

/**
 * Table code and menu channel of each ticket's order, read in one query. The
 * table comes from the order's table session; an order without one has none.
 */
async function orderHeaders(
  tx: Tx,
  context: ScopedTenantContext,
  tickets: readonly TicketRow[],
): Promise<Map<string, OrderHeader>> {
  const rows = await tx
    .select({
      id: orders.id,
      channel: orders.channel,
      serviceType: orders.serviceType,
      tableCode: tables.code,
    })
    .from(orders)
    .leftJoin(
      tableSessions,
      and(
        eq(tableSessions.tenantId, orders.tenantId),
        eq(tableSessions.id, orders.tableSessionId),
      ),
    )
    .leftJoin(
      tables,
      and(
        eq(tables.tenantId, tableSessions.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        inArray(orders.id, [
          ...new Set(tickets.map((ticket) => ticket.orderId)),
        ]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        tableLabel: row.tableCode,
        channel: posPriceChannel(
          row.channel as OrderChannel,
          row.serviceType as ServiceType,
        ),
      },
    ]),
  );
}

/** Renders tickets with their lines (one items query), keeping input order. */
export async function ticketDetails(
  tx: Tx,
  context: ScopedTenantContext,
  tickets: readonly TicketRow[],
): Promise<KitchenTicketDetail[]> {
  if (tickets.length === 0) return [];
  const items = await tx
    .select()
    .from(kitchenTicketItems)
    .where(
      and(
        eq(kitchenTicketItems.tenantId, context.tenant.tenantId),
        inArray(
          kitchenTicketItems.ticketId,
          tickets.map((ticket) => ticket.id),
        ),
      ),
    )
    .orderBy(asc(kitchenTicketItems.firedAt), asc(kitchenTicketItems.id));
  const byTicket = new Map<string, TicketItemRow[]>();
  for (const item of items) {
    const list = byTicket.get(item.ticketId) ?? [];
    list.push(item);
    byTicket.set(item.ticketId, list);
  }
  const headers = await orderHeaders(tx, context, tickets);
  return tickets.map((ticket) => {
    const header = headers.get(ticket.orderId);
    // The ticket's order FK guarantees the row; a miss is a bug, not a default.
    if (!header) throw new Error("Kitchen ticket order vanished");
    return ticketDetailDto(ticket, byTicket.get(ticket.id) ?? [], header);
  });
}

/** Re-reads one ticket and renders it. */
export async function freshTicketDetail(
  tx: Tx,
  context: ScopedTenantContext,
  ticketId: string,
): Promise<KitchenTicketDetail> {
  const [ticket] = await tx
    .select()
    .from(kitchenTickets)
    .where(
      and(
        eq(kitchenTickets.tenantId, context.tenant.tenantId),
        eq(kitchenTickets.id, ticketId),
      ),
    );
  if (!ticket)
    throw new Error("Kitchen ticket vanished inside its transaction");
  const [detail] = await ticketDetails(tx, context, [ticket]);
  if (!detail) throw new Error("Kitchen ticket detail returned nothing");
  return detail;
}
