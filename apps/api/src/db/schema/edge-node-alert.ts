// Edge node alerts shown on the back-office "Status edge" screen (beads
// legend-uux9k, legend-uvnll, legend-ph62j; docs/design/edge-status-cloud.md
// D5). One OPEN row per node and kind (partial unique index); the row closes
// when its condition clears, so a later episode is a new row and the history
// stays. Details carry counts and times only: no device ids, no secrets.
// Tenant + outlet owned (edge-node-alert.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EdgeNodeAlertKind } from "@starter/shared/edge/node-status";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edgeNodeAlerts = pgTable(
  "edge_node_alerts",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    kind: text("kind").$type<EdgeNodeAlertKind>().notNull(),
    /** First seen in this episode. */
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    /** Latest confirmation of the condition. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Null while the alert is open. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    detail: jsonb("detail")
      .$type<Record<string, string | number | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Edge event that opened it (ULID in uuid); null for cloud-computed alerts. */
    sourceEventId: ulidInUuid("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Nodes are revoked, never deleted: no cascade.
    foreignKey({
      name: "edge_node_alerts_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    uniqueIndex("edge_node_alerts_open_key")
      .on(table.tenantId, table.edgeNodeId, table.kind)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("edge_node_alerts_open_outlet_idx")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.resolvedAt} IS NULL`),
    check(
      "edge_node_alerts_kind_check",
      sql`${table.kind} IN ('device_registry_hard_stale', 'receipt_run_alert')`,
    ),
    check(
      "edge_node_alerts_resolved_check",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.raisedAt}`,
    ),
  ],
);
