// Tanya AI & MCP persisted records and governance (bead legend-1zxo, WS-12).
// PRD v1.7 §3 Fitur 38 (Tanya AI), 39 (MCP Server), 40 (Tata Kelola AI & MCP),
// §6 J (action_requests, ai_conversations, ai_messages, ai_jobs, mcp_clients,
// mcp_tokens, ai_feature_settings). Tool I/O lives in `tool-io.ts` and the tool
// catalog in `tools.ts`; this file must not import either (parallel ownership).
//
// Rules: wire is camelCase, statuses snake_case, objects strict. Money is whole
// rupiah (`…Idr`); percents are Decimal4 strings except the governance
// thresholds, which are whole-number settings. Client INPUT schemas never carry
// `tenantId` (tenant comes from the token or domain, TEN-02). A write tool never
// mutates: it only produces an action_request linked to an approval_request
// (AIG-03). MCP tokens are stored as hash + prefix only: no raw token field.

import {
  businessDateSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { roleTemplateKeySchema } from "../access/schemas.ts";
import type { RoleTemplateKey } from "../access/roles.ts";
import { approvalRequestIdSchema } from "../identity/ids.ts";
import { metricCodeSchema } from "../metrics/schemas.ts";
import {
  actionRequestIdSchema,
  actionRequestSourceSchema,
  actionRequestStatusSchema,
  actionRequestToolCodeSchema,
  aiChannelSchema,
  aiConversationIdSchema,
  aiFeatureCodeSchema,
  aiJobIdSchema,
  aiJobStatusSchema,
  aiMessageIdSchema,
  aiToolCallIdSchema,
  aiToolCodeSchema,
  mcpClientIdSchema,
  mcpClientStatusSchema,
  mcpScopeSchema,
  mcpTokenIdSchema,
} from "./ids.ts";
import type { ActionRequestStatus } from "./ids.ts";

// ---- Action requests (§6 J action_requests, AIG-03) ------------------------

/** approval_requests.action_type values used by AI and MCP (access/approval.ts). */
export const ACTION_REQUEST_APPROVAL_ACTION_TYPES = [
  "ai_action",
  "mcp_action",
  // The module's own rule, when the tenant has one for the change (never
  // weaker than making the change by hand).
  "stock_adjustment",
  "discount",
  "price_change",
] as const;
export type ActionRequestApprovalActionType =
  (typeof ACTION_REQUEST_APPROVAL_ACTION_TYPES)[number];
export const actionRequestApprovalActionTypeSchema = z.enum(
  ACTION_REQUEST_APPROVAL_ACTION_TYPES,
);

const resultRefSchema = z.string().trim().min(1).max(200);
const failureReasonSchema = z.string().trim().min(1).max(500);

/** Source decides the default approval action type: ai -> ai_action, mcp -> mcp_action. */
function expectedApprovalActionType(
  source: "ai" | "mcp",
): ActionRequestApprovalActionType {
  return source === "ai" ? "ai_action" : "mcp_action";
}

/** The default type of the source, or a module action; never the other source's. */
function approvalActionTypeFitsSource(
  source: "ai" | "mcp",
  type: ActionRequestApprovalActionType,
): boolean {
  return (
    type === expectedApprovalActionType(source) ||
    (type !== "ai_action" && type !== "mcp_action")
  );
}

type ActionRequestShapeCheck = {
  source: "ai" | "mcp";
  mcpClientId: unknown;
  approvalActionType: ActionRequestApprovalActionType;
};

/** Cross-field rules shared by the stored row and the server-side insert input. */
function checkActionRequestShape(
  value: ActionRequestShapeCheck,
  ctx: z.RefinementCtx,
): void {
  const add = (path: string, message: string, invalid: boolean) => {
    if (invalid) ctx.addIssue({ code: "custom", path: [path], message });
  };
  add(
    "mcpClientId",
    "mcpClientId is required when source is mcp",
    value.source === "mcp" && value.mcpClientId === null,
  );
  add(
    "mcpClientId",
    "mcpClientId must be null when source is ai",
    value.source === "ai" && value.mcpClientId !== null,
  );
  add(
    "approvalActionType",
    "approvalActionType must match source (ai -> ai_action, mcp -> mcp_action) or be a module action",
    !approvalActionTypeFitsSource(value.source, value.approvalActionType),
  );
}

const actionRequestInsertShape = {
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
  toolCode: actionRequestToolCodeSchema,
  requestedByUserId: userIdSchema,
  source: actionRequestSourceSchema,
  /** Required iff source is mcp. */
  mcpClientId: mcpClientIdSchema.nullable(),
  /** Parsed tool input snapshot (the tool input schema validates it upstream). */
  payload: z.record(z.string(), z.json()),
  approvalRequestId: approvalRequestIdSchema,
  approvalActionType: actionRequestApprovalActionTypeSchema,
  expiresAt: isoDateTimeSchema,
};

export const actionRequestSchema = z
  .strictObject({
    id: actionRequestIdSchema,
    ...actionRequestInsertShape,
    status: actionRequestStatusSchema,
    /** Non-null only when status is executed. */
    resultRef: resultRefSchema.nullable(),
    /** Non-null if and only if status is failed. */
    failureReason: failureReasonSchema.nullable(),
    createdAt: isoDateTimeSchema,
    /** Non-null iff status is executed. */
    executedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    checkActionRequestShape(request, ctx);
    if (request.resultRef !== null && request.status !== "executed")
      ctx.addIssue({
        code: "custom",
        path: ["resultRef"],
        message: "resultRef is only allowed when status is executed",
      });
    if ((request.status === "failed") !== (request.failureReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "failureReason is set if and only if status is failed",
      });
    if ((request.status === "executed") !== (request.executedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["executedAt"],
        message: "executedAt is set if and only if status is executed",
      });
  });
export type ActionRequest = z.infer<typeof actionRequestSchema>;

/**
 * Server-side insert input: no id, status, resultRef, failureReason, createdAt
 * or executedAt (the server sets them; a new request is always `pending`).
 * `expiresAt` stays because the approval deadline is decided by the caller.
 */
export const createActionRequestSchema = z
  .strictObject(actionRequestInsertShape)
  .superRefine(checkActionRequestShape);
export type CreateActionRequest = z.infer<typeof createActionRequestSchema>;

/** pending -> approved|rejected|expired; approved -> executed|failed; rest terminal. */
export const ACTION_REQUEST_TRANSITIONS: Readonly<
  Record<ActionRequestStatus, readonly ActionRequestStatus[]>
> = Object.freeze({
  pending: ["approved", "rejected", "expired"],
  approved: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
  expired: [],
});

export function canTransitionActionRequest(
  from: ActionRequestStatus,
  to: ActionRequestStatus,
): boolean {
  return ACTION_REQUEST_TRANSITIONS[from].includes(to);
}

// ---- Conversations and messages (§6 J ai_conversations, ai_messages) -------

export const AI_CONVERSATION_TITLE_MAX = 120;
export const AI_MESSAGE_CONTENT_MAX = 8000;
export const AI_QUESTION_MAX = 2000;
export const AI_MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];
export const aiMessageRoleSchema = z.enum(AI_MESSAGE_ROLES);

const conversationTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_CONVERSATION_TITLE_MAX);

export const aiConversationSchema = z.strictObject({
  id: aiConversationIdSchema,
  tenantId: tenantIdSchema,
  userId: userIdSchema,
  feature: aiFeatureCodeSchema,
  title: conversationTitleSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** Soft delete: the owner can delete a conversation (§3 Fitur 38). */
  deletedAt: isoDateTimeSchema.nullable(),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

/** "Jawaban Bersumber": where a number in an answer came from (§3 Fitur 38). */
export const aiMessageSourcePeriodSchema = z.strictObject({
  from: businessDateSchema,
  to: businessDateSchema,
});
export const aiMessageSourceSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  /** Relative app path to the source screen. */
  link: z
    .string()
    .min(1)
    .max(500)
    .regex(/^\//, "link must be a relative app path"),
  metricCode: metricCodeSchema.optional(),
  period: aiMessageSourcePeriodSchema.optional(),
});
export type AiMessageSource = z.infer<typeof aiMessageSourceSchema>;

export const aiMessageSchema = z
  .strictObject({
    id: aiMessageIdSchema,
    conversationId: aiConversationIdSchema,
    role: aiMessageRoleSchema,
    content: z.string().min(1).max(AI_MESSAGE_CONTENT_MAX),
    /** Set on tool-role messages that carry a tool result. */
    toolCode: aiToolCodeSchema.nullable(),
    sources: z.array(aiMessageSourceSchema).max(20),
    /** Assistant output is always labelled "Dibantu AI". */
    aiAssisted: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((message, ctx) => {
    if (message.role === "assistant" && !message.aiAssisted)
      ctx.addIssue({
        code: "custom",
        path: ["aiAssisted"],
        message: "Assistant messages must be marked aiAssisted",
      });
  });
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const createAiConversationSchema = z.strictObject({
  feature: aiFeatureCodeSchema,
  title: conversationTitleSchema.optional(),
});
export type CreateAiConversation = z.infer<typeof createAiConversationSchema>;

export const askAiSchema = z.strictObject({
  /** Omit to start a new conversation. */
  conversationId: aiConversationIdSchema.optional(),
  feature: aiFeatureCodeSchema,
  question: z.string().trim().min(1).max(AI_QUESTION_MAX),
  /** Checked against the caller's outlet scope (TEN-03). */
  outletId: outletIdSchema.optional(),
});
export type AskAi = z.infer<typeof askAiSchema>;

// ---- Jobs (§6 J ai_jobs) ---------------------------------------------------

export const AI_BLOCKED_REASONS = [
  "quota_exceeded",
  "budget_exceeded",
  "feature_disabled",
  "tool_disabled",
  "pii_blocked",
  "permission_denied",
] as const;
export type AiBlockedReason = (typeof AI_BLOCKED_REASONS)[number];
export const aiBlockedReasonSchema = z.enum(AI_BLOCKED_REASONS);

export const aiJobSchema = z
  .strictObject({
    id: aiJobIdSchema,
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    feature: aiFeatureCodeSchema,
    channel: aiChannelSchema,
    toolsCalled: z.array(aiToolCodeSchema).max(50),
    model: z.string().trim().min(1).max(100),
    promptVersion: z.string().trim().min(1).max(50),
    tokensIn: z.number().int().nonnegative().safe(),
    tokensOut: z.number().int().nonnegative().safe(),
    /** PRD §6 J says NUMERIC(12,2); normalized to whole rupiah per the §6 money convention. */
    costIdr: idrSchema.refine(
      (value) => value >= 0,
      "costIdr cannot be negative",
    ),
    status: aiJobStatusSchema,
    /** Non-null iff status is blocked. */
    blockedReason: aiBlockedReasonSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((job, ctx) => {
    if ((job.status === "blocked") !== (job.blockedReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "blockedReason is set if and only if status is blocked",
      });
  });
export type AiJob = z.infer<typeof aiJobSchema>;

// ---- Tool call audit (MCP-03) ----------------------------------------------

export const AI_TOOL_CALL_OUTCOMES = [
  "ok",
  "denied",
  "error",
  "rate_limited",
  "disabled",
] as const;
export type AiToolCallOutcome = (typeof AI_TOOL_CALL_OUTCOMES)[number];
export const aiToolCallOutcomeSchema = z.enum(AI_TOOL_CALL_OUTCOMES);

/** Params with PII and free text already redacted; scalars only, never nested. */
export const redactedParamsSchema = z.record(
  z.string().min(1).max(60),
  z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
);

export const aiToolCallRecordSchema = z
  .strictObject({
    id: aiToolCallIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    userId: userIdSchema,
    channel: aiChannelSchema,
    mcpClientId: mcpClientIdSchema.nullable(),
    mcpTokenId: mcpTokenIdSchema.nullable(),
    toolCode: aiToolCodeSchema,
    redactedParams: redactedParamsSchema,
    outcome: aiToolCallOutcomeSchema,
    rowCount: z.number().int().nonnegative().safe(),
    /** Set when a write tool produced an action request. */
    actionRequestId: actionRequestIdSchema.nullable(),
    durationMs: z.number().int().nonnegative().safe(),
    occurredAt: isoDateTimeSchema,
  })
  .superRefine((record, ctx) => {
    if (
      record.channel === "app" &&
      (record.mcpClientId !== null || record.mcpTokenId !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["channel"],
        message: "App channel calls carry no MCP client or token",
      });
    if (
      record.channel === "mcp" &&
      (record.mcpClientId === null || record.mcpTokenId === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["channel"],
        message: "MCP channel calls require an MCP client and token",
      });
  });
export type AiToolCallRecord = z.infer<typeof aiToolCallRecordSchema>;

// ---- Governance (§3 Fitur 40, ai_feature_settings) -------------------------

/** Cap on rows any AI/MCP response may return (§3 Fitur 40 "Batas baris"). */
export const AI_MAX_ROWS_PER_RESPONSE = 200;
export const AI_MCP_RATE_LIMIT_MAX_PER_MINUTE = 600;
/** 14 AI-xx features today; the cap leaves headroom without allowing unbounded lists. */
const AI_FEATURES_MAX = 50;

/** Daily question limit per user (§3 Fitur 40): staff 30, management 100. */
export const AI_DEFAULT_DAILY_LIMIT = {
  employee: 30,
  management: 100,
} as const;

const EMPLOYEE_TYPE_ROLES: ReadonlySet<RoleTemplateKey> = new Set([
  "employee",
  "cashier",
  "waiter",
  "barista_cook",
  "facility_attendant",
]);

/** Employee-type roles get 30 per day; every other role (incl. shareholder) 100. */
export function defaultDailyLimitForRole(roleKey: RoleTemplateKey): number {
  return EMPLOYEE_TYPE_ROLES.has(roleKey)
    ? AI_DEFAULT_DAILY_LIMIT.employee
    : AI_DEFAULT_DAILY_LIMIT.management;
}

export const dailyLimitByRoleSchema = z.partialRecord(
  roleTemplateKeySchema,
  z.number().int().nonnegative().safe(),
);

export const aiFeatureSettingSchema = z.strictObject({
  feature: aiFeatureCodeSchema,
  isEnabled: z.boolean(),
  /** Roles without an entry fall back to `defaultDailyLimitForRole`. */
  dailyLimitByRole: dailyLimitByRoleSchema,
});
export type AiFeatureSetting = z.infer<typeof aiFeatureSettingSchema>;

const warnPctSchema = z.number().int().min(1).max(100);
const stopPctSchema = z.number().int().min(1).max(100);

const aiGovernanceEditableShape = {
  aiEnabled: z.boolean(),
  mcpEnabled: z.boolean(),
  /** MCP-05: dynamic client registration is off unless the tenant turns it on. */
  dynamicClientRegistrationEnabled: z.boolean().default(false),
  monthlyBudgetIdr: idrSchema.refine(
    (value) => value >= 0,
    "monthlyBudgetIdr cannot be negative",
  ),
  budgetWarnPct: warnPctSchema.default(80),
  budgetStopPct: stopPctSchema.default(100),
  features: z.array(aiFeatureSettingSchema).max(AI_FEATURES_MAX),
  /** Per-tool kill switch (§3 Fitur 40). */
  disabledToolCodes: z.array(aiToolCodeSchema).max(50),
  mcpRateLimitPerMinute: z
    .number()
    .int()
    .min(1)
    .max(AI_MCP_RATE_LIMIT_MAX_PER_MINUTE),
  maxRowsPerResponse: z.number().int().min(1).max(AI_MAX_ROWS_PER_RESPONSE),
};

type GovernanceCheck = {
  budgetWarnPct?: number | undefined;
  budgetStopPct?: number | undefined;
  features?: readonly { feature: string }[] | undefined;
  disabledToolCodes?: readonly string[] | undefined;
};

/**
 * Rules shared by the stored settings and the partial update. On a partial
 * update, warn < stop is only checked when BOTH are in the payload: the
 * service must re-validate the merged result against the stored values (e.g.
 * an update that sets only budgetWarnPct must still be below the stored
 * budgetStopPct) before saving.
 */
function checkGovernance(value: GovernanceCheck, ctx: z.RefinementCtx): void {
  const add = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (
    value.budgetWarnPct !== undefined &&
    value.budgetStopPct !== undefined &&
    value.budgetWarnPct >= value.budgetStopPct
  )
    add("budgetWarnPct", "budgetWarnPct must be lower than budgetStopPct");
  if (
    value.features &&
    new Set(value.features.map((f) => f.feature)).size !== value.features.length
  )
    add("features", "features must be unique by feature code");
  if (
    value.disabledToolCodes &&
    new Set(value.disabledToolCodes).size !== value.disabledToolCodes.length
  )
    add("disabledToolCodes", "disabledToolCodes must not repeat a tool code");
}

export const aiGovernanceSettingsSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    ...aiGovernanceEditableShape,
    /** The platform turned AI off for this tenant; stored values stay intact. */
    platformLocked: z.boolean(),
    updatedAt: isoDateTimeSchema,
    updatedBy: userIdSchema,
  })
  .superRefine(checkGovernance);
export type AiGovernanceSettings = z.infer<typeof aiGovernanceSettingsSchema>;

/**
 * Partial update (ai.governance.manage). No tenantId (TEN-02), no audit fields.
 * Defaults are not applied to omitted fields: absent means "leave unchanged".
 */
export const updateAiGovernanceSettingsSchema = z
  .strictObject({
    aiEnabled: aiGovernanceEditableShape.aiEnabled.optional(),
    mcpEnabled: aiGovernanceEditableShape.mcpEnabled.optional(),
    dynamicClientRegistrationEnabled: z.boolean().optional(),
    monthlyBudgetIdr: aiGovernanceEditableShape.monthlyBudgetIdr.optional(),
    budgetWarnPct: warnPctSchema.optional(),
    budgetStopPct: stopPctSchema.optional(),
    features: aiGovernanceEditableShape.features.optional(),
    disabledToolCodes: aiGovernanceEditableShape.disabledToolCodes.optional(),
    mcpRateLimitPerMinute:
      aiGovernanceEditableShape.mcpRateLimitPerMinute.optional(),
    maxRowsPerResponse: aiGovernanceEditableShape.maxRowsPerResponse.optional(),
  })
  .superRefine(checkGovernance)
  .refine((update) => Object.keys(update).length > 0, {
    message: "Provide at least one setting to update",
  });
export type UpdateAiGovernanceSettings = z.infer<
  typeof updateAiGovernanceSettingsSchema
>;

export type BudgetState = "ok" | "warn" | "stopped";

/**
 * Budget gate (§3 Fitur 40): warn at `warnPct` of the budget, stop at `stopPct`.
 * Bigint math so used*100 never loses precision. A zero budget is always stopped.
 */
export function budgetState(
  usedIdr: number,
  budgetIdr: number,
  warnPct: number,
  stopPct: number,
): BudgetState {
  const used = BigInt(usedIdr) * 100n;
  const budget = BigInt(budgetIdr);
  if (used >= budget * BigInt(stopPct)) return "stopped";
  if (used >= budget * BigInt(warnPct)) return "warn";
  return "ok";
}

// ---- MCP clients and tokens (§3 Fitur 39, §6 J mcp_clients / mcp_tokens) ---

/** MCP-02: a revoked token or client stops working within 60 seconds. */
export const MCP_REVOCATION_MAX_SECONDS = 60;
/** Token lifetime ceiling; tokens are short-lived by design (MCP-02). */
export const MCP_TOKEN_MAX_TTL_HOURS = 24;
/**
 * Token format is `mcp_` + random. `tokenPrefix` is the first 12 chars of the
 * raw token (`mcp_` + 8 random chars), kept only for display and lookup.
 */
export const MCP_TOKEN_PREFIX_LENGTH = 12;
export const MCP_REDIRECT_URIS_MAX = 10;
const MCP_SCOPES_MAX = 30;

export const MCP_CLIENT_REGISTERED_VIA = ["admin", "dynamic"] as const;
export type McpClientRegisteredVia = (typeof MCP_CLIENT_REGISTERED_VIA)[number];
export const mcpClientRegisteredViaSchema = z.enum(MCP_CLIENT_REGISTERED_VIA);

/** Scopes: a non-empty unique list of real `McpScope` values (MCP-01). */
export const mcpScopesSchema = z
  .array(mcpScopeSchema)
  .min(1)
  .max(MCP_SCOPES_MAX)
  .refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "Scopes must be unique",
  );

/** True when every scope in `scopes` is also in `allowed` (pure, order-free). */
export function isScopeSubset(
  scopes: readonly string[],
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return scopes.every((scope) => set.has(scope));
}

/** https only; http is allowed for loopback hosts (native and local MCP clients). */
const LOOPBACK_HTTP =
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/|$)/;
export const mcpRedirectUriSchema = z
  .url()
  .max(2000)
  .refine(
    (uri) => uri.startsWith("https://") || LOOPBACK_HTTP.test(uri),
    "Redirect URI must use https (http only for localhost)",
  )
  .refine(
    (uri) => !uri.includes("#"),
    "Redirect URI cannot contain a fragment",
  );

const mcpClientNameSchema = z.string().trim().min(1).max(100);
const mcpOAuthClientIdSchema = z.string().trim().min(1).max(100);
const mcpRedirectUrisSchema = z
  .array(mcpRedirectUriSchema)
  .min(1)
  .max(MCP_REDIRECT_URIS_MAX);
const mcpReasonSchema = z.string().trim().min(3).max(500);

export const mcpClientSchema = z
  .strictObject({
    id: mcpClientIdSchema,
    tenantId: tenantIdSchema,
    name: mcpClientNameSchema,
    /** OAuth client id presented by the MCP client. */
    clientId: mcpOAuthClientIdSchema,
    redirectUris: mcpRedirectUrisSchema,
    allowedScopes: mcpScopesSchema,
    status: mcpClientStatusSchema,
    registeredVia: mcpClientRegisteredViaSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    revokedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((client, ctx) => {
    const add = (path: string, message: string, invalid: boolean) => {
      if (invalid) ctx.addIssue({ code: "custom", path: [path], message });
    };
    // approvedBy and approvedAt travel together. A revoked client keeps its
    // approval trail, so they are only forced null while it is still pending.
    add(
      "approvedAt",
      "approvedBy and approvedAt must both be set or both be null",
      (client.approvedBy === null) !== (client.approvedAt === null),
    );
    add(
      "approvedBy",
      "An approved client needs approvedBy and approvedAt",
      client.status === "approved" && client.approvedBy === null,
    );
    add(
      "approvedBy",
      "A pending client cannot have approvedBy or approvedAt",
      client.status === "pending" && client.approvedBy !== null,
    );
    add(
      "revokedAt",
      "revokedAt is set if and only if status is revoked",
      (client.status === "revoked") !== (client.revokedAt !== null),
    );
  });
export type McpClient = z.infer<typeof mcpClientSchema>;

/** Admin registration or dynamic registration request (MCP-05). No tenantId. */
export const registerMcpClientSchema = z.strictObject({
  name: mcpClientNameSchema,
  clientId: mcpOAuthClientIdSchema,
  redirectUris: mcpRedirectUrisSchema,
  allowedScopes: mcpScopesSchema,
});
export type RegisterMcpClient = z.infer<typeof registerMcpClientSchema>;

/**
 * Approval may narrow scopes; omit to keep what the client asked for. Rules the
 * service enforces with `isScopeSubset` (they need stored rows): approved
 * scopes must be a subset of the requested ones, and a token's scopes must be
 * a subset of its client's `allowedScopes`.
 */
export const approveMcpClientSchema = z.strictObject({
  allowedScopes: mcpScopesSchema.optional(),
});
export type ApproveMcpClient = z.infer<typeof approveMcpClientSchema>;

export const revokeMcpClientSchema = z.strictObject({
  reason: mcpReasonSchema,
});
export type RevokeMcpClient = z.infer<typeof revokeMcpClientSchema>;

/** Stored token: SHA-256 hex hash plus a short display prefix. Never the raw token. */
export const mcpTokenSchema = z
  .strictObject({
    id: mcpTokenIdSchema,
    tenantId: tenantIdSchema,
    clientId: mcpClientIdSchema,
    userId: userIdSchema,
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "tokenHash is a lowercase sha-256 hex"),
    /** First 12 chars of the raw token: `mcp_` + 8 alphanumerics. */
    tokenPrefix: z
      .string()
      .length(MCP_TOKEN_PREFIX_LENGTH)
      .regex(/^mcp_[A-Za-z0-9]{8}$/, "tokenPrefix must look like mcp_XXXXXXXX"),
    scopes: mcpScopesSchema,
    expiresAt: isoDateTimeSchema,
    revokedAt: isoDateTimeSchema.nullable(),
    lastUsedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((token, ctx) => {
    const ttlMs = Date.parse(token.expiresAt) - Date.parse(token.createdAt);
    if (ttlMs <= 0 || ttlMs > MCP_TOKEN_MAX_TTL_HOURS * 3_600_000)
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: `Token lifetime must be positive and at most ${MCP_TOKEN_MAX_TTL_HOURS} hours`,
      });
  });
export type McpToken = z.infer<typeof mcpTokenSchema>;

export const revokeMcpTokenSchema = z.strictObject({
  reason: mcpReasonSchema.optional(),
});
export type RevokeMcpToken = z.infer<typeof revokeMcpTokenSchema>;
