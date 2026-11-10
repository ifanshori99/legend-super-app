// Identity & access tables for the WhatsApp reverse-OTP login (PRD v1.7 §6 B
// `user_identities`, `login_challenges`, `wa_inbound_messages`; AUTH-01..04).
//
// All three tables are GLOBAL in §6 B: an account, its identities and a login
// attempt exist before (or across) tenant context, so they carry no RLS. The
// coordinator decision (docs/plan/contracts.md, `login_challenges` paragraph)
// is explicit: `login_challenges` and `wa_inbound_messages` "resolve the tenant
// from the receiving WhatsApp number and are service-scoped without RLS".
// `user_identities` is keyed by a keyed digest (unique per type), which is what
// makes it safe to look up without a tenant filter.
//
// Service scoping therefore lives in the services, not in Postgres:
// - a challenge row carries the tenant/brand context and the receiving number
//   it may be completed by, and the webhook refuses a message received on any
//   other number (`identity-wa-inbound.service.ts`);
// - `wa_inbound_messages` keeps no message body, only the provider message id
//   (the AUTH-02 idempotency key), the keyed sender digest and an outcome kind.
//
// Every secret is stored as a keyed digest (VARCHAR(64) hex) — the login code,
// the browser binding, the client IP and the sender number. `value_encrypted`
// on `user_identities` is an AES-GCM envelope (lib/secrets.ts) so a masked value
// can still be shown to its owner later.
//
// user_id columns are text next to Better Auth's `user` table, matching the
// platform-org convention (no FK across that boundary until the §6 `users`
// table lands).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  LoginChallengeStatus,
  LoginChannel,
  UserIdentityType,
  WhatsAppProofPurpose,
} from "@starter/shared/identity";
import { brands, tenants } from "./platform-org";

/** §6 B `user_identities` (global) — the account's login graph (§3 F6). */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Better Auth `user.id` (text; UUID-valued, see lib/auth.ts). */
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 20 }).$type<UserIdentityType>().notNull(),
    /** Keyed digest: `whatsAppNumberDigest` for WhatsApp, HMAC for email. */
    valueHash: varchar("value_hash", { length: 64 }).notNull(),
    /** AES-GCM envelope of the raw value; never returned on the wire. */
    valueEncrypted: text("value_encrypted"),
    /** Google subject id (OAuth); null for WhatsApp and email identities. */
    providerSubject: varchar("provider_subject", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    isPrimary: boolean("is_primary").notNull().default(false),
    /**
     * legend-lgfru (design D-WA3): when this identity became this account's,
     * verified. Trigger `user_identities_linked_at_on_owner_change`
     * (migration 0272) resets it to now() whenever `user_id` or `verified_at`
     * changes, so a merge or a late verification never inherits an old date.
     */
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // PRD §6 B: the blind index is unique per type, so one number maps to one
    // account platform-wide and a second account must merge (k2l).
    unique("user_identities_type_value_key").on(table.type, table.valueHash),
    index("user_identities_user_idx").on(table.userId),
    // legend-k2l: one WhatsApp number per account. A second number never
    // links silently; the merge flow (identity-merge.service.ts) or support
    // decides, so this index is the last line behind the service checks.
    uniqueIndex("user_identities_one_whatsapp_per_user")
      .on(table.userId)
      .where(sql`${table.type} = 'whatsapp'`),
    check(
      "user_identities_type_check",
      sql`${table.type} IN ('whatsapp', 'email', 'google')`,
    ),
    check(
      "user_identities_value_hash_check",
      sql`${table.valueHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** §6 B `login_challenges` (global) — one row per login attempt (AUTH-01). */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** null = a platform (Super Admin) login with no tenant context yet. */
    tenantId: uuid("tenant_id"),
    brandId: uuid("brand_id"),
    channel: varchar("channel", { length: 20 }).$type<LoginChannel>().notNull(),
    /**
     * legend-lgfru (design D-WA1): what the proof is for. `sign_in` rows are
     * the login flow; `payslip_pin_reset` rows are completed by the webhook
     * (identity-wa-proof.service.ts) and never link, merge or issue a session.
     */
    purpose: varchar("purpose", { length: 32 })
      .$type<WhatsAppProofPurpose>()
      .notNull()
      .default("sign_in"),
    /** Keyed digest of the number that must send the proof; null for sign_in. */
    expectedSenderHash: varchar("expected_sender_hash", { length: 64 }),
    /** When a verified proof was used for its action; null for sign_in. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** Keyed digest of the 8-symbol code (AUTH-01; the code itself is never stored). */
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    /** Keyed digest of the requesting browser's binding nonce (AUTH-01). */
    browserBindingHash: varchar("browser_binding_hash", {
      length: 64,
    }).notNull(),
    /**
     * The receiving WhatsApp number this challenge may be completed by: the
     * tenant's routing value, read from its `whatsapp` integration when the
     * challenge was created. A webhook message received on any other number is
     * rejected instead of completing this row (AUTH-02, no account leak).
     */
    receivingNumber: varchar("receiving_number", { length: 32 }),
    /** Authenticated session that requested a link; null for sign-in. */
    linkUserId: text("link_user_id"),
    linkSessionId: text("link_session_id"),
    /** The account the sending number resolved to; set when completed. */
    matchedUserId: text("matched_user_id"),
    status: varchar("status", { length: 20 })
      .$type<LoginChallengeStatus>()
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Better Auth session handed to the polling browser, at most once. */
    sessionId: text("session_id"),
    sessionIssuedAt: timestamp("session_issued_at", { withTimezone: true }),
    /**
     * legend-k2l: the address of an `email_magic_link` challenge, sealed with
     * `sealSecret(email, "login_challenge:email:<id>")`. The 43-char token
     * cannot carry the email and `matched_user_id` stays null until the link
     * is verified, so the address lives here. Null for every other channel.
     */
    emailEncrypted: text("email_encrypted"),
    /**
     * Card w8dfz.1: opt-in confirmation before a session is issued. The
     * sender is stored only masked (country code and last 4 digits).
     */
    senderMasked: text("sender_masked"),
    confirmRequired: boolean("confirm_required").notNull().default(false),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Keyed client-IP digest for the AUTH-04 per-IP limit. */
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "login_challenges_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
    }),
    foreignKey({
      name: "login_challenges_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check(
      "login_challenges_channel_check",
      sql`${table.channel} IN ('whatsapp_inbound', 'email_magic_link', 'google')`,
    ),
    check(
      "login_challenges_status_check",
      sql`${table.status} IN ('pending', 'completed', 'expired', 'cancelled')`,
    ),
    // legend-k2l: only a magic-link challenge carries a sealed address.
    check(
      "login_challenges_email_encrypted_check",
      sql`(${table.channel} = 'email_magic_link') = (${table.emailEncrypted} IS NOT NULL)`,
    ),
    check(
      "login_challenges_brand_needs_tenant_check",
      sql`${table.brandId} IS NULL OR ${table.tenantId} IS NOT NULL`,
    ),
    // legend-lgfru (design §5.1): a proof row is always a tenant's, bound to a
    // signed-in session and a sender, and never carries a login result.
    check(
      "login_challenges_purpose_check",
      sql`${table.purpose} IN ('sign_in', 'payslip_pin_reset')`,
    ),
    check(
      "login_challenges_proof_shape_check",
      sql`${table.purpose} = 'sign_in' OR (${table.channel} = 'whatsapp_inbound' AND ${table.tenantId} IS NOT NULL AND ${table.linkUserId} IS NOT NULL AND ${table.linkSessionId} IS NOT NULL AND ${table.expectedSenderHash} IS NOT NULL AND ${table.matchedUserId} IS NULL AND ${table.sessionId} IS NULL AND ${table.sessionIssuedAt} IS NULL)`,
    ),
    check(
      "login_challenges_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.purpose} <> 'sign_in' AND ${table.status} = 'completed')`,
    ),
    // Per-user proof limit and cancelling a user's open proofs.
    index("login_challenges_purpose_user_idx").on(
      table.purpose,
      table.linkUserId,
      table.createdAt,
    ),
    // A brand context without a tenant is impossible; the wire schema says so too.
    // The webhook matches the code digest inside one channel (AUTH-02).
    index("login_challenges_code_idx").on(table.channel, table.codeHash),
    // AUTH-04: "5 challenge aktif per perangkat atau IP per 15 menit" counts
    // the rows opened in the window per device and per IP.
    index("login_challenges_binding_idx").on(
      table.browserBindingHash,
      table.createdAt,
    ),
    index("login_challenges_ip_idx").on(table.ipHash, table.createdAt),
    // The sweep that expires pending rows and the tenant's recent attempts.
    index("login_challenges_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
  ],
);

/**
 * §6 B `wa_inbound_messages` (global) — the webhook log. No message body: only
 * the provider message id, the keyed sender digest and the outcome.
 *
 * `kind` is one of:
 * - `login` — a valid code completed a pending challenge;
 * - `proof` — a valid `RESET PIN` code completed a proof (legend-lgfru);
 * - `unknown` — not a login message (no `MASUK <code>`), or no pending challenge;
 * - `rejected` — the challenge was for another receiving number or no longer valid;
 * - `rate_limited` — AUTH-04's 10 messages per number per hour was reached.
 */
export const waInboundMessages = pgTable(
  "wa_inbound_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `X-Kirim-Event-Id` (the WhatsApp message id): unique, AUTH-02 dedupe. */
    providerMessageId: varchar("provider_message_id", {
      length: 255,
    }).notNull(),
    /** Keyed digest of the complete provider message, for replay binding. */
    requestHash: varchar("request_hash", { length: 64 }),
    /** null when no tenant owns the receiving number. */
    tenantId: uuid("tenant_id"),
    /** The provider-received number the message was routed by. */
    receivingNumber: varchar("receiving_number", { length: 32 }).notNull(),
    /** Keyed digest of the sender number; the raw number is never stored. */
    fromHash: varchar("from_hash", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    challengeId: uuid("challenge_id"),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // AUTH-02: a repeated message id is processed at most once, platform-wide.
    unique("wa_inbound_messages_provider_id_key").on(table.providerMessageId),
    foreignKey({
      name: "wa_inbound_messages_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
    }),
    foreignKey({
      name: "wa_inbound_messages_challenge_fk",
      columns: [table.challengeId],
      foreignColumns: [loginChallenges.id],
    }),
    check(
      "wa_inbound_messages_kind_check",
      sql`${table.kind} IN ('login', 'proof', 'unknown', 'rejected', 'rate_limited')`,
    ),
    check(
      "wa_inbound_messages_from_hash_check",
      sql`${table.fromHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // AUTH-04: "10 pesan login per nomor per jam" counts one hour of messages.
    index("wa_inbound_messages_from_idx").on(table.fromHash, table.processedAt),
    index("wa_inbound_messages_tenant_idx").on(
      table.tenantId,
      table.processedAt,
    ),
  ],
);
