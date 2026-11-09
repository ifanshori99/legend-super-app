// Staff device pins and POS supervisor overrides (bead legend-dxb; PRD v1.7
// §3 F6 "Staf — PIN Perangkat" + "Override Supervisor", §6 B staff_pins
// "(T, E)", AUTH-06).
//
// Both tables are tenant + outlet owned: the migration must call
// `app.enforce_tenant_rls(...)` and then `app.enforce_outlet_rls(...)` for each
// (outlet_id is NOT NULL on both; see docs/backend.md "Core database columns").
//
// staff_pins never stores a pin: `pin_hash` is scrypt over an HMAC of the pin
// under a tenant-bound pepper, with a random per-row salt, bound to tenant,
// outlet and user (services/device-pin-hash.ts). One row per staff member per
// outlet ("Six digits per user per outlet", contracts.md).
//
// pos_overrides is the AUTH-06 record: requester, approver, reason and value,
// and the database refuses an approver equal to the requester.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PosOverrideAction } from "@starter/shared/access";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { approvalRequests } from "./platform-approval";
import { outlets, tenants } from "./platform-org";
import { user } from "./user";

/**
 * PostgreSQL `xid8`: a 64-bit transaction id. Kept as its decimal text, which
 * is what the driver returns and what the edge export puts in its cursor.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

export const staffPins = pgTable(
  "staff_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    /** scrypt output, 64 lowercase hex. Never the pin. */
    pinHash: varchar("pin_hash", { length: 64 }).notNull(),
    /** Random 16-byte salt, base64. */
    pinSalt: varchar("pin_salt", { length: 24 }).notNull(),
    /** scrypt cost parameters the hash was made with. */
    kdfN: integer("kdf_n").notNull(),
    kdfR: integer("kdf_r").notNull(),
    kdfP: integer("kdf_p").notNull(),
    pepperVersion: integer("pepper_version").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    setBy: text("set_by")
      .notNull()
      .references(() => user.id),
    /**
     * When the current pin generation (hash material) was set (legend-kyie).
     * `updated_at` moves on every attempt, `created_at` not on a reset, so an
     * edge `staff_pin.set` is ordered against this column only.
     */
    pinSetAt: timestamp("pin_set_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Ordering key of pin generations (legend-kyie, Codex 160 C1). An edge set
     * stores its raw `setAt` here (edge clock, never clamped) so two edge sets
     * keep their order even when the edge clock runs ahead; `pin_set_at`
     * keeps the clamped time. A cloud set takes the later of the database
     * clock and the current key + 1 ms, so it still wins over an edge set
     * stamped in the future.
     */
    pinGenerationAt: timestamp("pin_generation_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Commit-ordered sync version (legend-t9ii): the id of the transaction
     * that last wrote the row. The default covers an insert, the
     * `staff_pins_sync_xid` trigger every update (no application code sets
     * it). The edge export reads only rows below the oldest transaction still
     * open, so a late commit is never passed by a watermark and no clock is
     * involved.
     */
    syncXid: xid8("sync_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
    /**
     * Edge copy only (legend-t9ii review K F2): the highest generation key
     * this edge received from the cloud (`applyStaffPinRecords`). The edge's
     * own next set caps the carried key at `GREATEST(edge now, this) + 5 min`,
     * so an edge clock far behind a recent cloud reset still stamps after it.
     * Never written by the cloud's own paths, so null there.
     */
    cloudGenerationAt: timestamp("cloud_generation_at", { withTimezone: true }),
    /**
     * Edge copy only (legend-7vv8h): the cloud lock state of the last record
     * applied. The edge merges a record's counter or lock only where it moved
     * past these, so a full resync replaying an old cloud counter never brings
     * back a counter or lock the edge already cleared. Null on the cloud.
     */
    cloudFailedAttempts: integer("cloud_failed_attempts"),
    cloudLockedUntil: timestamp("cloud_locked_until", { withTimezone: true }),
    /**
     * Cloud only (legend-rucdm): the edge node and its outbox aggregate
     * sequence whose `staff_pin.set` gave the current generation. A later set
     * of the same node (higher sequence) is newer whatever its key, so an
     * edge clock stepping back while offline cannot make the node's own newer
     * pin lose. Null after a cloud set, and on the edge.
     */
    generationEdgeNodeId: uuid("generation_edge_node_id"),
    generationEdgeSequence: bigint("generation_edge_sequence", {
      mode: "number",
    }),
    /**
     * Cloud only (legend-o839h): the edge database (`edge_nodes.instance_id`
     * of the sending edge) that gave the current generation. A rebuilt edge
     * database keeps its node id but restarts its sequences, so a set from
     * another instance of the same node compares by key, not by sequence.
     * Null when the edge did not report an instance (old edge), after a cloud
     * set, and on the edge.
     */
    generationEdgeInstanceId: uuid("generation_edge_instance_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("staff_pins_tenant_id_id_key").on(table.tenantId, table.id),
    unique("staff_pins_tenant_outlet_user_key").on(
      table.tenantId,
      table.outletId,
      table.userId,
    ),
    index("staff_pins_sync_idx").on(
      table.tenantId,
      table.outletId,
      table.syncXid,
      table.id,
    ),
    foreignKey({
      name: "staff_pins_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "staff_pins_hash_check",
      sql`${table.pinHash} ~ '^[0-9a-f]{64}$' AND char_length(${table.pinSalt}) = 24`,
    ),
    // §3 F6: locked after 5 misses (MAX_STAFF_PIN_ATTEMPTS).
    check(
      "staff_pins_attempts_check",
      sql`${table.failedAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "staff_pins_kdf_check",
      sql`${table.kdfN} >= 1024 AND ${table.kdfR} >= 1 AND ${table.kdfP} >= 1 AND ${table.pepperVersion} >= 1`,
    ),
  ],
);

export const posOverrides = pgTable(
  "pos_overrides",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    action: varchar("action", { length: 30 })
      .$type<PosOverrideAction>()
      .notNull(),
    method: varchar("method", { length: 20 })
      .$type<"supervisor_pin" | "supervisor_phone">()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<"pending" | "approved" | "rejected" | "expired" | "cancelled">()
      .notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    approvedBy: text("approved_by").references(() => user.id),
    reasonCode: varchar("reason_code", { length: 50 }),
    reason: varchar("reason", { length: 500 }).notNull(),
    valueIdr: idrColumn("value_idr").notNull(),
    objectType: varchar("object_type", { length: 50 }).notNull(),
    objectId: varchar("object_id", { length: 36 }).notNull(),
    /** Level-1 approval request (chain id) of a phone approval. */
    approvalRequestId: uuid("approval_request_id"),
    /** Requester's retry key and the request fingerprint it is bound to. */
    idempotencyKey: varchar("idempotency_key", { length: 100 }),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    unique("pos_overrides_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "pos_overrides_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_overrides_approval_request_fk",
      columns: [table.tenantId, table.approvalRequestId],
      foreignColumns: [approvalRequests.tenantId, approvalRequests.id],
    }),
    uniqueIndex("pos_overrides_idempotency_key")
      .on(table.tenantId, table.requestedBy, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("pos_overrides_approval_request_key")
      .on(table.tenantId, table.approvalRequestId)
      .where(sql`${table.approvalRequestId} IS NOT NULL`),
    index("pos_overrides_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
    ),
    check(
      "pos_overrides_action_check",
      sql`${table.action} IN ('void', 'discount', 'refund', 'cash_drawer_open', 'price_correction', 'cash_shift_close', 'edc_standalone')`,
    ),
    check(
      "pos_overrides_method_check",
      sql`${table.method} IN ('supervisor_pin', 'supervisor_phone')`,
    ),
    check(
      "pos_overrides_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')`,
    ),
    // AUTH-06: an approved override always names its approver, who is never
    // the requester; nothing else carries an approver.
    check(
      "pos_overrides_approver_check",
      sql`(${table.status} = 'approved') = (${table.approvedBy} IS NOT NULL)`,
    ),
    check(
      "pos_overrides_distinct_actor_check",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`,
    ),
    check(
      "pos_overrides_method_link_check",
      sql`(${table.method} = 'supervisor_phone') = (${table.approvalRequestId} IS NOT NULL) AND (${table.method} <> 'supervisor_pin' OR ${table.status} = 'approved')`,
    ),
    check(
      "pos_overrides_resolved_check",
      sql`(${table.status} = 'pending') = (${table.resolvedAt} IS NULL)`,
    ),
    check(
      "pos_overrides_value_check",
      sql`${table.valueIdr} >= 0 AND char_length(${table.reason}) >= 3`,
    ),
  ],
);
