// Dead-letter store of the cloud <-> edge link (bead legend-btx4d). An outbound
// event that alone exceeds the link frame cap can never be delivered; it used
// to hold every event behind it forever. The sender moves it here, whole
// (envelope, size, original link_seq, reason), recorded once per
// (tenant, node, direction, event), and renumbers the queue behind it
// (services edge/db-link-store.ts deadLetterOutbound). Append-only evidence:
// nothing is dropped silently, finance/ops can read and replay it by hand.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table
// (edge-link-dead-letter.custom.sql).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeLinkDeadLetterReason = "frame_too_large" | "brand_moved";

export const edgeLinkDeadLetters = pgTable(
  "edge_link_dead_letters",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<SyncDirection>()
      .notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    /** link_seq the event had in the outbound queue before it was removed. */
    linkSeq: bigint("link_seq", { mode: "number" }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 36 }).notNull(),
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "number",
    }).notNull(),
    /** Encoded size of the event in bytes. */
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 40 })
      .$type<EdgeLinkDeadLetterReason>()
      .notNull(),
    /** The full queued event, untouched. */
    event: jsonb("event").$type<EventEnvelope>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.edgeNodeId,
        table.direction,
        table.eventId,
      ],
    }),
    foreignKey({
      name: "edge_link_dead_letters_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_link_dead_letters_direction_check",
      sql`${table.direction} IN ('edge_to_cloud', 'cloud_to_edge')`,
    ),
    check(
      "edge_link_dead_letters_reason_check",
      sql`${table.reason} IN ('frame_too_large', 'brand_moved')`,
    ),
    check(
      "edge_link_dead_letters_size_check",
      sql`${table.linkSeq} >= 1 AND ${table.bytes} >= 0 AND ${table.aggregateSequence} >= 1`,
    ),
  ],
);
