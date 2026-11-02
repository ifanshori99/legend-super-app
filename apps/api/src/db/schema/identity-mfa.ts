import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("mfa_factors_user_id_idx").on(table.userId)],
);
