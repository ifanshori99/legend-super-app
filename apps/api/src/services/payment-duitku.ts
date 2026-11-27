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
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import type {
  GatewayHealth,
  GatewayIntent,
  GatewayIntentRequest,
  GatewayMethodAvailability,
  GatewayPaymentMethod,
  GatewayPaymentStatus,
  GuestFeeSchedule,
  OnlinePaymentMethod,
  PaymentGatewayPort,
} from "./payment-gateway";
import {
  feeQuoteAccepted,
  guestFeeFor,
  guestFeeMethodOn,
  guestFeeRatesOf,
  type GuestFeeRate,
} from "./payment-guest-fee";
import { duitkuSandboxRefused } from "./payment-duitku-sandbox-policy";
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
import {
  lockedGuestFeeChannels,
  withoutLockedGuestFees,
} from "./payment-guest-fee-lock";

const METHODS_CACHE_MS = 60_000;
/** Amount used to list the merchant's methods when no real amount applies. */
const PROBE_AMOUNT_IDR = 10_000;
const DEFAULT_VA_NAME = "Legend";
/** Duitku's only card code (payment-duitku-wire.ts): a card intent takes no
 * channel, so its guest fee rate is read under this code. */
const CARD_CODE = "VC";

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
 * Empty when the current merchant code, API key or environment is unusable;
 * a sandbox account is unusable in production (1269 C0), so neither an intent,
 * a status answer nor a callback of it counts there.
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
    (environment !== "sandbox" && environment !== "production") ||
    (environment === "sandbox" && duitkuSandboxRefused())
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

const feeChanged = () =>
  new HttpError(
    409,
    "FEE_CHANGED",
    "Biaya layanan berubah. Muat ulang lalu pilih metode lagi.",
  );

type Resolved = {
  integrationId: string;
  /** 1272 K1: usable guest fee rates by channel code (config `guestFees`). */
  guestFeeRates: ReadonlyMap<string, GuestFeeRate>;
  /** Current credentials first, then a previous one still in grace. */
  credentials: DuitkuCredentials[];
  notificationEmail: string | null;
  vaName: string;
};

// 1272 K2: a channel with an open guest_fee_shortfall case loses its guest
// fee rate here, so a guest-fee method hides it and createIntent refuses it
// (payment-guest-fee-lock.ts). A failed lock read fails the load (closed).
const defaultLoader: DuitkuCredentialLoader = async (context, outletId) => {
  const loaded = await loadActiveIntegrationCredentials(
    context,
    "duitku",
    outletId,
  );
  if (!loaded || env.DUITKU_GUEST_FEE_METHODS.length === 0) return loaded;
  const locked = await lockedGuestFeeChannels(context);
  return {
    ...loaded,
    integration: {
      ...loaded.integration,
      config: withoutLockedGuestFees(loaded.integration.config, locked),
    },
  };
};

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

/** 1269 C0: a method takes money only once `DUITKU_ENABLED_METHODS` lists it. */
function methodUnlocked(method: GatewayPaymentMethod): boolean {
  return env.DUITKU_ENABLED_METHODS.some((enabled) => enabled === method);
}

function withoutLocked(
  groups: readonly GatewayMethodAvailability[],
  guestFeeRates: ReadonlyMap<string, GuestFeeRate>,
): GatewayMethodAvailability[] {
  return groups.map((entry) => {
    if (!methodUnlocked(entry.method))
      return { method: entry.method, enabled: false, channels: [] };
    // 1272 K1 §1: a guest-fee method offers only the channels it has a usable
    // rate for (card: its one code); never a fee of 0 by omission.
    if (!guestFeeMethodOn(entry.method, env.DUITKU_GUEST_FEE_METHODS))
      return entry;
    const rated = entry.channels.filter((channel) =>
      guestFeeRates.has(channel.code),
    );
    const enabled =
      entry.enabled &&
      (entry.method === "card"
        ? guestFeeRates.has(CARD_CODE)
        : rated.length > 0);
    return {
      method: entry.method,
      enabled,
      channels: enabled ? rated : [],
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
      guestFeeRates: guestFeeRatesOf(loaded.integration.config),
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
    amountIdr?: number,
  ): Promise<readonly GatewayMethodAvailability[]> {
    const resolved = await requireCredentials(context, outletId);
    // At the real bill amount: a method can be out of limits for it. The
    // probe amount keeps its cache; any other amount is read fresh.
    if (amountIdr !== undefined && amountIdr !== PROBE_AMOUNT_IDR)
      return withoutLocked(
        groupMethods(await fetchMethods(resolved, amountIdr)),
        resolved.guestFeeRates,
      );
    return withoutLocked(
      groupMethods(await cachedMethods(resolved)),
      resolved.guestFeeRates,
    );
  }

  async function channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
    outletId?: string,
  ): Promise<PaymentChannel[]> {
    // Channel-bearing methods only; QRIS and card need no pick.
    if (method !== "va" && method !== "ewallet") return [];
    if (!methodUnlocked(method)) return [];
    const resolved = await resolveDetailed(context, outletId);
    if (typeof resolved === "string") return [];
    const group = withoutLocked(
      groupMethods(await cachedMethods(resolved)),
      resolved.guestFeeRates,
    ).find((entry) => entry.method === method);
    return [...(group?.channels ?? [])];
  }

  /** The Duitku code to pay with: the first enabled code of the category for
   * QRIS and card (card is VC), or the enabled code the caller named for va
   * and ewallet. */
  function chooseCode(
    rows: readonly DuitkuPaymentMethod[],
    method: GatewayPaymentMethod,
    channelCode: string | null,
  ): DuitkuPaymentMethod {
    const inMethod = rows.filter(
      (row) => METHOD_OF_CATEGORY[duitkuMethodCategory(row.code)] === method,
    );
    const chosen =
      method === "qris" || method === "card"
        ? inMethod[0]
        : inMethod.find((row) => row.code === channelCode);
    if (!chosen)
      throw validation(
        method === "qris"
          ? "QRIS tidak aktif di gateway ini."
          : method === "card"
            ? "Kartu tidak aktif di gateway ini."
            : "Kanal pembayaran tidak tersedia.",
      );
    return chosen;
  }

  function instructionsFor(
    method: GatewayPaymentMethod,
    code: DuitkuPaymentMethod,
    inquiry: {
      vaNumber: string | null;
      qrString: string | null;
      paymentUrl: string;
    },
  ): PaymentInstructions {
    // Pay-by-link (ewallet, card): the guest is sent to Duitku's page. The
    // schema accepts https only, so any other URL fails closed below.
    const candidate =
      method === "qris"
        ? { method, qrPayload: inquiry.qrString, issuer: null }
        : method === "ewallet" || method === "card"
          ? {
              method,
              channelCode: code.code,
              channelName: code.name.slice(0, 60),
              paymentUrl: inquiry.paymentUrl,
            }
          : {
              method,
              channelCode: code.code,
              channelName: code.name.slice(0, 60),
              virtualAccountNumber: inquiry.vaNumber,
            };
    const parsed = paymentInstructionsSchema.safeParse(candidate);
    if (!parsed.success) throw duitkuUnavailable();
    // legend-kt3t1: the guest is sent to this page, so only a Duitku host is
    // trusted (https is enforced by the schema); anything else fails closed.
    if (parsed.data.method === "ewallet" || parsed.data.method === "card") {
      let host: string;
      try {
        host = new URL(parsed.data.paymentUrl).hostname.toLowerCase();
      } catch {
        throw duitkuUnavailable();
      }
      if (host !== "duitku.com" && !host.endsWith(".duitku.com"))
        throw duitkuUnavailable();
    }
    return parsed.data;
  }

  /** 1272 K1: guest fee of one code for the bill (see `GuestFeeSchedule`). */
  function feeOf(
    rates: ReadonlyMap<string, GuestFeeRate>,
    method: GatewayPaymentMethod,
    channelCode: string | null,
    baseIdr: number,
  ): number | null {
    return guestFeeFor({
      method,
      channelCode: method === "card" ? CARD_CODE : channelCode,
      baseIdr,
      rates,
      feeMethods: env.DUITKU_GUEST_FEE_METHODS,
    });
  }

  async function guestFeeSchedule(
    context: ScopedTenantContext,
    outletId?: string,
  ): Promise<GuestFeeSchedule> {
    const resolved = await resolveDetailed(context, outletId);
    // No account: nothing can be issued anyway. A fee method answers null
    // (hidden), never 0.
    const rates: ReadonlyMap<string, GuestFeeRate> =
      typeof resolved === "string" ? new Map() : resolved.guestFeeRates;
    return (method, channelCode, baseIdr) =>
      feeOf(rates, method, channelCode, baseIdr);
  }

  async function createIntent(
    input: GatewayIntentRequest,
  ): Promise<GatewayIntent> {
    // Duitku has no bank transfer rail (D24); a locked method is refused before
    // any provider call.
    if (input.method === "bank_transfer" || !methodUnlocked(input.method))
      throw validation("Metode pembayaran tidak tersedia.");
    const resolved = await requireCredentials(input.context, input.outletId);
    if (!resolved.notificationEmail) throw duitkuUnavailable();
    const guestFeeIdr = input.guestFeeIdr ?? 0;
    // 1272 K1 §1: the fee must be the one this account's rate gives for the
    // channel now; a fee method without a rate is not offered.
    const expectedFee = feeOf(
      resolved.guestFeeRates,
      input.method,
      input.channelCode,
      input.amountIdr,
    );
    if (expectedFee === null)
      throw validation("Metode pembayaran tidak tersedia.");
    if (expectedFee !== guestFeeIdr) throw feeChanged();
    const chargedIdr = input.amountIdr + guestFeeIdr;
    // Fresh list at the charged amount: a method can be out of limits for it,
    // and its quote is the fee Duitku takes from that amount.
    const rows = await fetchMethods(resolved, chargedIdr);
    const code = chooseCode(rows, input.method, input.channelCode);
    // Every flagged method is checked, a zero rate too: a fee 0 against a
    // quote above 0 leaves the outlet short.
    if (
      guestFeeMethodOn(input.method, env.DUITKU_GUEST_FEE_METHODS) &&
      !feeQuoteAccepted(code.totalFee, guestFeeIdr)
    ) {
      // §1: Duitku would take more (outlet short) or clearly less (guest
      // overpays) than our rate: no intent, ops told to fix the rate.
      logger.warn(
        {
          integrationId: resolved.integrationId,
          method: input.method,
          channelCode: code.code,
          guestFeeIdr,
          quoteIdr: code.totalFee,
        },
        "Duitku fee quote differs from the guest fee rate",
      );
      throw feeChanged();
    }

    const expiresAtMs = Date.parse(input.expiresAt);
    const inquiry = await duitkuInquiry({
      creds: current(resolved),
      merchantOrderId: input.intentId,
      amountIdr: chargedIdr,
      paymentMethod: code.code,
      productDetails: `Pembayaran ${input.intentId.slice(0, 8)}`,
      email: resolved.notificationEmail,
      customerVaName: resolved.vaName,
      callbackUrl: `${callbackBaseUrl}/api/webhooks/payments/duitku/${input.context.tenant.tenantId}`,
      returnUrl: options.returnUrl,
      // Floor, never ceil: Duitku must not keep a code alive past our expiry.
      ...(Number.isFinite(expiresAtMs)
        ? {
            expiryPeriodMinutes: Math.max(
              1,
              Math.floor((expiresAtMs - now().getTime()) / 60_000),
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
      feeQuoteIdr: code.totalFee,
    };
  }

  function extraList(extras: Map<string, number>) {
    return [...extras].map(([providerRef, amountIdr]) => ({
      providerRef,
      amountIdr,
      paidAt: null,
    }));
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
    // Paid transactions under another reference: never move this payment, but
    // reported so they can be parked. Collected over every credential set,
    // because a later set may still answer for this payment's own reference.
    const extras = new Map<string, number>();
    let extraStatusCode = "";
    for (const creds of resolved.credentials) {
      try {
        const answer = await duitkuTransactionStatus({
          creds,
          merchantOrderId: input.intentId,
          fetch: doFetch,
        });
        if (answer.reference !== input.providerRef) {
          if (
            answer.status === "paid" &&
            answer.reference !== null &&
            answer.reference !== ""
          ) {
            extras.set(answer.reference, answer.amountIdr);
            extraStatusCode = answer.statusCode;
          }
          continue;
        }
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
          ...(extras.size > 0 ? { extraPayments: extraList(extras) } : {}),
        };
      } catch (error) {
        failure = error;
      }
    }
    if (extras.size > 0)
      return {
        status: "pending",
        providerRef: input.providerRef,
        amountIdr: null,
        paidAt: null,
        rawStatus: extraStatusCode,
        extraPayments: extraList(extras),
      };
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
    guestFeeSchedule,
    createIntent,
    getStatus,
    channels,
    methods,
    testConnection,
  };
}
