// Per-tenant AI provider contract (WS-12, bead legend-dwrr; docs/DECISIONS.md
// "WS-12 provider AI per tenant"). A tenant admin sets an OpenAI-compatible
// provider with an API key. No read schema carries the key: the key goes in
// through the PUT body only, and reads show `hasKey` and `keyLast4`.
//
// Permission (enforced by the API): ai.governance.manage. Tenant comes from
// the session, never the body (TEN-02).

import { dataResponseSchema, isoDateTimeSchema, z } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";

/** Legacy discriminator. PUT /provider is API-key only; ChatGPT uses /chatgpt. */
export const AI_CONNECTION_TYPES = ["api_key", "chatgpt_oauth"] as const;
export const aiConnectionTypeSchema = z.enum(AI_CONNECTION_TYPES);
export type AiConnectionType = z.infer<typeof aiConnectionTypeSchema>;

export const AI_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export const aiReasoningEffortSchema = z.enum(AI_REASONING_EFFORTS);
export type AiReasoningEffort = z.infer<typeof aiReasoningEffortSchema>;

export const aiModelCapabilityOverridesSchema = z
  .strictObject({
    contextWindow: z.number().int().min(1024).max(2_000_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
    supportsTools: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    reasoningEfforts: z.array(aiReasoningEffortSchema).max(3).optional(),
  })
  .refine(
    (value) =>
      value.contextWindow === undefined ||
      value.maxOutputTokens === undefined ||
      value.maxOutputTokens < value.contextWindow,
    {
      message: "Output limit must leave room for input.",
    },
  );
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

/** Fixed catalog of connection-test failures. Never provider error text. */
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

/** Safe Indonesian text for the UI, keyed by error code. */
export const aiProviderTestErrorMessages: Record<
  AiProviderTestErrorCode,
  string
> = {
  URL_BLOCKED: "Alamat provider tidak diizinkan.",
  REDIRECT_REFUSED: "Provider mengalihkan ke alamat lain. Pengalihan ditolak.",
  TIMEOUT: "Provider tidak menjawab tepat waktu.",
  AUTH_FAILED: "Kunci API ditolak oleh provider.",
  NOT_FOUND: "Alamat atau model tidak ditemukan di provider.",
  REQUEST_REJECTED: "Provider menolak permintaan uji.",
  RATE_LIMITED: "Provider membatasi permintaan. Coba lagi sebentar lagi.",
  PROVIDER_ERROR: "Provider sedang bermasalah.",
  NETWORK_ERROR: "Tidak bisa terhubung ke provider.",
  BAD_RESPONSE: "Jawaban provider tidak sesuai format yang diharapkan.",
  KEY_UNREADABLE: "Kunci tersimpan tidak bisa dibuka. Masukkan kunci lagi.",
};

export const aiProviderLastTestSchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  testedAt: isoDateTimeSchema,
  errorCode: aiProviderTestErrorCodeSchema.nullable(),
});
export type AiProviderLastTest = z.infer<typeof aiProviderLastTestSchema>;

/** Read shape. There is no key field here, by design. */
export const aiProviderConfigSchema = z.strictObject({
  connectionType: aiConnectionTypeSchema,
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

/**
 * `fallbackAvailable`: the platform env provider exists for this tenant.
 * `platformLocked`: the platform turned AI off for this tenant; every write
 * and use path is refused with AI_PLATFORM_DISABLED.
 */
export const aiProviderViewSchema = z.strictObject({
  config: aiProviderConfigSchema.nullable(),
  fallbackAvailable: z.boolean(),
  platformLocked: z.boolean(),
});
export type AiProviderView = z.infer<typeof aiProviderViewSchema>;

export const upsertAiProviderConfigInputSchema = z.strictObject({
  connectionType: aiConnectionTypeSchema,
  baseUrl: z.string().trim().min(1).max(500),
  defaultModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.:/@+-]+$/),
  /** Omit to keep the stored key (only while `baseUrl` is unchanged). */
  apiKey: z.string().trim().min(16).max(500).regex(/^\S+$/).optional(),
  /** Same provider/model: merge given fields; null clears; a new model resets. */
  capabilityOverrides: aiModelCapabilityOverridesSchema.nullable().optional(),
});
export type UpsertAiProviderConfigInput = z.infer<
  typeof upsertAiProviderConfigInputSchema
>;

/** Change overrides only. Unsent nested fields are retained; null clears all. */
export const patchAiProviderConfigInputSchema = z.strictObject({
  capabilityOverrides: aiModelCapabilityOverridesSchema.nullable(),
});
export type PatchAiProviderConfigInput = z.infer<
  typeof patchAiProviderConfigInputSchema
>;

export const aiProviderTestResultSchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  testedAt: isoDateTimeSchema,
  errorCode: aiProviderTestErrorCodeSchema.nullable(),
});
export type AiProviderTestResult = z.infer<typeof aiProviderTestResultSchema>;

// Named to avoid the API provider-factory's `getAiProvider`.
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

export const patchAiProviderConfig = defineEndpoint({
  method: "PATCH",
  path: "/api/ai/provider",
  body: patchAiProviderConfigInputSchema,
  response: dataResponseSchema(aiProviderViewSchema),
});

/** Hard delete; answers the view with `config: null`. */
export const deleteAiProviderConfig = defineEndpoint({
  method: "DELETE",
  path: "/api/ai/provider",
  response: dataResponseSchema(aiProviderViewSchema),
});

export const testAiProviderConfig = defineEndpoint({
  method: "POST",
  path: "/api/ai/provider/test",
  body: z.strictObject({}),
  response: dataResponseSchema(aiProviderTestResultSchema),
});
