// Tanya AI & MCP endpoint contracts (bead legend-1zxo, WS-12). The web app's
// typed client and mock mode, and later the API route validation, read these
// objects (docs/frontend.md, "Typed endpoints and mock mode"). Paths live under
// /api/ai so they cannot collide with another domain.
//
// Tenant comes from the domain or token, never the body (TEN-02). Outlet ids
// in a request ARE client input: the server checks them against the caller's
// outlet scope (TEN-03). Lists use cursor pagination (D-CORE-5).
//
// Permissions (enforced by the API, not by these schemas):
//   ask, conversations, action requests (own), usage, tool catalog -> ai.ask
//   governance get/update                                          -> ai.governance.manage
//   MCP clients list/register/approve/revoke                       -> mcp.client.manage
//   MCP tokens: own list/revoke needs mcp.client.manage OR token owner; the
//   tenant-wide list and revoking another user's token need mcp.client.manage.
//
// A write tool never mutates (AIG-03): `askAi` only answers or creates an
// action request linked to an approval request; there is no endpoint that
// executes one. Execution happens after approval in the approval module.
//
// Server-derived fields the client never sends: tenant, user, `status`,
// `approvedBy` / `approvedAt`, `revokedAt`, token hash and prefix. A raw MCP
// token is never returned by any list or get; issuing happens in the OAuth
// flow, outside this contract.

import {
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  actionRequestIdSchema,
  actionRequestStatusSchema,
  aiConversationIdSchema,
  aiFeatureCodeSchema,
  aiToolCodeSchema,
  aiToolKindSchema,
  aiToolNameSchema,
  mcpClientIdSchema,
  mcpScopeSchema,
  mcpTokenIdSchema,
} from "./ids.ts";
import {
  actionRequestSchema,
  aiConversationSchema,
  aiGovernanceSettingsSchema,
  aiMessageSchema,
  approveMcpClientSchema,
  askAiSchema,
  createAiConversationSchema,
  mcpClientSchema,
  mcpTokenSchema,
  registerMcpClientSchema,
  revokeMcpClientSchema,
  revokeMcpTokenSchema,
  updateAiGovernanceSettingsSchema,
} from "./schemas.ts";

// ---- Response items -------------------------------------------------------

/** MCP tool annotations (MCP-01): always closed-world and never destructive. */
export const aiToolSummaryAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean(),
  destructiveHint: z.literal(false),
  idempotentHint: z.boolean(),
  openWorldHint: z.literal(false),
});

/**
 * One row of the catalog list: a tool the caller may see (role, scope and the
 * tenant kill switch already applied). Input/output schemas are not on the
 * wire; the MCP server publishes them from the catalog object.
 */
export const aiToolSummarySchema = z.strictObject({
  code: aiToolCodeSchema,
  name: aiToolNameSchema,
  kind: aiToolKindSchema,
  /** Indonesian title for the app UI. */
  titleId: z.string().trim().min(1).max(120),
  /** English description given to the model. */
  description: z.string().trim().min(1).max(1000),
  scope: mcpScopeSchema,
  mcpAnnotations: aiToolSummaryAnnotationsSchema,
});
export type AiToolSummary = z.infer<typeof aiToolSummarySchema>;

/**
 * Answer to one question. `actionRequestIds` lists drafts the answer created
 * (write tools); each one waits for approval and has not run (AIG-03).
 */
export const askAiResponseSchema = z.strictObject({
  conversation: aiConversationSchema,
  userMessage: aiMessageSchema,
  assistantMessage: aiMessageSchema,
  actionRequestIds: z.array(actionRequestIdSchema).max(10),
});
export type AskAiResponse = z.infer<typeof askAiResponseSchema>;

/** A conversation with its messages in order (owner only). */
export const aiConversationDetailSchema = z.strictObject({
  conversation: aiConversationSchema,
  messages: z.array(aiMessageSchema).max(500),
});
export type AiConversationDetail = z.infer<typeof aiConversationDetailSchema>;

/**
 * Token as listed: no `tokenHash`, no raw token. Only the prefix is shown so a
 * person can tell tokens apart (MCP-02).
 */
export const mcpTokenSummarySchema = z.strictObject({
  id: mcpTokenIdSchema,
  tenantId: tenantIdSchema,
  clientId: mcpClientIdSchema,
  userId: userIdSchema,
  tokenPrefix: mcpTokenSchema.shape.tokenPrefix,
  scopes: mcpTokenSchema.shape.scopes,
  expiresAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type McpTokenSummary = z.infer<typeof mcpTokenSummarySchema>;

/** Quota of the caller for one feature today (AIG-01). */
export const aiFeatureUsageSchema = z.strictObject({
  feature: aiFeatureCodeSchema,
  isEnabled: z.boolean(),
  dailyLimit: z.number().int().nonnegative(),
  usedToday: z.number().int().nonnegative(),
});
export type AiFeatureUsage = z.infer<typeof aiFeatureUsageSchema>;

/** Tenant budget of the current month (AIG-02). */
export const aiBudgetUsageSchema = z.strictObject({
  monthlyBudgetIdr: idrSchema,
  usedIdr: idrSchema,
  warnPct: z.number().int().min(1).max(100),
  stopPct: z.number().int().min(1).max(100),
  /** Same values as `BudgetState` in schemas.ts. */
  state: z.enum(["ok", "warn", "stopped"]),
});
export type AiBudgetUsage = z.infer<typeof aiBudgetUsageSchema>;

/**
 * Usage summary. `features` is the caller's own quota. `budget` is tenant-wide
 * spend, so it is null unless the caller has `ai.governance.manage`.
 */
export const aiUsageSummarySchema = z.strictObject({
  aiEnabled: z.boolean(),
  /** First day of the budget month, "YYYY-MM". */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  features: z.array(aiFeatureUsageSchema).max(20),
  budget: aiBudgetUsageSchema.nullable(),
});
export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>;

// ---- List queries ---------------------------------------------------------

export const aiConversationListQuerySchema = cursorPageQuerySchema.extend({
  feature: aiFeatureCodeSchema.optional(),
});

export const actionRequestListQuerySchema = cursorPageQuerySchema.extend({
  status: actionRequestStatusSchema.optional(),
  toolCode: aiToolCodeSchema.optional(),
});

export const mcpClientListQuerySchema = cursorPageQuerySchema.extend({
  status: mcpClientSchema.shape.status.optional(),
});

export const mcpTokenListQuerySchema = cursorPageQuerySchema.extend({
  /** `mine` is the default; `tenant` needs mcp.client.manage. */
  scope: z.enum(["mine", "tenant"]).optional(),
  clientId: mcpClientIdSchema.optional(),
  /** Hide revoked and expired tokens when false. */
  includeInactive: z.stringbool().optional(),
});

// ---- Endpoints ------------------------------------------------------------

export const listAiTools = defineEndpoint({
  method: "GET",
  path: "/api/ai/tools",
  response: dataResponseSchema(z.array(aiToolSummarySchema).max(50)),
});

export const askAi = defineEndpoint({
  method: "POST",
  path: "/api/ai/ask",
  body: askAiSchema,
  response: dataResponseSchema(askAiResponseSchema),
});

export const listAiConversations = defineEndpoint({
  method: "GET",
  path: "/api/ai/conversations",
  query: aiConversationListQuerySchema,
  response: cursorPageSchema(aiConversationSchema),
});

export const createAiConversation = defineEndpoint({
  method: "POST",
  path: "/api/ai/conversations",
  body: createAiConversationSchema,
  response: dataResponseSchema(aiConversationSchema),
});

export const getAiConversation = defineEndpoint({
  method: "GET",
  path: "/api/ai/conversations/:conversationId",
  params: z.strictObject({ conversationId: aiConversationIdSchema }),
  response: dataResponseSchema(aiConversationDetailSchema),
});

/** Owner only; soft delete, 204 No Content. */
export const deleteAiConversation = defineEndpoint({
  method: "DELETE",
  path: "/api/ai/conversations/:conversationId",
  params: z.strictObject({ conversationId: aiConversationIdSchema }),
});

export const listMyActionRequests = defineEndpoint({
  method: "GET",
  path: "/api/ai/action-requests",
  query: actionRequestListQuerySchema,
  response: cursorPageSchema(actionRequestSchema),
});

export const getActionRequest = defineEndpoint({
  method: "GET",
  path: "/api/ai/action-requests/:actionRequestId",
  params: z.strictObject({ actionRequestId: actionRequestIdSchema }),
  response: dataResponseSchema(actionRequestSchema),
});

export const getAiGovernanceSettings = defineEndpoint({
  method: "GET",
  path: "/api/ai/governance",
  response: dataResponseSchema(aiGovernanceSettingsSchema),
});

export const updateAiGovernanceSettings = defineEndpoint({
  method: "PATCH",
  path: "/api/ai/governance",
  body: updateAiGovernanceSettingsSchema,
  response: dataResponseSchema(aiGovernanceSettingsSchema),
});

export const getAiUsageSummary = defineEndpoint({
  method: "GET",
  path: "/api/ai/usage",
  response: dataResponseSchema(aiUsageSummarySchema),
});

export const listMcpClients = defineEndpoint({
  method: "GET",
  path: "/api/ai/mcp-clients",
  query: mcpClientListQuerySchema,
  response: cursorPageSchema(mcpClientSchema),
});

/** Admin registration; a dynamic client lands as `pending` (MCP-05). */
export const registerMcpClient = defineEndpoint({
  method: "POST",
  path: "/api/ai/mcp-clients",
  body: registerMcpClientSchema,
  response: dataResponseSchema(mcpClientSchema),
});

export const approveMcpClient = defineEndpoint({
  method: "POST",
  path: "/api/ai/mcp-clients/:mcpClientId/approve",
  params: z.strictObject({ mcpClientId: mcpClientIdSchema }),
  body: approveMcpClientSchema,
  response: dataResponseSchema(mcpClientSchema),
});

export const revokeMcpClient = defineEndpoint({
  method: "POST",
  path: "/api/ai/mcp-clients/:mcpClientId/revoke",
  params: z.strictObject({ mcpClientId: mcpClientIdSchema }),
  body: revokeMcpClientSchema,
  response: dataResponseSchema(mcpClientSchema),
});

export const listMcpTokens = defineEndpoint({
  method: "GET",
  path: "/api/ai/mcp-tokens",
  query: mcpTokenListQuerySchema,
  response: cursorPageSchema(mcpTokenSummarySchema),
});

/** Takes effect within MCP_REVOCATION_MAX_SECONDS (MCP-02). */
export const revokeMcpToken = defineEndpoint({
  method: "POST",
  path: "/api/ai/mcp-tokens/:mcpTokenId/revoke",
  params: z.strictObject({ mcpTokenId: mcpTokenIdSchema }),
  body: revokeMcpTokenSchema,
  response: dataResponseSchema(mcpTokenSummarySchema),
});
