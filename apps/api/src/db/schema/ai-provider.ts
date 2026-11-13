// Per-tenant AI provider config (WS-12, bead legend-dwrr; docs/DECISIONS.md
// "WS-12 provider AI per tenant" items 1-3). One OpenAI-compatible provider per
// tenant, authenticated by an API key. `chatgpt_oauth` is reserved: the service
// rejects it; the device flow uses its own ai_chatgpt_connections table.
//
// (T) rules: tenant_id NOT NULL with enforced tenant RLS
// (ai-provider.custom.sql); the table is tenant-level, so no outlet_id. The key
// is stored only as a `lib/secrets.ts` envelope (AAD
// `ai_provider_config:<tenantId>:<id>`); `api_key_last4` is the only readable
// part. `last_test_error_code` is a code from the fixed catalog in
// `@starter/shared/ai`, never provider error text.

import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  AiConnectionType,
  AiModelCapabilities,
  AiModelCapabilityOverrides,
} from "@starter/shared/ai";
import { tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";

/** `ai_provider_configs` (T): the AI provider of one tenant. */
export const aiProviderConfigs = pgTable(
  "ai_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    connectionType: varchar("connection_type", { length: 20 })
      .$type<AiConnectionType>()
      .notNull()
      .default("api_key"),
    /** Normalised, no trailing slash. */
    baseUrl: varchar("base_url", { length: 500 }).notNull(),
    defaultModel: varchar("default_model", { length: 200 }).notNull(),
    detectedCapabilities: jsonb(
      "detected_capabilities",
    ).$type<AiModelCapabilities>(),
    capabilityOverrides: jsonb(
      "capability_overrides",
    ).$type<AiModelCapabilityOverrides>(),
    /** `sealSecret` envelope, base64. */
    apiKeyEncrypted: text("api_key_encrypted"),
    /** Version byte of the envelope, for key rotation. */
    apiKeyKeyVersion: smallint("api_key_key_version"),
    apiKeyLast4: varchar("api_key_last4", { length: 4 }),
    apiKeySetAt: timestamp("api_key_set_at", { withTimezone: true }),
    /** User id of whoever set the key. */
    apiKeySetBy: text("api_key_set_by"),
    lastTestStatus: varchar("last_test_status", { length: 10 }).$type<
      "ok" | "failed"
    >(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    /** Code from the fixed catalog, not provider error text. */
    lastTestErrorCode: varchar("last_test_error_code", { length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("ai_provider_configs_tenant_key").on(table.tenantId),
    check(
      "ai_provider_configs_connection_type_check",
      sql`${table.connectionType} IN ('api_key', 'chatgpt_oauth')`,
    ),
    check(
      "ai_provider_configs_test_status_check",
      sql`${table.lastTestStatus} IS NULL OR ${table.lastTestStatus} IN ('ok', 'failed')`,
    ),
    check(
      "ai_provider_configs_key_check",
      sql`${table.connectionType} <> 'api_key' OR (${table.apiKeyEncrypted} IS NOT NULL AND ${table.apiKeyKeyVersion} IS NOT NULL AND ${table.apiKeyLast4} IS NOT NULL)`,
    ),
    check(
      "ai_provider_configs_test_check",
      sql`${table.lastTestStatus} IS NULL OR ${table.lastTestedAt} IS NOT NULL`,
    ),
  ],
);
