// DOIT payment gateway adapter (bead legend-b9i; PRD v1.7 §3.13 F13,
// PAY-02/03/06). Implements `PaymentGatewayPort`; the wire format follows the
// official DOIT docs and lives in payment-doit-wire.ts.
//
// The base URL is https://pay.doit.id; an integration's `config.baseUrl` is
// only an override (tests, a local fake).
//
// Fails closed: no integration row, a missing field or a bad base URL means
// `health()` is `down` and create/getStatus answer 503. Credentials come from
// the sealed integration store per call and are never logged, thrown or
// echoed; a provider response body never reaches an error or a log line.
//
// The gateway also implements `PaymentRefundPort` (POST /v1/payments/{id}/refunds).
// DOIT has no refund lookup and does not document how long it keeps an
// idempotency key, so `getRefundStatus` never answers `not_found` and `refund`
// only ever runs on the first attempt.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicHttpsUrl, type PaymentResult } from "@starter/shared/adapters";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import type { PaymentChannel } from "@starter/shared/payment";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import {
  DOIT_BASE_URL,
  DOIT_CREATABLE_METHODS,
  DOIT_ERROR_BODY_MAX_BYTES,
  type DoitCreatableMethod,
  DoitRefundUnknownError,
  doitPaymentMethodsSchema,
  doitPaymentSchema,
  doitPaymentToGatewayStatus,
  doitPaymentToInstructions,
  doitPaymentToProviderResult,
  doitRefundDeclineCode,
  malformedProviderAnswer,
  mapDoitMethods,
  parseDoitErrorCode,
  parseDoitRefundAnswer,
  verifyDoitSignature,
} from "./payment-doit-wire";
import type {
  GatewayHealth,
  GatewayIntent,
  GatewayIntentRequest,
  GatewayMethodAvailability,
  GatewayPaymentMethod,
  GatewayPaymentStatus,
  OnlinePaymentMethod,
  PaymentGatewayPort,
} from "./payment-gateway";
import type {
  GatewayRefundLookup,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentRefundPort,
} from "./payment-refund-gateway";
import {
  loadActiveIntegrationCredentials,
  loadIntegrationCredentialsById,
} from "./platform-integration.service";

const REQUEST_TIMEOUT_MS = 10_000;
const METHODS_CACHE_MS = 60_000;
const REFUND_REASON_MAX = 255;

export type DoitCredentialLoader = (
  context: ScopedTenantContext,
  outletId: string | null,
) => Promise<{
  integration: {
    id: string;
    outletId: string | null;
    config: Record<string, unknown>;
  };
  credentials: Record<string, string>;
} | null>;

/** Loads one integration row by id, whatever its status (see
 * `loadIntegrationCredentialsById`). */
export type DoitCredentialByIdLoader = (
  context: ScopedTenantContext,
  integrationId: string,
) => ReturnType<DoitCredentialLoader>;

export type DoitLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string }>>;

export type DoitGatewayOptions = {
  fetch?: typeof fetch;
  /** Resolver used for the DNS rebinding guard. Defaults to
   * `dns.promises.lookup(host, { all: true })`; the guard is skipped under
   * NODE_ENV=test unless a lookup is injected. */
  lookup?: DoitLookup;
  loadCredentials?: DoitCredentialLoader;
  loadCredentialsById?: DoitCredentialByIdLoader;
  now?: () => Date;
};

export type DoitGateway = PaymentGatewayPort &
  PaymentRefundPort & {
    /** True when `header` is a fresh DOIT signature over `rawBody` made with
     * one of `secrets`. */
    verifyWebhook(input: {
      rawBody: Buffer;
      header: string | undefined;
      secrets: readonly string[];
      now?: Date;
    }): boolean;
    /** Read-only `GET /v1/payments/{providerRef}` in the provider contract's
     * shape. The answer must carry the same DOIT id and Legend reference. */
    lookupPayment(input: {
      context: ScopedTenantContext;
      outletId?: string;
      integrationId?: string | null;
      providerRef: string;
      reference: string;
    }): Promise<PaymentResult>;
  };

type Resolved = {
  integrationId: string;
  baseUrl: string;
  apiKey: string;
};

const defaultLoader: DoitCredentialLoader = (context, outletId) =>
  loadActiveIntegrationCredentials(context, "doit", outletId);

// By id = a payment already minted on that integration (status read, poll,
// cancel, refund): no plan check, so withdrawing DOIT from the plan stops new
// codes, never the reconciliation of money in flight (legend-la1yk).
const defaultByIdLoader: DoitCredentialByIdLoader = (context, integrationId) =>
  loadIntegrationCredentialsById(context, "doit", integrationId, {
    forStoredIntent: true,
  });

function unavailable(message: string): CoreError {
  return new CoreError("SERVICE_UNAVAILABLE", message);
}

/** A DOIT error status the caller asked to see (`captureErrorStatuses`). Holds
 * only the HTTP status and a validated DOIT error code, never body text. */
class DoitErrorStatus extends CoreError {
  constructor(
    readonly httpStatus: number,
    readonly doitCode: string | null,
  ) {
    super(
      "SERVICE_UNAVAILABLE",
      "Gateway pembayaran sedang bermasalah. Bayar di kasir.",
    );
  }
}

/** The DOIT error code in an error body of at most 4 KB, else null. */
async function readDoitErrorCode(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= DOIT_ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
    if (total > DOIT_ERROR_BODY_MAX_BYTES) return null;
    return parseDoitErrorCode(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** The one outlet an outlet-scoped context is limited to, else null (tenant
 * row). */
function singleOutletId(context: ScopedTenantContext): string | null {
  const scope = context.outletScope;
  return scope.kind === "outlets" && scope.outletIds.length === 1
    ? (scope.outletIds[0] ?? null)
    : null;
}

/** Public https host only (SSRF guard): no credentials, no explicit port, no
 * IP literal, no localhost or internal suffix. http to a local fake is
 * accepted under NODE_ENV=test. Trailing slash removed. */
export function parseDoitBaseUrl(
  value: unknown,
  allowLocalHttp: boolean = env.isTest,
): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const allowed = allowLocalHttp
    ? url.protocol === "https:" || url.protocol === "http:"
    : isPublicHttpsUrl(value) && url.port === "";
  if (!allowed) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function ipv4Blocked(a: number, b: number): boolean {
  return (
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal to eight 16-bit groups, or null when malformed. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, dotted.index)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  const groups = parts.map((part) => Number.parseInt(part, 16));
  if (
    groups.length !== 8 ||
    groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)
  )
    return null;
  return groups;
}

/** True for loopback, private, link-local, CGNAT, unique-local, unspecified
 * and multicast addresses, including IPv4-mapped/compatible and NAT64
 * embeddings of those. Unparseable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split("%")[0] ?? "");
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return ipv4Blocked(a, b);
  }
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const g = (index: number) => groups[index] ?? 0;
  const embedded = (hi: number, lo: number) =>
    ipv4Blocked(hi >> 8, hi & 0xff) || (hi === 0 && lo === 0);
  // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && g(5) === 0)
    return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && g(5) === 0xffff)
    return embedded(g(6), g(7));
  // NAT64 64:ff9b::/96
  if (
    g(0) === 0x64 &&
    g(1) === 0xff9b &&
    groups.slice(2, 6).every((x) => x === 0)
  )
    return embedded(g(6), g(7));
  // 6to4 2002::/16 embeds an IPv4 address in groups 1-2
  if (g(0) === 0x2002) return embedded(g(1), g(2));
  return (
    (g(0) & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g(0) & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (g(0) & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

export function createDoitGateway(
  options: DoitGatewayOptions = {},
): DoitGateway {
  const doFetch = options.fetch ?? fetch;
  const loadCredentials = options.loadCredentials ?? defaultLoader;
  const loadCredentialsById = options.loadCredentialsById ?? defaultByIdLoader;
  const now = options.now ?? (() => new Date());
  const resolveHost: DoitLookup | null =
    options.lookup ??
    (env.isTest
      ? null
      : (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const methodsCache = new Map<
    string,
    { at: number; value: readonly GatewayMethodAvailability[] }
  >();

  /** Why no account resolved: `unconfigured` (no integration or incomplete
   * credentials, so never set up) or `error` (the loader failed). */
  async function resolveDetailed(
    context: ScopedTenantContext,
    outletId?: string,
    integrationId?: string | null,
  ): Promise<Resolved | "unconfigured" | "error"> {
    let loaded: Awaited<ReturnType<DoitCredentialLoader>>;
    try {
      // A payment already minted is checked with the account that minted it.
      // Otherwise the bill's outlet wins over the caller's scope: a
      // tenant-scoped guest request must still use the outlet's own account.
      loaded = integrationId
        ? await loadCredentialsById(context, integrationId)
        : await loadCredentials(context, outletId ?? singleOutletId(context));
    } catch (error) {
      logger.warn(
        { errName: error instanceof Error ? error.name : "unknown" },
        "DOIT credentials could not be loaded",
      );
      return "error";
    }
    if (!loaded) return "unconfigured";
    const { apiKey } = loaded.credentials;
    const override = loaded.integration.config.baseUrl;
    // No override means the one DOIT host; a malformed override fails closed.
    const baseUrl =
      override === undefined || override === null || override === ""
        ? DOIT_BASE_URL
        : parseDoitBaseUrl(override);
    if (!apiKey || !loaded.credentials.webhookSecret || !baseUrl)
      return "unconfigured";
    return { integrationId: loaded.integration.id, baseUrl, apiKey };
  }

  async function resolve(
    context: ScopedTenantContext,
    outletId?: string,
    integrationId?: string | null,
  ): Promise<Resolved | null> {
    const resolved = await resolveDetailed(context, outletId, integrationId);
    return typeof resolved === "string" ? null : resolved;
  }

  async function requireCredentials(
    context: ScopedTenantContext,
    outletId?: string,
    integrationId?: string | null,
  ): Promise<Resolved> {
    const resolved = await resolve(context, outletId, integrationId);
    if (!resolved)
      throw unavailable(
        "Gateway pembayaran belum dikonfigurasi. Bayar di kasir.",
      );
    return resolved;
  }

  /** One authenticated call. Returns the parsed payload or throws a CoreError
   * that carries no provider text. */
  async function call<T>(
    resolved: Resolved,
    request: {
      method: "GET" | "POST";
      path: string;
      body?: unknown;
      idempotencyKey?: string;
      /** Aborts the call together with the internal timeout. */
      signal?: AbortSignal;
      /** Epoch ms (legend-3usn8): the request must not leave at or after it. */
      sendBy?: number;
      /** Error statuses to throw as `DoitErrorStatus` (status + DOIT code)
       * instead of the generic mapping. */
      captureErrorStatuses?: readonly number[];
    },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${resolved.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (request.method === "POST" && request.idempotencyKey)
      headers["Idempotency-Key"] = request.idempotencyKey;

    // DNS rebinding guard: a public-looking name must not resolve to an
    // internal address. Fail closed with no detail.
    if (resolveHost) {
      let addresses: ReadonlyArray<{ address: string }>;
      try {
        addresses = await resolveHost(new URL(resolved.baseUrl).hostname);
      } catch {
        addresses = [];
      }
      if (
        addresses.length === 0 ||
        addresses.some((entry) => isBlockedAddress(entry.address))
      ) {
        logger.warn(
          { integrationId: resolved.integrationId },
          "DOIT host resolved to a blocked address",
        );
        throw unavailable(
          "Gateway pembayaran tidak dapat dihubungi. Bayar di kasir.",
        );
      }
    }

    // legend-3usn8 fence: no await between these checks and the send. A worker
    // that stalled (credentials, DNS) past the deadline sends nothing; the
    // outcome stays unknown, never a decline.
    if (request.sendBy !== undefined && Date.now() >= request.sendBy)
      throw new DoitRefundUnknownError("DOIT_SEND_DEADLINE_PASSED");

    let response: Response;
    try {
      // Inside the try so an abort maps like any failed send (no reason text).
      request.signal?.throwIfAborted();
      response = await doFetch(`${resolved.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "error",
        signal: request.signal
          ? AbortSignal.any([
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              request.signal,
            ])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn(
        {
          integrationId: resolved.integrationId,
          errName: error instanceof Error ? error.name : "unknown",
        },
        "DOIT request failed",
      );
      throw unavailable(
        "Gateway pembayaran tidak dapat dihubungi. Bayar di kasir.",
      );
    }

    if (!response.ok) {
      const captured = request.captureErrorStatuses?.includes(response.status);
      const doitCode = captured ? await readDoitErrorCode(response) : null;
      logger.warn(
        {
          integrationId: resolved.integrationId,
          status: response.status,
          ...(doitCode ? { doitCode } : {}),
        },
        "DOIT answered with an error status",
      );
      if (captured) throw new DoitErrorStatus(response.status, doitCode);
      // Drop the body without reading it into memory or an error.
      void response.body?.cancel().catch(() => {});
      if (response.status === 400 || response.status === 422)
        throw new CoreError(
          "VALIDATION_ERROR",
          "Gateway pembayaran menolak permintaan ini.",
        );
      if (response.status === 409)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci permintaan sudah dipakai untuk pembayaran lain.",
        );
      throw unavailable(
        "Gateway pembayaran sedang bermasalah. Bayar di kasir.",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw malformedProviderAnswer();
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // Paths only: never the offending value or the body.
      logger.warn(
        {
          integrationId: resolved.integrationId,
          paths: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
        "DOIT answer failed validation",
      );
      throw malformedProviderAnswer();
    }
    return parsed.data;
  }

  async function loadMethods(
    resolved: Resolved,
  ): Promise<readonly GatewayMethodAvailability[]> {
    const key = `${resolved.integrationId}|${resolved.baseUrl}`;
    const cached = methodsCache.get(key);
    if (cached && now().getTime() - cached.at < METHODS_CACHE_MS)
      return cached.value;
    const answer = await call(
      resolved,
      { method: "GET", path: "/v1/methods" },
      doitPaymentMethodsSchema,
    );
    const value = mapDoitMethods(answer.data);
    methodsCache.set(key, { at: now().getTime(), value });
    return value;
  }

  return {
    provider: "doit",

    async health(context, outletId): Promise<GatewayHealth> {
      const resolved = await resolveDetailed(context, outletId);
      if (resolved === "unconfigured")
        return { status: "down", reason: "unconfigured" };
      if (resolved === "error") return { status: "down" };
      try {
        await loadMethods(resolved);
        return { status: "available" };
      } catch {
        return { status: "down" };
      }
    },

    async methods(context, outletId) {
      return loadMethods(await requireCredentials(context, outletId));
    },

    async channels(
      context,
      method: OnlinePaymentMethod,
      outletId?: string,
    ): Promise<PaymentChannel[]> {
      if (method === "qris") return [];
      const methods = await loadMethods(
        await requireCredentials(context, outletId),
      );
      const entry = methods.find((candidate) => candidate.method === method);
      return entry?.enabled ? [...entry.channels] : [];
    },

    async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
      const method: GatewayPaymentMethod = input.method;
      // This adapter serves QRIS and VA only (see DOIT_CREATABLE_METHODS).
      if (!(DOIT_CREATABLE_METHODS as readonly string[]).includes(method))
        throw new CoreError(
          "VALIDATION_ERROR",
          "Metode pembayaran ini belum tersedia.",
        );
      const creatable = method as DoitCreatableMethod;
      const resolved = await requireCredentials(input.context, input.outletId);
      const available = (await loadMethods(resolved)).find(
        (candidate) => candidate.method === creatable,
      );
      const channel =
        creatable === "va"
          ? (available?.channels.find(
              (candidate) => candidate.code === input.channelCode,
            ) ?? null)
          : null;
      if (!available?.enabled || (creatable === "va" && !channel))
        throw new CoreError(
          "VALIDATION_ERROR",
          "Metode pembayaran ini sedang tidak tersedia.",
        );

      // DOIT takes a lifetime in seconds (at least 60), not a timestamp.
      const lifetimeMs = Date.parse(input.expiresAt) - now().getTime();
      if (!Number.isFinite(lifetimeMs))
        throw new CoreError("VALIDATION_ERROR", "Batas waktu tidak valid.");
      const expiresIn = Math.max(60, Math.ceil(lifetimeMs / 1000));
      const payment = await call(
        resolved,
        {
          method: "POST",
          path: "/v1/payments",
          idempotencyKey: input.idempotencyKey,
          body: {
            amount: input.amountIdr,
            rail: creatable,
            ...(channel ? { va_bank: channel.code } : {}),
            reference: input.intentId,
            expires_in: expiresIn,
          },
        },
        doitPaymentSchema,
      );
      // The answer must describe the payment we asked for.
      if (
        payment.reference !== input.intentId ||
        payment.amount !== input.amountIdr ||
        payment.status !== "pending"
      )
        throw malformedProviderAnswer();
      // The guest pays total_amount. A fee DOIT adds on the customer's side
      // would charge more than the bill shows: the fee must be borne by the
      // merchant (portal setting).
      if (
        payment.total_amount !== null &&
        payment.total_amount !== payment.amount
      ) {
        logger.warn(
          { integrationId: resolved.integrationId },
          "DOIT charges the customer more than the bill; set the fee to the merchant",
        );
        throw unavailable(
          "Gateway pembayaran menambah biaya ke pembeli. Bayar di kasir.",
        );
      }
      // A pending payment always carries its expiry.
      if (payment.expires_at === null) throw malformedProviderAnswer();
      return {
        providerRef: payment.id,
        instructions: doitPaymentToInstructions(payment, creatable, channel),
        expiresAt: new Date(payment.expires_at).toISOString(),
        integrationId: resolved.integrationId,
      };
    },

    async getStatus(input): Promise<GatewayPaymentStatus> {
      const resolved = await requireCredentials(
        input.context,
        input.outletId,
        input.integrationId,
      );
      const payment = await call(
        resolved,
        {
          method: "GET",
          path: `/v1/payments/${encodeURIComponent(input.providerRef)}`,
        },
        doitPaymentSchema,
      );
      if (payment.id !== input.providerRef) throw malformedProviderAnswer();
      // The payment must belong to the intent being settled.
      if (input.intentId !== undefined && payment.reference !== input.intentId)
        throw malformedProviderAnswer();
      return doitPaymentToGatewayStatus(payment);
    },

    async lookupPayment(input): Promise<PaymentResult> {
      const resolved = await requireCredentials(
        input.context,
        input.outletId,
        input.integrationId,
      );
      const payment = await call(
        resolved,
        {
          method: "GET",
          path: `/v1/payments/${encodeURIComponent(input.providerRef)}`,
        },
        doitPaymentSchema,
      );
      if (payment.id !== input.providerRef) throw malformedProviderAnswer();
      if (payment.reference !== input.reference)
        throw malformedProviderAnswer();
      return doitPaymentToProviderResult(payment);
    },

    async refund(input: GatewayRefundRequest): Promise<GatewayRefundResult> {
      // Nothing to refund against (a manual intent has no DOIT payment): the
      // request never leaves, but that is not a provider decline, so the
      // outcome stays unknown and the refund waits for a person.
      if (input.paymentProviderRef === null)
        throw new DoitRefundUnknownError("DOIT_PAYMENT_REF_MISSING");
      const resolved = await requireCredentials(
        input.context,
        input.outletId,
        input.integrationId,
      );
      let answer: unknown;
      try {
        answer = await call(
          resolved,
          {
            method: "POST",
            path: `/v1/payments/${encodeURIComponent(input.paymentProviderRef)}/refunds`,
            idempotencyKey: input.idempotencyKey,
            body: {
              amount: input.amountIdr,
              reason: input.reason.slice(0, REFUND_REASON_MAX),
            },
            signal: input.signal,
            sendBy: input.sendBy,
            captureErrorStatuses: [400, 409, 502],
          },
          z.unknown(),
        );
      } catch (error) {
        if (error instanceof DoitErrorStatus) {
          // Only a definitive decline of this first send is a failure; every
          // other status or code leaves the outcome unknown.
          const code = doitRefundDeclineCode(error.httpStatus, error.doitCode);
          if (code !== null)
            return { status: "failed", providerRef: null, code };
          // Not a decline: unknown outcome, with the HTTP status as the code.
          throw new DoitRefundUnknownError(`DOIT_HTTP_${error.httpStatus}`);
        }
        throw error;
      }
      return parseDoitRefundAnswer(answer, {
        paymentProviderRef: input.paymentProviderRef,
        paymentIntentId: input.paymentIntentId,
        amountIdr: input.amountIdr,
        idempotencyKey: input.idempotencyKey,
      });
    },

    async getRefundStatus(input): Promise<GatewayRefundLookup> {
      // DOIT has no GET refund: the payment is the only thing to read. This
      // never answers `not_found` (see the file header).
      if (input.paymentProviderRef === null)
        throw new DoitRefundUnknownError("DOIT_REFUND_STATUS_UNKNOWN");
      const resolved = await requireCredentials(
        input.context,
        input.outletId,
        input.integrationId,
      );
      const payment = await call(
        resolved,
        {
          method: "GET",
          path: `/v1/payments/${encodeURIComponent(input.paymentProviderRef)}`,
          signal: input.signal,
        },
        doitPaymentSchema,
      );
      if (
        payment.id !== input.paymentProviderRef ||
        payment.reference !== input.paymentIntentId
      )
        throw new DoitRefundUnknownError("DOIT_REFUND_STATUS_UNKNOWN");
      // A refund we already hold a ref for, on a payment DOIT still shows as
      // paid: the refund has not landed yet.
      if (
        payment.status === "paid" &&
        input.providerRef !== null &&
        input.providerRef !== payment.id
      )
        return { status: "pending", providerRef: input.providerRef };
      if (payment.status !== "refunded" || payment.amount !== input.amountIdr)
        throw new DoitRefundUnknownError("DOIT_REFUND_STATUS_UNKNOWN");
      return {
        status: "succeeded",
        providerRef: input.providerRef ?? payment.id,
      };
    },

    verifyWebhook(input) {
      return verifyDoitSignature({
        rawBody: input.rawBody,
        header: input.header,
        secrets: input.secrets,
        now: input.now ?? now(),
      });
    },
  };
}
