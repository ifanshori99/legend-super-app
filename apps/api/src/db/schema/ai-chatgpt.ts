// One opt-in/tombstone per tenant. Plaintext credentials never enter a column;
// pending and token bundles are AES-GCM envelopes with separate tenant/row AAD.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatgptConnectionStatus } from "@starter/shared/ai";
import { tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";

export const aiChatgptConnections = pgTable(
  "ai_chatgpt_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    status: varchar("status", { length: 20 })
      .$type<ChatgptConnectionStatus>()
      .notNull()
      .default("disconnected"),
    model: varchar("model", { length: 200 }),
    generation: integer("generation").notNull().default(0),
    attemptId: uuid("attempt_id"),
    pendingEncrypted: text("pending_encrypted"),
    tokensEncrypted: text("tokens_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    nextStartAt: timestamp("next_start_at", { withTimezone: true }),
    operationId: uuid("operation_id"),
    operationLeaseUntil: timestamp("operation_lease_until", {
      withTimezone: true,
    }),
    riskAcceptedBy: text("risk_accepted_by"),
    riskAcceptedAt: timestamp("risk_accepted_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_chatgpt_connections_tenant_key").on(table.tenantId),
    check(
      "ai_chatgpt_connections_status_check",
      sql`${table.status} IN ('disconnected','pending','connected','unavailable')`,
    ),
    check(
      "ai_chatgpt_connections_consent_check",
      sql`NOT ${table.enabled} OR (${table.riskAcceptedBy} IS NOT NULL AND ${table.riskAcceptedAt} IS NOT NULL AND ${table.model} IS NOT NULL)`,
    ),
    check(
      "ai_chatgpt_connections_tokens_check",
      sql`${table.status} <> 'connected' OR (${table.enabled} AND ${table.tokensEncrypted} IS NOT NULL)`,
    ),
    check(
      "ai_chatgpt_connections_generation_check",
      sql`${table.generation} >= 0`,
    ),
    check(
      "ai_chatgpt_connections_interval_check",
      sql`${table.intervalSeconds} BETWEEN 5 AND 60`,
    ),
  ],
);
