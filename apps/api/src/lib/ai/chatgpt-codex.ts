// Isolated Codex device flow and Responses transport. Wire evidence is pinned
// in docs/briefs/ai-login-device-code-research-notes.md. No vendor error bodies,
// tokens or raw transport exceptions escape this adapter.
import { env } from "../../config/env.ts";
import type { AiModelCapabilities } from "@starter/shared/ai";
import { getModelCapabilities } from "./model-capabilities.ts";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiContentBlock,
  AiProvider,
} from "./types.ts";

/** Plan transport capabilities are separate from Chat Completions metadata. */
export function getChatgptCodexModelCapabilities(
  model: string,
): AiModelCapabilities {
  // These models require the Responses protocol for tool calling. Do not
  // promote them in the generic Chat Completions capability table. Operational
  // bounds are deliberately smaller than their advertised context/output;
  // verified sources are in the research checkpoint. Plan eligibility is
  // still decided by the upstream account, not by this table.
  if (
    [
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.3-codex",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
    ].includes(model)
  ) {
    return {
      contextWindow: 272_000,
      maxOutputTokens: 8192,
      supportsTools: true,
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      source: "known",
    };
  }
  return getModelCapabilities(model);
}

export type ChatgptTokenBundle = {
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  expiresAt: Date;
};
export type ChatgptDeviceStart = {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  intervalSeconds: number;
};
export class ChatgptCodexError extends Error {
  readonly name = "ChatgptCodexError";
  constructor(
    readonly kind: "auth" | "unavailable" | "disabled",
    readonly upstreamAuthRejected = false,
  ) {
    super("ChatGPT connection unavailable");
  }
}
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const INFERENCE = "https://chatgpt.com/backend-api/codex/responses";
const PROVIDER = "chatgpt-codex";
const JSON_BYTES = 128 * 1024;
const SSE_BYTES = 8 * 1024 * 1024;
let fetchOverride: typeof fetch | null = null;
export function setChatGptCodexFetchForTests(
  replacement: typeof fetch | null,
): void {
  fetchOverride = replacement;
}
export const setChatgptNetworkForTests = setChatGptCodexFetchForTests;
const unavailable = () => new ChatgptCodexError("unavailable");
function enabled(): void {
  if (!env.AI_CHATGPT_ENABLED) throw new ChatgptCodexError("disabled");
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function text(value: unknown, max = 65_536): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw unavailable();
  return value;
}
const safeError = (error: unknown) =>
  error instanceof ChatgptCodexError ? error : unavailable();

async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > JSON_BYTES) throw unavailable();
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const value = object(JSON.parse(body));
    if (!value) throw unavailable();
    return value;
  } catch (error) {
    throw safeError(error);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
function authCode(payload: Record<string, unknown>): boolean {
  const error = object(payload.error);
  const code = error?.code ?? error?.type ?? payload.error ?? payload.code;
  return (
    typeof code === "string" &&
    new Set([
      "invalid_grant",
      "invalid_token",
      "invalid_api_key",
      "authentication_error",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_reused",
      "refresh_token_invalidated",
    ]).has(code)
  );
}
async function refuse(response: Response): Promise<never> {
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new ChatgptCodexError("auth", true);
  }
  // 403 alone may mean model eligibility or quota; it is not evidence that
  // credentials were revoked and must not cause a paid API fallback.
  const payload = await boundedJson(response).catch(() => null);
  throw new ChatgptCodexError(
    payload && authCode(payload) ? "auth" : "unavailable",
    Boolean(payload && authCode(payload)),
  );
}
async function authRequest(
  path: string,
  data: Record<string, string>,
  form = false,
  allowDisabled = false,
): Promise<Response> {
  if (!allowDisabled) enabled();
  try {
    return await (fetchOverride ?? fetch)(`${AUTH}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
        Accept: "application/json",
      },
      body: form ? new URLSearchParams(data).toString() : JSON.stringify(data),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
    });
  } catch (error) {
    throw safeError(error);
  }
}
function claims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  try {
    return object(
      JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ),
    );
  } catch {
    return null;
  }
}
function bundle(
  payload: Record<string, unknown>,
  current?: ChatgptTokenBundle,
): ChatgptTokenBundle {
  const accessToken = text(payload.access_token ?? current?.accessToken);
  const refreshToken = text(payload.refresh_token ?? current?.refreshToken);
  // Decoding claims only supplies metadata for the token obtained from this
  // fixed trusted endpoint; it is never proof of the application's owner.
  const accessClaims = claims(accessToken);
  const idClaims = claims(payload.id_token);
  const account =
    object(idClaims?.["https://api.openai.com/auth"])?.chatgpt_account_id ??
    object(accessClaims?.["https://api.openai.com/auth"])?.chatgpt_account_id ??
    current?.accountId ??
    null;
  if (
    account !== null &&
    (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(account))
  )
    throw unavailable();
  const now = Date.now();
  const seconds = payload.expires_in;
  const jwtExp = accessClaims?.exp;
  let expiry = now + 5 * 60_000;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
    expiry = now + Math.min(seconds, 86_400) * 1000;
  else if (typeof jwtExp === "number" && Number.isFinite(jwtExp))
    expiry = Math.min(jwtExp * 1000, now + 86_400_000);
  else if (!payload.access_token && current)
    expiry = current.expiresAt.getTime();
  if (!Number.isFinite(expiry)) throw unavailable();
  return {
    accessToken,
    refreshToken,
    accountId: account,
    expiresAt: new Date(expiry),
  };
}
export async function startChatgptDevice(): Promise<ChatgptDeviceStart> {
  const response = await authRequest("/api/accounts/deviceauth/usercode", {
    client_id: CLIENT_ID,
  });
  if (!response.ok) return refuse(response);
  const payload = await boundedJson(response);
  enabled();
  const interval = Number(payload.interval);
  return {
    deviceAuthId: text(payload.device_auth_id, 1024),
    userCode: text(payload.user_code ?? payload.usercode, 128),
    verificationUri: `${AUTH}/codex/device`,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    intervalSeconds: Number.isFinite(interval)
      ? Math.max(5, Math.min(60, Math.ceil(interval)))
      : 5,
  };
}
export async function pollChatgptDevice(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<
  { status: "pending" } | { status: "authorized"; tokens: ChatgptTokenBundle }
> {
  const response = await authRequest("/api/accounts/deviceauth/token", {
    device_auth_id: text(input.deviceAuthId, 1024),
    user_code: text(input.userCode, 128),
  });
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    enabled();
    return { status: "pending" };
  }
  if (!response.ok) return refuse(response);
  const payload = await boundedJson(response);
  const exchanged = await authRequest(
    "/oauth/token",
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: text(payload.authorization_code, 4096),
      redirect_uri: `${AUTH}/deviceauth/callback`,
      code_verifier: text(payload.code_verifier, 1024),
    },
    true,
  );
  if (!exchanged.ok) return refuse(exchanged);
  const tokens = bundle(await boundedJson(exchanged));
  enabled();
  return { status: "authorized", tokens };
}
export async function refreshChatgptToken(
  current: ChatgptTokenBundle,
): Promise<ChatgptTokenBundle> {
  const response = await authRequest("/oauth/token", {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: text(current.refreshToken),
  });
  if (!response.ok) return refuse(response);
  const tokens = bundle(await boundedJson(response), current);
  enabled();
  return tokens;
}
/** Revocation is allowed while globally disabled: it terminates credentials. */
export async function revokeChatgptToken(refreshToken: string): Promise<void> {
  const response = await authRequest(
    "/oauth/revoke",
    {
      token: text(refreshToken),
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    },
    false,
    true,
  );
  if (!response.ok) return refuse(response);
  await response.body?.cancel().catch(() => undefined);
}
function toInput(request: AiCompletionRequest): unknown[] {
  const input: unknown[] = [];
  for (const message of request.messages) {
    let parts: { type: string; text: string }[] = [];
    const flushText = () => {
      if (parts.length) input.push({ role: message.role, content: parts });
      parts = [];
    };
    for (const block of message.content) {
      if (block.type === "text") {
        parts.push({
          type: message.role === "user" ? "input_text" : "output_text",
          text: block.text,
        });
      } else if (block.type === "tool_use") {
        flushText();
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        flushText();
        input.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      } else if (
        block.type === "opaque" &&
        block.provider === PROVIDER &&
        object(block.data)?.type === "reasoning"
      ) {
        flushText();
        input.push(block.data);
      }
    }
    flushText();
  }
  return input;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw unavailable();
  return value;
}
function completion(
  response: Record<string, unknown>,
  completedItems: Map<string, Record<string, unknown>>,
  model: string,
): AiCompletionResult {
  if (response.status !== undefined && response.status !== "completed")
    throw unavailable();
  const usage = object(response.usage);
  if (!usage) throw unavailable();
  const items = Array.isArray(response.output)
    ? response.output
    : [...completedItems.values()];
  const content: AiContentBlock[] = [];
  let refusal = false;
  for (const raw of items) {
    const item = object(raw);
    if (!item) throw unavailable();
    if (item.type === "message") {
      if (!Array.isArray(item.content)) throw unavailable();
      for (const part of item.content) {
        const block = object(part);
        if (block?.type === "output_text" && typeof block.text === "string")
          content.push({ type: "text", text: block.text });
        else if (block?.type === "refusal") refusal = true;
      }
    } else if (item.type === "function_call") {
      const name = text(item.name, 200);
      const id = text(item.call_id ?? item.id, 1024);
      const args =
        typeof item.arguments === "string"
          ? JSON.parse(item.arguments)
          : (() => {
              throw unavailable();
            })();
      content.push({ type: "tool_use", id, name, input: args });
    } else if (item.type === "reasoning")
      content.push({ type: "opaque", provider: PROVIDER, data: item });
  }
  if (
    !refusal &&
    !content.some((block) => block.type === "text" || block.type === "tool_use")
  )
    throw unavailable();
  return {
    content,
    stopReason: refusal
      ? "refusal"
      : content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn",
    // output_tokens already includes output_tokens_details.reasoning_tokens.
    usage: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
    },
    model,
  };
}
async function readCompletion(
  response: Response,
  model: string,
): Promise<AiCompletionResult> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const items = new Map<string, Record<string, unknown>>();
  let buffer = "";
  let size = 0;
  let events = 0;
  const dispatch = (frame: string): AiCompletionResult | null => {
    const lines = frame.split("\n");
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return null;
    if (++events > 4096) throw unavailable();
    const event = object(JSON.parse(data));
    if (!event) throw unavailable();
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      const error = object(event.response) ?? event;
      throw new ChatgptCodexError(
        authCode(error) ? "auth" : "unavailable",
        authCode(error),
      );
    }
    if (event.type === "response.output_item.done") {
      const item = object(event.item);
      if (!item || items.size >= 1024) throw unavailable();
      items.set(
        typeof item.id === "string" ? item.id : String(event.output_index),
        item,
      );
    }
    if (event.type === "response.completed") {
      const result = object(event.response);
      if (!result) throw unavailable();
      return completion(result, items, model);
    }
    return null;
  };
  try {
    for (;;) {
      enabled();
      const chunk = await reader.read();
      enabled();
      if (chunk.done) {
        buffer += decoder.decode();
      } else {
        size += chunk.value.byteLength;
        if (size > SSE_BYTES) throw unavailable();
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const result = dispatch(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (result) return result;
      }
      if (buffer.length > JSON_BYTES * 8) throw unavailable();
      if (chunk.done) {
        const result = buffer.trim() ? dispatch(buffer) : null;
        if (result) return result;
        throw unavailable();
      }
    }
  } catch (error) {
    throw safeError(error);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function createChatgptCodexProvider(options: {
  model: string;
  getCredentials: () => Promise<ChatgptTokenBundle | null>;
}): AiProvider {
  return {
    name: PROVIDER,
    async complete(request, callOptions) {
      try {
        enabled();
        const credentials = await options.getCredentials();
        enabled();
        if (!credentials) throw new ChatgptCodexError("auth");
        const headers: Record<string, string> = {
          Authorization: `Bearer ${text(credentials.accessToken)}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          originator: "legend-super-app",
          "User-Agent": "legend-ai/1.0",
        };
        if (credentials.accountId !== null) {
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(credentials.accountId))
            throw unavailable();
          headers["ChatGPT-Account-ID"] = credentials.accountId;
        }
        const payload = {
          model: options.model,
          instructions: request.system,
          input: toInput(request),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                  strict: false,
                })),
                tool_choice: "auto",
                parallel_tool_calls: true,
              }
            : {}),
          ...(request.reasoningEffort
            ? {
                reasoning: { effort: request.reasoningEffort },
                include: ["reasoning.encrypted_content"],
              }
            : {}),
          store: false,
          stream: true,
        };
        // The pinned Codex transport does not establish a hard output-token
        // cap. Plan usage is recorded separately from metered API invoices.
        const response = await (fetchOverride ?? fetch)(INFERENCE, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          redirect: "error",
          credentials: "omit",
          signal: callOptions?.signal
            ? AbortSignal.any([
                callOptions.signal,
                AbortSignal.timeout(env.AI_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(env.AI_TIMEOUT_MS),
        });
        if (!response.ok) return refuse(response);
        const result = await readCompletion(response, options.model);
        enabled();
        if (!(await options.getCredentials()))
          throw new ChatgptCodexError("auth");
        enabled();
        return result;
      } catch (error) {
        throw safeError(error);
      }
    },
  };
}
