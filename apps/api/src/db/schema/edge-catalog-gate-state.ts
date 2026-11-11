// Edge catalog sales gate state (legend-10nex). One row per edge node:
// - tracking_started_at: first boot of the freshness tracking. A critical
//   stream that never succeeded is aged from here, so a new edge is not
//   blocked at once but is after 24 h without a first sync.
// - clock_high_water_at: the highest trusted time the edge ever saw
//   (edge/trusted-clock.ts). A wall clock set backwards across a restart
//   never shrinks the age of a stale catalog.
// Tenant + outlet owned (edge-catalog-gate-state.custom.sql).
import {
  foreignKey,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { tenants, outlets } from "./platform-org.ts";

export const edgeCatalogGateState = pgTable(
  "edge_catalog_gate_state",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    trackingStartedAt: timestamp("tracking_started_at", {
      withTimezone: true,
    }).notNull(),
    clockHighWaterAt: timestamp("clock_high_water_at", {
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.edgeNodeId] }),
    foreignKey({
      name: "edge_catalog_gate_state_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
  ],
);
