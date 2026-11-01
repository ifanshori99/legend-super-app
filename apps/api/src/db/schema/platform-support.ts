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

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
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
    // TEN-04 audit view: the tenant's grants, newest first.
    index("support_access_tenant_started_idx").on(
      table.tenantId,
      table.startedAt.desc(),
    ),
    // "One open session per Super Admin and tenant" is checked in the service
    // because expiry is a clock comparison, not a stored predicate.
    index("support_access_admin_open_idx").on(
      table.tenantId,
      table.superAdminUserId,
      table.expiresAt,
    ),
  ],
);
