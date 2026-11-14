// `tenant_domains` (PRD v1.7 §6 A, TEN-02). Host name -> tenant is how a
// public request learns its tenant, so it is the one tenant-related table that
// must be readable *before* a tenant context exists.
//
// Read/write rules live in the `platform_org_rls` migration, not in
// `app.enforce_tenant_rls`:
// - SELECT is open to legend_app: DNS names and their owning tenant are public
//   information, and host resolution runs before `app.tenant_id` is known.
// - INSERT/UPDATE/DELETE require app.tenant_id to equal tenant_id, so a
//   tenant transaction can only change its own host names.
// RLS is ENABLE (not FORCE) so the migration owner can still repair rows, and
// the catalog guard test allowlists this table with the same reasoning.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { brands, tenants } from "./platform-org";

export const tenantDomains = pgTable(
  "tenant_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    brandId: uuid("brand_id").notNull(),
    /** Lowercase, no port, no trailing dot (`normalizeHostname`). Unique
     * across the platform only once verified (legend-t57t): an unverified
     * claim cannot block the real owner, and one host serves one tenant. */
    hostname: varchar("hostname", { length: 253 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    tlsStatus: varchar("tls_status", { length: 20 })
      .notNull()
      .default("pending"),
    /** null until the DNS ownership check passes; only verified hosts resolve. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Random value the tenant publishes as a DNS TXT record to prove it
     * controls a custom domain. Null for platform subdomains. */
    verificationToken: varchar("verification_token", { length: 64 }),
    /** Shared DNS attempt budget; survives API restart (legend-8y5fc). */
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    verificationWindowStartedAt: timestamp("verification_window_started_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("tenant_domains_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "tenant_domains_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    index("tenant_domains_brand_idx").on(table.tenantId, table.brandId),
    // One verified owner per host; unverified claims may coexist (anti-squat).
    uniqueIndex("tenant_domains_verified_hostname_key")
      .on(table.hostname)
      .where(sql`${table.verifiedAt} IS NOT NULL`),
    // A tenant claims a host once.
    uniqueIndex("tenant_domains_tenant_hostname_key").on(
      table.tenantId,
      table.hostname,
    ),
    // Host resolution reads every row for a host (verified first).
    index("tenant_domains_hostname_idx").on(table.hostname),
    check(
      "tenant_domains_verification_attempts_check",
      sql`${table.verificationAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "tenant_domains_kind_check",
      sql`${table.kind} IN ('platform_subdomain', 'custom')`,
    ),
    check(
      "tenant_domains_tls_status_check",
      sql`${table.tlsStatus} IN ('pending', 'active', 'failed')`,
    ),
  ],
);
