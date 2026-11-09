// Staff alerts for QR orders at the kitchen (bead legend-078b). Two events reach
// staff through the existing notification tables (no new table or transport):
//   - `kitchen_ticket.unrouted`: a fired QR line has no kitchen station, so no
//     screen shows it. Audience: the outlet's KDS managers.
//   - `order.kitchen_voided`: the kitchen voided a QR order's ticket or line.
//     Audience: the zone waiters of the order's table, else the KDS managers.
// Only orders with channel `qr` alert (a POS cashier sees the kitchen void on
// the order and gets the unrouted warning in the fire response).
//
// One notification per event: the event id is derived from the event's natural
// key, and the notification consumer ignores a source event it already holds
// (`notification_outbox_event_key`), so a replayed routing call or void never
// notifies twice. The write runs in a savepoint: an alert must never fail the
// kitchen action or the (maybe already paid) order.
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  toIsoDateTime,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { tables, tableSessions } from "../db/schema/floor.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import { logger } from "../lib/logger.ts";
import { createNotificationConsumer } from "./notification-consumer.ts";
import type { Tx } from "./menu-internals.ts";
import { buildRecipients, zoneWaiterIds } from "./service-request.service.ts";

const MANAGE_STATION_PERMISSION = "kds.station.manage";

/** Stable ULID for an event, from its natural key (same key, same id). */
function eventIdOf(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * Active holders of `kds.station.manage` whose assignment covers the outlet
 * (tenant, brand or outlet scope). A station-only grant is not a manager:
 * `requireOutletPermission` refuses it too.
 */
async function kdsManagerIds(
  tx: Tx,
  tenantId: string,
  outletId: string,
): Promise<string[]> {
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return [];
  const rows = await tx
    .selectDistinct({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .innerJoin(user, eq(user.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        sql`${roles.permissions} @> ${JSON.stringify([MANAGE_STATION_PERMISSION])}::jsonb`,
        or(
          eq(roleAssignments.scopeType, "tenant"),
          and(
            eq(roleAssignments.scopeType, "brand"),
            eq(roleAssignments.scopeId, outlet.brandId),
          ),
          and(
            eq(roleAssignments.scopeType, "outlet"),
            eq(roleAssignments.scopeId, outletId),
          ),
        ),
        or(
          isNull(user.banned),
          eq(user.banned, false),
          lte(user.banExpires, sql`now()`),
        ),
        lte(roleAssignments.validFrom, sql`now()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`now()`),
        ),
      ),
    );
  return rows.map((row) => row.userId).sort();
}

type QrOrder = {
  id: string;
  outletId: string;
  number: string;
  tableSessionId: string | null;
};

/** The order when it is a QR order of this outlet, else null (no alert). */
async function qrOrderOf(
  tx: Tx,
  tenantId: string,
  outletId: string,
  orderId: string,
): Promise<QrOrder | null> {
  const [order] = await tx
    .select({
      id: orders.id,
      outletId: orders.outletId,
      number: orders.number,
      channel: orders.channel,
      tableSessionId: orders.tableSessionId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        eq(orders.id, orderId),
      ),
    );
  return order && order.channel === "qr" ? order : null;
}

/** Zone of the table the order's session sits at, if any. */
async function zoneOfOrder(
  tx: Tx,
  tenantId: string,
  order: QrOrder,
): Promise<string | null> {
  if (!order.tableSessionId) return null;
  const [row] = await tx
    .select({ zoneId: tables.zoneId })
    .from(tableSessions)
    .innerJoin(
      tables,
      and(
        eq(tables.tenantId, tableSessions.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.id, order.tableSessionId),
      ),
    );
  return row?.zoneId ?? null;
}

type Alert = {
  /** Natural key of the event; the same key never notifies twice. */
  key: string;
  name: "kitchen_ticket.unrouted" | "order.kitchen_voided";
  order: QrOrder;
  userIds: string[];
  payload: Record<string, unknown>;
  title: string;
  body: string;
  now: Date;
};

async function emitAlert(
  tx: Tx,
  context: ScopedTenantContext,
  alert: Alert,
): Promise<void> {
  if (alert.userIds.length === 0) return;
  const tenantId = context.tenant.tenantId;
  const id = eventIdOf(alert.key);
  const event = eventEnvelopeSchema.parse({
    id,
    tenantId,
    outletId: alert.order.outletId,
    name: alert.name,
    version: 1,
    // The envelope requires the name prefix as aggregate type; the id is the
    // order in both events (the audit `kitchen_ticket.unrouted` does the same).
    aggregateType: alert.name.split(".")[0],
    aggregateId: alert.order.id,
    sequence: 1,
    occurredAt: toIsoDateTime(alert.now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${alert.name}:${id}`,
    payloadSchemaRef: `${alert.name}.v1`,
    payload: alert.payload,
  });
  const recipients = await buildRecipients(
    tx,
    tenantId,
    alert.userIds,
    { title: alert.title, body: alert.body },
    alert.now,
    "kitchen_alert",
  );
  await createNotificationConsumer(context, async () => recipients)(
    event,
    event.idempotencyKey,
    tx,
  );
}

/** Runs the alert in a savepoint; a failure is logged, never thrown. */
async function guarded(
  tx: Tx,
  context: ScopedTenantContext,
  run: (savepoint: Tx) => Promise<void>,
): Promise<void> {
  try {
    await tx.transaction((savepoint) => run(savepoint as unknown as Tx));
  } catch (error) {
    logger.warn(
      { err: error, tenantId: context.tenant.tenantId },
      "KDS staff alert failed; the kitchen action continues",
    );
  }
}

/**
 * QR lines that were fired but have no kitchen station: one alert per
 * (order, line) to the outlet's KDS managers, so they can map the menu item.
 */
export async function notifyUnroutedQrLines(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    orderId: string;
    itemIds: readonly string[];
    now: Date;
  },
): Promise<void> {
  if (input.itemIds.length === 0) return;
  await guarded(tx, context, async (sp) => {
    const tenantId = context.tenant.tenantId;
    const order = await qrOrderOf(sp, tenantId, input.outletId, input.orderId);
    if (!order) return;
    const lines = await sp
      .select({ id: orderItems.id, name: orderItems.name })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.orderId, order.id),
          inArray(orderItems.id, [...input.itemIds]),
        ),
      );
    if (lines.length === 0) return;
    const userIds = await kdsManagerIds(sp, tenantId, order.outletId);
    for (const line of lines)
      await emitAlert(sp, context, {
        key: `kitchen_ticket.unrouted:${order.id}:${line.id}`,
        name: "kitchen_ticket.unrouted",
        order,
        userIds,
        payload: { orderId: order.id, orderItemId: line.id },
        title: "Menu belum punya stasiun dapur",
        body: `${line.name} di pesanan ${order.number} tidak muncul di layar dapur mana pun. Atur stasiun menu ini agar pesanan berikutnya masuk dapur.`,
        now: input.now,
      });
  });
}

/**
 * The kitchen voided lines of a QR order: one alert per void (ticket) or line
 * void, to the zone waiters of the order's table, else the KDS managers.
 */
export async function notifyQrKitchenVoid(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: { id: string; outletId: string };
    ticketId: string;
    stationId: string;
    orderItemIds: readonly string[];
    ticketCancelled: boolean;
    reason: string | null;
    now: Date;
  },
): Promise<void> {
  await guarded(tx, context, async (sp) => {
    const tenantId = context.tenant.tenantId;
    const order = await qrOrderOf(
      sp,
      tenantId,
      input.order.outletId,
      input.order.id,
    );
    if (!order) return;
    const zoneId = await zoneOfOrder(sp, tenantId, order);
    const waiters = zoneId ? await zoneWaiterIds(sp, tenantId, zoneId) : [];
    const userIds =
      waiters.length > 0
        ? waiters
        : await kdsManagerIds(sp, tenantId, order.outletId);
    const lineIds = [...input.orderItemIds].sort();
    const count = lineIds.length;
    await emitAlert(sp, context, {
      key: `order.kitchen_voided:${order.id}:${input.ticketId}:${lineIds.join(",")}`,
      name: "order.kitchen_voided",
      order,
      userIds,
      payload: {
        orderId: order.id,
        ticketId: input.ticketId,
        stationId: input.stationId,
        orderItemIds: lineIds,
        ticketCancelled: input.ticketCancelled,
      },
      title: "Dapur membatalkan pesanan",
      body:
        `Dapur membatalkan ${count} item di pesanan ${order.number}` +
        (input.reason ? `: ${input.reason}.` : ".") +
        " Mohon kabari tamu.",
      now: input.now,
    });
  });
}
