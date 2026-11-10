// HRIS master replication to the edge + offline selfie (bead legend-hwn02, C1;
// design docs/design/hris-edge-replication.md sections 3.3, 4, 5, 6.1, 8).
//
// Edge side (same image, same migrations, but only an edge node writes them):
// - edge_people_sync_state: per (tenant, outlet) the ETag of the last applied
//   people snapshot, the seal public key it carried, and when the edge last
//   reached the cloud (`last_checked_at` moves on 200 and 304; `applied_at`
//   only on 200). The 24 h roster-stale flag reads `last_checked_at`.
// - edge_attendance_qr_keys: the per-day QR keys the snapshot carries
//   (never the seed). The edge QR display reads them.
// - edge_selfie_uploads: one row per sealed selfie waiting to go to the cloud.
//   No FK to attendance_logs or core_storage_objects on purpose: the edge
//   retention sweep deletes the files, objects and logs on their own clocks.
//
// Cloud side:
// - edge_received_selfies: receipt per uploaded sealed selfie. Append-only
//   (EDG-02 style): a replayed PUT is told apart from a conflicting one by the
//   stored hash, and a receipt is never rewritten.
//
// Every unique key leads with tenant_id. All four tables are tenant + outlet
// owned (edge-hris.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export type EdgeSelfieUploadState =
  "pending" | "uploaded" | "rejected" | "expired";
export type EdgeReceivedSelfieState = "stored" | "discarded";

export const edgePeopleSyncState = pgTable(
  "edge_people_sync_state",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    snapshotEtag: text("snapshot_etag"),
    snapshotGeneratedAt: timestamp("snapshot_generated_at", {
      withTimezone: true,
    }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    selfieSealKid: text("selfie_seal_kid"),
    selfieSealPublicKey: text("selfie_seal_public_key"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.outletId] }),
    foreignKey({
      name: "edge_people_sync_state_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
  ],
);

export const edgeAttendanceQrKeys = pgTable(
  "edge_attendance_qr_keys",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** UTC day of the 30 s QR window: floor(window * 30_000 / 86_400_000). */
    dayIndex: integer("day_index").notNull(),
    key: bytea("key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.outletId, table.dayIndex] }),
    foreignKey({
      name: "edge_attendance_qr_keys_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edge_attendance_qr_keys_key_check",
      sql`octet_length(${table.key}) = 32`,
    ),
  ],
);

export const edgeSelfieUploads = pgTable(
  "edge_selfie_uploads",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    objectId: uuid("object_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    attendanceLogId: uuid("attendance_log_id"),
    filePath: text("file_path").notNull(),
    sealedSha256: bytea("sealed_sha256").notNull(),
    sealedBytes: integer("sealed_bytes").notNull(),
    sealKid: text("seal_kid").notNull(),
    state: text("state")
      .$type<EdgeSelfieUploadState>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Error class only, never personal data. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.objectId] }),
    index("edge_selfie_uploads_state_next_idx").on(
      table.state,
      table.nextAttemptAt,
    ),
    foreignKey({
      name: "edge_selfie_uploads_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edge_selfie_uploads_state_check",
      sql`${table.state} IN ('pending', 'uploaded', 'rejected', 'expired')`,
    ),
    check(
      "edge_selfie_uploads_sealed_sha256_check",
      sql`octet_length(${table.sealedSha256}) = 32`,
    ),
    check("edge_selfie_uploads_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "edge_selfie_uploads_sealed_bytes_check",
      sql`${table.sealedBytes} > 0`,
    ),
  ],
);

export const edgeReceivedSelfies = pgTable(
  "edge_received_selfies",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    objectId: uuid("object_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    sealedSha256: bytea("sealed_sha256").notNull(),
    state: text("state").$type<EdgeReceivedSelfieState>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.objectId] }),
    foreignKey({
      name: "edge_received_selfies_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_received_selfies_state_check",
      sql`${table.state} IN ('stored', 'discarded')`,
    ),
    check(
      "edge_received_selfies_sealed_sha256_check",
      sql`octet_length(${table.sealedSha256}) = 32`,
    ),
  ],
);
