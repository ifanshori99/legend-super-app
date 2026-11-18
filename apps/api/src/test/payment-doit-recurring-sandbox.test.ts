// Optional sandbox certification for legend-bcb4p. A second opt-in keeps this
// mutation probe out of normal checks, even if a developer exports a test key.
// CI and live keys are always refused. Creates at most one subscription, GETs
// it by id and reference, then cancels it; never pays an invoice or refunds.
// The runner supplies DOIT_API_KEY privately, never as a printed command.

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../lib/logger";
import { createDoitRecurringClient } from "../services/payment-doit-recurring";
import {
  doitRecurringPlanSchema,
  doitRecurringSubscriptionListSchema,
  doitRecurringSubscriptionSchema,
  doitSubscriptionActionConfirmed,
} from "../services/payment-doit-recurring-wire";

function probeEnabled(key: string, optIn?: string, ci?: string): boolean {
  return key.startsWith("pb_test_") && optIn === "1" && !ci;
}

// Field names are useful contract evidence; all provider scalar values are
// replaced by types. Neither credentials nor customer/provider ids survive.
function payloadShape(value: unknown, key: string): unknown {
  if (value === null) return null;
  if (Array.isArray(value))
    return value.map((entry) => payloadShape(entry, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name.includes(key) ? "[redacted-field]" : name,
        payloadShape(entry, key),
      ]),
    );
  }
  return typeof value;
}

function assertNoKey(value: unknown, key: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_name: string, entry: unknown) =>
      entry instanceof Error
        ? {
            ...entry,
            name: entry.name,
            message: entry.message,
            stack: entry.stack,
            cause: entry.cause,
          }
        : entry,
    );
  } catch {
    throw new Error("DOIT sandbox probe could not inspect an error or log");
  }
  if (serialized?.includes(key))
    throw new Error("DOIT sandbox probe detected a secret in an error or log");
}

describe("DOIT recurring sandbox probe safety", () => {
  it("requires sandbox key plus explicit opt-in and refuses CI", () => {
    expect(probeEnabled("pb_test_example", "1")).toBe(true);
    expect(probeEnabled("pb_live_example", "1")).toBe(false);
    expect(probeEnabled("pb_test_example")).toBe(false);
    expect(probeEnabled("pb_test_example", "1", "true")).toBe(false);
  });

  it("redacts scalar values and secret-bearing field names", () => {
    const secret = "pb_test_do_not_print";
    const shape = payloadShape(
      { data: [{ id: "sub_private", token: secret, [secret]: secret }] },
      secret,
    );
    expect(shape).toEqual({
      data: [{ id: "string", token: "string", "[redacted-field]": "string" }],
    });
    expect(JSON.stringify(shape).includes(secret)).toBe(false);
    expect(() => assertNoKey({ message: secret }, secret)).toThrow(
      "DOIT sandbox probe detected a secret in an error or log",
    );
  });

  it("detects secrets in nested Error messages without echoing the secret", () => {
    const secret = "pb_test_do_not_print_nested_error";
    expect(() => assertNoKey({ err: new Error(secret) }, secret)).toThrowError(
      new Error("DOIT sandbox probe detected a secret in an error or log"),
    );
  });
});

const apiKey = process.env.DOIT_API_KEY ?? "";
const enabled = probeEnabled(
  apiKey,
  process.env.DOIT_RECURRING_SANDBOX_PROBE,
  process.env.CI,
);

describe.skipIf(!enabled)("DOIT recurring sandbox certification", () => {
  it("certifies GET by id/reference and cancels its only subscription", async () => {
    const calls: {
      method: string;
      endpoint: string;
      status: number;
      responseShape: unknown;
      parserAccepts: boolean;
    }[] = [];
    const messages: unknown[] = [];
    const levels = [
      "warn",
      "info",
      "error",
      "debug",
      "trace",
      "fatal",
    ] as const;
    const spies = levels.map((level) =>
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        messages.push(args);
      }),
    );
    let subscriptionId: string | null = null;
    let subscriptionCreateAccepted = false;
    let cancelled = false;
    let outcome = "failed";
    let failure = false;
    const reference = randomUUID();
    const client = createDoitRecurringClient({
      apiKey,
      // No base-url override: this probe can only send the sandbox key to
      // DOIT's configured HTTPS host, with the production DNS guard enabled.
      lookup: (host) => lookup(host, { all: true, verbatim: true }),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const isPlan = url.pathname === "/v1/recurring/plans";
        const isCreate =
          method === "POST" && url.pathname === "/v1/recurring/subscriptions";
        const isReference =
          method === "GET" && url.searchParams.has("reference");
        let payload: unknown = null;
        try {
          payload = await response.clone().json();
        } catch {
          // Status and null shape still prove a non-JSON response.
        }
        if (isCreate && response.ok) subscriptionCreateAccepted = true;
        if (isCreate && response.ok && payload && typeof payload === "object") {
          // Keep the id for finally cleanup even when the assumed parser
          // rejects an otherwise successful subscription creation response.
          const direct = "id" in payload ? payload.id : undefined;
          const nested = "data" in payload ? payload.data : undefined;
          const candidate =
            direct ??
            (nested && typeof nested === "object" && "id" in nested
              ? nested.id
              : undefined);
          if (typeof candidate === "string" && candidate.length <= 100)
            subscriptionId = candidate;
        }
        const schema = isPlan
          ? doitRecurringPlanSchema
          : isReference
            ? doitRecurringSubscriptionListSchema
            : doitRecurringSubscriptionSchema;
        calls.push({
          method,
          endpoint: isPlan
            ? "/v1/recurring/plans"
            : isCreate
              ? "/v1/recurring/subscriptions"
              : isReference
                ? "/v1/recurring/subscriptions?reference=[redacted]"
                : url.pathname.endsWith("/cancel")
                  ? "/v1/recurring/subscriptions/[redacted]/cancel"
                  : "/v1/recurring/subscriptions/[redacted]",
          status: response.status,
          responseShape: payloadShape(payload, apiKey),
          parserAccepts: schema.safeParse(payload).success,
        });
        return response;
      },
    });

    try {
      const plan = await client.createPlan(
        {
          name: "Legend recurring sandbox certification",
          amountIdr: 1000,
          interval: "month",
        },
        `bcb4p-plan-${reference}`,
      );
      const subscription = await client.createSubscription(
        { providerPlanId: plan.id, reference },
        `bcb4p-subscription-${reference}`,
      );
      subscriptionId = subscription.id;
      let byIdMatches = false;
      let byReferenceMatches = false;
      // Exercise both GETs even if one assumed contract fails.
      try {
        const answer = await client.getSubscription(subscription.id);
        byIdMatches =
          answer.id === subscription.id && answer.reference === reference;
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const answers = await client.findSubscriptionByReference(reference);
        byReferenceMatches =
          answers.length === 1 &&
          answers[0]?.id === subscription.id &&
          answers[0]?.reference === reference;
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
      if (!byIdMatches || !byReferenceMatches) failure = true;
      outcome = failure ? "contract-mismatch" : "contract-matches";
    } catch (error) {
      messages.push(error instanceof Error ? error.message : String(error));
      const last = calls.at(-1);
      if (!subscriptionId && last && [404, 405, 501].includes(last.status)) {
        outcome = "adapter-path-mismatch";
        // Not a pass: the adapter's /v1/recurring/* paths do not exist at DOIT.
        failure = true;
        // A created id is unavailable, but record both requested legacy GET
        // routes with an intentionally absent id/reference. These responses
        // do not certify lookup semantics or permit changing the adapter.
        for (const query of [
          () => client.getSubscription(`bcb4p-absent-${reference}`),
          () => client.findSubscriptionByReference(reference),
        ]) {
          try {
            await query();
          } catch (lookupError) {
            messages.push(
              lookupError instanceof Error
                ? lookupError.message
                : String(lookupError),
            );
          }
        }
      } else {
        failure = true;
      }
    } finally {
      if (subscriptionId) {
        try {
          const answer = await client.cancelSubscription(
            subscriptionId,
            `bcb4p-cancel-${reference}`,
          );
          cancelled = doitSubscriptionActionConfirmed(
            "cancel",
            answer,
            subscriptionId,
          );
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
        if (!cancelled) failure = true;
      }
      for (const spy of spies) spy.mockRestore();
      // Assertions carry only booleans/fixed messages, never provider data.
      assertNoKey(messages, apiKey);
      const evidence = {
        card: "legend-bcb4p",
        capturedAt: new Date().toISOString(),
        environment: "sandbox",
        documentation: "https://doit.id/docs/en/",
        outcome,
        subscriptionCreateAccepted,
        cleanupIdKnown: subscriptionId !== null,
        cancellationConfirmed: cancelled,
        refundRequested: false,
        calls,
      };
      assertNoKey(evidence, apiKey);
      const folder = new URL(
        "../../../../docs/qa/evidence/doit-sandbox/",
        import.meta.url,
      );
      await mkdir(folder, { recursive: true });
      await writeFile(
        new URL("bcb4p-recurring.redacted.json", folder),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    expect(
      failure,
      "DOIT recurring certification failed; inspect redacted evidence",
    ).toBe(false);
  }, 90_000);
});
