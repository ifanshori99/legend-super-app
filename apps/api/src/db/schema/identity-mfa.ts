import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { session } from "./session";

// Second factors (PRD v1.7 §6 B `mfa_factors`, global). TOTP today; a passkey
// row keeps the WebAuthn public key once the assertion contract lands.
//
// `secret_encrypted` is sealed with lib/secrets.ts (AES-256-GCM, AAD = the
// factor id), never stored raw and never returned after enrollment: the
// enrollment response is the only place the base32 secret appears.
//
// `user_id` is a UUID without a foreign key on purpose: Better Auth's `user.id`
// is a text column (generated as a UUID), and Postgres cannot reference text
// from a uuid column. The service validates the id and scopes every query by
// the authenticated user.
export const mfaFactors = pgTable(
  "mfa_factors",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    /** `totp` | `passkey` (identity/schemas.ts MFA_FACTOR_TYPES). */
    type: varchar("type", { length: 20 }).notNull(),
    secretEncrypted: text("secret_encrypted"),
    /** WebAuthn credential public key, JSON-safe (passkey factors). */
    publicKey: jsonb("public_key").$type<Record<string, unknown>>(),
    /** Null until the user proves possession; unverified factors grant nothing. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * RFC 6238 time step of the last accepted TOTP code: a code is single-use
     * even while it is still inside the ±1 step window.
     */
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    /**
     * Passkeys: the authenticator's last accepted signature counter. A
     * response whose counter does not rise above it (while either is above
     * zero) is a cloned-authenticator signal and is refused (legend-jemg).
     */
    signCount: bigint("sign_count", { mode: "number" }).notNull().default(0),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("mfa_factors_user_id_idx").on(table.userId)],
);

// Pending WebAuthn challenges (legend-jemg; global like mfa_factors). One row per
// (factor, session, purpose): asking again replaces it, and verification
// deletes it first, so a challenge is single use, bound to the session that
// asked, and expires. The challenge is random per request, not a secret.
export const mfaPasskeyChallenges = pgTable(
  "mfa_passkey_challenges",
  {
    id: uuid("id").primaryKey(),
    factorId: uuid("factor_id")
      .notNull()
      .references(() => mfaFactors.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    /** `register` (finish enrollment) | `authenticate` (verify a session). */
    purpose: varchar("purpose", { length: 12 }).notNull(),
    /** base64url challenge exactly as sent to the browser. */
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("mfa_passkey_challenges_factor_session_purpose_key").on(
      table.factorId,
      table.sessionId,
      table.purpose,
    ),
    check(
      "mfa_passkey_challenges_purpose_check",
      sql`${table.purpose} IN ('register', 'authenticate')`,
    ),
  ],
);

// Recovery codes for staff MFA (global, no tenant RLS, like mfa_factors; user_id
// has no foreign key for the same reason). One set per user: regenerating
// replaces the set, and the cascade removes its codes. `failed_attempts` and
// `locked_until` rate-limit guesses per user, not per code.
export const mfaRecoveryCodeSets = pgTable("mfa_recovery_code_sets", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().unique(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// `code_hash` is the keyed blind index (lib/secrets.ts blindIndex) of the
// normalized code; the plaintext is never stored.
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey(),
    setId: uuid("set_id")
      .notNull()
      .references(() => mfaRecoveryCodeSets.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("mfa_recovery_codes_set_hash_key").on(table.setId, table.codeHash),
  ],
);
