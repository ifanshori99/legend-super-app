import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./user";

// legend-k2l: how this session was opened (brief 290b, design ws08 M2 "Sign-in
// method gate"). Only a `password` session may open a management surface;
// `legacy` is every session that existed before migration 0204 (customer rows)
// and the safe default for any path that does not set the column.
export type SessionAuthMethod =
  "password" | "whatsapp" | "email_magic_link" | "google" | "legacy";

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
    // legend-658 (L5): stamped only when a code, recovery code or passkey is
    // checked against an already verified factor, never by the first
    // enrollment. NULL means mfa_verified_at (if any) may come from enrollment
    // alone, so a payout action asks for the password again.
    mfaChallengeVerifiedAt: timestamp("mfa_challenge_verified_at", {
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // legend-k2l: sign-in method gate. Set by the server only (Better Auth
    // `additionalFields` with `input: false`), never by a client. Existing
    // management rows are backfilled `password`, everything else `legacy`.
    authMethod: varchar("auth_method", { length: 20 })
      .$type<SessionAuthMethod>()
      .notNull()
      .default("legacy"),
    // legend-k2l: true when the login was completed on another device than
    // the one that asked for it (magic link opened elsewhere). Such a session
    // may not request a WhatsApp link (IDENTITY_LINK_REAUTH_REQUIRED).
    authCrossDevice: boolean("auth_cross_device").notNull().default(false),
    // legend-ypwsp: the shared-mode device this session was last seen on.
    // Stamped server-side only; lets the acting-staff guard keep demanding a
    // staff token when the device header is stripped. No FK: a revoked or
    // deleted device just lets the mark lapse.
    sharedDeviceId: uuid("shared_device_id"),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    check(
      "session_auth_method_check",
      sql`${table.authMethod} IN ('password', 'whatsapp', 'email_magic_link', 'google', 'legacy')`,
    ),
  ],
);
