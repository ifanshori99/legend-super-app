// DOIT recurring billing client (bead 6c6). Plain HTTP client for the ASSUMED
// recurring contract in payment-doit-recurring-wire.ts; it never decides what
// a subscription is worth or whether it is active (only a verified
// `invoice.paid` event does that).
//
// Same transport rules as payment-doit.ts: Bearer key, Idempotency-Key on
// every POST, public https host only (SSRF guard), DNS rebinding guard, no
// redirects, and no provider body, header or key in any error or log line.
// The caller loads the credentials and passes them in `config`.

import { lookup as dnsLookup } from "node:dns/promises";
import { CoreError } from "@starter/shared/core";
import type { z } from "zod";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import {
  isBlockedAddress,
  parseDoitBaseUrl,
  type DoitLookup,
} from "./payment-doit";
import { DOIT_BASE_URL, malformedProviderAnswer } from "./payment-doit-wire";
import {
  doitCreatePlanBody,
  doitCreateSubscriptionBody,
  doitRecurringPlanSchema,
  doitRecurringSubscriptionListSchema,
  doitRecurringSubscriptionSchema,
  type DoitCreatePlanInput,
  type DoitCreateSubscriptionInput,
  type DoitRecurringPlan,
  type DoitRecurringSubscription,
} from "./payment-doit-recurring-wire";

const REQUEST_TIMEOUT_MS = 10_000;

export type DoitRecurringClientConfig = {
  apiKey: string;
  /** Override of the one DOIT host (tests, a local fake). Validated like the
   * integration `config.baseUrl`; a bad value fails closed. */
  baseUrl?: string | null;
  /** Integration id, only for log lines. */
  integrationId?: string;
  fetch?: typeof fetch;
  /** Resolver for the DNS rebinding guard; skipped under NODE_ENV=test unless
   * injected. */
  lookup?: DoitLookup;
};

export type DoitRecurringClient = {
  createPlan(
    input: DoitCreatePlanInput,
    idempotencyKey: string,
  ): Promise<DoitRecurringPlan>;
  createSubscription(
    input: DoitCreateSubscriptionInput,
    idempotencyKey: string,
  ): Promise<DoitRecurringSubscription>;
  pauseSubscription(
    providerSubscriptionId: string,
    idempotencyKey: string,
  ): Promise<DoitRecurringSubscription>;
  resumeSubscription(
    providerSubscriptionId: string,
    idempotencyKey: string,
  ): Promise<DoitRecurringSubscription>;
  cancelSubscription(
    providerSubscriptionId: string,
    idempotencyKey: string,
  ): Promise<DoitRecurringSubscription>;
  /** Read-only GET of one subscription (ASSUMED contract). */
  getSubscription(
    providerSubscriptionId: string,
  ): Promise<DoitRecurringSubscription>;
  /** Read-only lookup by Legend's own subscription id (`reference`, ASSUMED
   * contract). An empty array means DOIT knows no such subscription; a thrown
   * error means unknown, never "empty". */
  findSubscriptionByReference(
    reference: string,
  ): Promise<DoitRecurringSubscription[]>;
};

function unavailable(message: string): CoreError {
  return new CoreError("SERVICE_UNAVAILABLE", message);
}

export function createDoitRecurringClient(
  config: DoitRecurringClientConfig,
): DoitRecurringClient {
  const doFetch = config.fetch ?? fetch;
  const resolveHost: DoitLookup | null =
    config.lookup ??
    (env.isTest
      ? null
      : (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const logContext = { integrationId: config.integrationId };

  function resolveBaseUrl(): string {
    const override = config.baseUrl;
    const baseUrl =
      override === undefined || override === null || override === ""
        ? DOIT_BASE_URL
        : parseDoitBaseUrl(override);
    if (!config.apiKey || !baseUrl)
      throw unavailable("Penagihan berulang belum dikonfigurasi.");
    return baseUrl;
  }

  /** One authenticated request (POST with an Idempotency-Key, or a bodyless
   * GET). Returns the parsed payload or throws a CoreError that carries no
   * provider text. */
  async function send<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    idempotencyKey: string | null,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const baseUrl = resolveBaseUrl();

    if (resolveHost) {
      let addresses: ReadonlyArray<{ address: string }>;
      try {
        addresses = await resolveHost(new URL(baseUrl).hostname);
      } catch {
        addresses = [];
      }
      if (
        addresses.length === 0 ||
        addresses.some((entry) => isBlockedAddress(entry.address))
      ) {
        logger.warn(logContext, "DOIT host resolved to a blocked address");
        throw unavailable("Gateway pembayaran tidak dapat dihubungi.");
      }
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
          ...(method === "POST"
            ? {
                "Content-Type": "application/json",
                ...(idempotencyKey
                  ? { "Idempotency-Key": idempotencyKey }
                  : {}),
              }
            : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn(
        {
          ...logContext,
          errName: error instanceof Error ? error.name : "unknown",
        },
        "DOIT recurring request failed",
      );
      throw unavailable("Gateway pembayaran tidak dapat dihubungi.");
    }

    if (!response.ok) {
      logger.warn(
        { ...logContext, status: response.status },
        "DOIT recurring answered with an error status",
      );
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
          "Kunci permintaan sudah dipakai untuk permintaan lain.",
        );
      throw unavailable("Gateway pembayaran sedang bermasalah.");
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
          ...logContext,
          paths: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
        "DOIT recurring answer failed validation",
      );
      throw malformedProviderAnswer();
    }
    return parsed.data;
  }

  const post = <T>(
    path: string,
    body: unknown,
    idempotencyKey: string,
    schema: z.ZodType<T>,
  ) => send("POST", path, body, idempotencyKey, schema);

  const subscriptionAction =
    (action: "pause" | "resume" | "cancel") =>
    (providerSubscriptionId: string, idempotencyKey: string) =>
      post(
        `/v1/recurring/subscriptions/${encodeURIComponent(providerSubscriptionId)}/${action}`,
        {},
        idempotencyKey,
        doitRecurringSubscriptionSchema,
      );

  return {
    createPlan: (input, idempotencyKey) =>
      post(
        "/v1/recurring/plans",
        doitCreatePlanBody(input),
        idempotencyKey,
        doitRecurringPlanSchema,
      ),
    createSubscription: (input, idempotencyKey) =>
      post(
        "/v1/recurring/subscriptions",
        doitCreateSubscriptionBody(input),
        idempotencyKey,
        doitRecurringSubscriptionSchema,
      ),
    pauseSubscription: subscriptionAction("pause"),
    resumeSubscription: subscriptionAction("resume"),
    cancelSubscription: subscriptionAction("cancel"),
    getSubscription: (providerSubscriptionId) =>
      send(
        "GET",
        `/v1/recurring/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        null,
        null,
        doitRecurringSubscriptionSchema,
      ),
    findSubscriptionByReference: async (reference) => {
      const answer = await send(
        "GET",
        `/v1/recurring/subscriptions?reference=${encodeURIComponent(reference)}`,
        null,
        null,
        doitRecurringSubscriptionListSchema,
      );
      return answer.data;
    },
  };
}
