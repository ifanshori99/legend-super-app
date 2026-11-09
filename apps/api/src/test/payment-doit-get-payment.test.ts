// DOIT getPayment (bead legend-6g29, tingkat K uang). Black-box tests against
// docs/briefs/sub-doit-get-payment.md: wire mapping, `gateway.lookupPayment`
// and the `PaymentProvider.getPayment` reader in payment-doit-provider.ts.
//
// DOIT is faked by a real `http.createServer` on 127.0.0.1 (same pattern as
// payment-doit.test.ts). No database is needed: credentials and the
// reference -> DOIT id lookup are injected.
//
// Webhook signature checks (wrong secret, empty header, signature of another
// body) are already covered by "verifyDoitSignature" in payment-doit.test.ts
// and the store-then-process dedupe (same event id answers `duplicate`, settles
// once) by payment-webhook-api.test.ts ("PAY-03 the same event id delivered
// twice settles once"). Not duplicated here.
//
// Assumptions where the brief is silent:
// - Tenant mismatch and malformed input make the reader reject with any error
//   (not a pinned code) and never reach `resolve` or the network.
// - A DOIT status that is not one of the 5 documented (incl. "cancelled",
//   "settled", empty, number, null) is a malformed answer: SERVICE_UNAVAILABLE.
// - The validation warning is observed by spying on the shared pino logger.
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CoreError,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { logger } from "../lib/logger";
import { createDoitGateway } from "../services/payment-doit";
import { createDoitPaymentReader } from "../services/payment-doit-provider";
import {
  doitPaymentToProviderResult,
  doitPaymentToProviderStatus,
} from "../services/payment-doit-wire";

const API_KEY = "test-api-key-5f3a9c1e7b";
const WEBHOOK_SECRET = "test-webhook-secret-8d2e4a6c";
const INTEGRATION_ID = "5b0b3f7e-2f4a-4c0e-9a55-5d3c1a7e9f01";
const OUTLET_ID = "0c4f1c8e-4d6b-4a3e-8f0a-1b2c3d4e5f60" as OutletId;
const TENANT_ID = "7a1e2d3c-4b5a-4968-8776-655443322110" as TenantId;
const OTHER_TENANT_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1a0f9e8d7c6b" as TenantId;
const REFERENCE = "11111111-1111-4111-8111-111111111111";
const PROVIDER_REF = "pay_0001";
const NOW = new Date("2026-11-08T10:00:00.000Z");
const BODY_MARKER = "DOIT-ERROR-BODY-MARKER-91ac";

// --------------------------------------------------------------------------
// Fake DOIT server
// --------------------------------------------------------------------------

type Recorded = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
};
type Reply = { status?: number; json?: unknown; text?: string; hang?: boolean };

let server: http.Server;
let baseUrl: string;
let requests: Recorded[] = [];
let route: (req: Recorded) => Reply = () => ({ status: 404 });
const sockets = new Set<import("node:net").Socket>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
      };
      requests.push(recorded);
      const reply = route(recorded);
      if (reply.hang) return;
      res.statusCode = reply.status ?? 200;
      if (reply.text !== undefined) {
        res.setHeader("content-type", "text/plain");
        res.end(reply.text);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.json ?? {}));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  route = () => ({ status: 404 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const tenant = establishTenantContext({
  tenantId: TENANT_ID,
  brandId: null,
  source: "webhook",
});
const outletContext: ScopedTenantContext = establishScopedTenantContext(
  tenant,
  { kind: "outlets", outletIds: [OUTLET_ID] },
);

function creds(config: Record<string, unknown> = { baseUrl }) {
  return {
    integration: { id: INTEGRATION_ID, outletId: null, config },
    credentials: { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET },
  };
}

function makeGateway(config?: Record<string, unknown>) {
  const loadCredentials = vi.fn(
    async (...args: [ScopedTenantContext, string | null]) => {
      void args;
      return creds(config);
    },
  );
  // A payment already minted is read with the integration that minted it.
  const loadCredentialsById = vi.fn(
    async (...args: [ScopedTenantContext, string]) => {
      void args;
      return creds(config);
    },
  );
  const gateway = createDoitGateway({
    loadCredentials,
    loadCredentialsById,
    now: () => NOW,
  });
  return { gateway, loadCredentials, loadCredentialsById };
}

/** A DOIT payment object as the docs describe it. */
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_REF,
    status: "pending",
    amount: 50_000,
    rail: "qris",
    reference: REFERENCE,
    qr_content: "00020101021226610014ID.CO.DOIT.WWW0215ID1234567890123",
    va_number: null,
    va_bank: null,
    hosted_url: "https://pay.doit.id/p/pay_0001",
    return_url: null,
    provider: "pjp",
    provider_ref: "A48957157",
    fee_amount: 0,
    fee_payer: "merchant",
    total_amount: 50_000,
    expires_at: "2026-11-08T10:15:00.000Z",
    paid_at: null,
    metadata: null,
    created_at: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

const lookup = (gateway: ReturnType<typeof makeGateway>["gateway"]) =>
  gateway.lookupPayment({
    context: outletContext,
    outletId: OUTLET_ID,
    integrationId: INTEGRATION_ID,
    providerRef: PROVIDER_REF,
    reference: REFERENCE,
  });

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
}

async function expectCoreError(promise: Promise<unknown>, code: string) {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
  return error as CoreError;
}

function dump(error: unknown): string {
  return [
    String(error),
    (error as Error).message,
    (error as Error).stack ?? "",
    JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
  ].join("\n");
}

/** Captures logger and console output (same approach as payment-doit.test.ts). */
function captureOutput() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    for (const arg of args) {
      try {
        lines.push(
          typeof arg === "string"
            ? arg
            : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {})),
        );
      } catch {
        lines.push(String(arg));
      }
    }
  };
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const spyLevels = (target: Record<string, unknown>) => {
    for (const level of levels)
      if (typeof target[level] === "function")
        vi.spyOn(
          target as Record<string, (...a: unknown[]) => unknown>,
          level,
        ).mockImplementation((...args: unknown[]) => record(...args));
  };
  spyLevels(logger as unknown as Record<string, unknown>);
  const originalChild = logger.child.bind(logger);
  vi.spyOn(logger, "child").mockImplementation(((...args: unknown[]) => {
    record(...args);
    const child = (originalChild as (...a: unknown[]) => unknown)(...args);
    spyLevels(child as Record<string, unknown>);
    return child;
  }) as unknown as typeof logger.child);
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) =>
      record(...args),
    );
  return lines;
}

function getRoute(reply: (req: Recorded) => Reply) {
  route = (req) =>
    req.method === "GET" && req.path.startsWith("/v1/payments/")
      ? reply(req)
      : { status: 404 };
}

// --------------------------------------------------------------------------
// Wire mapping
// --------------------------------------------------------------------------

describe("doitPaymentToProviderStatus", () => {
  it.each([
    ["pending", "pending"],
    ["paid", "paid"],
    ["expired", "expired"],
    ["failed", "failed"],
    // Money went back: stays visible as refunded, not folded into pending.
    ["refunded", "refunded"],
  ] as const)("maps DOIT %s to %s", (doit, expected) => {
    expect(doitPaymentToProviderStatus(doit)).toBe(expected);
  });

  it.each([
    ["settled"],
    ["cancelled"],
    [""],
    ["PAID_"],
    [7],
    [null],
    [undefined],
  ])("refuses unknown status %j and never answers paid", (value) => {
    let result: unknown;
    let error: unknown;
    try {
      result = doitPaymentToProviderStatus(value as never);
    } catch (e) {
      error = e;
    }
    expect(result).not.toBe("paid");
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("doitPaymentToProviderResult", () => {
  it("answers the Legend reference and the DOIT id as provider reference", () => {
    expect(
      doitPaymentToProviderResult(payment({ status: "paid" }) as never),
    ).toEqual({
      reference: REFERENCE,
      providerReference: PROVIDER_REF,
      status: "paid",
    });
  });
});

// --------------------------------------------------------------------------
// gateway.lookupPayment
// --------------------------------------------------------------------------

describe("DOIT gateway: lookupPayment", () => {
  it("reads GET /v1/payments/{providerRef} with Bearer auth and no idempotency key", async () => {
    getRoute(() => ({ json: payment() }));
    const { gateway, loadCredentials, loadCredentialsById } = makeGateway();

    expect(await lookup(gateway)).toEqual({
      reference: REFERENCE,
      providerReference: PROVIDER_REF,
      status: "pending",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toBe(`/v1/payments/${PROVIDER_REF}`);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(loadCredentialsById.mock.calls[0]![1]).toBe(INTEGRATION_ID);
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "pending"],
    ["paid", "paid"],
    ["expired", "expired"],
    ["failed", "failed"],
    ["refunded", "refunded"],
  ] as const)("maps DOIT status %s to %s", async (doit, expected) => {
    getRoute(() => ({ json: payment({ status: doit }) }));
    const result = await lookup(makeGateway().gateway);
    expect(result.status).toBe(expected);
  });

  it.each([
    ["settled", "settled"],
    ["cancelled", "cancelled"],
    ["empty", ""],
    ["a number", 1],
    ["null", null],
    ["missing", undefined],
  ])(
    "refuses a DOIT status that is %s: SERVICE_UNAVAILABLE, never paid",
    async (_name, value) => {
      getRoute(() => ({ json: payment({ status: value }) }));
      const outcome = await caught(lookup(makeGateway().gateway));
      expect(outcome).toBeInstanceOf(CoreError);
      expect((outcome as CoreError).code).toBe("SERVICE_UNAVAILABLE");
    },
  );

  it("logs the failed validation with paths only, no values or body", async () => {
    const output = captureOutput();
    const LEAK = "LEAKY-STATUS-VALUE-77";
    getRoute(() => ({
      json: payment({ status: LEAK, hosted_url: BODY_MARKER }),
    }));

    const error = await caught(lookup(makeGateway().gateway));

    const logged = output.join("\n");
    expect(logged).toContain("DOIT answer failed validation");
    expect(logged).toContain("status");
    expect(logged).toContain(INTEGRATION_ID);
    for (const text of [logged, dump(error)]) {
      expect(text).not.toContain(LEAK);
      expect(text).not.toContain(BODY_MARKER);
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
  });

  it.each([
    ["a different id", { id: "pay_other" }],
    [
      "a different reference",
      { reference: "22222222-2222-4222-8222-222222222222" },
    ],
    ["no reference", { reference: null }],
  ])("rejects an answer with %s", async (_name, overrides) => {
    getRoute(() => ({ json: payment({ status: "paid", ...overrides }) }));
    await expectCoreError(lookup(makeGateway().gateway), "SERVICE_UNAVAILABLE");
  });

  it("encodes the provider reference in the path", async () => {
    getRoute((req) => ({
      json: payment({ id: decodeURIComponent(req.path.split("/").pop()!) }),
    }));
    await makeGateway().gateway.lookupPayment({
      context: outletContext,
      outletId: OUTLET_ID,
      integrationId: INTEGRATION_ID,
      providerRef: "pay/ 1?x=y",
      reference: REFERENCE,
    });
    expect(requests[0]!.path).toBe(
      `/v1/payments/${encodeURIComponent("pay/ 1?x=y")}`,
    );
  });

  it.each([[429], [500], [502], [503]])(
    "answers SERVICE_UNAVAILABLE on HTTP %i without leaking the body",
    async (status) => {
      const output = captureOutput();
      getRoute(() => ({ status, text: BODY_MARKER }));
      const error = await expectCoreError(
        lookup(makeGateway().gateway),
        "SERVICE_UNAVAILABLE",
      );
      for (const text of [dump(error), output.join("\n")]) {
        expect(text).not.toContain(BODY_MARKER);
        expect(text).not.toContain(API_KEY);
      }
    },
  );

  it("answers SERVICE_UNAVAILABLE on timeout after 10 seconds", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new Error("timeout")));
    getRoute(() => ({ hang: true }));
    await expectCoreError(lookup(makeGateway().gateway), "SERVICE_UNAVAILABLE");
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("answers SERVICE_UNAVAILABLE when the connection is refused", async () => {
    // A port nobody listens on: bind, read the port, close.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const { gateway } = makeGateway({
      baseUrl: `http://127.0.0.1:${closedPort}`,
    });
    await expectCoreError(lookup(gateway), "SERVICE_UNAVAILABLE");
  });
});

// --------------------------------------------------------------------------
// PaymentProvider.getPayment reader
// --------------------------------------------------------------------------

describe("createDoitPaymentReader: getPayment", () => {
  const input = {
    tenantId: TENANT_ID,
    outletId: OUTLET_ID,
    reference: REFERENCE,
  };

  function makeReader(
    resolved: {
      providerRef: string;
      integrationId: string | null;
      outletId: string;
    } | null = {
      providerRef: PROVIDER_REF,
      integrationId: INTEGRATION_ID,
      outletId: OUTLET_ID,
    },
  ) {
    const resolve = vi.fn(async (...args: unknown[]) => {
      void args;
      return resolved;
    });
    const { gateway, loadCredentials } = makeGateway();
    const reader = createDoitPaymentReader({
      gateway,
      resolve: resolve as never,
    });
    return { reader, resolve, loadCredentials };
  }

  it("resolves the Legend reference to the DOIT id and answers the provider result", async () => {
    getRoute(() => ({ json: payment({ status: "paid" }) }));
    const { reader, resolve } = makeReader();

    expect(await reader.getPayment(outletContext, input)).toEqual({
      reference: REFERENCE,
      providerReference: PROVIDER_REF,
      status: "paid",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(requests.map((r) => r.path)).toEqual([
      `/v1/payments/${PROVIDER_REF}`,
    ]);
  });

  it.each(["pending", "paid", "expired", "failed", "refunded"] as const)(
    "answers %s for a DOIT payment in that status",
    async (status) => {
      getRoute(() => ({ json: payment({ status }) }));
      const result = await makeReader().reader.getPayment(outletContext, input);
      expect(result.status).toBe(status);
    },
  );

  it("answers NOT_FOUND when the reference is unknown, without calling DOIT", async () => {
    const { reader } = makeReader(null);
    await expectCoreError(reader.getPayment(outletContext, input), "NOT_FOUND");
    expect(requests).toHaveLength(0);
  });

  it.each([[429], [500], [502]])(
    "passes DOIT HTTP %i through as SERVICE_UNAVAILABLE",
    async (status) => {
      getRoute(() => ({ status, text: BODY_MARKER }));
      await expectCoreError(
        makeReader().reader.getPayment(outletContext, input),
        "SERVICE_UNAVAILABLE",
      );
    },
  );

  it("answers SERVICE_UNAVAILABLE on timeout", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error("timeout")),
    );
    getRoute(() => ({ hang: true }));
    await expectCoreError(
      makeReader().reader.getPayment(outletContext, input),
      "SERVICE_UNAVAILABLE",
    );
  });

  it("refuses an unknown DOIT status instead of answering paid", async () => {
    getRoute(() => ({ json: payment({ status: "settled" }) }));
    await expectCoreError(
      makeReader().reader.getPayment(outletContext, input),
      "SERVICE_UNAVAILABLE",
    );
  });

  it.each([
    ["a different id", { id: "pay_other" }],
    [
      "a different reference",
      { reference: "22222222-2222-4222-8222-222222222222" },
    ],
  ])("rejects a DOIT answer with %s", async (_name, overrides) => {
    getRoute(() => ({ json: payment({ status: "paid", ...overrides }) }));
    await expectCoreError(
      makeReader().reader.getPayment(outletContext, input),
      "SERVICE_UNAVAILABLE",
    );
  });

  it("rejects a tenant that differs from the caller context before any lookup", async () => {
    getRoute(() => ({ json: payment({ status: "paid" }) }));
    const { reader, resolve } = makeReader();

    await expect(
      reader.getPayment(outletContext, { ...input, tenantId: OTHER_TENANT_ID }),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("answers NOT_FOUND when the resolver returns another outlet, without calling DOIT", async () => {
    getRoute(() => ({ json: payment({ status: "paid" }) }));
    const { reader } = makeReader({
      providerRef: PROVIDER_REF,
      integrationId: INTEGRATION_ID,
      outletId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
    });
    await expectCoreError(reader.getPayment(outletContext, input), "NOT_FOUND");
    expect(requests).toHaveLength(0);
  });

  it("refuses an outlet outside the caller scope before resolving", async () => {
    const { reader, resolve } = makeReader();
    await expectCoreError(
      reader.getPayment(outletContext, {
        ...input,
        outletId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e" as OutletId,
      }),
      "OUTLET_OUT_OF_SCOPE",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("falls back to the outlet credentials when the resolver has no integration id", async () => {
    getRoute(() => ({ json: payment({ status: "paid" }) }));
    const { reader, loadCredentials } = makeReader({
      providerRef: PROVIDER_REF,
      integrationId: null,
      outletId: OUTLET_ID,
    });
    const result = await reader.getPayment(outletContext, input);
    expect(result.status).toBe("paid");
    expect(loadCredentials).toHaveBeenCalledTimes(1);
    expect(loadCredentials.mock.calls[0]![1]).toBe(OUTLET_ID);
  });

  it.each([
    ["an empty reference", { reference: "" }],
    ["an unknown extra key", { extra: "x" }],
    ["a missing outlet", { outletId: undefined }],
  ])("rejects input with %s before any lookup", async (_name, patch) => {
    const { reader, resolve } = makeReader();
    await expect(
      reader.getPayment(outletContext, { ...input, ...patch } as never),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});
