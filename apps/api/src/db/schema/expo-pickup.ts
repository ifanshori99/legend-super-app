// Expo runner assignment + pickup call numbers (bead legend-aiksz; PRD v1.7
// §3 F12 "KDS, Expo & Pickup Display"; contract @starter/shared/kitchen
// `expoTicketSchema`, `pickupCallSchema`, `PICKUP_CALL_TRANSITIONS`).
//
//   pickup_calls      one daily per-outlet call number per takeaway or
//                     delivery-platform order: assigned -> called -> picked_up.
//   expo_assignments  the runner of one order, written when expo assigns a
//                     runner; `delivered_at` is "diantar". The rest of the expo
//                     ticket (stations, isComplete, readyAt) is read from
//                     kitchen_tickets, so it is not stored here.
//
// (T) rules: tenant_id and outlet_id NOT NULL (tenant + outlet RLS in
// expo-pickup.custom.sql), unique constraints include tenant_id, parents are
// referenced through composite (tenant_id, id) keys. Lifecycle rules that a
// CHECK cannot express (no status regression, first timestamps kept, delivered
// rows frozen) are triggers in expo-pickup.custom.sql.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PickupCallStatus, PickupChannel } from "@starter/shared/kitchen";
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** `pickup_calls` (T, O): the call number of one takeaway/delivery order. */
export const pickupCalls = pgTable(
  "pickup_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    channel: varchar("channel", { length: 20 })
      .$type<PickupChannel>()
      .notNull(),
    /**
     * Daily per-outlet sequence 1, 2, 3... The code shown on the display and
     * receipt (A-001..A-999, B-001...) is derived from it (`formatPickupCode`).
     */
    number: integer("number").notNull(),
    businessDate: businessDate("business_date").notNull(),
    status: varchar("status", { length: 20 })
      .$type<PickupCallStatus>()
      .notNull(),
    calledAt: timestamp("called_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("pickup_calls_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pickup_calls_tenant_order_key").on(table.tenantId, table.orderId),
    unique("pickup_calls_outlet_day_number_key").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
      table.number,
    ),
    foreignKey({
      name: "pickup_calls_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "pickup_calls_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pickup_calls_status_check",
      sql`${table.status} IN ('assigned', 'called', 'picked_up')`,
    ),
    check(
      "pickup_calls_channel_check",
      sql`${table.channel} IN ('takeaway', 'delivery', 'gofood', 'grabfood', 'shopeefood')`,
    ),
    check("pickup_calls_number_check", sql`${table.number} >= 1`),
    // Only an assigned number has no calledAt; called and picked_up keep it.
    check(
      "pickup_calls_called_at_check",
      sql`(${table.status} = 'assigned') = (${table.calledAt} IS NULL)`,
    ),
    check(
      "pickup_calls_picked_up_at_check",
      sql`(${table.status} = 'picked_up') = (${table.pickedUpAt} IS NOT NULL)`,
    ),
    check(
      "pickup_calls_order_check",
      sql`${table.pickedUpAt} IS NULL OR ${table.pickedUpAt} >= ${table.calledAt}`,
    ),
  ],
);

/** `expo_assignments` (T, O): the runner of one order and its delivery. */
export const expoAssignments = pgTable(
  "expo_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** Staff user id; NOT NULL, so a delivered order always has a runner. */
    runnerId: uuid("runner_id").notNull(),
    runnerAssignedAt: timestamp("runner_assigned_at", {
      withTimezone: true,
    }).notNull(),
    /** Staff who assigned the runner (expo screen session). */
    assignedBy: uuid("assigned_by"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Staff who marked the order delivered ("diantar", session user). */
    deliveredBy: uuid("delivered_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("expo_assignments_tenant_id_id_key").on(table.tenantId, table.id),
    unique("expo_assignments_tenant_order_key").on(
      table.tenantId,
      table.orderId,
    ),
    foreignKey({
      name: "expo_assignments_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "expo_assignments_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("expo_assignments_runner_idx").on(
      table.tenantId,
      table.outletId,
      table.runnerId,
    ),
    check(
      "expo_assignments_delivered_by_check",
      sql`(${table.deliveredAt} IS NULL) = (${table.deliveredBy} IS NULL)`,
    ),
    check(
      "expo_assignments_delivered_order_check",
      sql`${table.deliveredAt} IS NULL OR ${table.deliveredAt} >= ${table.runnerAssignedAt}`,
    ),
  ],
);
