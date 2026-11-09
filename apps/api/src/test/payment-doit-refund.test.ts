// DOIT refund adapter (bead legend-0ogy, WS-05, tingkat K uang). Black-box
// tests against docs/briefs/sub-doit-refund.md, potongan A: `createDoitGateway`
// also implements `PaymentRefundPort` (`refund`, `getRefundStatus`).
//
// DOIT is faked by a real `http.createServer` on 127.0.0.1 (same pattern as
// test/payment-doit.test.ts; http is allowed because NODE_ENV=test). Credentials
// come through the `loadCredentials` / `loadCredentialsById` options, so no
// database is needed.
//
// Assumptions where the brief is silent:
// - The `code` of a `failed` result for an HTTP rejection (409/400/502) is not
//   fixed by the brief; the tests only require a short non-empty string that
//   carries no provider text.
// - Throws are asserted as `CoreError` (any code), never as a specific code,
//   because the brief only says "CoreError tanpa teks provider".
// - With `integrationId: null` the adapter resolves credentials by outlet
//   (`loadCredentials(context, outletId)`), like `getStatus` does.
// - A refund object only has `id`, `status` and optionally `amount`; the status
//   words are compared as given (lower case).
// - `getRefundStatus` on a `refunded` payment whose `amount` differs from
//   `amountIdr` (a partial refund) is UNKNOWN (throw), as the brief says.
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
} from "@starter/shared/core";
import { logger } from "../lib/logger";
import { createDoitGateway } from "../services/payment-doit";
import type {
  GatewayRefundRequest,
  PaymentRefundPort,
} from "../services/payment-refund-gateway";

const API_KEY = "test-api-key-5f3a9c1e7b";
const WEBHOOK_SECRET = "test-webhook-secret-8d2e4a6c";
const INTEGRATION_ID = "5b0b3f7e-2f4a-4c0e-9a55-5d3c1a7e9f01";
const MINTING_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const MINTING_KEY = "minting-api-key-0003";
const OUTLET_ID = "0c4f1c8e-4d6b-4a3e-8f0a-1b2c3d4e5f60" as OutletId;
const TENANT_ID = "7a1e2d3c-4b5a-4968-8776-655443322110";
const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const REFUND_ID = "22222222-2222-4222-8222-222222222222";
const IDEM_KEY = `refund:${REFUND_ID}`;
const PAYMENT_REF = "pay_0001";
const AMOUNT = 50_000;
const REASON = "Pelanggan membatalkan pesanan REASON-TEXT-77b1";
// Marker the fake DOIT puts in every error body; it must never reach an error,
// a result or a log line (PAY-06).
const BODY_MARKER = "DOIT-ERROR-BODY-MARKER-91ac";

// --------------------------------------------------------------------------
// Fake DOIT server
// --------------------------------------------------------------------------

type Recorded = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};
type Reply = {
  status?: number;
  json?: unknown;
  text?: string;
  hang?: boolean;
};
type Route = (req: Recorded) => Reply;

let server: http.Server;
let baseUrl: string;
let requests: Recorded[] = [];
let route: Route = () => ({ status: 404 });
const sockets = new Set<import("node:net").Socket>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const reply = route(recorded);
      if (reply.hang) return; // never answers; the client must give up
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
const tenantContext: ScopedTenantContext = establishScopedTenantContext(
  tenant,
  { kind: "tenant" },
);

type Creds = {
  integration: {
    id: string;
    outletId: string | null;
    config: Record<string, unknown>;
  };
  credentials: Record<string, string>;
};

function creds(overrides: Partial<Creds> = {}): Creds {
  return {
    integration: {
      id: INTEGRATION_ID,
      outletId: null,
      config: { baseUrl },
    },
    credentials: { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET },
    ...overrides,
  };
}

function makeGateway(options: { creds?: Creds | null } = {}) {
  const loadCredentials = vi.fn(
    async (...args: [ScopedTenantContext, string | null]) => {
      void args;
      return options.creds === undefined ? creds() : options.creds;
    },
  );
  const loadCredentialsById = vi.fn(
    async (_context: ScopedTenantContext, id: string) =>
      options.creds === undefined
        ? creds({
            integration: { id, outletId: null, config: { baseUrl } },
            credentials: {
              apiKey: MINTING_KEY,
              webhookSecret: WEBHOOK_SECRET,
            },
          })
        : options.creds,
  );
  const gateway: PaymentRefundPort = createDoitGateway({
    loadCredentials,
    loadCredentialsById,
    now: () => new Date("2026-11-09T10:00:00.000Z"),
  });
  return { gateway, loadCredentials, loadCredentialsById };
}

function refundRequest(
  overrides: Partial<GatewayRefundRequest> = {},
): GatewayRefundRequest {
  return {
    context: tenantContext,
    refundId: REFUND_ID,
    idempotencyKey: IDEM_KEY,
    paymentIntentId: INTENT_ID,
    paymentProviderRef: PAYMENT_REF,
    amountIdr: AMOUNT,
    reason: REASON,
    integrationId: null,
    outletId: OUTLET_ID,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function statusRequest(
  overrides: Partial<Parameters<PaymentRefundPort["getRefundStatus"]>[0]> = {},
): Parameters<PaymentRefundPort["getRefundStatus"]>[0] {
  return {
    context: tenantContext,
    idempotencyKey: IDEM_KEY,
    providerRef: null,
    signal: new AbortController().signal,
    paymentIntentId: INTENT_ID,
    paymentProviderRef: PAYMENT_REF,
    integrationId: null,
    outletId: OUTLET_ID,
    amountIdr: AMOUNT,
    ...overrides,
  };
}

/** A DOIT payment object as the docs describe it. */
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_REF,
    status: "paid",
    amount: AMOUNT,
    rail: "qris",
    reference: INTENT_ID,
    qr_content: null,
    va_number: null,
    va_bank: null,
    hosted_url: "https://pay.doit.id/p/pay_0001",
    return_url: null,
    provider: "pjp",
    provider_ref: "A48957157",
    fee_amount: 0,
    fee_payer: "merchant",
    total_amount: AMOUNT,
    expires_at: "2026-11-08T10:15:00.000Z",
    paid_at: "2026-11-08T10:05:00.000Z",
    metadata: null,
    created_at: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

/** A refund object; its shape is not documented by DOIT (brief section A.4). */
function refundObject(overrides: Record<string, unknown> = {}) {
  return { id: "ref_0001", status: "succeeded", amount: AMOUNT, ...overrides };
}

const REFUND_PATH = `/v1/payments/${PAYMENT_REF}/refunds`;
const PAYMENT_PATH = `/v1/payments/${PAYMENT_REF}`;

function refundRoute(reply: Reply | ((req: Recorded) => Reply)): Route {
  return (req) => {
    if (req.method === "POST" && req.path === REFUND_PATH)
      return typeof reply === "function" ? reply(req) : reply;
    return { status: 404 };
  };
}

function paymentRoute(reply: Reply | ((req: Recorded) => Reply)): Route {
  return (req) => {
    if (req.method === "GET" && req.path === PAYMENT_PATH)
      return typeof reply === "function" ? reply(req) : reply;
    return { status: 404 };
  };
}

function errorBody(code: string | null, status: number): Reply {
  return {
    status,
    json: {
      error: {
        ...(code === null ? {} : { code }),
        message: BODY_MARKER,
        doc_url: "https://doit.id/docs/en/#errors",
      },
    },
  };
}

const posts = () => requests.filter((r) => r.method === "POST");

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
}

/** A throw means "outcome unknown": a CoreError that shows no provider text. */
async function expectUnknownOutcome(promise: Promise<unknown>) {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(CoreError);
  const text = dump(error);
  expect(text).not.toContain(BODY_MARKER);
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(WEBHOOK_SECRET);
  return error as CoreError;
}

/** Everything a thrown value can show to a caller or a log reader. */
function dump(error: unknown): string {
  const record = error as Record<string, unknown>;
  return [
    String(error),
    (error as Error).message,
    (error as Error).stack ?? "",
    JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    JSON.stringify(record.cause ?? null, (_k, v) =>
      v instanceof Error ? { message: v.message, stack: v.stack } : v,
    ),
  ].join("\n");
}

// Captures logger and console output of the adapter.
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

// --------------------------------------------------------------------------
// refund(): request shape
// --------------------------------------------------------------------------

describe("DOIT refund: request", () => {
  it("identifies itself as doit, the same provider as the payment gateway", () => {
    expect(makeGateway().gateway.provider).toBe("doit");
  });

  it("POSTs to the payment's refunds path with Bearer auth, the idempotency key and an explicit amount", async () => {
    route = refundRoute({ json: refundObject() });
    await makeGateway().gateway.refund(refundRequest());

    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe(REFUND_PATH);
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers["idempotency-key"]).toBe(IDEM_KEY);
    expect(sent.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(sent.body)).toEqual({ amount: AMOUNT, reason: REASON });
  });

  it("always sends the amount explicitly, also for a partial refund", async () => {
    route = refundRoute({ json: refundObject({ amount: 20_000 }) });
    await makeGateway().gateway.refund(refundRequest({ amountIdr: 20_000 }));

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.amount).toBe(20_000);
    expect(typeof body.amount).toBe("number");
  });

  it("cuts the reason to 255 characters", async () => {
    route = refundRoute({ json: refundObject() });
    const reason = "x".repeat(300);
    await makeGateway().gateway.refund(refundRequest({ reason }));

    const body = JSON.parse(requests[0]!.body) as { reason: string };
    expect(body.reason).toBe("x".repeat(255));
  });

  it("encodes the payment ref in the path", async () => {
    route = (req) =>
      req.method === "POST" &&
      req.path === "/v1/payments/pay_0001%2F..%2Fx%20y/refunds"
        ? { json: refundObject() }
        : { status: 404 };
    const result = await makeGateway().gateway.refund(
      refundRequest({ paymentProviderRef: "pay_0001/../x y" }),
    );
    expect(result.status).toBe("succeeded");
    expect(requests[0]!.path).toBe(
      "/v1/payments/pay_0001%2F..%2Fx%20y/refunds",
    );
  });

  it("sends the same idempotency key on a retry of the same refund", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway } = makeGateway();
    await gateway.refund(refundRequest());
    await gateway.refund(refundRequest());
    expect(requests.map((r) => r.headers["idempotency-key"])).toEqual([
      IDEM_KEY,
      IDEM_KEY,
    ]);
  });
});

// --------------------------------------------------------------------------
// refund(): credentials
// --------------------------------------------------------------------------

describe("DOIT refund: credentials", () => {
  it("uses the integration that minted the payment intent, not the outlet's current one", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway, loadCredentials, loadCredentialsById } = makeGateway();

    await gateway.refund(refundRequest({ integrationId: MINTING_ID }));

    expect(loadCredentialsById).toHaveBeenCalledWith(tenantContext, MINTING_ID);
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${MINTING_KEY}`);
  });

  it("without a minting integration (older intents) resolves by the refund's outlet", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway, loadCredentials, loadCredentialsById } = makeGateway();

    await gateway.refund(refundRequest({ integrationId: null }));

    expect(loadCredentials).toHaveBeenCalledWith(tenantContext, OUTLET_ID);
    expect(loadCredentialsById).not.toHaveBeenCalled();
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("throws SERVICE_UNAVAILABLE and sends nothing without an active integration", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway } = makeGateway({ creds: null });

    const error = await expectUnknownOutcome(gateway.refund(refundRequest()));
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    const byId = await expectUnknownOutcome(
      gateway.refund(refundRequest({ integrationId: MINTING_ID })),
    );
    expect(byId.code).toBe("SERVICE_UNAVAILABLE");
    expect(requests).toHaveLength(0);
  });

  it("throws SERVICE_UNAVAILABLE when the credentials lack the api key", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway } = makeGateway({
      creds: creds({ credentials: { webhookSecret: WEBHOOK_SECRET } }),
    });
    const error = await expectUnknownOutcome(gateway.refund(refundRequest()));
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(requests).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// refund(): 2xx responses
// --------------------------------------------------------------------------

describe("DOIT refund: 2xx responses", () => {
  it.each(["succeeded", "success", "completed", "refunded"])(
    "refund object with status %s is succeeded and keeps the refund id",
    async (status) => {
      route = refundRoute({ json: refundObject({ status }) });
      await expect(
        makeGateway().gateway.refund(refundRequest()),
      ).resolves.toEqual({ status: "succeeded", providerRef: "ref_0001" });
    },
  );

  it.each(["pending", "processing", "requested"])(
    "refund object with status %s is pending and keeps the refund id",
    async (status) => {
      route = refundRoute({ json: refundObject({ status }) });
      await expect(
        makeGateway().gateway.refund(refundRequest()),
      ).resolves.toEqual({ status: "pending", providerRef: "ref_0001" });
    },
  );

  it("refund object with status failed is a definitive failure DOIT_REFUND_FAILED", async () => {
    route = refundRoute({ json: refundObject({ status: "failed" }) });
    const result = await makeGateway().gateway.refund(refundRequest());
    expect(result).toMatchObject({
      status: "failed",
      code: "DOIT_REFUND_FAILED",
    });
  });

  it("accepts any 2xx status, for example 201 and 202", async () => {
    route = refundRoute({ status: 201, json: refundObject() });
    await expect(
      makeGateway().gateway.refund(refundRequest()),
    ).resolves.toEqual({
      status: "succeeded",
      providerRef: "ref_0001",
    });
    route = refundRoute({
      status: 202,
      json: refundObject({ status: "pending" }),
    });
    await expect(
      makeGateway().gateway.refund(refundRequest()),
    ).resolves.toEqual({
      status: "pending",
      providerRef: "ref_0001",
    });
  });

  it("a refund object without an amount field is accepted", async () => {
    route = refundRoute({
      json: refundObject({ amount: undefined, status: "pending" }),
    });
    await expect(
      makeGateway().gateway.refund(refundRequest()),
    ).resolves.toEqual({
      status: "pending",
      providerRef: "ref_0001",
    });
  });

  it("a refund object whose amount differs from the requested amount throws", async () => {
    route = refundRoute({ json: refundObject({ amount: 25_000 }) });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));

    route = refundRoute({
      json: refundObject({ amount: 25_000, status: "pending" }),
    });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));

    // A canonical integer string is read (the DOIT replay sends one, legend-0yd1),
    // so a different string amount or a non-canonical one is still unknown.
    route = refundRoute({
      json: refundObject({ amount: "25000", status: "succeeded" }),
    });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));

    route = refundRoute({
      json: refundObject({ amount: "50000.0", status: "succeeded" }),
    });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
  });

  it("a payment object that is refunded for exactly the amount is succeeded with the payment id", async () => {
    route = refundRoute({ json: payment({ status: "refunded" }) });
    await expect(
      makeGateway().gateway.refund(refundRequest()),
    ).resolves.toEqual({
      status: "succeeded",
      providerRef: PAYMENT_REF,
    });
  });

  it("a payment object of another intent (reference differs or is missing) throws", async () => {
    for (const body of [
      payment({
        status: "refunded",
        reference: "99999999-9999-4999-8999-999999999999",
      }),
      payment({ status: "refunded", reference: undefined }),
      payment({ status: "refunded", reference: 12 }),
    ]) {
      route = refundRoute({ json: body });
      await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    }
  });

  it("a payment object in any other state or with another amount throws", async () => {
    for (const body of [
      payment({ status: "paid" }),
      payment({ status: "pending" }),
      payment({ status: "expired" }),
      payment({ status: "refunded", amount: 40_000 }),
      payment({ status: "refunded", amount: undefined }),
    ]) {
      route = refundRoute({ json: body });
      await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    }
  });

  it("an unrecognised 2xx shape throws instead of guessing", async () => {
    const shapes: unknown[] = [
      {},
      [],
      null,
      "ok",
      42,
      { status: "succeeded" }, // no id
      { id: 7, status: "succeeded" }, // id not a string
      { id: "ref_0001" }, // no status
      { id: "ref_0001", status: "mystery" },
      { id: "ref_0001", status: 5 },
      { id: "ref_0001", status: "" },
      // id equals the payment id but it is no payment object (no reference)
      { id: PAYMENT_REF, status: "succeeded", amount: AMOUNT },
      { data: refundObject() },
    ];
    for (const json of shapes) {
      route = refundRoute({ status: 200, json });
      await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    }
  });

  it("a 2xx body that is not JSON or is empty throws", async () => {
    route = refundRoute({ text: "not json" });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    route = refundRoute({ text: "" });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    route = refundRoute({ text: '{"id":"ref_0001","status":"succ' });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
  });
});

// --------------------------------------------------------------------------
// refund(): definitive declines and unknown outcomes
// --------------------------------------------------------------------------

describe("DOIT refund: error responses", () => {
  it.each([
    [409, "payment_not_refundable"],
    [400, "invalid_refund_amount"],
    [502, "provider_refund_failed"],
  ])(
    "HTTP %i with code %s is a definitive failure that carries no provider text",
    async (status, code) => {
      route = refundRoute(errorBody(code, status));
      const result = await makeGateway().gateway.refund(refundRequest());

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.providerRef).toBeNull();
      expect(typeof result.code).toBe("string");
      expect(result.code.length).toBeGreaterThan(0);
      expect(result.code.length).toBeLessThanOrEqual(64);
      expect(JSON.stringify(result)).not.toContain(BODY_MARKER);
      expect(posts()).toHaveLength(1);
    },
  );

  it.each([
    ["502 without a code", errorBody(null, 502)],
    ["502 with an unrelated code", errorBody("internal_error", 502)],
    ["409 without a code", errorBody(null, 409)],
    [
      "409 with the code of another status",
      errorBody("provider_refund_failed", 409),
    ],
    ["400 without a code", errorBody(null, 400)],
    [
      "400 with the code of another status",
      errorBody("payment_not_refundable", 400),
    ],
    [
      "502 with the code of another status",
      errorBody("payment_not_refundable", 502),
    ],
    ["409 with an unknown code", errorBody("something_else", 409)],
    ["code in upper case", errorBody("PAYMENT_NOT_REFUNDABLE", 409)],
    ["code with a space", errorBody("payment_not_refundable ", 409)],
    ["code longer than 64 characters", errorBody("a".repeat(65), 409)],
    [
      "code that is not a string",
      {
        status: 409,
        json: { error: { code: 409, message: BODY_MARKER } },
      },
    ],
    ["404 payment_not_found", errorBody("payment_not_found", 404)],
    ["429 rate_limited", errorBody("rate_limited", 429)],
    ["500 internal_error", errorBody("internal_error", 500)],
    ["503 service_unavailable", errorBody("service_unavailable", 503)],
    ["401", errorBody("unauthorized", 401)],
    ["403", errorBody("forbidden", 403)],
    [
      "409 with a text body",
      { status: 409, text: `payment_not_refundable ${BODY_MARKER}` },
    ],
    ["409 with an empty body", { status: 409, text: "" }],
    [
      "409 with a broken JSON body",
      { status: 409, text: '{"error":{"code":"payment_not' },
    ],
    ["500 with a text body", { status: 500, text: BODY_MARKER }],
    ["3xx", { status: 302, text: BODY_MARKER }],
  ] as const)("%s throws (unknown outcome)", async (_name, reply) => {
    route = refundRoute(reply);
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
    // One attempt only: the adapter never re-sends on its own.
    expect(posts()).toHaveLength(1);
  });

  it.each([
    [409, errorBody(null, 409)],
    [409, errorBody("provider_refund_failed", 409)],
    [400, errorBody("payment_not_refundable", 400)],
    [502, { status: 502, text: BODY_MARKER }],
  ] as const)(
    "a non-decline HTTP %i throws with the code DOIT_HTTP_<status>",
    async (status, reply) => {
      route = refundRoute(reply);
      const error = await expectUnknownOutcome(
        makeGateway().gateway.refund(refundRequest()),
      );
      expect(error.code).toBe(`DOIT_HTTP_${status}`);
      expect(error.status).toBe(503);
    },
  );

  it("a connection that dies mid-request throws", async () => {
    const dead = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) =>
      dead.listen(0, "127.0.0.1", () => resolve()),
    );
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    try {
      const { gateway } = makeGateway({
        creds: creds({
          integration: {
            id: INTEGRATION_ID,
            outletId: null,
            config: { baseUrl: deadUrl },
          },
        }),
      });
      await expectUnknownOutcome(gateway.refund(refundRequest()));
    } finally {
      await new Promise<void>((resolve) => dead.close(() => resolve()));
    }
  });

  it("times out as an unknown outcome", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error("timeout")),
    );
    route = refundRoute({ hang: true });
    await expectUnknownOutcome(makeGateway().gateway.refund(refundRequest()));
  });

  it("an already aborted caller signal throws", async () => {
    route = refundRoute({ json: refundObject() });
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expectUnknownOutcome(
      makeGateway().gateway.refund(
        refundRequest({ signal: controller.signal }),
      ),
    );
  });

  it("aborting the caller signal while DOIT hangs throws", async () => {
    route = refundRoute({ hang: true });
    const controller = new AbortController();
    const pending = caught(
      makeGateway().gateway.refund(
        refundRequest({ signal: controller.signal }),
      ),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(new Error("deadline"));
    const error = await pending;
    expect(error).toBeInstanceOf(CoreError);
    expect(dump(error)).not.toContain(API_KEY);
  });
});

// --------------------------------------------------------------------------
// refund(): payment ref missing
// --------------------------------------------------------------------------

describe("DOIT refund: payment ref missing", () => {
  it("a null paymentProviderRef is an unknown outcome DOIT_PAYMENT_REF_MISSING (not a decline) and nothing is sent", async () => {
    route = refundRoute({ json: refundObject() });
    const { gateway } = makeGateway();

    const error = await expectUnknownOutcome(
      gateway.refund(refundRequest({ paymentProviderRef: null })),
    );

    expect(error.code).toBe("DOIT_PAYMENT_REF_MISSING");
    expect(requests).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// getRefundStatus(): never not_found, never refunds
// --------------------------------------------------------------------------

describe("DOIT refund status", () => {
  it("reads the payment with a GET carrying Bearer auth and no idempotency key", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    await makeGateway().gateway.getRefundStatus(statusRequest());

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toBe(PAYMENT_PATH);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("a refunded payment for exactly the amount is succeeded with the payment id when there is no refund ref", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    await expect(
      makeGateway().gateway.getRefundStatus(statusRequest()),
    ).resolves.toEqual({ status: "succeeded", providerRef: PAYMENT_REF });
  });

  it("keeps the refund's own provider ref when there is one", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    await expect(
      makeGateway().gateway.getRefundStatus(
        statusRequest({ providerRef: "ref_0001" }),
      ),
    ).resolves.toEqual({ status: "succeeded", providerRef: "ref_0001" });
  });

  it("a provider ref that is the payment id still reads the payment", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    await expect(
      makeGateway().gateway.getRefundStatus(
        statusRequest({ providerRef: PAYMENT_REF }),
      ),
    ).resolves.toEqual({ status: "succeeded", providerRef: PAYMENT_REF });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${PAYMENT_PATH}`,
    ]);
  });

  it("a held refund ref on a payment DOIT still shows as paid is pending, with the refund's own ref", async () => {
    route = paymentRoute({ json: payment({ status: "paid" }) });
    await expect(
      makeGateway().gateway.getRefundStatus(
        statusRequest({ providerRef: "ref_0001" }),
      ),
    ).resolves.toEqual({ status: "pending", providerRef: "ref_0001" });
    expect(posts()).toHaveLength(0);
  });

  it("a paid payment is still unknown without a refund ref, or when the ref is the payment id, or for another payment", async () => {
    const cases: Array<
      [
        string,
        Record<string, unknown>,
        Partial<ReturnType<typeof statusRequest>>,
      ]
    > = [
      ["no refund ref", payment({ status: "paid" }), {}],
      [
        "ref is the payment id",
        payment({ status: "paid" }),
        { providerRef: PAYMENT_REF },
      ],
      [
        "other reference",
        payment({
          status: "paid",
          reference: "99999999-9999-4999-8999-999999999999",
        }),
        { providerRef: "ref_0001" },
      ],
      [
        "other payment id",
        payment({ status: "paid", id: "pay_other" }),
        { providerRef: "ref_0001" },
      ],
      [
        "pending payment",
        payment({ status: "pending" }),
        { providerRef: "ref_0001" },
      ],
    ];
    for (const [name, body, overrides] of cases) {
      requests = [];
      route = paymentRoute({ json: body });
      const error = await caught(
        makeGateway().gateway.getRefundStatus(statusRequest(overrides)),
      );
      expect(error, name).toBeInstanceOf(CoreError);
      expect(posts(), name).toHaveLength(0);
    }
  });

  it("never answers not_found and never sends a refund: every non-refunded situation throws", async () => {
    const cases: Array<
      [string, Reply, Partial<ReturnType<typeof statusRequest>>]
    > = [
      ["paid", { json: payment({ status: "paid" }) }, {}],
      ["pending", { json: payment({ status: "pending" }) }, {}],
      ["expired", { json: payment({ status: "expired" }) }, {}],
      [
        "partially refunded: other amount",
        { json: payment({ status: "refunded", amount: 20_000 }) },
        {},
      ],
      [
        "refunded without amount",
        { json: payment({ status: "refunded", amount: undefined }) },
        {},
      ],
      [
        "refunded, smaller request",
        { json: payment({ status: "refunded" }) },
        { amountIdr: 20_000 },
      ],
      ["404 payment_not_found", errorBody("payment_not_found", 404), {}],
      ["404 empty", { status: 404, text: "" }, {}],
      ["429", errorBody("rate_limited", 429), {}],
      ["500", errorBody("internal_error", 500), {}],
      ["503", errorBody("service_unavailable", 503), {}],
      ["broken JSON", { text: "not json" }, {}],
      ["empty body", { text: "" }, {}],
      ["array body", { json: [] }, {}],
      ["null body", { json: null }, {}],
      [
        "other payment id",
        { json: payment({ id: "pay_other", status: "refunded" }) },
        {},
      ],
      [
        "other reference",
        {
          json: payment({
            status: "refunded",
            reference: "99999999-9999-4999-8999-999999999999",
          }),
        },
        {},
      ],
      [
        "no reference",
        { json: payment({ status: "refunded", reference: undefined }) },
        {},
      ],
    ];
    for (const [name, reply, overrides] of cases) {
      requests = [];
      route = paymentRoute(reply);
      const outcome = await makeGateway()
        .gateway.getRefundStatus(statusRequest(overrides))
        .then(
          (value) => ({ value }) as const,
          (error: unknown) => ({ error }) as const,
        );
      expect(
        "error" in outcome,
        `${name}: expected a throw, got ${JSON.stringify((outcome as { value?: unknown }).value)}`,
      ).toBe(true);
      if ("error" in outcome) {
        expect(outcome.error, name).toBeInstanceOf(CoreError);
        expect(dump(outcome.error), name).not.toContain(BODY_MARKER);
      }
      expect(posts(), name).toHaveLength(0);
    }
  });

  it("a null paymentProviderRef throws and sends nothing", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    const result = await makeGateway()
      .gateway.getRefundStatus(statusRequest({ paymentProviderRef: null }))
      .then(
        (value) => ({ value }) as const,
        (error: unknown) => ({ error }) as const,
      );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toBeInstanceOf(CoreError);
    expect(requests).toHaveLength(0);
  });

  it("uses the integration that minted the intent", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    const { gateway, loadCredentials, loadCredentialsById } = makeGateway();

    await gateway.getRefundStatus(statusRequest({ integrationId: MINTING_ID }));

    expect(loadCredentialsById).toHaveBeenCalledWith(tenantContext, MINTING_ID);
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${MINTING_KEY}`);
  });

  it("without a minting integration resolves by outlet; without any integration throws SERVICE_UNAVAILABLE", async () => {
    route = paymentRoute({ json: payment({ status: "refunded" }) });
    const first = makeGateway();
    await first.gateway.getRefundStatus(statusRequest());
    expect(first.loadCredentials).toHaveBeenCalledWith(
      tenantContext,
      OUTLET_ID,
    );

    requests = [];
    const none = makeGateway({ creds: null });
    const error = await expectUnknownOutcome(
      none.gateway.getRefundStatus(statusRequest()),
    );
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(requests).toHaveLength(0);
  });

  it("times out as an unknown outcome", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error("timeout")),
    );
    route = paymentRoute({ hang: true });
    await expectUnknownOutcome(
      makeGateway().gateway.getRefundStatus(statusRequest()),
    );
  });

  it("aborting the caller signal while DOIT hangs throws", async () => {
    route = paymentRoute({ hang: true });
    const controller = new AbortController();
    const pending = caught(
      makeGateway().gateway.getRefundStatus(
        statusRequest({ signal: controller.signal }),
      ),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(new Error("deadline"));
    expect(await pending).toBeInstanceOf(CoreError);
  });
});

// --------------------------------------------------------------------------
// PAY-06: no body, header, key or secret in errors or logs
// --------------------------------------------------------------------------

describe("DOIT refund: secrets never leak (PAY-06)", () => {
  const failures: Array<[string, Reply]> = [
    ["409 not refundable", errorBody("payment_not_refundable", 409)],
    ["502 declined", errorBody("provider_refund_failed", 502)],
    ["502 without code", errorBody(null, 502)],
    ["429", errorBody("rate_limited", 429)],
    ["500", errorBody("internal_error", 500)],
    ["503", errorBody("service_unavailable", 503)],
    ["404", errorBody("payment_not_found", 404)],
    ["text body", { status: 500, text: `${BODY_MARKER} ${API_KEY}` }],
    [
      "2xx with a body that is not understood",
      {
        json: { id: "ref_0001", status: "mystery", note: BODY_MARKER },
      },
    ],
  ];

  function expectClean(text: string) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain(IDEM_KEY);
    expect(text).not.toContain(REFUND_ID);
    expect(text).not.toContain("REASON-TEXT-77b1");
    expect(text.toLowerCase()).not.toContain("bearer ");
  }

  it("refund(): neither the results, the errors nor the logs show a provider body, header, key or secret", async () => {
    const lines = captureOutput();
    for (const [, reply] of failures) {
      route = refundRoute(reply);
      const outcome = await makeGateway()
        .gateway.refund(refundRequest())
        .then(
          (value) => JSON.stringify(value),
          (error: unknown) => dump(error),
        );
      expectClean(outcome);
    }
    expectClean(lines.join("\n"));
  });

  it("refund(): a timeout whose reason carries the api key does not leak it", async () => {
    const lines = captureOutput();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error(`timeout ${API_KEY} ${IDEM_KEY}`)),
    );
    route = refundRoute({ hang: true });
    const error = await caught(makeGateway().gateway.refund(refundRequest()));
    expectClean(dump(error));
    expectClean(lines.join("\n"));
  });

  it("refund(): a caller abort whose reason carries the api key does not leak it", async () => {
    const lines = captureOutput();
    const controller = new AbortController();
    controller.abort(new Error(`aborted ${API_KEY} ${IDEM_KEY}`));
    route = refundRoute({ json: refundObject() });
    const error = await caught(
      makeGateway().gateway.refund(
        refundRequest({ signal: controller.signal }),
      ),
    );
    expectClean(dump(error));
    expectClean(lines.join("\n"));
  });

  it("getRefundStatus(): neither the errors nor the logs show a provider body, header, key or secret", async () => {
    const lines = captureOutput();
    for (const [, reply] of failures) {
      route = paymentRoute(reply);
      const outcome = await makeGateway()
        .gateway.getRefundStatus(statusRequest())
        .then(
          (value) => JSON.stringify(value),
          (error: unknown) => dump(error),
        );
      expectClean(outcome);
    }
    expectClean(lines.join("\n"));
  });

  it("the only provider detail that may be logged is a short lower-case DOIT error code", async () => {
    const lines = captureOutput();
    route = refundRoute(errorBody("payment_not_refundable", 409));
    await makeGateway().gateway.refund(refundRequest());
    route = refundRoute(errorBody("internal_error", 500));
    await caught(makeGateway().gateway.refund(refundRequest()));

    const logged = lines.join("\n");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain("doc_url");
    expect(logged).not.toContain("doit.id/docs");
  });
});
