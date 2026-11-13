// Cloud-side durable inbox for edge events the cloud accepts but does not yet
// apply (bead legend-9fhs). POS `order.*` events from an edge outlet used to
// have no classifier, so the whole edge -> cloud batch rolled back forever and
// stalled `stock.moved` behind them. They are now parked here, verbatim and
// idempotent by (tenant_id, event_id), until a POS-order applier backfills
// from this table (bead legend-078n). Only the recipe-deduction guard below
// reads it, and only to SKIP a deduction.
//
// Parked rows must never be deleted or purged: the recipe-deduction consume
// guard (isEdgeParkedOrder, legend-078n) reads the parked `order.paid` row to
// avoid deducting an edge-paid order a second time on the cloud.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table
// (edge-deferred-event.custom.sql).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

/** What a later applier did with a parked row (legend-kyie). */
export type EdgeDeferredApplyOutcome = "applied" | "not_applicable" | "refused";

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
    /** "deferred": explicit WS-04 registration; "unclassified": generic fallback. */
    parkedReason: varchar("parked_reason", { length: 20 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set once a later applier processed the parked row (legend-kyie: access
     * events drained by edge/access-applier.ts). NULL = still parked.
     */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** "applied" | "not_applicable" | "refused"; NULL while parked. */
    applyOutcome: varchar("apply_outcome", {
      length: 20,
    }).$type<EdgeDeferredApplyOutcome>(),
    /**
     * Total HPP (whole rupiah) of a parked `order.paid`: the sum of the order's
     * edge `stock.moved` sale rows, recomputed (assigned, never added) by
     * edge/order-edge-applier.ts whenever either side arrives (legend-pd9t).
     * NULL = no stock row seen yet; informational, never a money source.
     */
    costSnapshotIdr: idrColumn("cost_snapshot_idr"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventId] }),
    foreignKey({
      name: "edge_deferred_events_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_deferred_events_parked_reason_check",
      sql`${table.parkedReason} IN ('deferred', 'unclassified')`,
    ),
    index("edge_deferred_events_aggregate_idx").on(
      table.tenantId,
      table.aggregateType,
      table.receivedAt,
    ),
    // legend-078n guard B: "was this order parked from an edge?" per order event.
    index("edge_deferred_events_aggregate_id_idx").on(
      table.tenantId,
      table.aggregateType,
      table.aggregateId,
    ),
    check(
      "edge_deferred_events_cost_snapshot_check",
      sql`${table.costSnapshotIdr} IS NULL OR ${table.costSnapshotIdr} >= 0`,
    ),
    check(
      "edge_deferred_events_apply_outcome_check",
      sql`(${table.applyOutcome} IS NULL OR ${table.applyOutcome} IN ('applied', 'not_applicable', 'refused')) AND (${table.applyOutcome} IS NULL) = (${table.appliedAt} IS NULL)`,
    ),
    index("edge_deferred_events_pending_idx")
      .on(
        table.tenantId,
        table.outletId,
        table.aggregateType,
        table.receivedAt,
        table.eventId,
      )
      .where(sql`${table.appliedAt} IS NULL`),
  ],
);
