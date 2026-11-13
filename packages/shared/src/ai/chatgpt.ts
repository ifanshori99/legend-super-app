// Canonical contract for the tenant Pengaturan AI screen (legend-nnufz).
// OAuth credentials, PKCE and server device_auth_id never enter these DTOs.
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
/** Stored state stays independent from the presentation state and kill switch. */
export const chatgptConnectionStatusSchema = z.enum([
  "disconnected",
  "pending",
  "connected",
  "unavailable",
]);
export type ChatgptConnectionStatus = z.infer<
  typeof chatgptConnectionStatusSchema
>;
export const CHATGPT_LOGIN_STATES = [
  "disconnected",
  "pending",
  "connected",
  "failed",
  "expired",
] as const;
export const chatgptLoginStateSchema = z.enum(CHATGPT_LOGIN_STATES);
export type ChatgptLoginState = z.infer<typeof chatgptLoginStateSchema>;
export const chatgptLoginStatusSchema = z.strictObject({
  state: chatgptLoginStateSchema,
  /** ChatGPT-only global switch; the tenant's custom fallback remains available. */
  platformDisabled: z.boolean(),
  /** Actual owner permission, independent of the global availability switch. */
  viewerCanManage: z.boolean(),
  /** Short verification code, visible only to an actual owner while pending. */
  deviceCode: z.string().min(1).max(40).nullable(),
  verificationUrl: z.string().max(200).nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  connectedAt: isoDateTimeSchema.nullable(),
  riskAcceptedAt: isoDateTimeSchema.nullable(),
});
export type ChatgptLoginStatus = z.infer<typeof chatgptLoginStatusSchema>;
export const startChatgptConnectionInputSchema = z.strictObject({
  riskAccepted: z.literal(true),
  /** Optional extension; omit to preserve the selected model or use the server default. */
  model: chatgptModelSchema.optional(),
});
export type StartChatgptConnectionInput = z.infer<
  typeof startChatgptConnectionInputSchema
>;
export const pollChatgptConnectionInputSchema = z.strictObject({
  /** Optional extension for clients that pin a particular login attempt. */
  attemptId: uuidSchema.optional(),
});
export const getChatgptLogin = defineEndpoint({
  method: "GET",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptLoginStatusSchema),
});
export const startChatgptLogin = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device",
  body: startChatgptConnectionInputSchema,
  response: dataResponseSchema(chatgptLoginStatusSchema),
});
export const pollChatgptLogin = defineEndpoint({
  method: "POST",
  path: "/api/ai/chatgpt/device/poll",
  body: pollChatgptConnectionInputSchema,
  response: dataResponseSchema(chatgptLoginStatusSchema),
});
export const revokeChatgptLogin = defineEndpoint({
  method: "DELETE",
  path: "/api/ai/chatgpt",
  response: dataResponseSchema(chatgptLoginStatusSchema),
});

// Legacy import names use the same canonical response, never a second wire shape.
export const chatgptConnectionViewSchema = chatgptLoginStatusSchema;
export type ChatgptConnectionView = ChatgptLoginStatus;
export const chatgptDeviceAttemptSchema = chatgptLoginStatusSchema;
export type ChatgptDeviceAttempt = ChatgptLoginStatus;
export const getChatgptConnection = getChatgptLogin;
export const startChatgptDeviceConnection = startChatgptLogin;
export const pollChatgptDeviceConnection = pollChatgptLogin;
export const revokeChatgptConnection = revokeChatgptLogin;
