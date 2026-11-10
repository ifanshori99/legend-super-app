// `support_access_grants` (PRD v1.7 §3 F4 "Support Access", TEN-04).
//
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka (default 60 menit) dengan alasan wajib, read-only secara
// default, tercatat di audit log, dan memicu notifikasi ke admin tenant."
//
// The row names the tenant being supported, so it is tenant-owned (T): the
// platform service sets that tenant's context explicitly for the operation,
// and the tenant admin reads the same rows through the tenant API. A tenant
// transaction can therefore never see another tenant's support sessions.
//
// Lifecycle (legend-33f): a grant is open until it is ended early
// (ended_at/ended_by) or its expiry is recorded (expiry_recorded_at, set by
// the worker sweep or the next request once expires_at has passed). Access is
// always decided against the clock at read time; expiry_recorded_at only makes
// the expiry audit row + support_access.ended event happen exactly once.

import { sql } from "drizzle-orm";
import {
  check,
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
import type { SupportAccessMode } from "@starter/shared/platform";
import { tenants } from "./platform-org";

export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Better Auth user id of the Super Admin opening the session. */
    superAdminUserId: text("super_admin_user_id").notNull(),
    /** Mandatory, at least 20 characters (support-access contract). */
    reason: text("reason").notNull(),
    accessMode: varchar("access_mode", { length: 20 })
      .$type<SupportAccessMode>()
      .notNull()
      .default("read_only"),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Server-computed start + duration; never extended, only ended early. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Second factor re-verified when the session was opened. */
    mfaVerifiedAt: timestamp("mfa_verified_at", {
      withTimezone: true,
    }).notNull(),
    /** Set when support_access.granted queued the tenant-admin notification. */
    tenantAdminNotifiedAt: timestamp("tenant_admin_notified_at", {
      withTimezone: true,
    }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    /** When the automatic expiry was audited and announced (never extended). */
    expiryRecordedAt: timestamp("expiry_recorded_at", { withTimezone: true }),
    /**
     * The owner-approved request a read_write grant came from (legend-c9kbk,
     * Q37). Null for read_only grants and for write grants that predate the
     * approval flow.
     */
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // FK support_access_grants_approval_request_fk (tenant_id,
    // approval_request_id) -> support_access_requests (tenant_id, id) lives in
    // migration 0160 only: declaring it here makes the two tables reference
    // each other and drizzle's inferred types circular (TS7022).
    uniqueIndex("support_access_grants_approval_request_key")
      .on(table.approvalRequestId)
      .where(sql`${table.approvalRequestId} IS NOT NULL`),
    // legend-c9kbk (Q37): an open write session exists only through an
    // approved request. Closed rows (ended or expiry recorded) are exempt, so
    // a read_write grant opened before the approval flow can still be ended
    // or recorded as expired (Postgres checks NOT VALID constraints on every
    // UPDATE). An unapproved open write grant can never be inserted.
    check(
      "support_access_grant_write_approved_check",
      sql`${table.accessMode} = 'read_only' OR ${table.approvalRequestId} IS NOT NULL OR ${table.endedAt} IS NOT NULL OR ${table.expiryRecordedAt} IS NOT NULL`,
    ),
    check(
      "support_access_mode_check",
      sql`${table.accessMode} IN ('read_only', 'read_write')`,
    ),
    check(
      "support_access_duration_check",
      sql`${table.durationMinutes} IN (15, 30, 60, 120)`,
    ),
    check(
      "support_access_window_check",
      sql`${table.expiresAt} = ${table.startedAt} + make_interval(mins => ${table.durationMinutes})`,
    ),
    check(
      "support_access_mfa_check",
      sql`${table.mfaVerifiedAt} <= ${table.startedAt}`,
    ),
    check(
      "support_access_ended_pair_check",
      sql`(${table.endedAt} IS NULL) = (${table.endedBy} IS NULL)`,
    ),
    // TEN-04 "read-only secara default": a write session is an explicit
    // choice and is capped shorter than a read session (PRD silent on the
    // cap; safest option, see SUPPORT_ACCESS_WRITE_MAX_MINUTES).
    check(
      "support_access_write_duration_check",
      sql`${table.accessMode} = 'read_only' OR ${table.durationMinutes} <= 30`,
    ),
    // An expiry is recorded only for a session that was not ended early, and
    // never before it actually expired.
    check(
      "support_access_expiry_recorded_check",
      sql`${table.expiryRecordedAt} IS NULL OR (${table.endedAt} IS NULL AND ${table.expiryRecordedAt} >= ${table.expiresAt})`,
    ),
    // TEN-04 audit view: the tenant's grants, newest first.
    index("support_access_tenant_started_idx").on(
      table.tenantId,
      table.startedAt.desc(),
    ),
    index("support_access_admin_open_idx").on(
      table.tenantId,
      table.superAdminUserId,
      table.expiresAt,
    ),
    // One open session per Super Admin and tenant. Expiry is a clock
    // comparison, so the service also takes an advisory lock and records any
    // lapsed session before opening a new one; this index is the backstop.
    uniqueIndex("support_access_one_open_key")
      .on(table.tenantId, table.superAdminUserId)
      .where(
        sql`${table.endedAt} IS NULL AND ${table.expiryRecordedAt} IS NULL`,
      ),
  ],
);

// `support_access_requests` (legend-c9kbk, founder Q37/Q38): a read_write
// support session is first REQUESTED by a Super Admin. Until a tenant owner
// approves it no row exists in `support_access_grants`, so every guard sees
// "no grant" (fail closed). Approval inserts a normal read_write grant that
// starts at approval time and links it through `grant_id`. A request not
// decided within 24 h expires. Tenant-owned (forced RLS, see
// platform-support-request.custom.sql, which also makes a decided row final).
export const supportAccessRequests = pgTable(
  "support_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Better Auth user id of the Super Admin asking for write access. */
    superAdminUserId: text("super_admin_user_id").notNull(),
    reason: text("reason").notNull(),
    accessMode: varchar("access_mode", { length: 20 })
      .$type<"read_write">()
      .notNull()
      .default("read_write"),
    durationMinutes: integer("duration_minutes").notNull(),
    /** Second factor re-verified when the request was filed. */
    mfaVerifiedAt: timestamp("mfa_verified_at", {
      withTimezone: true,
    }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Server-computed requested_at + 24 h; after it the request is expired. */
    approvalExpiresAt: timestamp("approval_expires_at", {
      withTimezone: true,
    }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<"pending" | "approved" | "rejected" | "expired">()
      .notNull()
      .default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Tenant owner who approved or rejected (null for expired). */
    decidedBy: text("decided_by"),
    /** The read_write grant created on approval. */
    grantId: uuid("grant_id"),
    /** Set when support_access.requested queued the owner notification. */
    ownerNotifiedAt: timestamp("owner_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Target of support_access_grants (tenant_id, approval_request_id).
    unique("support_access_requests_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    check(
      "support_access_request_mode_check",
      sql`${table.accessMode} = 'read_write'`,
    ),
    check(
      "support_access_request_duration_check",
      sql`${table.durationMinutes} IN (15, 30)`,
    ),
    check(
      "support_access_request_window_check",
      sql`${table.approvalExpiresAt} = ${table.requestedAt} + interval '24 hours'`,
    ),
    check(
      "support_access_request_mfa_check",
      sql`${table.mfaVerifiedAt} <= ${table.requestedAt}`,
    ),
    check(
      "support_access_request_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired')`,
    ),
    check(
      "support_access_request_decided_at_check",
      sql`(${table.status} = 'pending') = (${table.decidedAt} IS NULL)`,
    ),
    check(
      "support_access_request_decided_by_check",
      sql`(${table.status} IN ('approved', 'rejected')) = (${table.decidedBy} IS NOT NULL)`,
    ),
    check(
      "support_access_request_no_self_decision_check",
      sql`${table.decidedBy} IS NULL OR ${table.decidedBy} <> ${table.superAdminUserId}`,
    ),
    check(
      "support_access_request_grant_check",
      sql`(${table.status} = 'approved') = (${table.grantId} IS NOT NULL)`,
    ),
    check(
      "support_access_request_approved_in_time_check",
      sql`${table.status} <> 'approved' OR ${table.decidedAt} < ${table.approvalExpiresAt}`,
    ),
    check(
      "support_access_request_expired_late_check",
      sql`${table.status} <> 'expired' OR ${table.decidedAt} >= ${table.approvalExpiresAt}`,
    ),
    index("support_access_request_tenant_requested_idx").on(
      table.tenantId,
      table.requestedAt.desc(),
    ),
    // One pending request per Super Admin and tenant.
    uniqueIndex("support_access_request_one_pending_key")
      .on(table.tenantId, table.superAdminUserId)
      .where(sql`${table.status} = 'pending'`),
    index("support_access_request_due_idx").on(
      table.tenantId,
      table.status,
      table.approvalExpiresAt,
    ),
  ],
);
