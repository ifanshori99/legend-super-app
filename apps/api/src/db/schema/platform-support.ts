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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
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
