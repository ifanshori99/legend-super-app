// Tanya AI & MCP domain events (bead legend-1zxo, WS-12). Registered in the
// WS-00 event catalog (packages/shared/src/events/catalog.ts, WS-12 line; the
// action_request.created/approved/executed names stay on the WS-01 line) and
// emitted through the transactional outbox contract. Payloads carry ids and
// counters only: never question text, tool parameters, token values or PII
// (PRD §3 Fitur 40 Input Minimum, MCP-03). Tokens appear only as `tokenPrefix`.
//
// The catalogued placeholder `tool_request.approved` has no payload here: it
// predates the action_request aggregate and has no emitter (action_request.approved
// covers it).

import {
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import { approvalRequestIdSchema } from "../identity/ids.ts";
import {
  aiBlockedReasonSchema,
  aiToolCallOutcomeSchema,
  MCP_TOKEN_PREFIX_LENGTH,
  mcpScopesSchema,
} from "./schemas.ts";
import {
  actionRequestIdSchema,
  actionRequestSourceSchema,
  aiChannelSchema,
  aiConversationIdSchema,
  aiFeatureCodeSchema,
  aiJobIdSchema,
  aiJobStatusSchema,
  aiToolCallIdSchema,
  aiToolCodeSchema,
  mcpClientIdSchema,
  mcpTokenIdSchema,
} from "./ids.ts";

export const aiEventNames = [
  "ai_job.completed",
  "action_request.created",
  "action_request.approved",
  "action_request.executed",
  "action_request.rejected",
  "action_request.failed",
  "action_request.expired",
  "ai_conversation.deleted",
  "mcp_client.registered",
  "mcp_client.approved",
  "mcp_client.revoked",
  "mcp_token.issued",
  "mcp_token.revoked",
  "ai_settings.updated",
  "ai_budget.threshold_reached",
  "ai_tool.invoked",
] as const;
export type AiEventName = (typeof aiEventNames)[number];

/** AIG-01: every job, including blocked ones, so usage and cost reports can
 * be rebuilt from events. Cost is whole rupiah (§6 convention). */
export const aiJobCompletedEventPayloadSchema = z
  .strictObject({
    aiJobId: aiJobIdSchema,
    userId: userIdSchema,
    feature: aiFeatureCodeSchema,
    channel: aiChannelSchema,
    status: aiJobStatusSchema,
    blockedReason: aiBlockedReasonSchema.nullable(),
    toolsCalled: z
      .array(aiToolCodeSchema)
      .max(50) /* same cap as aiJobSchema.toolsCalled */,
    tokensIn: z.number().int().nonnegative().safe(),
    tokensOut: z.number().int().nonnegative().safe(),
    costIdr: idrSchema.refine((v) => v >= 0, "costIdr must not be negative"),
    completedAt: isoDateTimeSchema,
  })
  .superRefine((payload, ctx) => {
    // Same rule as aiJobSchema: a reason exactly when the job was blocked.
    if ((payload.status === "blocked") !== (payload.blockedReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "blockedReason is set if and only if status is blocked",
      });
  });
export type AiJobCompletedEventPayload = z.infer<
  typeof aiJobCompletedEventPayloadSchema
>;

/** Common action_request fields: enough to route the event without a read.
 * The write payload itself never travels in the event (AIG-03). */
const actionRequestEventBase = {
  actionRequestId: actionRequestIdSchema,
  approvalRequestId: approvalRequestIdSchema,
  toolCode: aiToolCodeSchema,
  source: actionRequestSourceSchema,
  outletId: outletIdSchema.nullable(),
};

export const actionRequestCreatedEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  requestedByUserId: userIdSchema,
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type ActionRequestCreatedEventPayload = z.infer<
  typeof actionRequestCreatedEventPayloadSchema
>;

export const actionRequestApprovedEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  approvedByUserId: userIdSchema,
  approvedAt: isoDateTimeSchema,
});
export type ActionRequestApprovedEventPayload = z.infer<
  typeof actionRequestApprovedEventPayloadSchema
>;

export const actionRequestRejectedEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  rejectedByUserId: userIdSchema,
  rejectedAt: isoDateTimeSchema,
});
export type ActionRequestRejectedEventPayload = z.infer<
  typeof actionRequestRejectedEventPayloadSchema
>;

/** `resultRef` points at the record the approved action produced. */
export const actionRequestExecutedEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  resultRef: z.string().trim().min(1).max(255),
  executedAt: isoDateTimeSchema,
});
export type ActionRequestExecutedEventPayload = z.infer<
  typeof actionRequestExecutedEventPayloadSchema
>;

export const actionRequestFailedEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  failureReason: z.string().trim().min(1).max(500),
  failedAt: isoDateTimeSchema,
});
export type ActionRequestFailedEventPayload = z.infer<
  typeof actionRequestFailedEventPayloadSchema
>;

/** The approval window passed without a decision (expiresAt reached). */
export const actionRequestExpiredEventPayloadSchema = z.strictObject({
  ...actionRequestEventBase,
  expiredAt: isoDateTimeSchema,
});
export type ActionRequestExpiredEventPayload = z.infer<
  typeof actionRequestExpiredEventPayloadSchema
>;

/** §6 J ai_conversations.deleted_at: owner deleted their chat. */
export const aiConversationDeletedEventPayloadSchema = z.strictObject({
  conversationId: aiConversationIdSchema,
  userId: userIdSchema,
  deletedAt: isoDateTimeSchema,
});
export type AiConversationDeletedEventPayload = z.infer<
  typeof aiConversationDeletedEventPayloadSchema
>;

/** MCP-05: a registered client stays pending until an admin approves it. */
export const mcpClientRegisteredEventPayloadSchema = z.strictObject({
  mcpClientId: mcpClientIdSchema,
  registeredVia: z.enum(["admin", "dynamic"]),
  registeredAt: isoDateTimeSchema,
});
export type McpClientRegisteredEventPayload = z.infer<
  typeof mcpClientRegisteredEventPayloadSchema
>;

export const mcpClientApprovedEventPayloadSchema = z.strictObject({
  mcpClientId: mcpClientIdSchema,
  approvedBy: userIdSchema,
  approvedAt: isoDateTimeSchema,
});
export type McpClientApprovedEventPayload = z.infer<
  typeof mcpClientApprovedEventPayloadSchema
>;

/** The revocation reason is audit data, not event data. */
export const mcpClientRevokedEventPayloadSchema = z.strictObject({
  mcpClientId: mcpClientIdSchema,
  revokedBy: userIdSchema,
  revokedAt: isoDateTimeSchema,
});
export type McpClientRevokedEventPayload = z.infer<
  typeof mcpClientRevokedEventPayloadSchema
>;

/** Never the token: only the stored `mcp_XXXXXXXX` prefix, same as
 * mcp_tokens.token_prefix (MCP-02). */
export const mcpTokenIssuedEventPayloadSchema = z.strictObject({
  mcpTokenId: mcpTokenIdSchema,
  mcpClientId: mcpClientIdSchema,
  userId: userIdSchema,
  tokenPrefix: z
    .string()
    .length(MCP_TOKEN_PREFIX_LENGTH)
    .regex(/^mcp_[A-Za-z0-9]{8}$/),
  scopes: mcpScopesSchema,
  expiresAt: isoDateTimeSchema,
  issuedAt: isoDateTimeSchema,
});
export type McpTokenIssuedEventPayload = z.infer<
  typeof mcpTokenIssuedEventPayloadSchema
>;

/** MCP-02: consumers must stop honouring the token within 60 seconds. */
export const mcpTokenRevokedEventPayloadSchema = z.strictObject({
  mcpTokenId: mcpTokenIdSchema,
  mcpClientId: mcpClientIdSchema,
  userId: userIdSchema,
  revokedBy: userIdSchema,
  revokedAt: isoDateTimeSchema,
});
export type McpTokenRevokedEventPayload = z.infer<
  typeof mcpTokenRevokedEventPayloadSchema
>;

/** AIG settings change: names the changed fields, never their values. */
export const aiSettingsUpdatedEventPayloadSchema = z.strictObject({
  changedFields: z.array(z.string().min(1).max(64)).min(1).max(50),
  updatedBy: userIdSchema,
  updatedAt: isoDateTimeSchema,
});
export type AiSettingsUpdatedEventPayload = z.infer<
  typeof aiSettingsUpdatedEventPayloadSchema
>;

/** AIG-02: monthly budget crossed the warn or stop threshold (once per month
 * per threshold). `usedIdr` and `budgetIdr` are whole rupiah. */
export const aiBudgetThresholdReachedEventPayloadSchema = z.strictObject({
  threshold: z.enum(["warn", "stop"]),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  usedIdr: idrSchema,
  budgetIdr: idrSchema,
  reachedAt: isoDateTimeSchema,
});
export type AiBudgetThresholdReachedEventPayload = z.infer<
  typeof aiBudgetThresholdReachedEventPayloadSchema
>;

/** MCP-03: one audit row per tool call. Redacted parameters stay in the audit
 * table; the event carries the outcome only. */
export const aiToolInvokedEventPayloadSchema = z.strictObject({
  toolCallId: aiToolCallIdSchema,
  toolCode: aiToolCodeSchema,
  channel: aiChannelSchema,
  userId: userIdSchema,
  outcome: aiToolCallOutcomeSchema,
  rowCount: z.number().int().nonnegative().safe(),
  durationMs: z.number().int().nonnegative().safe(),
  occurredAt: isoDateTimeSchema,
});
export type AiToolInvokedEventPayload = z.infer<
  typeof aiToolInvokedEventPayloadSchema
>;

/** Payload schema per event name, for the outbox writer and consumers. */
export const AI_EVENT_PAYLOAD_SCHEMAS = {
  "ai_job.completed": aiJobCompletedEventPayloadSchema,
  "action_request.created": actionRequestCreatedEventPayloadSchema,
  "action_request.approved": actionRequestApprovedEventPayloadSchema,
  "action_request.executed": actionRequestExecutedEventPayloadSchema,
  "action_request.rejected": actionRequestRejectedEventPayloadSchema,
  "action_request.failed": actionRequestFailedEventPayloadSchema,
  "action_request.expired": actionRequestExpiredEventPayloadSchema,
  "ai_conversation.deleted": aiConversationDeletedEventPayloadSchema,
  "mcp_client.registered": mcpClientRegisteredEventPayloadSchema,
  "mcp_client.approved": mcpClientApprovedEventPayloadSchema,
  "mcp_client.revoked": mcpClientRevokedEventPayloadSchema,
  "mcp_token.issued": mcpTokenIssuedEventPayloadSchema,
  "mcp_token.revoked": mcpTokenRevokedEventPayloadSchema,
  "ai_settings.updated": aiSettingsUpdatedEventPayloadSchema,
  "ai_budget.threshold_reached": aiBudgetThresholdReachedEventPayloadSchema,
  "ai_tool.invoked": aiToolInvokedEventPayloadSchema,
} as const satisfies Record<AiEventName, z.ZodType<Record<string, unknown>>>;

/**
 * Catalog-bound definitions (contracts.md "One catalog, typed payloads"):
 * defineDomainEvent throws at module load for an uncatalogued name, and each
 * `envelopeSchema` validates name, version, schema ref and payload together.
 */
export const aiEvents = Object.fromEntries(
  aiEventNames.map((name) => [
    name,
    defineDomainEvent({
      name,
      payload: AI_EVENT_PAYLOAD_SCHEMAS[name] as z.ZodType<
        Record<string, unknown>
      >,
    }),
  ]),
) as Record<AiEventName, ReturnType<typeof defineDomainEvent>>;

export const aiEventCatalogEntries: readonly EventCatalogEntry[] =
  aiEventNames.map((name) => aiEvents[name].entry);

/** Envelope whose name and payload belong to this domain. */
export const aiEventSchema = eventEnvelopeSchema
  .refine((event) => (aiEventNames as readonly string[]).includes(event.name), {
    path: ["name"],
    message: "Not a Tanya AI or MCP event",
  })
  .refine(
    (event) =>
      aiEvents[event.name as AiEventName]?.envelopeSchema.safeParse(event)
        .success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );
export type AiEvent = EventEnvelope;
