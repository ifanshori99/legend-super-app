// KDS routing + ticket lifecycle tables (bead legend-4d5; PRD v1.7 §3 F9
// "Kitchen Display System"; KDS-01..KDS-04; contract @starter/shared/kitchen).
//
// A fired POS order line (order_items, schema/qr-order.ts) is routed to the
// station of its menu item:
//
//   kitchen_tickets               one ticket per order, station and fire batch.
//   kitchen_ticket_items          one line per routed order_items row (the
//                                 unique order_item_id makes routing idempotent).
//   kitchen_ticket_status_changes append-only log: every ticket or item status
//                                 change with time and actor (KDS-04).
//   kitchen_station_feed          append-only per-station change feed with a
//                                 gapless `sequence`: reconnecting displays
//                                 resume after their last sequence (KDS-02).
//   kitchen_station_cursors       last issued sequence per station; the row
//                                 lock serializes writers so the feed is gapless.
//
// (T) rules: tenant_id NOT NULL everywhere, outlet_id NOT NULL on every table
// (enforced tenant + outlet RLS in kds.custom.sql), unique constraints include
// tenant_id, and children reference parents through composite (tenant_id, id)
// keys. Append-only rules are DB triggers in kds.custom.sql.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { stations } from "./menu";
import { outlets, tenants } from "./platform-org";
import { orderItems, orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** `kitchen_tickets` (T, O): one station ticket of a fire batch. */
export const kitchenTickets = pgTable(
  "kitchen_tickets",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    stationId: uuid("station_id").notNull(),
    fireBatchId: ulidInUuid("fire_batch_id").notNull(),
    /** Outlet business day of `firedAt` (zone + cutoff), scopes `ticketNo`. */
    businessDate: businessDate("business_date").notNull(),
    /** Running number per outlet and business day (scan code K-001). */
    ticketNo: integer("ticket_no").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    priority: smallint("priority").notNull().default(0),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    servedAt: timestamp("served_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    printedFallback: boolean("printed_fallback").notNull().default(false),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("kitchen_tickets_tenant_id_id_key").on(table.tenantId, table.id),
    unique("kitchen_tickets_order_station_batch_key").on(
      table.tenantId,
      table.orderId,
      table.stationId,
      table.fireBatchId,
    ),
    foreignKey({
      name: "kitchen_tickets_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "kitchen_tickets_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_tickets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("kitchen_tickets_outlet_day_ticket_no_key").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
      table.ticketNo,
    ),
    index("kitchen_tickets_station_status_idx").on(
      table.tenantId,
      table.stationId,
      table.status,
    ),
    check(
      "kitchen_tickets_status_check",
      sql`${table.status} IN ('new', 'in_progress', 'done', 'recalled', 'cancelled')`,
    ),
    check(
      "kitchen_tickets_priority_check",
      sql`${table.priority} BETWEEN 0 AND 9`,
    ),
  ],
);

/** `kitchen_ticket_items` (T, O): one routed order line on a ticket. */
export const kitchenTicketItems = pgTable(
  "kitchen_ticket_items",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    ticketId: ulidInUuid("ticket_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    orderItemId: ulidInUuid("order_item_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    variantId: uuid("variant_id"),
    name: varchar("name", { length: 150 }).notNull(),
    quantity: smallint("quantity").notNull(),
    course: varchar("course", { length: 20 }),
    /** Modifier names snapshotted from the order line. */
    modifiers: text("modifiers")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    note: varchar("note", { length: 200 }),
    status: varchar("status", { length: 20 }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    servedAt: timestamp("served_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    recalledCount: smallint("recalled_count").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("kitchen_ticket_items_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // An order line routes to exactly one ticket line (idempotent routing).
    unique("kitchen_ticket_items_order_item_key").on(
      table.tenantId,
      table.orderItemId,
    ),
    foreignKey({
      name: "kitchen_ticket_items_ticket_fk",
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [kitchenTickets.tenantId, kitchenTickets.id],
    }),
    foreignKey({
      name: "kitchen_ticket_items_order_item_fk",
      columns: [table.tenantId, table.orderItemId],
      foreignColumns: [orderItems.tenantId, orderItems.id],
    }),
    foreignKey({
      name: "kitchen_ticket_items_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("kitchen_ticket_items_ticket_idx").on(table.tenantId, table.ticketId),
    check(
      "kitchen_ticket_items_status_check",
      sql`${table.status} IN ('queued', 'in_progress', 'ready', 'served', 'voided')`,
    ),
    check(
      "kitchen_ticket_items_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 999`,
    ),
  ],
);

/** `kitchen_ticket_status_changes` (T, O): append-only log (KDS-04). */
export const kitchenTicketStatusChanges = pgTable(
  "kitchen_ticket_status_changes",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    ticketId: ulidInUuid("ticket_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    stationId: uuid("station_id").notNull(),
    /** Set when the change is about one line. */
    orderItemId: ulidInUuid("order_item_id"),
    fromStatus: varchar("from_status", { length: 20 }),
    toStatus: varchar("to_status", { length: 20 }).notNull(),
    itemFromStatus: varchar("item_from_status", { length: 20 }),
    itemToStatus: varchar("item_to_status", { length: 20 }),
    source: varchar("source", { length: 10 }).notNull(),
    actorId: uuid("actor_id"),
    deviceId: uuid("device_id"),
    reason: varchar("reason", { length: 200 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("kitchen_ticket_status_changes_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "kitchen_ticket_status_changes_ticket_fk",
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [kitchenTickets.tenantId, kitchenTickets.id],
    }),
    foreignKey({
      name: "kitchen_ticket_status_changes_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("kitchen_ticket_status_changes_ticket_idx").on(
      table.tenantId,
      table.ticketId,
      table.occurredAt,
    ),
    check(
      "kitchen_ticket_status_changes_source_check",
      sql`${table.source} IN ('user', 'device', 'system')`,
    ),
    check(
      "kitchen_ticket_status_changes_actor_check",
      sql`${table.source} = 'system' OR ${table.actorId} IS NOT NULL`,
    ),
    check(
      "kitchen_ticket_status_changes_device_check",
      sql`${table.source} <> 'device' OR ${table.deviceId} IS NOT NULL`,
    ),
    check(
      "kitchen_ticket_status_changes_reason_check",
      sql`${table.toStatus} NOT IN ('recalled', 'cancelled') OR ${table.reason} IS NOT NULL OR ${table.orderItemId} IS NOT NULL`,
    ),
  ],
);

/** `kitchen_station_feed` (T, O): append-only per-station change feed. */
export const kitchenStationFeed = pgTable(
  "kitchen_station_feed",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    stationId: uuid("station_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    ticketId: ulidInUuid("ticket_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("kitchen_station_feed_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("kitchen_station_feed_station_sequence_key").on(
      table.tenantId,
      table.stationId,
      table.sequence,
    ),
    foreignKey({
      name: "kitchen_station_feed_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_station_feed_ticket_fk",
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [kitchenTickets.tenantId, kitchenTickets.id],
    }),
    foreignKey({
      name: "kitchen_station_feed_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("kitchen_station_feed_ticket_idx").on(
      table.tenantId,
      table.stationId,
      table.ticketId,
    ),
    check("kitchen_station_feed_sequence_check", sql`${table.sequence} > 0`),
  ],
);

/** `kitchen_station_cursors` (T, O): last feed sequence issued per station. */
export const kitchenStationCursors = pgTable(
  "kitchen_station_cursors",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    stationId: uuid("station_id").notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt,
  },
  (table) => [
    primaryKey({
      name: "kitchen_station_cursors_pkey",
      columns: [table.tenantId, table.stationId],
    }),
    foreignKey({
      name: "kitchen_station_cursors_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_station_cursors_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "kitchen_station_cursors_sequence_check",
      sql`${table.lastSequence} >= 0`,
    ),
  ],
);
