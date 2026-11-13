// Duitku payment gateway adapter (sub-brief 302, Slice C; design D17-D18,
// D23-D26). Implements `PaymentGatewayPort`; the wire format (signatures,
// inquiry, transactionStatus, getpaymentmethod) lives in payment-duitku-wire.ts.
//
// Sandbox or production comes from the integration's `config.environment`;
// merchant code and API key come from the sealed credentials, per call.
// Fails closed: no integration or a missing field means `health()` is `down`
// (`unconfigured`) and create/getStatus answer 503. Nothing here logs or throws
// a secret, a signature or a provider response body.
//
// Not implemented on purpose: `cancel` (Duitku has no cancel call we use) and
// refunds (manual, D6).

import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  paymentInstructionsSchema,
  type PaymentChannel,
  type PaymentInstructions,
} from "@starter/shared/payment";
import { logger } from "../lib/logger";
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
import {
  duitkuGetPaymentMethods,
  duitkuInquiry,
  duitkuMethodCategory,
  duitkuTransactionStatus,
  duitkuUnavailable,
  type DuitkuCredentials,
  type DuitkuMethodCategory,
  type DuitkuPaymentMethod,
} from "./payment-duitku-wire";
import {
  loadActiveIntegrationCredentials,
  loadIntegrationCredentialsById,
} from "./platform-integration.service";

const METHODS_CACHE_MS = 60_000;
/** Amount used to list the merchant's methods when no real amount applies. */
const PROBE_AMOUNT_IDR = 10_000;
const DEFAULT_VA_NAME = "Legend";

type Loaded = {
  integration: { config: Record<string, unknown> };
  credentials: Record<string, string>;
};

export type DuitkuLoaded = Loaded & {
  integration: { id: string; outletId: string | null };
};

export type DuitkuCredentialLoader = (
  context: ScopedTenantContext,
  outletId: string | null,
) => Promise<DuitkuLoaded | null>;

/** Loads one integration row by id, whatever its status. */
export type DuitkuCredentialByIdLoader = (
  context: ScopedTenantContext,
  integrationId: string,
) => Promise<DuitkuLoaded | null>;

export type DuitkuGatewayOptions = {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Public API origin Duitku posts callbacks to (`DUITKU_CALLBACK_BASE_URL`). */
  callbackBaseUrl: string;
  /** Page the customer returns to (`DUITKU_RETURN_URL`). */
  returnUrl: string;
  loadCredentials?: DuitkuCredentialLoader;
  loadCredentialsById?: DuitkuCredentialByIdLoader;
};

/**
 * Credentials Duitku may have signed a callback with: the current ones first,
 * then the previous generation while `now < previousValidUntil` (D17-D18).
 * Empty when the current merchant code, API key or environment is unusable.
 * An incomplete or unreadable previous generation is ignored.
 */
export function duitkuCredentialSet(
  loaded: Loaded,
  now: Date,
): DuitkuCredentials[] {
  const { merchantCode, apiKey } = loaded.credentials;
  const environment = loaded.integration.config.environment;
  if (
    !merchantCode ||
    !apiKey ||
    (environment !== "sandbox" && environment !== "production")
  )
    return [];
  const set: DuitkuCredentials[] = [{ merchantCode, apiKey, environment }];
  const {
    previousMerchantCode,
    previousApiKey,
    previousValidUntil: until,
  } = loaded.credentials;
  const validUntil = until ? Date.parse(until) : Number.NaN;
  if (
    previousMerchantCode &&
    previousApiKey &&
    Number.isFinite(validUntil) &&
    now.getTime() < validUntil
  )
    set.push({
      merchantCode: previousMerchantCode,
      apiKey: previousApiKey,
      environment,
    });
  return set;
}

type Resolved = {
  integrationId: string;
  /** Current credentials first, then a previous one still in grace. */
  credentials: DuitkuCredentials[];
  notificationEmail: string | null;
  vaName: string;
};

const defaultLoader: DuitkuCredentialLoader = (context, outletId) =>
  loadActiveIntegrationCredentials(context, "duitku", outletId);

// By id = a payment already minted on that integration: no plan check (a
// revoked plan blocks new intents through `defaultLoader`, never the
// reconciliation of money in flight, Codex P1 legend-rgddb).
const defaultByIdLoader: DuitkuCredentialByIdLoader = (
  context,
  integrationId,
) =>
  loadIntegrationCredentialsById(context, "duitku", integrationId, {
    forStoredIntent: true,
  });

/** The one outlet an outlet-scoped context is limited to, else null (tenant
 * row). */
function singleOutletId(context: ScopedTenantContext): string | null {
  const scope = context.outletScope;
  return scope.kind === "outlets" && scope.outletIds.length === 1
    ? (scope.outletIds[0] ?? null)
    : null;
}

/** `yyyy-MM-dd HH:mm:ss` in WIB (UTC+7, no daylight saving): the text signed
 * for getpaymentmethod. */
function wibDatetime(date: Date): string {
  return new Date(date.getTime() + 7 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

const METHOD_ORDER: readonly GatewayPaymentMethod[] = [
  "qris",
  "va",
  "bank_transfer",
  "ewallet",
  "card",
];

/** Duitku categories that map to a guest-facing method (D24); retail,
 * paylater and unknown codes are dropped. */
const METHOD_OF_CATEGORY: Partial<
  Record<DuitkuMethodCategory, GatewayPaymentMethod>
> = { qris: "qris", va: "va", ewallet: "ewallet", card: "card" };

function channelOf(row: DuitkuPaymentMethod): PaymentChannel {
  return { code: row.code, name: row.name.slice(0, 60) };
}

function groupMethods(
  rows: readonly DuitkuPaymentMethod[],
): GatewayMethodAvailability[] {
  return METHOD_ORDER.map((method) => {
    // Duitku has no bank transfer rail: never offered.
    if (method === "bank_transfer")
      return { method, enabled: false, channels: [] };
    const inMethod = rows.filter(
      (row) => METHOD_OF_CATEGORY[duitkuMethodCategory(row.code)] === method,
    );
    return {
      method,
      enabled: inMethod.length > 0,
      // QRIS needs no channel pick; the others list the codes to choose from.
      channels: method === "qris" ? [] : inMethod.map(channelOf),
    };
  });
}

/** Records the HTTP outcome of calls so `testConnection` can tell a refused
 * login from an unreachable host without ever reading a body. */
function trackFetch(base: typeof fetch): {
  fetch: typeof fetch;
  seen: { status: number | null; threw: boolean };
} {
  const seen = { status: null as number | null, threw: false };
  const tracked = async (...args: Parameters<typeof fetch>) => {
    try {
      const response = await base(...args);
      seen.status = response.status;
      return response;
    } catch (error) {
      seen.threw = true;
      throw error;
    }
  };
  return { fetch: tracked as typeof fetch, seen };
}

function validation(message: string): CoreError {
  return new CoreError("VALIDATION_ERROR", message);
}

export function createDuitkuGateway(
  options: DuitkuGatewayOptions,
): PaymentGatewayPort {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const loadCredentials = options.loadCredentials ?? defaultLoader;
  const loadCredentialsById = options.loadCredentialsById ?? defaultByIdLoader;
  const callbackBaseUrl = options.callbackBaseUrl.replace(/\/+$/, "");
  const methodsCache = new Map<
    string,
    { at: number; rows: readonly DuitkuPaymentMethod[] }
  >();

  function toResolved(loaded: DuitkuLoaded): Resolved | null {
    const credentials = duitkuCredentialSet(loaded, now());
    if (credentials.length === 0) return null;
    const { notificationEmail, vaName } = loaded.integration.config;
    return {
      integrationId: loaded.integration.id,
      credentials,
      notificationEmail:
        typeof notificationEmail === "string" && notificationEmail
          ? notificationEmail
          : null,
      vaName:
        typeof vaName === "string" && vaName.trim()
          ? vaName.trim()
          : DEFAULT_VA_NAME,
    };
  }

  /** Why no account resolved: `unconfigured` (no integration or incomplete
   * credentials) or `error` (the loader failed). */
  async function resolveDetailed(
    context: ScopedTenantContext,
    outletId?: string,
    integrationId?: string | null,
  ): Promise<Resolved | "unconfigured" | "error"> {
    let loaded: DuitkuLoaded | null;
    try {
      // A payment already minted is checked with the account that minted it.
      loaded = integrationId
        ? await loadCredentialsById(context, integrationId)
        : await loadCredentials(context, outletId ?? singleOutletId(context));
    } catch (error) {
      logger.warn(
        { errName: error instanceof Error ? error.name : "unknown" },
        "Duitku credentials could not be loaded",
      );
      return "error";
    }
    return (loaded && toResolved(loaded)) ?? "unconfigured";
  }

  async function requireCredentials(
    context: ScopedTenantContext,
    outletId?: string,
    integrationId?: string | null,
  ): Promise<Resolved> {
    const resolved = await resolveDetailed(context, outletId, integrationId);
    if (typeof resolved === "string")
      throw new CoreError(
        "SERVICE_UNAVAILABLE",
        "Gateway pembayaran belum dikonfigurasi. Bayar di kasir.",
      );
    return resolved;
  }

  const current = (resolved: Resolved): DuitkuCredentials =>
    resolved.credentials[0] as DuitkuCredentials;

  async function fetchMethods(
    resolved: Resolved,
    amountIdr: number,
    fetchImpl: typeof fetch = doFetch,
  ): Promise<readonly DuitkuPaymentMethod[]> {
    const creds = current(resolved);
    const rows = await duitkuGetPaymentMethods({
      creds,
      amountIdr,
      datetime: wibDatetime(now()),
      fetch: fetchImpl,
    });
    if (amountIdr === PROBE_AMOUNT_IDR)
      methodsCache.set(cacheKey(resolved), { at: now().getTime(), rows });
    return rows;
  }

  const cacheKey = (resolved: Resolved) =>
    `${resolved.integrationId}:${current(resolved).environment}:${current(resolved).merchantCode}`;

  async function cachedMethods(
    resolved: Resolved,
  ): Promise<readonly DuitkuPaymentMethod[]> {
    const hit = methodsCache.get(cacheKey(resolved));
    if (hit && now().getTime() - hit.at < METHODS_CACHE_MS) return hit.rows;
    return fetchMethods(resolved, PROBE_AMOUNT_IDR);
  }

  async function health(
    context: ScopedTenantContext,
    outletId?: string,
  ): Promise<GatewayHealth> {
    const resolved = await resolveDetailed(context, outletId);
    if (resolved === "unconfigured")
      return { status: "down", reason: "unconfigured" };
    if (resolved === "error") return { status: "down" };
    try {
      await cachedMethods(resolved);
      return { status: "available" };
    } catch {
      return { status: "down" };
    }
  }

  async function methods(
    context: ScopedTenantContext,
    outletId?: string,
  ): Promise<readonly GatewayMethodAvailability[]> {
    const resolved = await requireCredentials(context, outletId);
    return groupMethods(await cachedMethods(resolved));
  }

  async function channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
    outletId?: string,
  ): Promise<PaymentChannel[]> {
    if (method !== "va") return [];
    const resolved = await resolveDetailed(context, outletId);
    if (typeof resolved === "string") return [];
    const group = groupMethods(await cachedMethods(resolved)).find(
      (entry) => entry.method === "va",
    );
    return [...(group?.channels ?? [])];
  }

  /** The Duitku code to pay with: first enabled QRIS code, or the enabled code
   * the caller named for va, ewallet or card. */
  function chooseCode(
    rows: readonly DuitkuPaymentMethod[],
    method: GatewayPaymentMethod,
    channelCode: string | null,
  ): DuitkuPaymentMethod {
    const inMethod = rows.filter(
      (row) => METHOD_OF_CATEGORY[duitkuMethodCategory(row.code)] === method,
    );
    const chosen =
      method === "qris"
        ? inMethod[0]
        : inMethod.find((row) => row.code === channelCode);
    if (!chosen)
      throw validation(
        method === "qris"
          ? "QRIS tidak aktif di gateway ini."
          : "Kanal pembayaran tidak tersedia.",
      );
    return chosen;
  }

  function instructionsFor(
    method: GatewayPaymentMethod,
    code: DuitkuPaymentMethod,
    inquiry: { vaNumber: string | null; qrString: string | null },
  ): PaymentInstructions {
    const candidate =
      method === "qris"
        ? { method, qrPayload: inquiry.qrString, issuer: null }
        : {
            method,
            channelCode: code.code,
            channelName: code.name.slice(0, 60),
            virtualAccountNumber: inquiry.vaNumber,
          };
    const parsed = paymentInstructionsSchema.safeParse(candidate);
    if (!parsed.success) throw duitkuUnavailable();
    return parsed.data;
  }

  async function createIntent(
    input: GatewayIntentRequest,
  ): Promise<GatewayIntent> {
    // Duitku has no bank transfer rail (D24).
    if (input.method === "bank_transfer")
      throw validation("Metode pembayaran tidak tersedia.");
    const resolved = await requireCredentials(input.context, input.outletId);
    if (!resolved.notificationEmail) throw duitkuUnavailable();
    // Fresh list at the real amount: a method can be out of limits for it.
    const rows = await fetchMethods(resolved, input.amountIdr);
    const code = chooseCode(rows, input.method, input.channelCode);
    // Pay-by-link answers (ewallet, card) have no PaymentInstructions variant
    // yet: the contract change and the guest screen are a separate bead.
    if (input.method === "ewallet" || input.method === "card")
      throw validation("Metode pembayaran ini belum didukung.");

    const expiresAtMs = Date.parse(input.expiresAt);
    const inquiry = await duitkuInquiry({
      creds: current(resolved),
      merchantOrderId: input.intentId,
      amountIdr: input.amountIdr,
      paymentMethod: code.code,
      productDetails: `Pembayaran ${input.intentId.slice(0, 8)}`,
      email: resolved.notificationEmail,
      customerVaName: resolved.vaName,
      callbackUrl: `${callbackBaseUrl}/api/webhooks/payments/duitku/${input.context.tenant.tenantId}`,
      returnUrl: options.returnUrl,
      ...(Number.isFinite(expiresAtMs)
        ? {
            expiryPeriodMinutes: Math.max(
              1,
              Math.ceil((expiresAtMs - now().getTime()) / 60_000),
            ),
          }
        : {}),
      fetch: doFetch,
    });
    return {
      providerRef: inquiry.reference,
      instructions: instructionsFor(input.method, code, inquiry),
      expiresAt: input.expiresAt,
      integrationId: resolved.integrationId,
    };
  }

  async function getStatus(input: {
    context: ScopedTenantContext;
    outletId?: string;
    integrationId?: string | null;
    providerRef: string;
    intentId?: string;
  }): Promise<GatewayPaymentStatus> {
    // The merchantOrderId is the intent id: without it Duitku cannot be asked.
    if (!input.intentId) throw duitkuUnavailable();
    const resolved = await requireCredentials(
      input.context,
      input.outletId,
      input.integrationId,
    );
    // Current credentials first. An intent minted with the previous merchant
    // code is unknown to the current one: while the previous generation is in
    // grace, ask once with it (D18).
    let failure: unknown = duitkuUnavailable();
    for (const creds of resolved.credentials) {
      try {
        const answer = await duitkuTransactionStatus({
          creds,
          merchantOrderId: input.intentId,
          fetch: doFetch,
        });
        // An answer about another Duitku payment must never move this one.
        if (answer.reference !== input.providerRef) continue;
        return {
          status:
            answer.status === "paid"
              ? "paid"
              : answer.status === "pending"
                ? "pending"
                : "expired",
          providerRef: input.providerRef,
          amountIdr: answer.status === "paid" ? answer.amountIdr : null,
          paidAt: null,
          rawStatus: answer.statusCode,
        };
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  async function testConnection(
    context: ScopedTenantContext,
    integrationId: string,
  ): ReturnType<NonNullable<PaymentGatewayPort["testConnection"]>> {
    const resolved = await resolveDetailed(context, undefined, integrationId);
    if (typeof resolved === "string")
      return { ok: false, code: "GATEWAY_REJECTED" };
    const { fetch: tracked, seen } = trackFetch(doFetch);
    try {
      // Always a live call: a cached answer would hide a wrong key.
      const rows = await fetchMethods(resolved, PROBE_AMOUNT_IDR, tracked);
      return { ok: true, methods: groupMethods(rows) };
    } catch {
      const status = seen.status;
      if (seen.threw || (status !== null && status >= 500))
        return { ok: false, code: "GATEWAY_UNREACHABLE" };
      if (status === 401 || status === 403)
        return { ok: false, code: "GATEWAY_AUTH_FAILED" };
      return { ok: false, code: "GATEWAY_REJECTED" };
    }
  }

  return {
    provider: "duitku",
    health,
    createIntent,
    getStatus,
    channels,
    methods,
    testConnection,
  };
}
