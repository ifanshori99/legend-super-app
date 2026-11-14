// Edge node registry and the cloud <-> edge link tables (bead legend-2pi;
// PRD v1.7 §3 F5 "Server Lokal", "Sinkronisasi", §6 A `edge_nodes`, §6 J
// `sync_cursors`). The same tables exist in the cloud database and in the
// edge node's local PostgreSQL (same image, same migrations).
//
// Every table is tenant + outlet owned: the migration must call
// `app.enforce_tenant_rls(...)` and then `app.enforce_outlet_rls(...)` for
// each (edge-node.custom.sql). Unique constraints all lead with tenant_id and
// every reference to an edge node is a composite (tenant_id, outlet_id, id)
// foreign key, so a row can never point at another tenant's or outlet's node.
//
// - edge_nodes: one row per registered mini PC. Only a SHA-256 digest of the
//   high-entropy link credential is stored (edge/credential.ts); revocation
//   is a status change with timestamp, never a delete.
// - sync_cursors: per node and direction, the link sequence counters. The
//   sender side uses next_out_seq / acked_out_seq, the receiver side
//   received_in_seq. A cursor only advances in the transaction that durably
//   applied (receiver) or acknowledged (sender) the events (EDG-02 contract).
// - edge_outbound_queue: the durable offline queue. A row is an event waiting
//   for the peer's acknowledgement, numbered by a gap-free link_seq. Event
//   contents are immutable; only status/acked_at change (trigger).
// - edge_inbound_events: what this side received, for idempotent apply by
//   event id and per-aggregate ordering. Append-only.
// - edge_sync_conflicts: events the conflict rules refused to apply (cloud
//   wins master data; transaction events are never overwritten). The full
//   envelope is kept, so a refused event is never lost. Append-only.
// - edge_pull_checkpoints: edge side only, per node and pulled stream, the
//   watermark of the last fully applied cloud pull (legend-2lp.7). It cannot
//   be derived from the replica (heartbeats bump devices.updated_at locally).
// - edge_staff_pin_peppers: edge side only, per node and key version, the
//   tenant's DERIVED staff pin pepper sealed with a key derived from the edge
//   credential (edge/staff-pin-pepper-store.ts, legend-ideif). Never the root.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CatalogSyncStream } from "@starter/shared/edge";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeNodeRole = "primary" | "standby";
export type EdgeNodeStatus = "active" | "revoked";
/** PRD §3 F5 "Pembagian Sumber Kebenaran"; shared `conflictResolution`. */
export type EdgeEventKind = "master_data" | "transaction_event";
export type EdgeConflictResolution = "cloud_wins" | "append_only";

const directionCheck = (column: unknown) =>
  sql`${column} IN ('edge_to_cloud', 'cloud_to_edge')`;
const kindCheck = (column: unknown) =>
  sql`${column} IN ('master_data', 'transaction_event')`;

export const edgeNodes = pgTable(
  "edge_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    role: varchar("role", { length: 20 }).$type<EdgeNodeRole>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<EdgeNodeStatus>()
      .notNull()
      .default("active"),
    label: varchar("label", { length: 255 }).notNull(),
    /** Image version the node last reported (heartbeat). */
    version: varchar("version", { length: 255 }).notNull().default("unknown"),
    /** SHA-256 hex of the tenant/outlet/node-bound credential. Never the token. */
    credentialHash: varchar("credential_hash", { length: 64 }).notNull(),
    credentialIssuedAt: timestamp("credential_issued_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    /**
     * Rotation grace (legend-x3lv): the digest the last rotation replaced,
     * accepted until `previous_credential_expires_at`. Both null or both set.
     */
    previousCredentialHash: varchar("previous_credential_hash", {
      length: 64,
    }),
    previousCredentialExpiresAt: timestamp("previous_credential_expires_at", {
      withTimezone: true,
    }),
    /**
     * legend-zsdd: identity of the edge DATABASE. Set only on the edge's own
     * local row (random UUID); a rebuilt edge gets a new one. Cloud rows NULL.
     */
    instanceId: uuid("instance_id"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastSyncCursor: varchar("last_sync_cursor", { length: 1024 }),
    /** Better Auth user id; null for the edge's own provisioning row. */
    registeredBy: text("registered_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokeReason: varchar("revoke_reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("edge_nodes_tenant_id_id_key").on(table.tenantId, table.id),
    unique("edge_nodes_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    // PRD §3 F5 / R10: one primary and one standby per outlet at a time.
    uniqueIndex("edge_nodes_active_role_key")
      .on(table.tenantId, table.outletId, table.role)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: "edge_nodes_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edge_nodes_role_check",
      sql`${table.role} IN ('primary', 'standby')`,
    ),
    check(
      "edge_nodes_status_check",
      sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "edge_nodes_credential_hash_check",
      sql`${table.credentialHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "edge_nodes_previous_credential_check",
      sql`(${table.previousCredentialHash} IS NULL AND ${table.previousCredentialExpiresAt} IS NULL) OR (${table.previousCredentialHash} ~ '^[0-9a-f]{64}$' AND ${table.previousCredentialExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<SyncDirection>()
      .notNull(),
    /** Sender: last link_seq handed out for this direction (gap-free). */
    nextOutSeq: bigint("next_out_seq", { mode: "number" }).notNull().default(0),
    /** Sender: highest cumulative acknowledgement from the peer. */
    ackedOutSeq: bigint("acked_out_seq", { mode: "number" })
      .notNull()
      .default(0),
    /** Receiver: highest contiguous link_seq durably applied. */
    receivedInSeq: bigint("received_in_seq", { mode: "number" })
      .notNull()
      .default(0),
    /** PRD §6 J `sync_cursors.last_event_id` (ULID in uuid). */
    lastEventId: ulidInUuid("last_event_id"),
    /**
     * Cloud only (legend-nd3cu): the edge database (`edge_nodes.instance_id`
     * sent on the link) whose link numbering these cursors follow. Null =
     * unknown (an edge that never sent its instance, and the edge's own rows).
     */
    peerInstanceId: uuid("peer_instance_id"),
    /**
     * Cloud only (legend-nd3cu): the stored cursor at which the current peer
     * instance's numbering starts. A rebuilt edge database restarts its link
     * sequences at 0 while the stored cursors only move forward, so the link
     * speaks `stored - offset`. Zero until an instance change rebases it.
     */
    peerSeqOffset: bigint("peer_seq_offset", { mode: "number" })
      .notNull()
      .default(0),
    lastAckedAt: timestamp("last_acked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.edgeNodeId, table.direction],
    }),
    foreignKey({
      name: "sync_cursors_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check("sync_cursors_direction_check", directionCheck(table.direction)),
    check(
      "sync_cursors_seq_check",
      sql`${table.ackedOutSeq} >= 0 AND ${table.ackedOutSeq} <= ${table.nextOutSeq} AND ${table.receivedInSeq} >= 0`,
    ),
    check(
      "sync_cursors_peer_offset_check",
      sql`${table.peerSeqOffset} >= 0 AND ${table.peerSeqOffset} <= GREATEST(${table.ackedOutSeq}, ${table.receivedInSeq}) AND (${table.peerInstanceId} IS NOT NULL OR ${table.peerSeqOffset} = 0)`,
    ),
  ],
);

export const edgeOutboundQueue = pgTable(
  "edge_outbound_queue",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<SyncDirection>()
      .notNull(),
    linkSeq: bigint("link_seq", { mode: "number" }).notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    /** UUID or ULID as the envelope carries it. */
    aggregateId: varchar("aggregate_id", { length: 36 }).notNull(),
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "number",
    }).notNull(),
    kind: varchar("kind", { length: 20 }).$type<EdgeEventKind>().notNull(),
    event: jsonb("event").$type<EventEnvelope>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<"pending" | "acked">()
      .notNull()
      .default("pending"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.edgeNodeId,
        table.direction,
        table.linkSeq,
      ],
    }),
    unique("edge_outbound_queue_event_key").on(
      table.tenantId,
      table.edgeNodeId,
      table.direction,
      table.eventId,
    ),
    unique("edge_outbound_queue_aggregate_sequence_key").on(
      table.tenantId,
      table.edgeNodeId,
      table.direction,
      table.aggregateType,
      table.aggregateId,
      table.aggregateSequence,
    ),
    index("edge_outbound_queue_pending_idx").on(
      table.tenantId,
      table.edgeNodeId,
      table.direction,
      table.status,
      table.linkSeq,
    ),
    foreignKey({
      name: "edge_outbound_queue_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_outbound_queue_direction_check",
      directionCheck(table.direction),
    ),
    check("edge_outbound_queue_kind_check", kindCheck(table.kind)),
    // PRD §3 F5: master data flows cloud -> edge only (cloud wins).
    check(
      "edge_outbound_queue_master_direction_check",
      sql`${table.kind} <> 'master_data' OR ${table.direction} = 'cloud_to_edge'`,
    ),
    check(
      "edge_outbound_queue_seq_check",
      sql`${table.linkSeq} >= 1 AND ${table.aggregateSequence} >= 1`,
    ),
    check(
      "edge_outbound_queue_status_check",
      sql`(${table.status} = 'pending' AND ${table.ackedAt} IS NULL) OR (${table.status} = 'acked' AND ${table.ackedAt} IS NOT NULL)`,
    ),
  ],
);

export const edgeInboundEvents = pgTable(
  "edge_inbound_events",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<SyncDirection>()
      .notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    linkSeq: bigint("link_seq", { mode: "number" }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 36 }).notNull(),
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "number",
    }).notNull(),
    kind: varchar("kind", { length: 20 }).$type<EdgeEventKind>().notNull(),
    outcome: varchar("outcome", { length: 20 })
      .$type<"applied" | "superseded" | "conflict">()
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
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
    index("edge_inbound_events_aggregate_idx").on(
      table.tenantId,
      table.edgeNodeId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateSequence,
    ),
    foreignKey({
      name: "edge_inbound_events_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_inbound_events_direction_check",
      directionCheck(table.direction),
    ),
    check("edge_inbound_events_kind_check", kindCheck(table.kind)),
    check(
      "edge_inbound_events_outcome_check",
      sql`${table.outcome} IN ('applied', 'superseded', 'conflict')`,
    ),
  ],
);

// Cloud-side registry of edge_to_cloud event ids, one row per (tenant, event)
// whichever node delivered it first (legend-wg5t). Primary and standby of one
// outlet may both send the same event id (the standby took over with the
// primary's outbox); receipts in edge_inbound_events stay per node and
// append-only, so the tenant-wide "already received" check and its race
// guard (primary key) live here instead of in a unique index on the
// receipts, which pre-existing duplicate receipts would break. Migration 0065
// backfills it from the receipts. Append-only like the receipts.
export const edgeReceivedEvents = pgTable(
  "edge_received_events",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    firstEdgeNodeId: uuid("first_edge_node_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventId] }),
    foreignKey({
      name: "edge_received_events_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.firstEdgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
  ],
);

export const edgeSyncConflicts = pgTable(
  "edge_sync_conflicts",
  {
    id: ulidInUuid("id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    direction: varchar("direction", { length: 20 })
      .$type<SyncDirection>()
      .notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    aggregateType: varchar("aggregate_type", { length: 255 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 36 }).notNull(),
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "number",
    }).notNull(),
    kind: varchar("kind", { length: 20 }).$type<EdgeEventKind>().notNull(),
    reason: varchar("reason", { length: 50 }).notNull(),
    resolution: varchar("resolution", { length: 20 })
      .$type<EdgeConflictResolution>()
      .notNull(),
    /** Highest aggregate sequence this side already held. */
    existingSequence: bigint("existing_sequence", { mode: "number" }).notNull(),
    /**
     * Why the applier refused (reason `applier_refused`: the domain's own
     * message, max 500 characters); null for the rule-based reasons.
     */
    detail: varchar("detail", { length: 500 }),
    event: jsonb("event").$type<EventEnvelope>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("edge_sync_conflicts_event_key").on(
      table.tenantId,
      table.edgeNodeId,
      table.direction,
      table.eventId,
    ),
    foreignKey({
      name: "edge_sync_conflicts_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_sync_conflicts_direction_check",
      directionCheck(table.direction),
    ),
    check("edge_sync_conflicts_kind_check", kindCheck(table.kind)),
    check(
      "edge_sync_conflicts_resolution_check",
      sql`${table.resolution} IN ('cloud_wins', 'append_only')`,
    ),
  ],
);

// Edge-side pull checkpoint (legend-2lp.7; PRD §3 F5 device registry
// replica). One row per (node, stream): `watermark` is the cursor returned by
// the last pull that applied every page (null = the cloud had no records
// yet), `last_success_at` is when that pull finished, so replica staleness
// survives a restart. Written only after a pull returned, never mid-pull.
export const edgePullCheckpoints = pgTable(
  "edge_pull_checkpoints",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    stream: varchar("stream", { length: 40 })
      .$type<
        | "device_registry"
        | "staff_pins"
        | `catalog:${CatalogSyncStream}`
        // Local stamp normalization, independent of HTTP progress/freshness.
        | `catalog:init:${CatalogSyncStream}`
        // Pending menu_categories parent links of the catalog pull (legend-24318).
        | "catalog:menu_categories:parents"
        // Pending printers fallback links of the catalog pull (legend-fbf4v).
        | "catalog:printers:fallbacks"
      >()
      .notNull(),
    watermark: text("watermark"),
    lastSuccessAt: timestamp("last_success_at", {
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.edgeNodeId, table.stream] }),
    foreignKey({
      name: "edge_pull_checkpoints_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_pull_checkpoints_stream_check",
      // staff_pins: the staff pin down-sync (legend-yvhw8). catalog:<stream>:
      // the menu, price and recipe down-sync (legend-97p, 10 streams).
      sql`${table.stream} IN ('device_registry', 'staff_pins') OR ${table.stream} LIKE 'catalog:%'`,
    ),
  ],
);

// Edge-side staff pin peppers (legend-ideif). One row per (node, version): the
// tenant's derived pepper, AES-256-GCM sealed (edge/staff-pin-pepper-store.ts),
// so the edge can verify pins offline without ever holding the root pepper.
export const edgeStaffPinPeppers = pgTable(
  "edge_staff_pin_peppers",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.edgeNodeId, table.version] }),
    foreignKey({
      name: "edge_staff_pin_peppers_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check("edge_staff_pin_peppers_version_check", sql`${table.version} >= 1`),
  ],
);
