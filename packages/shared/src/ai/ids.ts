// Tanya AI & MCP ids and closed vocabularies (bead legend-1zxo, WS-12).
// PRD v1.7 §3 Fitur 38 (Tanya AI), 39 (MCP Server), 40 (Tata Kelola AI & MCP);
// §6 J (action_requests, mcp_clients, ai_jobs, mcp_tokens, ai_conversations,
// ai_messages, ai_feature_settings). One tool catalog serves both channels
// (D32): the codes and names below are the single source for Tanya AI and MCP.

import { ulidIdSchema, uuidIdSchema, z } from "../core/index.ts";

export const actionRequestIdSchema = uuidIdSchema<"ActionRequestId">();
export type ActionRequestId = z.infer<typeof actionRequestIdSchema>;
export const mcpClientIdSchema = uuidIdSchema<"McpClientId">();
export type McpClientId = z.infer<typeof mcpClientIdSchema>;
export const mcpTokenIdSchema = uuidIdSchema<"McpTokenId">();
export type McpTokenId = z.infer<typeof mcpTokenIdSchema>;
export const aiConversationIdSchema = uuidIdSchema<"AiConversationId">();
export type AiConversationId = z.infer<typeof aiConversationIdSchema>;
export const aiMessageIdSchema = uuidIdSchema<"AiMessageId">();
export type AiMessageId = z.infer<typeof aiMessageIdSchema>;
export const aiJobIdSchema = uuidIdSchema<"AiJobId">();
export type AiJobId = z.infer<typeof aiJobIdSchema>;
/** One tool invocation (MCP-03 audit row). Operational and time-ordered: ULID. */
export const aiToolCallIdSchema = ulidIdSchema<"AiToolCallId">();
export type AiToolCallId = z.infer<typeof aiToolCallIdSchema>;
export const knowledgeChunkIdSchema = uuidIdSchema<"KnowledgeChunkId">();
export type KnowledgeChunkId = z.infer<typeof knowledgeChunkIdSchema>;

/** §3 Fitur 39 tool table, in PRD order. Index i is TL-(i+1). */
export const AI_TOOLS = [
  ["TL-01", "get_sales_summary"],
  ["TL-02", "get_menu_performance"],
  ["TL-03", "get_stock_levels"],
  ["TL-04", "get_food_cost"],
  ["TL-05", "get_labor_summary"],
  ["TL-06", "get_financial_statement"],
  ["TL-07", "get_customer_segments"],
  ["TL-08", "get_shift_schedule"],
  ["TL-09", "get_my_payslip"],
  ["TL-10", "search_sop"],
  ["TL-11", "get_anomalies"],
  ["TL-12", "get_my_profit_share"],
  ["TL-13", "draft_purchase_order"],
  ["TL-14", "draft_stock_adjustment"],
  ["TL-15", "draft_promotion"],
  ["TL-16", "draft_shift_schedule"],
  ["TL-17", "draft_price_change"],
  ["TL-18", "draft_menu_availability"],
  ["TL-19", "get_action_request_status"],
  ["TL-20", "get_facility_utilization"],
  ["TL-21", "get_review_summary"],
] as const;

export type AiToolCode = (typeof AI_TOOLS)[number][0];
export const AI_TOOL_CODES: readonly AiToolCode[] = Object.freeze(
  AI_TOOLS.map(([code]) => code),
);
export const aiToolCodeSchema = z.enum(
  AI_TOOL_CODES as [AiToolCode, ...AiToolCode[]],
);

export type AiToolName = (typeof AI_TOOLS)[number][1];
export const AI_TOOL_NAMES: readonly AiToolName[] = Object.freeze(
  AI_TOOLS.map(([, name]) => name),
);
export const aiToolNameSchema = z.enum(
  AI_TOOL_NAMES as [AiToolName, ...AiToolName[]],
);

/** Baca vs Tulis → approval (§3 Fitur 39 "Jenis"). */
export const AI_TOOL_KINDS = ["read", "write"] as const;
export type AiToolKind = (typeof AI_TOOL_KINDS)[number];
export const aiToolKindSchema = z.enum(AI_TOOL_KINDS);

/** §3 Fitur 38 AI-xx feature table. */
export const AI_FEATURE_CODES = [
  "AI-01",
  "AI-02",
  "AI-03",
  "AI-04",
  "AI-05",
  "AI-06",
  "AI-07",
  "AI-08",
  "AI-09",
  "AI-10",
  "AI-11",
  "AI-12",
  "AI-13",
  "AI-14",
] as const;
export type AiFeatureCode = (typeof AI_FEATURE_CODES)[number];
export const aiFeatureCodeSchema = z.enum(AI_FEATURE_CODES);

/** §6 J action_requests.source and ai_jobs.channel. */
export const ACTION_REQUEST_SOURCES = ["ai", "mcp"] as const;
export type ActionRequestSource = (typeof ACTION_REQUEST_SOURCES)[number];
export const actionRequestSourceSchema = z.enum(ACTION_REQUEST_SOURCES);

export const AI_CHANNELS = ["app", "mcp"] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];
export const aiChannelSchema = z.enum(AI_CHANNELS);

/** §6 J action_requests.status. */
export const ACTION_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
] as const;
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number];
export const actionRequestStatusSchema = z.enum(ACTION_REQUEST_STATUSES);

/** §6 J mcp_clients.status. */
export const MCP_CLIENT_STATUSES = ["pending", "approved", "revoked"] as const;
export type McpClientStatus = (typeof MCP_CLIENT_STATUSES)[number];
export const mcpClientStatusSchema = z.enum(MCP_CLIENT_STATUSES);

/** §6 J ai_jobs.status. */
export const AI_JOB_STATUSES = ["succeeded", "failed", "blocked"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];
export const aiJobStatusSchema = z.enum(AI_JOB_STATUSES);

/** Write tools TL-13..TL-18 (§3 Fitur 39 "Tulis"). Only these make action requests. */
export const ACTION_REQUEST_TOOL_CODES = [
  "TL-13",
  "TL-14",
  "TL-15",
  "TL-16",
  "TL-17",
  "TL-18",
] as const satisfies readonly AiToolCode[];
export type ActionRequestToolCode = (typeof ACTION_REQUEST_TOOL_CODES)[number];
export const actionRequestToolCodeSchema = z.enum(ACTION_REQUEST_TOOL_CODES);

// ---- MCP scopes (MCP-01) ---------------------------------------------------

/** Read scopes: `mcp:<domain>:read`. */
export const MCP_READ_SCOPES = [
  "mcp:sales:read",
  "mcp:menu:read",
  "mcp:inventory:read",
  "mcp:food_cost:read",
  "mcp:labor:read",
  "mcp:finance:read",
  "mcp:customers:read",
  "mcp:schedule:read",
  "mcp:payslip:read",
  "mcp:profit_share:read",
  "mcp:sop:read",
  "mcp:anomalies:read",
  "mcp:actions:read",
  "mcp:facility:read",
  "mcp:reviews:read",
] as const;

/** Draft (write) scopes: `mcp:<domain>:draft`. A draft only makes an action request. */
export const MCP_DRAFT_SCOPES = [
  "mcp:purchasing:draft",
  "mcp:inventory:draft",
  "mcp:promotion:draft",
  "mcp:schedule:draft",
  "mcp:pricing:draft",
  "mcp:menu:draft",
] as const;

export const MCP_SCOPES = [...MCP_READ_SCOPES, ...MCP_DRAFT_SCOPES] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
/** The real scope enum: an unknown scope such as `mcp:evil:read` is rejected. */
export const mcpScopeSchema = z.enum(MCP_SCOPES);

/** Plain Indonesian label for the consent screen, one per scope (MCP-01). */
export const MCP_SCOPE_LABELS_ID: Record<McpScope, string> = {
  "mcp:sales:read": "Melihat ringkasan penjualan",
  "mcp:menu:read": "Melihat menu dan harga",
  "mcp:inventory:read": "Melihat stok dan pergerakan stok",
  "mcp:food_cost:read": "Melihat food cost dan resep",
  "mcp:labor:read": "Melihat biaya tenaga kerja dan absensi",
  "mcp:finance:read": "Melihat laporan keuangan",
  "mcp:customers:read": "Melihat segmen pelanggan",
  "mcp:schedule:read": "Melihat jadwal shift",
  "mcp:payslip:read": "Melihat slip gaji Anda sendiri",
  "mcp:profit_share:read": "Melihat bagi hasil Anda sendiri",
  "mcp:sop:read": "Mencari dan membaca SOP",
  "mcp:anomalies:read": "Melihat anomali operasional",
  "mcp:actions:read": "Melihat status permintaan aksi",
  "mcp:facility:read": "Melihat pemakaian fasilitas",
  "mcp:reviews:read": "Melihat ringkasan ulasan pelanggan",
  "mcp:purchasing:draft": "Menyusun draf pembelian (menunggu persetujuan)",
  "mcp:inventory:draft":
    "Menyusun draf penyesuaian stok (menunggu persetujuan)",
  "mcp:promotion:draft": "Menyusun draf promosi (menunggu persetujuan)",
  "mcp:schedule:draft": "Menyusun draf jadwal shift (menunggu persetujuan)",
  "mcp:pricing:draft": "Menyusun draf perubahan harga (menunggu persetujuan)",
  "mcp:menu:draft": "Menyusun draf ketersediaan menu (menunggu persetujuan)",
};

export function isMcpScope(value: unknown): value is McpScope {
  return mcpScopeSchema.safeParse(value).success;
}
