// Tenant owner opt-in for the isolated Codex device flow. Secrets are write-only
// server state; only start returns the short user-facing verification code.
import { defineEndpoint } from "../api/index.ts";
import {
  dataResponseSchema,
  isoDateTimeSchema,
  uuidSchema,
  z,
} from "../core/index.ts";

export const chatgptModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@+-]+$/);
export const chatgptConnectionStatusSchema = z.enum([
  "disconnected",
  "pending",
  "connected",
  "unavailable",
]);
export type ChatgptConnectionStatus = z.infer<
  typeof chatgptConnectionStatusSchema
>;
export const chatgptConnectionViewSchema = z.strictObject({
  enabled: z.boolean(),
  status: chatgptConnectionStatusSchema,
  model: chatgptModelSchema.nullable(),
  consent: z
    .strictObject({
      acceptedBy: z.string().min(1),
      acceptedAt: isoDateTimeSchema,
    })
    .nullable(),
  connectedAt: isoDateTimeSchema.nullable(),
});
export type ChatgptConnectionView = z.infer<typeof chatgptConnectionViewSchema>;
export const startChatgptConnectionInputSchema = z.strictObject({
  model: chatgptModelSchema,
  riskAccepted: z.literal(true),
});
export type StartChatgptConnectionInput = z.infer<
  typeof startChatgptConnectionInputSchema
>;
export const chatgptDeviceAttemptSchema = z.strictObject({
  attemptId: uuidSchema,
  userCode: z.string().min(1).max(100),
  verificationUri: z.literal("https://auth.openai.com/codex/device"),
  expiresAt: isoDateTimeSchema,
  intervalSeconds: z.number().int().min(5).max(60),
});
export type ChatgptDeviceAttempt = z.infer<typeof chatgptDeviceAttemptSchema>;
export const pollChatgptConnectionInputSchema = z.strictObject({
  attemptId: uuidSchema,
});
export const getChatgptConnection = defineEndpoint({
  method: "GET",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptConnectionViewSchema),
});
export const startChatgptDeviceConnection = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device",
  body: startChatgptConnectionInputSchema,
  response: dataResponseSchema(chatgptDeviceAttemptSchema),
});
export const pollChatgptDeviceConnection = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device/poll",
  body: pollChatgptConnectionInputSchema,
  response: dataResponseSchema(chatgptConnectionViewSchema),
});
export const revokeChatgptConnection = defineEndpoint({
  method: "DELETE",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptConnectionViewSchema),
});
