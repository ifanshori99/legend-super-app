// Edge -> cloud commands (card F1, brief 1269). The same tables exist in the
// cloud database and in the edge node's local PostgreSQL (same migrations).
//
// - edge_command_requests (edge side): the command the edge froze and the state
//   of its answer. `pending` = never sent, `unknown` = sent at least once and
//   no outcome received. Both keep the subject (a bill) locked: at most one open
//   command per subject. The body is the exact text that is sent every time.
// - edge_command_executions (cloud side): one row per command id, written in
//   the transaction that executed it, so the row exists exactly when the effect
//   does. `absent` is the tombstone a status question leaves for an unknown id.
//   The body itself is not kept in the cloud, only its digest.
//
// Tenant + outlet owned: RLS and the guards are in edge-cloud-command.custom.sql.
// A command id is unique per tenant, so an id another outlet used is refused.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EdgeCommandFinalStatus } from "@starter/shared/edge";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeCommandRequestStatus =
  "pending" | "unknown" | EdgeCommandFinalStatus;
/** `executing` is visible only inside the executing transaction. */
export type EdgeCommandExecutionStatus = "executing" | EdgeCommandFinalStatus;

export const edgeCommandRequests = pgTable(
  "edge_command_requests",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    id: ulidInUuid("id").notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    kind: varchar("kind", { length: 60 }).notNull(),
    /** What the command locks, e.g. `order` + order id. */
    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: varchar("subject_id", { length: 36 }).notNull(),
    /** The frozen body, sent byte for byte on every attempt. */
    body: text("body").notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<EdgeCommandRequestStatus>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    code: varchar("code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "edge_command_requests_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    uniqueIndex("edge_command_requests_open_subject_key")
      .on(table.tenantId, table.outletId, table.subjectType, table.subjectId)
      .where(sql`${table.status} IN ('pending', 'unknown')`),
    index("edge_command_requests_open_idx")
      .on(table.tenantId, table.outletId, table.createdAt)
      .where(sql`${table.status} IN ('pending', 'unknown')`),
    check(
      "edge_command_requests_kind_check",
      sql`${table.kind} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`,
    ),
    check(
      "edge_command_requests_sha_check",
      sql`${table.bodySha256} ~ '^[0-9a-f]{64}$' AND ${table.bodySha256} = encode(sha256(convert_to(${table.body}, 'UTF8')), 'hex')`,
    ),
    check(
      "edge_command_requests_status_check",
      sql`(${table.status} IN ('pending', 'unknown') AND ${table.settledAt} IS NULL AND ${table.result} IS NULL AND ${table.code} IS NULL)
        OR (${table.status} = 'succeeded' AND ${table.settledAt} IS NOT NULL AND ${table.result} IS NOT NULL AND ${table.code} IS NULL)
        OR (${table.status} = 'refused' AND ${table.settledAt} IS NOT NULL AND ${table.result} IS NULL AND ${table.code} IS NOT NULL)
        OR (${table.status} IN ('expired', 'absent') AND ${table.settledAt} IS NOT NULL AND ${table.result} IS NULL AND ${table.code} IS NULL)`,
    ),
    check(
      "edge_command_requests_attempts_check",
      sql`${table.attempts} >= 0 AND (${table.attempts} > 0) = (${table.lastAttemptAt} IS NOT NULL) AND (${table.status} <> 'pending' OR ${table.attempts} = 0)`,
    ),
  ],
);

export const edgeCommandExecutions = pgTable(
  "edge_command_executions",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    id: ulidInUuid("id").notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** The edge database that sent it (matched against the link cursor). */
    edgeInstanceId: uuid("edge_instance_id").notNull(),
    kind: varchar("kind", { length: 60 }).notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<EdgeCommandExecutionStatus>()
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    code: varchar("code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "edge_command_executions_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    index("edge_command_executions_node_idx").on(
      table.tenantId,
      table.edgeNodeId,
      table.createdAt,
    ),
    check(
      "edge_command_executions_kind_check",
      sql`${table.kind} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`,
    ),
    check(
      "edge_command_executions_sha_check",
      sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "edge_command_executions_status_check",
      sql`(${table.status} = 'executing' AND ${table.decidedAt} IS NULL AND ${table.result} IS NULL AND ${table.code} IS NULL)
        OR (${table.status} = 'succeeded' AND ${table.decidedAt} IS NOT NULL AND ${table.result} IS NOT NULL AND ${table.code} IS NULL)
        OR (${table.status} = 'refused' AND ${table.decidedAt} IS NOT NULL AND ${table.result} IS NULL AND ${table.code} IS NOT NULL)
        OR (${table.status} IN ('expired', 'absent') AND ${table.decidedAt} IS NOT NULL AND ${table.result} IS NULL AND ${table.code} IS NULL)`,
    ),
  ],
);
