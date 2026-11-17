// Tanya AI, MCP server and AI governance tables (PRD v1.7 §3 Fitur 38/39/40,
// §6 J; beads legend-zfi4, xq8y, zw9r, xkbt). Contract: `@starter/shared/ai`
// (schemas.ts, ids.ts). Tenant RLS and the pre-auth lookup policies live in
// ai.custom.sql.
//
// - Every table is tenant owned (`tenant_id` NOT NULL); operational rows carry
//   `outlet_id` (nullable where the contract allows tenant-level rows).
// - Money: `*_idr` is whole rupiah (budget unit, `monthlyBudgetIdr`);
//   `*_micro_usd` is the provider's price in millionths of a US dollar.
// - Pre-auth lookups (MCP bearer token, OAuth code exchange) run before a
//   tenant context exists. `mcp_tokens.token_hash` and `mcp_auth_codes.code_hash`
//   are 256-bit secrets, unique across tenants; ai.custom.sql resolves them to
//   (id, tenant_id) through SECURITY DEFINER functions.
// - The audit table `ai_tool_calls` is INSERT + SELECT only for the app role.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { approvalRequests } from "./platform-approval.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const userRef = (name: string) =>
  text(name)
    .$type<UserId>()
    .references(() => user.id);

/** §3 Fitur 40: one governance row per tenant (`aiGovernanceSettingsSchema`). */
export const aiSettings = pgTable(
  "ai_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    mcpEnabled: boolean("mcp_enabled").notNull().default(false),
    /** MCP-05: dynamic client registration is off unless the tenant turns it on. */
    dynamicClientRegistrationEnabled: boolean(
      "dynamic_client_registration_enabled",
    )
      .notNull()
      .default(false),
    /** Fail closed: a zero budget is always "stopped" until the owner sets one. */
    monthlyBudgetIdr: idrColumn("monthly_budget_idr")
      .notNull()
      .default(sql`0`),
    budgetWarnPct: integer("budget_warn_pct").notNull().default(80),
    budgetStopPct: integer("budget_stop_pct").notNull().default(100),
    /**
     * `AiFeatureSetting[]`: per feature `isEnabled` + `dailyLimitByRole`.
     * Roles without an entry use `defaultDailyLimitForRole` (employee 30,
     * management and owner 100).
     */
    features: jsonb("features")
      .$type<
        {
          feature: string;
          isEnabled: boolean;
          dailyLimitByRole: Record<string, number>;
        }[]
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Per-tool kill switch (`AiToolCode[]`). */
    disabledToolCodes: text("disabled_tool_codes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mcpRateLimitPerMinute: integer("mcp_rate_limit_per_minute")
      .notNull()
      .default(60),
    maxRowsPerResponse: integer("max_rows_per_response").notNull().default(200),
    updatedBy: userRef("updated_by").notNull(),
    updatedAt,
  },
  (table) => [
    unique("ai_settings_tenant_key").on(table.tenantId),
    check("ai_settings_budget_check", sql`${table.monthlyBudgetIdr} >= 0`),
    check(
      "ai_settings_pct_check",
      sql`${table.budgetWarnPct} BETWEEN 1 AND 100 AND ${table.budgetStopPct} BETWEEN 1 AND 100 AND ${table.budgetWarnPct} < ${table.budgetStopPct}`,
    ),
    check(
      "ai_settings_features_check",
      sql`jsonb_typeof(${table.features}) = 'array'`,
    ),
    check(
      "ai_settings_mcp_rate_check",
      sql`${table.mcpRateLimitPerMinute} BETWEEN 1 AND 600`,
    ),
    check(
      "ai_settings_max_rows_check",
      sql`${table.maxRowsPerResponse} BETWEEN 1 AND 200`,
    ),
  ],
);

/** One row per provider call: the cost and quota ledger (AI-13, AIG-01). */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    userId: userRef("user_id").notNull(),
    outletId: outletIdColumn(() => outlets.id),
    /** `AI-01`..`AI-14`; null when a call belongs to no feature (MCP). */
    feature: varchar("feature", { length: 10 }),
    channel: varchar("channel", { length: 10 }).notNull(),
    /** Server-owned billing source: a subscription is not an API invoice. */
    billingMode: varchar("billing_mode", { length: 20 })
      .$type<"api_metered" | "chatgpt_plan">()
      .notNull()
      .default("api_metered"),
    provider: varchar("provider", { length: 30 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Provider price, millionths of a US dollar. */
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    /** Same cost in whole rupiah (the budget unit of `ai_settings`). */
    costIdr: idrColumn("cost_idr")
      .notNull()
      .default(sql`0`),
    status: varchar("status", { length: 10 }).notNull(),
    errorCode: varchar("error_code", { length: 50 }),
    createdAt,
  },
  (table) => [
    check(
      "ai_usage_events_billing_mode_check",
      sql`${table.billingMode} IN ('api_metered', 'chatgpt_plan')`,
    ),
    foreignKey({
      name: "ai_usage_events_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("ai_usage_events_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("ai_usage_events_tenant_user_idx").on(
      table.tenantId,
      table.userId,
      table.createdAt,
    ),
    check(
      "ai_usage_events_channel_check",
      sql`${table.channel} IN ('tanya_ai', 'mcp', 'job')`,
    ),
    check(
      "ai_usage_events_status_check",
      sql`${table.status} IN ('ok', 'blocked', 'error')`,
    ),
    check(
      "ai_usage_events_amounts_check",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.costMicroUsd} >= 0 AND ${table.costIdr} >= 0`,
    ),
  ],
);

/**
 * Daily quota counter per user. Increment atomically:
 * `INSERT .. ON CONFLICT (tenant_id, user_id, usage_date) DO UPDATE
 *  SET request_count = ai_usage_daily.request_count + 1 RETURNING request_count`.
 */
export const aiUsageDaily = pgTable(
  "ai_usage_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    userId: userRef("user_id").notNull(),
    usageDate: businessDate("usage_date").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("ai_usage_daily_tenant_user_date_key").on(
      table.tenantId,
      table.userId,
      table.usageDate,
    ),
    check("ai_usage_daily_count_check", sql`${table.requestCount} >= 0`),
  ],
);

/** Monthly tenant spend; `warned_at` makes the 80% event fire once (AIG-01). */
export const aiUsageMonthly = pgTable(
  "ai_usage_monthly",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** `YYYY-MM` in the tenant's business calendar. */
    usageMonth: varchar("usage_month", { length: 7 }).notNull(),
    costIdr: idrColumn("cost_idr")
      .notNull()
      .default(sql`0`),
    /** Worst-case cost authorized before I/O; ambiguous failures stay held. */
    reservedCostIdr: idrColumn("reserved_cost_idr")
      .notNull()
      .default(sql`0`),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    requestCount: integer("request_count").notNull().default(0),
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("ai_usage_monthly_tenant_month_key").on(
      table.tenantId,
      table.usageMonth,
    ),
    check(
      "ai_usage_monthly_month_check",
      sql`${table.usageMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "ai_usage_monthly_reserved_cost_check",
      sql`${table.reservedCostIdr} >= 0`,
    ),
    check(
      "ai_usage_monthly_amounts_check",
      sql`${table.costIdr} >= 0 AND ${table.costMicroUsd} >= 0 AND ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.requestCount} >= 0`,
    ),
  ],
);

/** Cached answers (AI-12). The key hashes role set + scope + normalized question. */
export const aiResponseCache = pgTable(
  "ai_response_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    cacheKey: varchar("cache_key", { length: 128 }).notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt,
    /** At most 7 days after `created_at`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("ai_response_cache_tenant_key").on(table.tenantId, table.cacheKey),
    index("ai_response_cache_expires_idx").on(table.expiresAt),
    check(
      "ai_response_cache_ttl_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
  ],
);

/** A user's Tanya AI conversation. History delete removes the rows (cascade). */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    ownerUserId: userRef("owner_user_id").notNull(),
    feature: varchar("feature", { length: 10 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    createdAt,
    updatedAt,
    /** Contract field `deletedAt`; the service deletes rows, so it stays null. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Unsaved conversation retention: at most 7 days. Null = kept. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("ai_conversations_tenant_id_id_key").on(table.tenantId, table.id),
    index("ai_conversations_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.updatedAt,
    ),
    index("ai_conversations_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
    check(
      "ai_conversations_feature_check",
      sql`${table.feature} ~ '^AI-(0[1-9]|1[0-4])$'`,
    ),
    check(
      "ai_conversations_title_check",
      sql`char_length(${table.title}) BETWEEN 1 AND 120`,
    ),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    conversationId: uuid("conversation_id").notNull(),
    role: varchar("role", { length: 10 }).notNull(),
    content: text("content").notNull(),
    /** Set only on tool-role messages that carry a tool result. */
    toolCode: varchar("tool_code", { length: 5 }),
    /** `AiMessageSource[]` ("Jawaban Bersumber"). */
    sources: jsonb("sources")
      .$type<
        {
          label: string;
          link: string;
          metricCode?: string;
          period?: { from: string; to: string };
        }[]
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    aiAssisted: boolean("ai_assisted").notNull().default(false),
    createdAt,
    /** Unsaved assistant output: at most 7 days after `created_at`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "ai_messages_conversation_fk",
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [aiConversations.tenantId, aiConversations.id],
    }).onDelete("cascade"),
    index("ai_messages_conversation_idx").on(
      table.tenantId,
      table.conversationId,
      table.createdAt,
    ),
    check(
      "ai_messages_role_check",
      sql`${table.role} IN ('user', 'assistant', 'tool')`,
    ),
    check(
      "ai_messages_content_check",
      sql`char_length(${table.content}) BETWEEN 1 AND 8000`,
    ),
    check(
      "ai_messages_tool_code_check",
      sql`${table.toolCode} IS NULL OR (${table.role} = 'tool' AND ${table.toolCode} ~ '^TL-(0[1-9]|1[0-9]|20)$')`,
    ),
    check(
      "ai_messages_assistant_labelled_check",
      sql`${table.role} <> 'assistant' OR ${table.aiAssisted}`,
    ),
    check(
      "ai_messages_sources_check",
      sql`jsonb_typeof(${table.sources}) = 'array' AND jsonb_array_length(${table.sources}) <= 20`,
    ),
    check(
      "ai_messages_retention_check",
      sql`${table.expiresAt} IS NULL OR (${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days')`,
    ),
  ],
);

/**
 * MCP clients (§3 Fitur 39, MCP-01/05). `client_id` is the public OAuth id.
 * Revoked clients keep their approval trail (`mcpClientSchema` rules).
 */
export const mcpClients = pgTable(
  "mcp_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    clientId: varchar("client_id", { length: 100 }).notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    allowedScopes: text("allowed_scopes").array().notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    registeredVia: varchar("registered_via", { length: 10 }).notNull(),
    approvedBy: userRef("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedBy: userRef("revoked_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: varchar("revoke_reason", { length: 500 }),
    createdAt,
  },
  (table) => [
    unique("mcp_clients_tenant_id_id_key").on(table.tenantId, table.id),
    unique("mcp_clients_tenant_client_id_key").on(
      table.tenantId,
      table.clientId,
    ),
    index("mcp_clients_tenant_status_idx").on(table.tenantId, table.status),
    check(
      "mcp_clients_status_check",
      sql`${table.status} IN ('pending', 'approved', 'revoked')`,
    ),
    check(
      "mcp_clients_registered_via_check",
      sql`${table.registeredVia} IN ('admin', 'dynamic')`,
    ),
    check(
      "mcp_clients_arrays_check",
      sql`cardinality(${table.redirectUris}) BETWEEN 1 AND 10 AND cardinality(${table.allowedScopes}) BETWEEN 1 AND 30`,
    ),
    check(
      "mcp_clients_approval_check",
      sql`((${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL))
        AND (${table.status} <> 'approved' OR ${table.approvedBy} IS NOT NULL)
        AND (${table.status} <> 'pending' OR ${table.approvedBy} IS NULL)
        AND ((${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL))`,
    ),
  ],
);

/**
 * MCP access tokens (MCP-02): SHA-256 hex hash + display prefix, never the raw
 * token. `token_hash` is globally unique so a bearer token resolves to its
 * tenant before any tenant context exists (ai.custom.sql).
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    mcpClientId: uuid("mcp_client_id").notNull(),
    userId: userRef("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** First 12 chars of the raw token (`mcp_` + 8 chars): display only. */
    tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: varchar("revoke_reason", { length: 500 }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    unique("mcp_tokens_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("mcp_tokens_token_hash_key").on(table.tokenHash),
    foreignKey({
      name: "mcp_tokens_client_fk",
      columns: [table.tenantId, table.mcpClientId],
      foreignColumns: [mcpClients.tenantId, mcpClients.id],
    }),
    index("mcp_tokens_tenant_client_idx").on(table.tenantId, table.mcpClientId),
    index("mcp_tokens_tenant_user_idx").on(table.tenantId, table.userId),
    check(
      "mcp_tokens_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$' AND ${table.tokenPrefix} ~ '^mcp_[A-Za-z0-9]{8}$'`,
    ),
    check(
      "mcp_tokens_scopes_check",
      sql`cardinality(${table.scopes}) BETWEEN 1 AND 30`,
    ),
    check(
      "mcp_tokens_ttl_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '24 hours'`,
    ),
  ],
);

/** OAuth authorization codes, PKCE S256 only, valid at most 10 minutes (MCP-01). */
export const mcpAuthCodes = pgTable(
  "mcp_auth_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    mcpClientId: uuid("mcp_client_id").notNull(),
    userId: userRef("user_id").notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
    codeChallengeMethod: varchar("code_challenge_method", { length: 10 })
      .notNull()
      .default("S256"),
    redirectUri: varchar("redirect_uri", { length: 2000 }).notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_auth_codes_code_hash_key").on(table.codeHash),
    foreignKey({
      name: "mcp_auth_codes_client_fk",
      columns: [table.tenantId, table.mcpClientId],
      foreignColumns: [mcpClients.tenantId, mcpClients.id],
    }),
    index("mcp_auth_codes_expires_idx").on(table.expiresAt),
    check(
      "mcp_auth_codes_hash_check",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "mcp_auth_codes_method_check",
      sql`${table.codeChallengeMethod} = 'S256'`,
    ),
    check(
      "mcp_auth_codes_scopes_check",
      sql`cardinality(${table.scopes}) BETWEEN 1 AND 30`,
    ),
    check(
      "mcp_auth_codes_ttl_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
  ],
);

/**
 * Write-tool proposals (AIG-03, TL-13..TL-18): never a mutation, only a request
 * linked to one approval_request. `status` follows ACTION_REQUEST_TRANSITIONS.
 */
export const actionRequests = pgTable(
  "action_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Null = tenant-level request. */
    outletId: outletIdColumn(() => outlets.id),
    toolCode: varchar("tool_code", { length: 5 }).notNull(),
    requestedByUserId: userRef("requested_by_user_id").notNull(),
    source: varchar("source", { length: 3 }).notNull(),
    /** Required iff source is `mcp`. */
    mcpClientId: uuid("mcp_client_id"),
    /** Parsed tool input snapshot. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    approvalRequestId: uuid("approval_request_id").notNull(),
    approvalActionType: varchar("approval_action_type", {
      length: 20,
    }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    resultRef: varchar("result_ref", { length: 200 }),
    failureReason: varchar("failure_reason", { length: 500 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => [
    unique("action_requests_tenant_id_id_key").on(table.tenantId, table.id),
    unique("action_requests_tenant_approval_key").on(
      table.tenantId,
      table.approvalRequestId,
    ),
    foreignKey({
      name: "action_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "action_requests_mcp_client_fk",
      columns: [table.tenantId, table.mcpClientId],
      foreignColumns: [mcpClients.tenantId, mcpClients.id],
    }),
    foreignKey({
      name: "action_requests_approval_fk",
      columns: [table.tenantId, table.approvalRequestId],
      foreignColumns: [approvalRequests.tenantId, approvalRequests.id],
    }),
    index("action_requests_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    index("action_requests_tenant_requester_idx").on(
      table.tenantId,
      table.requestedByUserId,
      table.createdAt,
    ),
    check(
      "action_requests_tool_check",
      sql`${table.toolCode} IN ('TL-13', 'TL-14', 'TL-15', 'TL-16', 'TL-17', 'TL-18')`,
    ),
    check(
      "action_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')`,
    ),
    check(
      "action_requests_source_check",
      sql`(${table.source} = 'ai' AND ${table.mcpClientId} IS NULL AND ${table.approvalActionType} IN ('ai_action', 'stock_adjustment', 'discount', 'price_change'))
        OR (${table.source} = 'mcp' AND ${table.mcpClientId} IS NOT NULL AND ${table.approvalActionType} IN ('mcp_action', 'stock_adjustment', 'discount', 'price_change'))`,
    ),
    check(
      "action_requests_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check(
      "action_requests_outcome_check",
      sql`((${table.status} = 'executed') = (${table.executedAt} IS NOT NULL))
        AND (${table.resultRef} IS NULL OR ${table.status} = 'executed')
        AND ((${table.status} = 'failed') = (${table.failureReason} IS NOT NULL))`,
    ),
  ],
);

/**
 * Tool invocation audit (MCP-03). `params` is already PII-redacted by the
 * caller. Append-only for the app role (ai.custom.sql). `conversation_id` has
 * no FK: deleting a conversation must not touch the audit trail.
 */
export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    /** ULID in application code (`AiToolCallId`), UUID bytes in PostgreSQL. */
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    toolCode: varchar("tool_code", { length: 5 }).notNull(),
    channel: varchar("channel", { length: 3 }).notNull(),
    userId: userRef("user_id").notNull(),
    mcpClientId: uuid("mcp_client_id"),
    /** The MCP token that made the call (null for app calls and old rows). */
    mcpTokenId: uuid("mcp_token_id"),
    conversationId: uuid("conversation_id"),
    params: jsonb("params")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar("status", { length: 10 }).notNull(),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    errorCode: varchar("error_code", { length: 50 }),
    createdAt,
  },
  (table) => [
    foreignKey({
      name: "ai_tool_calls_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "ai_tool_calls_mcp_client_fk",
      columns: [table.tenantId, table.mcpClientId],
      foreignColumns: [mcpClients.tenantId, mcpClients.id],
    }),
    foreignKey({
      name: "ai_tool_calls_mcp_token_fk",
      columns: [table.tenantId, table.mcpTokenId],
      foreignColumns: [mcpTokens.tenantId, mcpTokens.id],
    }),
    index("ai_tool_calls_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("ai_tool_calls_tenant_user_idx").on(
      table.tenantId,
      table.userId,
      table.createdAt,
    ),
    check(
      "ai_tool_calls_tool_check",
      sql`${table.toolCode} ~ '^TL-(0[1-9]|1[0-9]|20)$'`,
    ),
    check(
      "ai_tool_calls_channel_check",
      sql`${table.channel} IN ('app', 'mcp')`,
    ),
    check(
      "ai_tool_calls_status_check",
      sql`${table.status} IN ('ok', 'denied', 'error')`,
    ),
    check(
      "ai_tool_calls_amounts_check",
      sql`(${table.rowCount} IS NULL OR ${table.rowCount} >= 0) AND (${table.durationMs} IS NULL OR ${table.durationMs} >= 0)`,
    ),
  ],
);
