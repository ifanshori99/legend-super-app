import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./user";

// Better Auth owns the session cookie and the `token` lookup column. PRD v1.7
// §6 B lists `sessions` (global) with token_hash, device_label, tenant_id,
// expires_at and revoked_at; the identity bead (legend-6xf) extends this same
// row instead of adding a second session table, so a revoke takes effect for
// every route (Better Auth reads this table on each request).
//
// Deviations from §6 B, deliberate and reported:
// - `token` keeps Better Auth's raw token because Better Auth resolves a
//   session by comparing that column; storing only a digest would break every
//   signed-in request. The column is never exposed on the wire, logged or
//   audited.
// - `sessions` is a global table (auth runs before a tenant is known, like
//   tenant_domains), so it carries no tenant RLS; `tenant_id` is nullable and
//   records the tenant of a tenant-bound login when the login flow sets it.
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set by the admin plugin while an admin is impersonating this user.
    impersonatedBy: text("impersonated_by"),
    // Legend session policy (§3 F6 "Sesi & Perangkat"; identity/machines.ts
    // sessionGate). `kind` is upgraded to management the first time the
    // session opens a guarded surface; `expires_at` is the idle deadline for a
    // management session and the 90-day end for a customer session.
    kind: varchar("kind", { length: 20 }).notNull().default("customer"),
    deviceLabel: varchar("device_label", { length: 120 }),
    tenantId: uuid("tenant_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);
