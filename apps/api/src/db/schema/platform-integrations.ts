// `tenant_integrations` (T, PRD v1.7 §3 F4 "Integrasi per Tenant" and §6 A).
// One row per provider, tenant-wide (outlet_id null) or for one outlet; the
// outlet row wins for that outlet (`resolveIntegration`).
//
// Credentials are WRITE-ONLY: the API seals them with lib/secrets.ts and keeps
// only the sealed blob plus an opaque secret reference and the field names.
// Plaintext never reaches this table, a read response, an event or a log.
//
// `usage_costs_daily` (T, PRD v1.7 §6 J "Realisasi biaya") lives here too: it
// is the skeleton the quota/cost-cap helpers in platform-usage.service.ts read
// (PRD §3 F4 "Kuota & Plafon", A17, R18).

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationStatus,
} from "@starter/shared/platform";
import { outlets, tenants } from "./platform-org";

export const tenantIntegrations = pgTable(
  "tenant_integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** null = the tenant-wide default; set = only this outlet. */
    outletId: uuid("outlet_id"),
    provider: varchar("provider", { length: 30 })
      .$type<IntegrationProvider>()
      .notNull(),
    /** Non-secret settings only (merchant code, sender address, base URL). */
    config: jsonb("config").$type<IntegrationConfig>().notNull().default({}),
    /** Sealed credential envelope (AES-256-GCM, base64). Write-only. */
    credentialsEncrypted: text("credentials_encrypted"),
    /** Opaque `sec_…` pointer returned on reads; never derived from the secret. */
    credentialSecretRef: varchar("credential_secret_ref", { length: 80 }),
    /** Field names stored inside the sealed blob (not their values). */
    credentialFields: text("credential_fields").array(),
    credentialsSetAt: timestamp("credentials_set_at", { withTimezone: true }),
    /** Better Auth user id of the last credential writer. */
    credentialsSetBy: text("credentials_set_by"),
    /**
     * Envelope/key version of `credentials_encrypted` (lib/secrets.ts leading
     * version byte). Key rotation re-seals every row whose version is not the
     * current one, so stale rows are found without opening any blob.
     */
    credentialsKeyVersion: smallint("credentials_key_version"),
    status: varchar("status", { length: 20 })
      .$type<IntegrationStatus>()
      .notNull()
      .default("draft"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // NULL outlet_id would escape a plain unique index, so split the key.
    uniqueIndex("tenant_integrations_tenant_provider_key")
      .on(table.tenantId, table.provider)
      .where(sql`${table.outletId} IS NULL`),
    uniqueIndex("tenant_integrations_outlet_provider_key")
      .on(table.tenantId, table.outletId, table.provider)
      .where(sql`${table.outletId} IS NOT NULL`),
    foreignKey({
      name: "tenant_integrations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("tenant_integrations_tenant_idx").on(table.tenantId, table.provider),
    check(
      "tenant_integrations_status_check",
      sql`${table.status} IN ('draft', 'active', 'disabled')`,
    ),
    // An active integration always has stored credentials (contract refine).
    check(
      "tenant_integrations_active_credentials_check",
      sql`${table.status} <> 'active' OR ${table.credentialsEncrypted} IS NOT NULL`,
    ),
    check(
      "tenant_integrations_secret_ref_check",
      sql`${table.credentialSecretRef} IS NULL OR ${table.credentialSecretRef} ~ '^sec_[A-Za-z0-9_-]{16,64}$'`,
    ),
  ],
);

/** PRD §6 J `usage_costs_daily.component`. */
export const USAGE_COST_COMPONENTS = [
  "ai",
  "whatsapp",
  "email",
  "gateway",
  "server",
] as const;
export type UsageCostComponent = (typeof USAGE_COST_COMPONENTS)[number];

/**
 * `usage_costs_daily` (T): realised operating cost per tenant, day and
 * component (PRD §6 J). `cost_date` is the Asia/Jakarta calendar day; `units`
 * counts billable units (messages for WhatsApp/email, requests for AI) and
 * feeds the monthly AI request quota; `cost_idr` is whole rupiah and feeds the
 * WhatsApp/AI/email monthly cost caps. Tenant-level billing, not outlet
 * operations, so there is no outlet_id.
 */
export const usageCostsDaily = pgTable(
  "usage_costs_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    costDate: date("cost_date", { mode: "string" }).notNull(),
    component: varchar("component", { length: 20 })
      .$type<UsageCostComponent>()
      .notNull(),
    units: bigint("units", { mode: "number" }).notNull().default(0),
    costIdr: bigint("cost_idr", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("usage_costs_daily_tenant_date_component_key").on(
      table.tenantId,
      table.costDate,
      table.component,
    ),
    check(
      "usage_costs_daily_component_check",
      sql`${table.component} IN ('ai', 'whatsapp', 'email', 'gateway', 'server')`,
    ),
    check("usage_costs_daily_units_check", sql`${table.units} >= 0`),
    check("usage_costs_daily_cost_check", sql`${table.costIdr} >= 0`),
  ],
);
