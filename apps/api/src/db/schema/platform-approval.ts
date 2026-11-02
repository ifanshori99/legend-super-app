// Generic approval requests (bead legend-y5q; PRD v1.7 §3 F7 "Matriks
// Approval" + "Kotak Approval", §6 B approval_requests, AUTH-06, MCP-04).
//
// One row = one level of one request (identity contract approvalRequestSchema).
// The rows of a multi-level request share `chain_id` (= the level-1 row id).
// The matrix requirement is snapshotted on every row (`required_steps`), so a
// matrix edit never changes a request already in flight.
//
// Tenant RLS is installed in the custom migration that follows the generated
// one. `outlet_id` is nullable (tenant-wide actions such as payroll have no
// outlet), so the NOT NULL `app.enforce_outlet_rls` helper does not apply; the
// custom migration adds an equivalent RESTRICTIVE policy where a NULL outlet is
// visible only to a tenant-wide scope, and the service re-checks the approver's
// role scope on every decision.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ApprovalActionType,
  ApprovalSource,
} from "@starter/shared/access";
import type { ApprovalRequestStatus } from "@starter/shared/identity";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";
import { user } from "./user";

/** Snapshot of the matrix tier the request was created against. */
export type ApprovalStepSnapshot = {
  readonly level: number;
  readonly approverRoleIds: readonly string[];
};

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    /** The level-1 row id; every level of one request shares it. */
    chainId: uuid("chain_id").notNull(),
    /** Module that opened the request; `inbox` = POST /api/approvals. */
    sourceModule: varchar("source_module", { length: 50 }).notNull(),
    actionType: varchar("action_type", { length: 50 })
      .$type<ApprovalActionType>()
      .notNull(),
    objectType: varchar("object_type", { length: 50 }).notNull(),
    objectId: varchar("object_id", { length: 36 }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    source: varchar("source", { length: 10 }).$type<ApprovalSource>().notNull(),
    level: integer("level").notNull(),
    requiredLevels: integer("required_levels").notNull(),
    requiredSteps: jsonb("required_steps")
      .$type<ApprovalStepSnapshot[]>()
      .notNull(),
    thresholdIdr: idrColumn("threshold_idr"),
    amountIdr: idrColumn("amount_idr"),
    status: varchar("status", { length: 20 })
      .$type<ApprovalRequestStatus>()
      .notNull()
      .default("pending"),
    requestReason: varchar("request_reason", { length: 500 }).notNull(),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: varchar("reason", { length: 500 }),
    /** sha256 of (request, decision, reason, approver): replay detection. */
    decisionFingerprint: varchar("decision_fingerprint", { length: 64 }),
    decisionIdempotencyKey: varchar("decision_idempotency_key", {
      length: 100,
    }),
    /** Level 1 only: the requester's retry key and the body it was bound to. */
    createIdempotencyKey: varchar("create_idempotency_key", { length: 100 }),
    createFingerprint: varchar("create_fingerprint", { length: 64 }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("approval_requests_tenant_id_id_key").on(table.tenantId, table.id),
    unique("approval_requests_chain_level_key").on(
      table.tenantId,
      table.chainId,
      table.level,
    ),
    foreignKey({
      name: "approval_requests_chain_fk",
      columns: [table.tenantId, table.chainId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "approval_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // One open level per (action, object): a second concurrent request for
    // the same thing is refused instead of opening a parallel chain.
    uniqueIndex("approval_requests_one_pending_key")
      .on(table.tenantId, table.actionType, table.objectType, table.objectId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("approval_requests_create_key")
      .on(table.tenantId, table.requestedBy, table.createIdempotencyKey)
      .where(sql`${table.createIdempotencyKey} IS NOT NULL`),
    index("approval_requests_due_idx")
      .on(table.tenantId, table.deadlineAt)
      .where(sql`${table.status} = 'pending'`),
    index("approval_requests_inbox_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    check(
      "approval_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')`,
    ),
    check(
      "approval_requests_source_check",
      sql`${table.source} IN ('user', 'ai', 'mcp')`,
    ),
    check(
      "approval_requests_level_check",
      sql`${table.requiredLevels} BETWEEN 1 AND 3 AND ${table.level} BETWEEN 1 AND ${table.requiredLevels}`,
    ),
    check(
      "approval_requests_chain_check",
      sql`(${table.level} = 1) = (${table.chainId} = ${table.id})`,
    ),
    check(
      "approval_requests_amount_check",
      sql`(${table.amountIdr} IS NULL OR ${table.amountIdr} >= 0) AND (${table.thresholdIdr} IS NULL OR ${table.thresholdIdr} >= 0)`,
    ),
    check(
      "approval_requests_decision_check",
      sql`(${table.status} IN ('approved', 'rejected')) = (${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.reason} IS NOT NULL)`,
    ),
    // AUTH-06 / §3 F7 "Penyetuju selalu berbeda dari pemohon".
    check(
      "approval_requests_distinct_actor_check",
      sql`${table.decidedBy} IS NULL OR ${table.decidedBy} <> ${table.requestedBy}`,
    ),
    check(
      "approval_requests_deadline_check",
      sql`${table.deadlineAt} > ${table.createdAt}`,
    ),
    check(
      "approval_requests_json_check",
      sql`jsonb_typeof(${table.payload}) = 'object' AND jsonb_typeof(${table.requiredSteps}) = 'array'`,
    ),
    check(
      "approval_requests_reason_check",
      sql`char_length(${table.requestReason}) >= 3 AND (${table.reason} IS NULL OR char_length(${table.reason}) >= 3)`,
    ),
  ],
);
