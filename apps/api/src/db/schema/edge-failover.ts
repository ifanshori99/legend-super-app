// Edge -> cloud failover windows (1271 F1; docs/design/edge-cloud-failover.md,
// docs/briefs/1271-edge-failover-cards.md D1-D6; contract
// @starter/shared/edge failover.ts).
//
// One row per failover of an outlet. The cloud writes it; the outlet edge
// holds a copy of the same table (applied from the window-state events). At
// most one `active`/`returning` window per outlet (partial unique index).
// Status moves forward only (active -> returning -> closed, active ->
// cancelled), identity and set-once fields never change, and a row is never
// deleted (edge-failover.custom.sql). Tenant + outlet RLS like the other edge
// tables.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { FailoverWindowStatus } from "@starter/shared/edge";
import { businessDate, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export const outletFailoverWindows = pgTable(
  "outlet_failover_windows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** The active primary edge node when the window was opened. */
    edgeNodeId: uuid("edge_node_id").notNull(),
    status: varchar("status", { length: 10 })
      .$type<FailoverWindowStatus>()
      .notNull()
      .default("active"),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** Opened although the edge heartbeat was fresh (owner notified). */
    override: boolean("override").notNull().default(false),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    // No FK to "user" (review P2): the edge copy names managers its people
    // snapshot may not hold, and a refused copy would let the edge keep selling.
    activatedBy: text("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last edge heartbeat the cloud had seen at activation (null = never). */
    edgeHeartbeatAt: timestamp("edge_heartbeat_at", { withTimezone: true }),
    /** Outlet business date at activation. */
    businessDateFrom: businessDate("business_date_from").notNull(),
    /** Business date when the window left `active`; null while active. */
    businessDateTo: businessDate("business_date_to"),
    returnStartedAt: timestamp("return_started_at", { withTimezone: true }),
    returnStartedBy: text("return_started_by"),
    /** Deterministic id of the window-closing cloud -> edge event. */
    closingEventId: uuid("closing_event_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("outlet_failover_windows_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // Target of the pos_orders / pos_shifts window keys: same outlet only.
    unique("outlet_failover_windows_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("outlet_failover_windows_idempotency_key").on(
      table.tenantId,
      table.outletId,
      table.idempotencyKey,
    ),
    // W1: at most one open window per outlet.
    uniqueIndex("outlet_failover_windows_open_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.status} IN ('active', 'returning')`),
    foreignKey({
      name: "outlet_failover_windows_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "outlet_failover_windows_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "outlet_failover_windows_status_check",
      sql`${table.status} IN ('active', 'returning', 'closed', 'cancelled')`,
    ),
    check(
      "outlet_failover_windows_reason_check",
      sql`char_length(btrim(${table.reason})) >= 3`,
    ),
    check(
      "outlet_failover_windows_return_check",
      sql`(${table.returnStartedAt} IS NOT NULL) = (${table.status} IN ('returning', 'closed'))`,
    ),
    check(
      "outlet_failover_windows_return_by_check",
      sql`(${table.returnStartedBy} IS NOT NULL) = (${table.status} IN ('returning', 'closed'))`,
    ),
    check(
      "outlet_failover_windows_cancelled_by_check",
      sql`(${table.cancelledBy} IS NOT NULL) = (${table.status} = 'cancelled')`,
    ),
    check(
      "outlet_failover_windows_closed_check",
      sql`(${table.closedAt} IS NOT NULL) = (${table.status} = 'closed')`,
    ),
    check(
      "outlet_failover_windows_cancelled_check",
      sql`(${table.cancelledAt} IS NOT NULL) = (${table.status} = 'cancelled')`,
    ),
    check(
      "outlet_failover_windows_closing_event_check",
      sql`${table.closingEventId} IS NULL OR ${table.status} <> 'active'`,
    ),
    check(
      "outlet_failover_windows_business_dates_check",
      sql`(${table.businessDateTo} IS NULL) = (${table.status} = 'active')
        AND (${table.businessDateTo} IS NULL OR ${table.businessDateTo} >= ${table.businessDateFrom})`,
    ),
  ],
);
