// Kirimdev outbound WhatsApp adapter (legend-w8dfz) and webhook verification
// seam (legend-6qyk). Docs: https://docs.kirimdev.com/ (not kirim.dev).
//
// Only `send` and `verifyWebhook` of MessagingProvider are implemented here:
// inbound `receive` stays with identity-wa-inbound.service.ts. Nothing calls
// `send` yet; it is wired by whichever feature turns outbound on.
//
// Rules this file keeps:
// - Fail closed: no platform-mapped sender number for the tenant (or outlet)
//   means no HTTP call.
// - One Idempotency-Key per (tenant, outlet, reference), identical on every
//   retry, so a retry or a crash never produces a second WhatsApp message.
// - Errors carry only status, code and request id. Never the recipient, the
//   text, the response body or the Authorization header.
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  isPublicHttpsUrl,
  messageRequestSchema,
  operationResultSchema,
  verifyKirimWebhook,
  type MessagingProvider,
} from "@starter/shared/adapters";
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { env } from "../config/env";
import { kirimdevSenderMappings, tenants } from "../db/schema";
import { withTenant } from "../db/tenant";

export type KirimdevMessagingOptions = {
  /** Must match /^kdv_live_[A-Za-z0-9_-]{24}$/; otherwise TypeError (value not printed). */
  apiKey: string;
  /** Default https://api.kirimdev.com, https only. */
  baseUrl?: string;
  /** Test seam. */
  fetch?: typeof fetch;
  /** The platform-mapped `phone_number_id` for the tenant/outlet; null fails closed. */
  resolveSender: (
    context: ScopedTenantContext,
    message: { outletId: string | null },
  ) => Promise<string | null>;
  /** Optional for an outbound-only caller (templates); verifyWebhook rejects when empty. */
  webhookSecrets?: readonly string[];
  /** Default 10000. */
  timeoutMs?: number;
  /** Default 3. */
  maxAttempts?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Unix seconds; test seam for verifyWebhook. */
  now?: () => number;
};

type KirimdevSendErrorInit = {
  code: string;
  status: number | null;
  retryable: boolean;
  requestId: string | null;
};

/** Message holds only status, code and request id. */
export class KirimdevSendError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(init: KirimdevSendErrorInit) {
    super(
      `Kirimdev send failed: status=${init.status ?? "none"} code=${init.code} request_id=${init.requestId ?? "none"}`,
    );
    this.name = "KirimdevSendError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.requestId = init.requestId;
  }
}

const DEFAULT_BASE_URL = "https://api.kirimdev.com";
const API_KEY_PATTERN = /^kdv_live_[A-Za-z0-9_-]{24}$/;
/** The sender id goes into the URL path: only a plain token is allowed. */
const SENDER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_DELAY_MS = 8_000;
const BASE_BACKOFF_MS = 500;

type Failure = {
  error: KirimdevSendError;
  /** Server-requested wait (Retry-After) in ms, when present. */
  retryAfterMs: number | null;
};

/** Error codes and request ids come from the provider: keep only a token. */
function safeToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Retry-After in whole seconds only; an HTTP date is ignored. */
function parseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

/** Retry 429, 502, 503 and an idempotent request still in flight. */
function isRetryableStatus(status: number, code: string): boolean {
  if (status === 429 || status === 502 || status === 503) return true;
  return status === 409 && code === "idempotency_in_progress";
}

/** Same checks as the fake provider: trusted context, schema, scope. */
function acceptMessage(context: ScopedTenantContext, input: unknown) {
  assertTrustedScopedContext(context);
  const value = messageRequestSchema.parse(input);
  if (context.tenant.tenantId !== value.tenantId)
    throw new TypeError("Tenant mismatch");
  if (value.outletId === null) {
    if (context.outletScope.kind !== "tenant")
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Anda tidak memiliki akses ke operasi tingkat tenant.",
      );
  } else assertOutletInScope(context.outletScope, value.outletId);
  return value;
}

export type KirimdevTemplateRequest = {
  tenantId: string;
  outletId: string | null;
  reference: string;
  recipient: string;
  templateName: string;
  variables: Record<string, string>;
};
const templateRequestSchema = z.strictObject({
  tenantId: z.string().min(1),
  outletId: z.string().min(1).nullable(),
  reference: z.string().min(1).max(255),
  recipient: z.string().regex(/^[1-9][0-9]{7,14}$/),
  templateName: z.string().min(1).max(512),
  variables: z.record(z.string().min(1).max(64), z.string().max(1000)),
});
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

/** Positional {{1}}, {{2}}...: numeric keys ascending, else insertion order.
 * Kirimdev rejects blank, newline, tab or 4+ spaces, so clean each value. */
function orderedParameters(variables: Record<string, string>): string[] {
  const keys = Object.keys(variables);
  if (keys.every((k) => /^[0-9]+$/.test(k))) keys.sort((a, b) => +a - +b);
  return keys.map((k) => variables[k]!.replace(/\s+/g, " ").trim() || "-");
}

export function createKirimdevMessagingProvider(
  options: KirimdevMessagingOptions,
): Pick<MessagingProvider, "verifyWebhook" | "send"> & {
  sendTemplate: (
    context: ScopedTenantContext,
    request: KirimdevTemplateRequest,
  ) => Promise<{ reference: string; accepted: true }>;
} {
  if (!API_KEY_PATTERN.test(options.apiKey))
    throw new TypeError("Invalid Kirimdev API key format");
  const rawBaseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  if (!isPublicHttpsUrl(rawBaseUrl))
    throw new TypeError("Kirimdev base URL must be a public https URL");
  // Origin only: a path, query or fragment in the setting never reaches the URL.
  const baseUrl = new URL(rawBaseUrl).origin;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const secrets = [...(options.webhookSecrets ?? [])];
  const authorization = `Bearer ${options.apiKey}`;

  async function attempt(
    url: string,
    idempotencyKey: string,
    body: string,
  ): Promise<{ failure: Failure } | { ok: true; requestId: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body,
          // A redirect would resend the bearer token to another host.
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        const timedOut = controller.signal.aborted;
        return {
          failure: {
            error: new KirimdevSendError({
              code: timedOut ? "timeout" : "network",
              status: null,
              retryable: true,
              requestId: null,
            }),
            retryAfterMs: null,
          },
        };
      }

      const payload = asRecord(await readJson(response));
      if (response.status === 200 || response.status === 202) {
        const data = asRecord(payload?.data);
        const requestId = safeToken(payload?.request_id);
        if (typeof data?.id !== "string" || data.id === "")
          return {
            failure: {
              error: new KirimdevSendError({
                code: "invalid_response",
                status: response.status,
                retryable: false,
                requestId,
              }),
              retryAfterMs: null,
            },
          };
        return { ok: true, requestId };
      }

      const errorBody = asRecord(payload?.error);
      const code =
        safeToken(errorBody?.code) ?? `http_${String(response.status)}`;
      return {
        failure: {
          error: new KirimdevSendError({
            code,
            status: response.status,
            retryable: isRetryableStatus(response.status, code),
            requestId: safeToken(errorBody?.request_id),
          }),
          retryAfterMs: parseRetryAfterMs(response),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retry-After (or exponential backoff) with 0.75-1.25 jitter, max 8 s. */
  function delayFor(attemptNumber: number, retryAfterMs: number | null) {
    const base = retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attemptNumber - 1);
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.min(MAX_DELAY_MS, Math.round(base * jitter));
  }

  async function postWithRetry(
    url: string,
    idempotencyKey: string,
    body: string,
  ): Promise<void> {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      const result = await attempt(url, idempotencyKey, body);
      if ("ok" in result) return;
      const { error, retryAfterMs } = result.failure;
      if (!error.retryable || attemptNumber >= maxAttempts) throw error;
      await sleep(delayFor(attemptNumber, retryAfterMs));
    }
  }

  return {
    verifyWebhook(input) {
      const nowSeconds = input.nowSeconds ?? options.now?.();
      return verifyKirimWebhook({
        ...input,
        secrets,
        ...(nowSeconds === undefined ? {} : { nowSeconds }),
      });
    },

    async send(context, input) {
      const message = acceptMessage(context, input);
      const sender = (
        await options.resolveSender(context, { outletId: message.outletId })
      )?.trim();
      if (!sender || !SENDER_PATTERN.test(sender))
        throw new KirimdevSendError({
          code: "no_sender",
          status: null,
          retryable: false,
          requestId: null,
        });

      const url = `${baseUrl}/v1/${encodeURIComponent(sender)}/messages`;
      const idempotencyKey = createHash("sha256")
        .update(`${message.tenantId}:${message.outletId}:${message.reference}`)
        .digest("hex");
      const body = JSON.stringify({
        messaging_product: "whatsapp",
        to: `+${message.recipient}`,
        type: "text",
        text: { body: message.text },
      });

      await postWithRetry(url, idempotencyKey, body);
      return operationResultSchema.parse({
        reference: message.reference,
        accepted: true,
      });
    },

    /** Approved template (works outside the 24 h window). Same retry and key rules. */
    async sendTemplate(context, input) {
      assertTrustedScopedContext(context);
      const request = templateRequestSchema.parse(input);
      if (context.tenant.tenantId !== request.tenantId)
        throw new TypeError("Tenant mismatch");
      if (request.outletId === null) {
        if (context.outletScope.kind !== "tenant")
          throw new CoreError(
            "OUTLET_OUT_OF_SCOPE",
            "Anda tidak memiliki akses ke operasi tingkat tenant.",
          );
      } else assertOutletInScope(context.outletScope, request.outletId);
      const fail = (code: string) =>
        new KirimdevSendError({
          code,
          status: null,
          retryable: false,
          requestId: null,
        });
      if (!TEMPLATE_NAME_PATTERN.test(request.templateName))
        throw fail("invalid_template");
      const sender = (
        await options.resolveSender(context, { outletId: request.outletId })
      )?.trim();
      if (!sender || !SENDER_PATTERN.test(sender)) throw fail("no_sender");
      const url = `${baseUrl}/v1/${encodeURIComponent(sender)}/messages`;
      const idempotencyKey = createHash("sha256")
        .update(
          `template:${request.tenantId}:${request.outletId}:${request.reference}`,
        )
        .digest("hex");
      const body = JSON.stringify({
        messaging_product: "whatsapp",
        to: `+${request.recipient}`,
        type: "template",
        template: {
          name: request.templateName,
          language: "id",
          components: [
            {
              type: "body",
              parameters: orderedParameters(request.variables).map((text) => ({
                type: "text",
                text,
              })),
            },
          ],
        },
      });
      await postWithRetry(url, idempotencyKey, body);
      return { reference: request.reference, accepted: true as const };
    },
  };
}

type KirimdevEnv = Pick<
  typeof env,
  "KIRIM_API_KEY" | "KIRIM_API_BASE_URL" | "KIRIM_WEBHOOK_SECRET"
>;

/** Built from env: null while KIRIM_API_KEY is empty (outbound stays off). */
export function getKirimdevMessaging(deps: {
  resolveSender: KirimdevMessagingOptions["resolveSender"];
  env?: KirimdevEnv;
}): Pick<MessagingProvider, "verifyWebhook" | "send"> | null {
  const source = deps.env ?? env;
  if (!source.KIRIM_API_KEY) return null;
  return createKirimdevMessagingProvider({
    apiKey: source.KIRIM_API_KEY,
    ...(source.KIRIM_API_BASE_URL
      ? { baseUrl: source.KIRIM_API_BASE_URL }
      : {}),
    resolveSender: deps.resolveSender,
    webhookSecrets: source.KIRIM_WEBHOOK_SECRET,
  });
}

/**
 * Reads the sender mapping a platform admin wrote for the tenant: the outlet's
 * own mapping first (when the message names an outlet), else the tenant-wide
 * one. The tenant must be `active`. `tenant_integrations.config.phoneNumberId`
 * is a tenant-written value and is ignored here. No mapping: null (fail closed).
 */
export function kirimdevSenderFromPlatformMapping(
  database: Parameters<typeof withTenant>[0],
): KirimdevMessagingOptions["resolveSender"] {
  return (context, { outletId }) =>
    withTenant(database, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      const [tenantRow] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (tenantRow?.status !== "active") return null;
      if (outletId !== null) {
        const [outletRow] = await tx
          .select({ phoneNumberId: kirimdevSenderMappings.phoneNumberId })
          .from(kirimdevSenderMappings)
          .where(
            and(
              eq(kirimdevSenderMappings.tenantId, tenantId),
              eq(kirimdevSenderMappings.outletId, outletId),
            ),
          )
          .limit(1);
        if (outletRow) return outletRow.phoneNumberId;
      }
      const [tenantWide] = await tx
        .select({ phoneNumberId: kirimdevSenderMappings.phoneNumberId })
        .from(kirimdevSenderMappings)
        .where(
          and(
            eq(kirimdevSenderMappings.tenantId, tenantId),
            isNull(kirimdevSenderMappings.outletId),
          ),
        )
        .limit(1);
      return tenantWide?.phoneNumberId ?? null;
    });
}
