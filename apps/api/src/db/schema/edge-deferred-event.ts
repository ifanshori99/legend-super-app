// Cloud-side durable inbox for edge events the cloud accepts but does not yet
// apply (bead legend-9fhs). POS `order.*` events from an edge outlet used to
// have no classifier, so the whole edge -> cloud batch rolled back forever and
// stalled `stock.moved` behind them. They are now parked here, verbatim and
// idempotent by (tenant_id, event_id), until a POS-order applier backfills
// from this table (bead legend-078n). Nothing reads this table to change
// money or stock.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table
// (edge-deferred-event.custom.sql).
import {
  bigint,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EventEnvelope } from "@starter/shared/events";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edgeDeferredEvents = pgTable(
  "edge_deferred_events",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 36 }).notNull(),
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "number",
    }).notNull(),
    eventName: varchar("event_name", { length: 255 }).notNull(),
    /** The full event as the edge sent it. */
    envelope: jsonb("envelope").$type<EventEnvelope>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventId] }),
    foreignKey({
      name: "edge_deferred_events_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    index("edge_deferred_events_aggregate_idx").on(
      table.tenantId,
      table.aggregateType,
      table.receivedAt,
    ),
  ],
);
