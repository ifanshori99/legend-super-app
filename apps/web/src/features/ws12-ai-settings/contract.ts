// INTERIM contract for the tenant "Pengaturan AI" screen (bead legend-nnufz).
//
// The provider view with detected capabilities and overrides is the target
// contract of branch ws/ai-login-autodetect (packages/shared/src/ai/provider.ts,
// cards legend-39d.8 / legend-z83k), which is not on milestone/m1 yet. The
// ChatGPT device-code status/start/poll/revoke endpoints are not written
// anywhere yet; their paths and shapes below are the UI's assumption.
//
// When that branch merges: delete this file, import the same names from
// `@starter/shared/ai`, and point the ChatGPT endpoints at the real paths. Only
// `api.ts`, `queries.ts`, `hooks.ts` and `mock.ts` import from here.
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema, isoDateTimeSchema, z } from "@starter/shared/core";

export const aiReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export const aiModelCapabilityOverridesSchema = z.strictObject({
  contextWindow: z.number().int().min(1024).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  reasoningEfforts: z.array(aiReasoningEffortSchema).max(3).optional(),
});
export type AiModelCapabilityOverrides = z.infer<
  typeof aiModelCapabilityOverridesSchema
>;

export const aiModelCapabilitiesSchema = z.strictObject({
  contextWindow: z.number().int().min(1024).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean(),
  reasoningEfforts: z.array(aiReasoningEffortSchema).max(3),
  source: z.enum(["metadata", "known", "default"]),
});
export type AiModelCapabilities = z.infer<typeof aiModelCapabilitiesSchema>;

export const AI_PROVIDER_TEST_ERROR_CODES = [
  "URL_BLOCKED",
  "REDIRECT_REFUSED",
  "TIMEOUT",
  "AUTH_FAILED",
  "NOT_FOUND",
  "REQUEST_REJECTED",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "NETWORK_ERROR",
  "BAD_RESPONSE",
  "KEY_UNREADABLE",
] as const;
export const aiProviderTestErrorCodeSchema = z.enum(
  AI_PROVIDER_TEST_ERROR_CODES,
);
export type AiProviderTestErrorCode = z.infer<
  typeof aiProviderTestErrorCodeSchema
>;

export const aiProviderLastTestSchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  testedAt: isoDateTimeSchema,
  errorCode: aiProviderTestErrorCodeSchema.nullable(),
});

/** Read shape. There is no key field here, by design: `keyLast4` only. */
export const aiProviderConfigSchema = z.strictObject({
  connectionType: z.enum(["api_key", "chatgpt_oauth"]),
  baseUrl: z.string().min(1).max(500),
  defaultModel: z.string().min(1).max(200),
  capabilities: aiModelCapabilitiesSchema,
  capabilityOverrides: aiModelCapabilityOverridesSchema.nullable(),
  hasKey: z.boolean(),
  keyLast4: z.string().length(4).nullable(),
  keySetAt: isoDateTimeSchema.nullable(),
  lastTest: aiProviderLastTestSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

export const aiProviderViewSchema = z.strictObject({
  config: aiProviderConfigSchema.nullable(),
  fallbackAvailable: z.boolean(),
});
export type AiProviderView = z.infer<typeof aiProviderViewSchema>;

export const upsertAiProviderConfigInputSchema = z.strictObject({
  connectionType: z.enum(["api_key", "chatgpt_oauth"]),
  baseUrl: z.string().trim().min(1).max(500),
  defaultModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.:/@+-]+$/),
  /** Omit to keep the stored key (only while `baseUrl` is unchanged). */
  apiKey: z.string().trim().min(16).max(500).regex(/^\S+$/).optional(),
  capabilityOverrides: aiModelCapabilityOverridesSchema.nullable().optional(),
});
export type UpsertAiProviderConfigInput = z.infer<
  typeof upsertAiProviderConfigInputSchema
>;

export const aiProviderTestResultSchema = aiProviderLastTestSchema;
export type AiProviderTestResult = z.infer<typeof aiProviderTestResultSchema>;

export const getAiProviderConfig = defineEndpoint({
  method: "GET",
  path: "/api/ai/provider",
  response: dataResponseSchema(aiProviderViewSchema),
});

export const upsertAiProviderConfig = defineEndpoint({
  method: "PUT",
  path: "/api/ai/provider",
  body: upsertAiProviderConfigInputSchema,
  response: dataResponseSchema(aiProviderViewSchema),
});

export const testAiProviderConfig = defineEndpoint({
  method: "POST",
  path: "/api/ai/provider/test",
  body: z.strictObject({}),
  response: dataResponseSchema(aiProviderTestResultSchema),
});

// ---- ChatGPT login by device code (assumed shape, legend-z83k) -----------

export const CHATGPT_LOGIN_STATES = [
  "disconnected",
  "pending",
  "connected",
  "failed",
  "expired",
] as const;
export const chatgptLoginStateSchema = z.enum(CHATGPT_LOGIN_STATES);
export type ChatgptLoginState = z.infer<typeof chatgptLoginStateSchema>;

/**
 * Never carries a token. `viewerCanManage` is decided by the API (owner only):
 * the UI only presents it. `deviceCode` and `verificationUrl` are set while
 * `state` is `pending` and the viewer may manage the connection.
 */
export const chatgptLoginStatusSchema = z.strictObject({
  state: chatgptLoginStateSchema,
  /**
   * Platform kill switch (legend-z83k): AI is off for every tenant. The UI
   * locks all controls and says so. Where this flag lives in the API is open;
   * this status is the assumed carrier.
   */
  platformDisabled: z.boolean(),
  viewerCanManage: z.boolean(),
  deviceCode: z.string().min(1).max(40).nullable(),
  verificationUrl: z.string().max(200).nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  connectedAt: isoDateTimeSchema.nullable(),
  riskAcceptedAt: isoDateTimeSchema.nullable(),
});
export type ChatgptLoginStatus = z.infer<typeof chatgptLoginStatusSchema>;

export const getChatgptLogin = defineEndpoint({
  method: "GET",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptLoginStatusSchema),
});

/** Starts a device code. `riskAccepted` must be `true`: the API records who and when. */
export const startChatgptLogin = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device",
  body: z.strictObject({ riskAccepted: z.literal(true) }),
  response: dataResponseSchema(chatgptLoginStatusSchema),
});

/** Asks the API to check the code once (the API rate-limits polling). */
export const pollChatgptLogin = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device/poll",
  body: z.strictObject({}),
  response: dataResponseSchema(chatgptLoginStatusSchema),
});

/** Cancels a pending code or revokes the connection (same call). */
export const revokeChatgptLogin = defineEndpoint({
  method: "DELETE",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptLoginStatusSchema),
});
