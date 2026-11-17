// DOIT PaymentProvider adapter (bead legend-b9i, S5 test F; PRD v1.7 §3 F13,
// PAY-02/03/06). Black-box tests against the S2 contract in
// docs/briefs/sub-doit-provider.md.
//
// DOIT is faked by a real `http.createServer` on 127.0.0.1 (a random port,
// http is allowed because NODE_ENV=test). Credentials come through the
// `loadCredentials` option, so no database is needed.
//
// The fake server speaks the wire format of the official DOIT docs
// (https://doit.id/docs/en/): GET /v1/methods, POST /v1/payments and
// GET /v1/payments/{id}, payment objects without a paid amount. Change the
// `payment()` helpers here together with payment-doit-wire.ts.
//
// Assumptions where the brief is silent:
// - `signDoitWebhook` returns the full header string `t=<unix>,v1=<hex>`.
// - "healthy" in the brief is `available` in the shared PaymentGatewayStatus.
// - The methods cache TTL is driven by the injected `now` option.
// - Logger output is observed by spying on the shared pino `logger` (and its
//   children) plus `console.*`.
import { createHmac } from "node:crypto";
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
import { paymentInstructionsSchema } from "@starter/shared/payment";
import { logger } from "../lib/logger";
import {
  createDoitGateway,
  isBlockedAddress,
  parseDoitBaseUrl,
} from "../services/payment-doit";
import {
  DOIT_BASE_URL,
  doitWebhookEnvelopeSchema,
  doitWebhookEventSchema,
  isDoitPaymentEvent,
  signDoitWebhook,
  verifyDoitSignature,
} from "../services/payment-doit-wire";

const API_KEY = "test-api-key-5f3a9c1e7b";
const WEBHOOK_SECRET = "test-webhook-secret-8d2e4a6c";
const INTEGRATION_ID = "5b0b3f7e-2f4a-4c0e-9a55-5d3c1a7e9f01";
const OUTLET_ID = "0c4f1c8e-4d6b-4a3e-8f0a-1b2c3d4e5f60" as OutletId;
const TENANT_ID = "7a1e2d3c-4b5a-4968-8776-655443322110";
// Default clock of the gateway under test: 15 minutes before the intent
// expiry used by `intentRequest()`.
const NOW = new Date("2026-11-08T10:00:00.000Z");
// Marker the fake DOIT puts in every error body; it must never reach an error
// or a log line (PAY-06).
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
      if (reply.hang) return; // never answers; the client must time out
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
const outletContext: ScopedTenantContext = establishScopedTenantContext(
  tenant,
  { kind: "outlets", outletIds: [OUTLET_ID] },
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

function makeGateway(
  options: {
    creds?: Creds | null;
    now?: () => Date;
  } = {},
) {
  const loadCredentials = vi.fn(
    async (...args: [ScopedTenantContext, string | null]) => {
      void args;
      return options.creds === undefined ? creds() : options.creds;
    },
  );
  const gateway = createDoitGateway({
    loadCredentials,
    now: options.now ?? (() => NOW),
  });
  return { gateway, loadCredentials };
}

type PaymentOverrides = Record<string, unknown>;

/** A DOIT payment object as the docs describe it (no paid amount). */
function payment(overrides: PaymentOverrides = {}) {
  return {
    id: "pay_0001",
    status: "pending",
    amount: 50_000,
    rail: null,
    reference: "11111111-1111-4111-8111-111111111111",
    qr_content: null,
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

const qrisPayment = (overrides: PaymentOverrides = {}) =>
  payment({
    rail: "qris",
    qr_content: "00020101021226610014ID.CO.DOIT.WWW0215ID1234567890123",
    ...overrides,
  });

const vaPayment = (overrides: PaymentOverrides = {}) =>
  payment({
    rail: "va",
    va_number: "8808123456789012",
    va_bank: "bmri",
    ...overrides,
  });

/** Bank transfer (Account Mutation): total_amount adds a unique code. */
const transferPayment = (overrides: PaymentOverrides = {}) =>
  payment({
    rail: "transfer",
    va_bank: "bca",
    total_amount: 50_417,
    ...overrides,
  });

function intentRequest(
  overrides: Partial<
    Parameters<ReturnType<typeof makeGateway>["gateway"]["createIntent"]>[0]
  > = {},
) {
  return {
    context: tenantContext,
    provider: "doit",
    intentId: "11111111-1111-4111-8111-111111111111",
    method: "qris" as const,
    channelCode: null,
    amountIdr: 50_000,
    idempotencyKey: "idem-key-0001-abcdefghij",
    expiresAt: "2026-11-08T10:15:00.000Z",
    ...overrides,
  };
}

function methodRow(
  code: string,
  label: string,
  rail: string,
  bank: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    code,
    label,
    rail,
    bank,
    fee_flat: 0,
    fee_pct: 0,
    fee_payer: "merchant",
    min_amount: null,
    max_amount: null,
    fee_amount: 0,
    total_amount: null,
    within_limits: true,
    limit: null,
    ...overrides,
  };
}

const METHODS_REPLY = {
  environment: "sandbox",
  amount: null,
  data: [
    methodRow("qris", "QRIS", "qris", null),
    methodRow("va_bmri", "Mandiri Virtual Account", "va", "bmri"),
    methodRow("va_bnia", "BNI Virtual Account", "va", "bnia"),
    // BCA VA is not served by DOIT: ignored even if listed.
    methodRow("va_bca", "BCA Virtual Account", "va", "bca"),
    methodRow("transfer_bca", "BCA Bank Transfer", "transfer", "bca"),
    methodRow("crypto_btc", "Bitcoin", "crypto", "btc"),
  ],
};

const MANDIRI = { code: "bmri", name: "Mandiri Virtual Account" };
const BNI = { code: "bnia", name: "BNI Virtual Account" };

function methodsAndPayments(handlers: {
  methods?: Reply;
  create?: (req: Recorded) => Reply;
  get?: (req: Recorded) => Reply;
}): Route {
  return (req) => {
    if (req.method === "GET" && req.path === "/v1/methods")
      return handlers.methods ?? { json: METHODS_REPLY };
    if (req.method === "POST" && req.path === "/v1/payments")
      return handlers.create?.(req) ?? { status: 404 };
    if (req.method === "GET" && req.path.startsWith("/v1/payments/"))
      return handlers.get?.(req) ?? { status: 404 };
    return { status: 404 };
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

async function expectCoreError(promise: Promise<unknown>, code: string) {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
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

function expectNoSecrets(text: string) {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(WEBHOOK_SECRET);
  expect(text).not.toContain(BODY_MARKER);
}

// --------------------------------------------------------------------------
// methods / channels / health
// --------------------------------------------------------------------------

describe("DOIT adapter: payment methods", () => {
  it("identifies itself as doit", () => {
    expect(makeGateway().gateway.provider).toBe("doit");
  });

  it("maps the provider list by rail: VA banks grouped, unknown rails and banks ignored", async () => {
    route = methodsAndPayments({});
    const { gateway } = makeGateway();

    const methods = await gateway.methods!(tenantContext);

    const byMethod = new Map(methods.map((m) => [m.method as string, m]));
    expect(byMethod.get("qris")).toMatchObject({ enabled: true, channels: [] });
    expect(byMethod.get("va")).toMatchObject({ enabled: true });
    expect(byMethod.get("va")!.channels).toEqual([MANDIRI, BNI]);
    // The payment object carries no transfer account: never offered.
    expect(byMethod.get("bank_transfer")).toEqual({
      method: "bank_transfer",
      enabled: false,
      channels: [],
    });
    expect(byMethod.has("crypto")).toBe(false);
    // DOIT has no e-wallet or card rail.
    expect(byMethod.has("ewallet")).toBe(false);
    expect(byMethod.has("card")).toBe(false);
  });

  it("reads the documented methods endpoint", async () => {
    route = methodsAndPayments({});
    await makeGateway().gateway.methods!(tenantContext);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/methods",
    ]);
  });

  it("disables a row outside its amount limits", async () => {
    route = methodsAndPayments({
      methods: {
        json: {
          ...METHODS_REPLY,
          data: [
            methodRow("qris", "QRIS", "qris", null, {
              within_limits: false,
              limit: "max_amount",
            }),
            methodRow("va_bmri", "Mandiri Virtual Account", "va", "bmri", {
              within_limits: false,
            }),
            methodRow("va_bnia", "BNI Virtual Account", "va", "bnia"),
          ],
        },
      },
    });
    const methods = await makeGateway().gateway.methods!(tenantContext);
    expect(methods).toEqual([
      { method: "qris", enabled: false, channels: [] },
      { method: "va", enabled: true, channels: [BNI] },
    ]);
  });

  it("sends Bearer auth, JSON accept and no idempotency key on GET", async () => {
    route = methodsAndPayments({});
    await makeGateway().gateway.methods!(tenantContext);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]!.headers.accept).toContain("application/json");
    expect(requests[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("lists channels per online method and none for qris", async () => {
    route = methodsAndPayments({});
    const { gateway } = makeGateway();

    expect(await gateway.channels(tenantContext, "va")).toEqual([MANDIRI, BNI]);
    expect(await gateway.channels(tenantContext, "bank_transfer")).toEqual([]);
    expect(await gateway.channels(tenantContext, "qris")).toEqual([]);
  });

  it("caches the list per integration for 60 seconds", async () => {
    route = methodsAndPayments({});
    let clock = new Date("2026-11-08T10:00:00.000Z");
    const { gateway } = makeGateway({ now: () => clock });

    await gateway.methods!(tenantContext);
    await gateway.methods!(tenantContext);
    await gateway.channels(tenantContext, "va");
    expect(requests).toHaveLength(1);

    clock = new Date(clock.getTime() + 59_000);
    await gateway.methods!(tenantContext);
    expect(requests).toHaveLength(1);

    clock = new Date(clock.getTime() + 2_000); // 61 s after the first read
    await gateway.methods!(tenantContext);
    expect(requests).toHaveLength(2);
  });

  it("keeps a separate cache per integration", async () => {
    route = methodsAndPayments({});
    const other = creds({
      integration: {
        id: "9e1f2a3b-4c5d-4e6f-8a7b-0c1d2e3f4a5b",
        outletId: OUTLET_ID,
        config: { baseUrl },
      },
    });
    const loadCredentials = vi.fn(
      async (_context: ScopedTenantContext, outletId: string | null) =>
        outletId === OUTLET_ID ? other : creds(),
    );
    const gateway = createDoitGateway({ loadCredentials });

    await gateway.methods!(tenantContext);
    await gateway.methods!(outletContext);
    expect(requests).toHaveLength(2);
    await gateway.methods!(tenantContext);
    await gateway.methods!(outletContext);
    expect(requests).toHaveLength(2);
  });

  it("uses the outlet id of an outlet-scoped context to load credentials", async () => {
    route = methodsAndPayments({
      create: () => ({ json: qrisPayment() }),
    });
    const { gateway, loadCredentials } = makeGateway();

    await gateway.createIntent(intentRequest({ context: outletContext }));
    expect(loadCredentials).toHaveBeenCalledWith(outletContext, OUTLET_ID);

    loadCredentials.mockClear();
    await gateway.createIntent(intentRequest({ context: tenantContext }));
    expect(loadCredentials).toHaveBeenCalledWith(tenantContext, null);
  });

  describe("tenant-scoped caller with a per-outlet integration (QR order)", () => {
    const OUTLET_KEY = "outlet-api-key-0002";
    const outletCreds = () =>
      creds({
        integration: {
          id: "9e1f2a3b-4c5d-4e6f-8a7b-0c1d2e3f4a5b",
          outletId: OUTLET_ID,
          config: { baseUrl },
        },
        credentials: { apiKey: OUTLET_KEY, webhookSecret: WEBHOOK_SECRET },
      });
    const makeLoader = () =>
      vi.fn(async (_context: ScopedTenantContext, outletId: string | null) =>
        outletId === OUTLET_ID ? outletCreds() : creds(),
      );

    it("creates the intent with the bill's outlet credentials, not the tenant's", async () => {
      route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
      const loadCredentials = makeLoader();
      const gateway = createDoitGateway({ loadCredentials });

      await gateway.createIntent(
        intentRequest({ context: tenantContext, outletId: OUTLET_ID }),
      );

      expect(loadCredentials).toHaveBeenCalledWith(tenantContext, OUTLET_ID);
      expect(loadCredentials).not.toHaveBeenCalledWith(tenantContext, null);
      expect(posts()).toHaveLength(1);
      expect(posts()[0]!.headers.authorization).toBe(`Bearer ${OUTLET_KEY}`);
    });

    it("reads the status with the bill's outlet credentials", async () => {
      route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
      const loadCredentials = makeLoader();
      const gateway = createDoitGateway({ loadCredentials });

      await gateway.getStatus({
        context: tenantContext,
        outletId: OUTLET_ID,
        providerRef: "pay_0001",
      });

      expect(loadCredentials).toHaveBeenCalledWith(tenantContext, OUTLET_ID);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${OUTLET_KEY}`);
    });

    it("uses the outlet credentials for health, methods and channels", async () => {
      route = methodsAndPayments({});
      const loadCredentials = makeLoader();
      const gateway = createDoitGateway({ loadCredentials });

      expect(await gateway.health(tenantContext, OUTLET_ID)).toEqual({
        status: "available",
      });
      await gateway.methods!(tenantContext, OUTLET_ID);
      await gateway.channels(tenantContext, "va", OUTLET_ID);

      expect(loadCredentials).toHaveBeenCalledTimes(3);
      for (const call of loadCredentials.mock.calls)
        expect(call[1]).toBe(OUTLET_ID);
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${OUTLET_KEY}`);
    });

    it("prefers the explicit outlet over the context's single outlet", async () => {
      route = methodsAndPayments({});
      const { gateway, loadCredentials } = makeGateway();
      const otherOutlet = "5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

      await gateway.health(outletContext, otherOutlet);

      expect(loadCredentials).toHaveBeenCalledWith(outletContext, otherOutlet);
    });
  });

  describe("the integration that minted a payment is remembered", () => {
    const MINTING_KEY = "minting-api-key-0003";
    const MINTING_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

    it("createIntent reports the integration whose credentials it used", async () => {
      route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
      const intent = await makeGateway().gateway.createIntent(intentRequest());
      expect(intent.integrationId).toBe(INTEGRATION_ID);
    });

    it("getStatus with an integration id loads that row, not the outlet's current one", async () => {
      route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
      const loadCredentials = vi.fn(async () => creds());
      const loadCredentialsById = vi.fn(
        async (_context: ScopedTenantContext, id: string) =>
          creds({
            integration: { id, outletId: null, config: { baseUrl } },
            credentials: {
              apiKey: MINTING_KEY,
              webhookSecret: WEBHOOK_SECRET,
            },
          }),
      );
      const gateway = createDoitGateway({
        loadCredentials,
        loadCredentialsById,
        now: () => NOW,
      });

      await gateway.getStatus({
        context: tenantContext,
        outletId: OUTLET_ID,
        integrationId: MINTING_ID,
        providerRef: "pay_0001",
      });

      expect(loadCredentialsById).toHaveBeenCalledWith(
        tenantContext,
        MINTING_ID,
      );
      expect(loadCredentials).not.toHaveBeenCalled();
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${MINTING_KEY}`);
    });

    it("getStatus without an integration id (older intents) resolves by outlet", async () => {
      route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
      const loadCredentialsById = vi.fn(async () => creds());
      const { loadCredentials } = makeGateway();
      const gateway = createDoitGateway({
        loadCredentials,
        loadCredentialsById,
        now: () => NOW,
      });

      await gateway.getStatus({
        context: tenantContext,
        outletId: OUTLET_ID,
        integrationId: null,
        providerRef: "pay_0001",
      });

      expect(loadCredentials).toHaveBeenCalledWith(tenantContext, OUTLET_ID);
      expect(loadCredentialsById).not.toHaveBeenCalled();
    });

    it("a minting row that is gone fails closed (503)", async () => {
      route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
      const gateway = createDoitGateway({
        loadCredentials: async () => creds(),
        loadCredentialsById: async () => null,
        now: () => NOW,
      });
      await expect(
        gateway.getStatus({
          context: tenantContext,
          integrationId: MINTING_ID,
          providerRef: "pay_0001",
        }),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(requests).toHaveLength(0);
    });
  });
});

describe("DOIT adapter: health", () => {
  it("is available when the methods endpoint answers", async () => {
    route = methodsAndPayments({});
    expect(await makeGateway().gateway.health(tenantContext)).toEqual({
      status: "available",
    });
  });

  it.each([401, 500, 503])("is down when DOIT answers %i", async (status) => {
    route = () => ({ status, text: BODY_MARKER });
    expect(await makeGateway().gateway.health(tenantContext)).toEqual({
      status: "down",
    });
  });

  it("is down when the answer is malformed", async () => {
    route = () => ({ json: { data: "nope" } });
    expect(await makeGateway().gateway.health(tenantContext)).toEqual({
      status: "down",
    });
  });

  it("is down when DOIT is unreachable", async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) =>
      dead.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const { gateway } = makeGateway({
      creds: creds({
        integration: {
          id: INTEGRATION_ID,
          outletId: null,
          config: { baseUrl: `http://127.0.0.1:${port}` },
        },
      }),
    });
    expect(await gateway.health(tenantContext)).toEqual({ status: "down" });
  });

  it("is down when the request times out after 10 seconds", async () => {
    // Shorten the real timer; assert the adapter asked for 10 s.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new Error("timeout")));
    route = () => ({ hang: true });

    expect(await makeGateway().gateway.health(tenantContext)).toEqual({
      status: "down",
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});

describe("DOIT adapter: fails closed without usable credentials", () => {
  const cases: Array<[string, Creds | null]> = [
    ["no integration row", null],
    [
      "missing apiKey",
      creds({ credentials: { webhookSecret: WEBHOOK_SECRET } }),
    ],
    ["missing webhookSecret", creds({ credentials: { apiKey: API_KEY } })],
    [
      "empty apiKey",
      creds({ credentials: { apiKey: "", webhookSecret: WEBHOOK_SECRET } }),
    ],
    [
      "baseUrl that is not a url",
      creds({
        integration: {
          id: INTEGRATION_ID,
          outletId: null,
          config: { baseUrl: "not a url" },
        },
      }),
    ],
    [
      "baseUrl with a non-http scheme",
      creds({
        integration: {
          id: INTEGRATION_ID,
          outletId: null,
          config: { baseUrl: "ftp://127.0.0.1/doit" },
        },
      }),
    ],
  ];

  it.each(cases)(
    "%s: health down, create and status 503, no HTTP",
    async (_name, value) => {
      route = methodsAndPayments({
        create: () => ({ json: qrisPayment() }),
        get: () => ({ json: qrisPayment() }),
      });
      const { gateway } = makeGateway({ creds: value });

      expect(await gateway.health(tenantContext)).toEqual({
        status: "down",
        reason: "unconfigured",
      });
      await expectCoreError(
        gateway.createIntent(intentRequest()),
        "SERVICE_UNAVAILABLE",
      );
      await expectCoreError(
        gateway.getStatus({ context: tenantContext, providerRef: "pay_0001" }),
        "SERVICE_UNAVAILABLE",
      );
      expect(requests).toHaveLength(0);
    },
  );
});

describe("DOIT adapter: base URL", () => {
  it.each([
    ["no override", {}],
    ["a null override", { baseUrl: null }],
  ])("calls %s at https://pay.doit.id", async (_name, config) => {
    const fetchSpy = vi.fn(async (url: string) => {
      void url;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const gateway = createDoitGateway({
      fetch: fetchSpy as unknown as typeof fetch,
      loadCredentials: async () =>
        creds({ integration: { id: INTEGRATION_ID, outletId: null, config } }),
    });

    expect(await gateway.health(tenantContext)).toEqual({
      status: "available",
    });
    expect(DOIT_BASE_URL).toBe("https://pay.doit.id");
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://pay.doit.id/v1/methods",
    );
  });
});

// --------------------------------------------------------------------------
// createIntent
// --------------------------------------------------------------------------

describe("DOIT adapter: createIntent", () => {
  it("creates a QRIS payment and returns the QR payload", async () => {
    route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
    const { gateway } = makeGateway();

    const intent = await gateway.createIntent(intentRequest());

    expect(intent.providerRef).toBe("pay_0001");
    expect(intent.instructions).toEqual({
      method: "qris",
      qrPayload: "00020101021226610014ID.CO.DOIT.WWW0215ID1234567890123",
      issuer: null,
    });
    expect(
      paymentInstructionsSchema.safeParse(intent.instructions).success,
    ).toBe(true);
    expect(new Date(intent.expiresAt).toISOString()).toBe(
      "2026-11-08T10:15:00.000Z",
    );
  });

  it("sends the documented request body", async () => {
    route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
    await makeGateway().gateway.createIntent(intentRequest());

    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.path).toBe("/v1/payments");
    expect(post.headers["content-type"]).toContain("application/json");
    expect(post.headers.accept).toContain("application/json");
    // Whole rupiah, rail, our reference and a lifetime in seconds; never
    // method/channel_code/expires_at/currency.
    expect(JSON.parse(post.body)).toEqual({
      amount: 50_000,
      rail: "qris",
      reference: "11111111-1111-4111-8111-111111111111",
      expires_in: 900,
    });
  });

  it("asks for at least 60 seconds", async () => {
    route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
    await makeGateway({
      now: () => new Date("2026-11-08T10:14:30.000Z"),
    }).gateway.createIntent(intentRequest());
    expect(JSON.parse(posts()[0]!.body).expires_in).toBe(60);
  });

  it("creates a virtual account payment with the bank as va_bank", async () => {
    route = methodsAndPayments({ create: () => ({ json: vaPayment() }) });
    const intent = await makeGateway().gateway.createIntent(
      intentRequest({ method: "va", channelCode: "bmri" }),
    );

    expect(intent.instructions).toEqual({
      method: "va",
      channelCode: "bmri",
      channelName: "Mandiri Virtual Account",
      virtualAccountNumber: "8808123456789012",
    });
    expect(JSON.parse(posts()[0]!.body)).toEqual({
      amount: 50_000,
      rail: "va",
      va_bank: "bmri",
      reference: "11111111-1111-4111-8111-111111111111",
      expires_in: 900,
    });
  });

  it.each([
    ["no bank", null],
    ["a bank DOIT does not list", "bca"],
  ])(
    "refuses a VA with %s before creating a payment",
    async (_name, channelCode) => {
      route = methodsAndPayments({ create: () => ({ json: vaPayment() }) });
      await expectCoreError(
        makeGateway().gateway.createIntent(
          intentRequest({ method: "va", channelCode }),
        ),
        "VALIDATION_ERROR",
      );
      expect(posts()).toHaveLength(0);
    },
  );

  it("refuses bank transfer before creating a payment (no account data on the wire)", async () => {
    route = methodsAndPayments({ create: () => ({ json: transferPayment() }) });
    await expectCoreError(
      makeGateway().gateway.createIntent(
        intentRequest({ method: "bank_transfer", channelCode: "bca" }),
      ),
      "VALIDATION_ERROR",
    );
    expect(requests).toHaveLength(0);
  });

  it("sends Bearer auth and the idempotency key on POST", async () => {
    route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
    await makeGateway().gateway.createIntent(intentRequest());

    const post = posts()[0]!;
    expect(post.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(post.headers["idempotency-key"]).toBe("idem-key-0001-abcdefghij");
  });

  it("reuses the same idempotency key when the caller retries", async () => {
    route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
    const { gateway } = makeGateway();

    await gateway.createIntent(intentRequest());
    await gateway.createIntent(intentRequest());
    await gateway.createIntent(
      intentRequest({ idempotencyKey: "idem-key-0002-abcdefghij" }),
    );

    expect(posts().map((p) => p.headers["idempotency-key"])).toEqual([
      "idem-key-0001-abcdefghij",
      "idem-key-0001-abcdefghij",
      "idem-key-0002-abcdefghij",
    ]);
  });

  it.each(["ewallet", "card"] as const)(
    "refuses %s with VALIDATION_ERROR before any HTTP call",
    async (method) => {
      route = methodsAndPayments({ create: () => ({ json: qrisPayment() }) });
      await expectCoreError(
        makeGateway().gateway.createIntent(intentRequest({ method })),
        "VALIDATION_ERROR",
      );
      expect(requests).toHaveLength(0);
    },
  );

  it("refuses a method the provider reports as disabled, without creating a payment", async () => {
    route = methodsAndPayments({
      methods: {
        json: {
          ...METHODS_REPLY,
          data: [
            methodRow("qris", "QRIS", "qris", null, { within_limits: false }),
            methodRow("va_bmri", "Mandiri Virtual Account", "va", "bmri"),
          ],
        },
      },
      create: () => ({ json: qrisPayment() }),
    });
    const { gateway } = makeGateway();

    expect(
      (await gateway.methods!(tenantContext)).find((m) => m.method === "qris")
        ?.enabled,
    ).toBe(false);
    await expectCoreError(
      gateway.createIntent(intentRequest({ method: "qris" })),
      "VALIDATION_ERROR",
    );
    expect(posts()).toHaveLength(0);
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [422, "VALIDATION_ERROR"],
    [409, "IDEMPOTENCY_KEY_REUSED"],
    [401, "SERVICE_UNAVAILABLE"],
    [403, "SERVICE_UNAVAILABLE"],
    [404, "SERVICE_UNAVAILABLE"],
    [429, "SERVICE_UNAVAILABLE"],
    [500, "SERVICE_UNAVAILABLE"],
    [502, "SERVICE_UNAVAILABLE"],
    [503, "SERVICE_UNAVAILABLE"],
  ] as const)("maps a %i answer to %s", async (status, code) => {
    route = methodsAndPayments({
      create: () => ({ status, text: BODY_MARKER }),
    });
    await expectCoreError(
      makeGateway().gateway.createIntent(intentRequest()),
      code,
    );
  });

  it.each([
    ["a non-JSON body", { text: "<html>gateway</html>" }],
    ["an empty object", { json: {} }],
    ["an unknown status", { json: qrisPayment({ status: "weird" }) }],
    ["a missing payment id", { json: qrisPayment({ id: undefined }) }],
    [
      "the removed cancelled status",
      { json: qrisPayment({ status: "cancelled" }) },
    ],
    ["a missing payment id", { json: qrisPayment({ id: undefined }) }],
    ["a QRIS payment without a QR string", { json: payment() }],
    ["another reference", { json: qrisPayment({ reference: "other" }) }],
    ["another amount", { json: qrisPayment({ amount: 49_000 }) }],
    [
      "a payment that is no longer pending",
      { json: qrisPayment({ status: "paid" }) },
    ],
    [
      "a fee charged to the customer",
      { json: qrisPayment({ fee_payer: "customer", total_amount: 50_350 }) },
    ],
    ["an invalid VA number", { json: vaPayment({ va_number: "abc" }) }],
    ["a VA without a number", { json: vaPayment({ va_number: null }) }],
    ["a VA at another bank", { json: vaPayment({ va_bank: "bnia" }) }],
    [
      "a VA fee charged to the customer",
      { json: vaPayment({ fee_payer: "customer", total_amount: 54_000 }) },
    ],
  ] as const)("answers SERVICE_UNAVAILABLE for %s", async (_name, reply) => {
    route = methodsAndPayments({ create: () => reply as Reply });
    const method = _name.includes("VA") ? "va" : "qris";
    await expectCoreError(
      makeGateway().gateway.createIntent(
        intentRequest({
          method,
          channelCode: method === "va" ? "bmri" : null,
        }),
      ),
      "SERVICE_UNAVAILABLE",
    );
  });

  it("answers SERVICE_UNAVAILABLE when DOIT does not answer within 10 seconds", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new Error("timeout")));
    route = methodsAndPayments({ create: () => ({ hang: true }) });

    await expectCoreError(
      makeGateway().gateway.createIntent(intentRequest()),
      "SERVICE_UNAVAILABLE",
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("answers SERVICE_UNAVAILABLE when the connection fails", async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const gateway = createDoitGateway({
      fetch: failingFetch as unknown as typeof fetch,
      loadCredentials: async () => creds(),
    });
    await expectCoreError(
      gateway.createIntent(intentRequest()),
      "SERVICE_UNAVAILABLE",
    );
  });
});

// --------------------------------------------------------------------------
// getStatus
// --------------------------------------------------------------------------

describe("DOIT adapter: getStatus", () => {
  const status = (providerRef = "pay_0001") =>
    makeGateway().gateway.getStatus({ context: tenantContext, providerRef });

  it("reads the payment with a GET carrying Bearer auth and no idempotency key", async () => {
    route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
    const result = await status();

    expect(result).toEqual({
      status: "pending",
      rawStatus: "pending",
      providerRef: "pay_0001",
      amountIdr: null,
      paidAt: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toBe("/v1/payments/pay_0001");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("a paid payment whose expiry, QR or paid time is missing or malformed still reads as paid", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: payment({
          status: "paid",
          expires_at: undefined,
          qr_content: 42,
          paid_at: "not a time",
        }),
      }),
    });
    expect(await status()).toEqual({
      status: "paid",
      rawStatus: "paid",
      providerRef: "pay_0001",
      amountIdr: 50_000,
      paidAt: null,
    });
  });

  it("createIntent still requires the expiry of the new payment", async () => {
    route = methodsAndPayments({
      create: () => ({ json: qrisPayment({ expires_at: null }) }),
    });
    await expect(
      makeGateway().gateway.createIntent(intentRequest()),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("encodes the provider reference in the path", async () => {
    route = methodsAndPayments({
      get: (req) => ({
        json: qrisPayment({
          id: decodeURIComponent(req.path.split("/").pop()!),
        }),
      }),
    });
    await status("pay/ 1?x=y");
    expect(requests[0]!.path).toBe(
      `/v1/payments/${encodeURIComponent("pay/ 1?x=y")}`,
    );
  });

  it.each([
    ["pending", "pending"],
    ["expired", "expired"],
    ["failed", "failed"],
    // Money went back: a terminal answer, never pending (false timeout) and
    // never paid (no credit); nothing in the books changes automatically.
    ["refunded", "failed"],
  ] as const)("maps provider status %s to %s", async (provider, expected) => {
    route = methodsAndPayments({
      get: () => ({ json: qrisPayment({ status: provider }) }),
    });
    expect(await status()).toEqual({
      status: expected,
      rawStatus: provider,
      providerRef: "pay_0001",
      amountIdr: null,
      paidAt: null,
    });
  });

  it("refuses a status the docs do not define", async () => {
    route = methodsAndPayments({
      get: () => ({ json: qrisPayment({ status: "cancelled" }) }),
    });
    await expectCoreError(status(), "SERVICE_UNAVAILABLE");
  });

  it("reports `amount` and the provider's paid time for a paid QRIS payment", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: qrisPayment({
          status: "paid",
          paid_at: "2026-11-08T10:05:00.000Z",
        }),
      }),
    });
    expect(await status()).toEqual({
      status: "paid",
      rawStatus: "paid",
      providerRef: "pay_0001",
      amountIdr: 50_000,
      paidAt: "2026-11-08T10:05:00.000Z",
    });
  });

  it("normalizes a paid time with an offset to ISO UTC", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: qrisPayment({
          status: "paid",
          paid_at: "2026-11-08T17:05:00+07:00",
        }),
      }),
    });
    expect((await status()).paidAt).toBe("2026-11-08T10:05:00.000Z");
  });

  it("reads a paid time without a time zone as unknown (paidAt null)", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: qrisPayment({
          status: "paid",
          paid_at: "2026-11-08T17:05:00",
        }),
      }),
    });
    expect(await status()).toEqual({
      status: "paid",
      rawStatus: "paid",
      providerRef: "pay_0001",
      amountIdr: 50_000,
      paidAt: null,
    });
  });

  it("reads a paid time with a space separator and a zone", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: qrisPayment({
          status: "paid",
          paid_at: "2026-11-08 17:05:00+07:00",
        }),
      }),
    });
    expect(await status()).toEqual({
      status: "paid",
      rawStatus: "paid",
      providerRef: "pay_0001",
      amountIdr: 50_000,
      paidAt: "2026-11-08T10:05:00.000Z",
    });
  });

  it("reports `amount` for a paid VA, also once its QR/VA instrument is released", async () => {
    route = methodsAndPayments({
      get: () => ({ json: vaPayment({ status: "paid", rail: null }) }),
    });
    expect((await status()).amountIdr).toBe(50_000);
  });

  it("credits `amount`, not total_amount, when a transfer adds a unique code", async () => {
    route = methodsAndPayments({
      get: () => ({ json: transferPayment({ status: "paid" }) }),
    });
    expect(await status()).toMatchObject({
      status: "paid",
      providerRef: "pay_0001",
      amountIdr: 50_000,
    });
  });

  it("credits `amount`, not total_amount, when the customer bore a fee", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: vaPayment({
          status: "paid",
          fee_payer: "customer",
          fee_amount: 4_000,
          total_amount: 54_000,
        }),
      }),
    });
    expect((await status()).amountIdr).toBe(50_000);
  });

  it("reports a different `amount` raw, so the lifecycle flags the mismatch", async () => {
    for (const amount of [40_000, 60_000]) {
      route = methodsAndPayments({
        get: () => ({ json: qrisPayment({ status: "paid", amount }) }),
      });
      expect((await status()).amountIdr).toBe(amount);
    }
  });

  it("keeps the flags on a late payment without changing the mapping", async () => {
    route = methodsAndPayments({
      get: () => ({
        json: qrisPayment({ status: "paid", flags: ["bayar_telat"] }),
      }),
    });
    expect((await status()).status).toBe("paid");
  });

  it("accepts a payment whose reference is the intent id", async () => {
    route = methodsAndPayments({ get: () => ({ json: qrisPayment() }) });
    const result = await makeGateway().gateway.getStatus({
      context: tenantContext,
      providerRef: "pay_0001",
      intentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.status).toBe("pending");
  });

  it("refuses a payment that belongs to another intent (nothing settles)", async () => {
    route = methodsAndPayments({
      get: () => ({ json: qrisPayment({ status: "paid" }) }),
    });
    await expectCoreError(
      makeGateway().gateway.getStatus({
        context: tenantContext,
        providerRef: "pay_0001",
        intentId: "22222222-2222-4222-8222-222222222222",
      }),
      "SERVICE_UNAVAILABLE",
    );
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [409, "IDEMPOTENCY_KEY_REUSED"],
    [401, "SERVICE_UNAVAILABLE"],
    [404, "SERVICE_UNAVAILABLE"],
    [500, "SERVICE_UNAVAILABLE"],
  ] as const)("maps a %i answer to %s", async (httpStatus, code) => {
    route = methodsAndPayments({
      get: () => ({ status: httpStatus, text: BODY_MARKER }),
    });
    await expectCoreError(status(), code);
  });

  it("answers SERVICE_UNAVAILABLE for a malformed payment", async () => {
    route = methodsAndPayments({
      get: () => ({ json: { id: "pay_0001", status: "paid" } }),
    });
    await expectCoreError(status(), "SERVICE_UNAVAILABLE");

    // A paid payment without its amount proves nothing.
    route = methodsAndPayments({
      get: () => ({ json: qrisPayment({ status: "paid", amount: undefined }) }),
    });
    await expectCoreError(status(), "SERVICE_UNAVAILABLE");

    route = methodsAndPayments({ get: () => ({ text: "not json" }) });
    await expectCoreError(status(), "SERVICE_UNAVAILABLE");
  });

  it("answers SERVICE_UNAVAILABLE on timeout", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new Error("timeout")));
    route = methodsAndPayments({ get: () => ({ hang: true }) });
    await expectCoreError(status(), "SERVICE_UNAVAILABLE");
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});

// --------------------------------------------------------------------------
// PAY-06: secrets never leak
// --------------------------------------------------------------------------

describe("DOIT adapter: secrets never leak (PAY-06)", () => {
  it("keeps apiKey, webhookSecret and provider bodies out of errors and logs", async () => {
    const output = captureOutput();
    const errors: unknown[] = [];

    for (const status of [400, 401, 409, 422, 500, 503]) {
      route = methodsAndPayments({
        methods: {
          status,
          text: `${BODY_MARKER} ${API_KEY} ${WEBHOOK_SECRET}`,
        },
        create: () => ({
          status,
          text: `${BODY_MARKER} ${API_KEY} ${WEBHOOK_SECRET}`,
        }),
        get: () => ({
          status,
          text: `${BODY_MARKER} ${API_KEY} ${WEBHOOK_SECRET}`,
        }),
      });
      const { gateway } = makeGateway();
      errors.push(await caught(gateway.createIntent(intentRequest())));
      errors.push(
        await caught(
          gateway.getStatus({
            context: tenantContext,
            providerRef: "pay_0001",
          }),
        ),
      );
      await gateway.health(tenantContext);
    }

    // A 200 whose body echoes the secrets but is malformed.
    route = methodsAndPayments({
      create: () => ({
        json: { id: API_KEY, status: WEBHOOK_SECRET, note: BODY_MARKER },
      }),
      get: () => ({
        json: { id: API_KEY, status: WEBHOOK_SECRET, note: BODY_MARKER },
      }),
    });
    const { gateway } = makeGateway();
    errors.push(await caught(gateway.createIntent(intentRequest())));
    errors.push(
      await caught(
        gateway.getStatus({ context: tenantContext, providerRef: "pay_0001" }),
      ),
    );

    // No credentials at all.
    const closed = makeGateway({ creds: null }).gateway;
    errors.push(await caught(closed.createIntent(intentRequest())));

    // Timeout and connection failure.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error(`timeout ${API_KEY}`)),
    );
    route = methodsAndPayments({ create: () => ({ hang: true }) });
    errors.push(
      await caught(makeGateway().gateway.createIntent(intentRequest())),
    );
    const failing = createDoitGateway({
      fetch: (async () => {
        throw new TypeError(`fetch failed for Bearer ${API_KEY}`);
      }) as unknown as typeof fetch,
      loadCredentials: async () => creds(),
    });
    errors.push(await caught(failing.createIntent(intentRequest())));

    for (const error of errors) {
      expect(error).toBeInstanceOf(CoreError);
      expectNoSecrets(dump(error));
    }
    expectNoSecrets(output.join("\n"));
  });

  it("does not log or print anything with the credentials on a successful flow", async () => {
    const output = captureOutput();
    route = methodsAndPayments({
      create: () => ({ json: qrisPayment() }),
      get: () => ({ json: qrisPayment({ status: "paid" }) }),
    });
    const { gateway } = makeGateway();
    await gateway.health(tenantContext);
    await gateway.createIntent(intentRequest());
    await gateway.getStatus({
      context: tenantContext,
      providerRef: "pay_0001",
    });

    expectNoSecrets(output.join("\n"));
  });

  it("fails closed and logs no secret when the credential loader throws", async () => {
    const output = captureOutput();
    const gateway = createDoitGateway({
      loadCredentials: async () => {
        throw new Error(`vault unavailable for ${API_KEY} ${WEBHOOK_SECRET}`);
      },
    });

    expect(await gateway.health(tenantContext)).toEqual({ status: "down" });
    const error = await expectCoreError(
      gateway.createIntent(intentRequest()),
      "SERVICE_UNAVAILABLE",
    );
    expectNoSecrets(dump(error));
    // The capture itself works: the adapter logged something, without secrets.
    expect(output.length).toBeGreaterThan(0);
    expectNoSecrets(output.join("\n"));
  });

  it("never prints through console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    route = methodsAndPayments({ create: () => ({ status: 500, text: "x" }) });
    const { gateway } = makeGateway();
    await caught(gateway.createIntent(intentRequest()));
    await gateway.health(tenantContext);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Webhook signature verification (PAY-03)
// --------------------------------------------------------------------------

describe("verifyDoitSignature", () => {
  const now = new Date("2026-11-08T10:00:00.000Z");
  const unix = Math.floor(now.getTime() / 1000);
  const rawBody = Buffer.from(
    JSON.stringify({
      id: "evt_0001",
      type: "payment.paid",
      created_at: "2026-11-08T09:59:50.000Z",
      data: qrisPayment({ status: "paid" }),
    }),
  );

  // Independent of signDoitWebhook: the assumed wire format from the brief.
  function header(
    secret: string,
    body: Buffer = rawBody,
    t: number = unix,
  ): string {
    const mac = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${t}.`), body]))
      .digest("hex");
    return `t=${t},v1=${mac}`;
  }

  const verify = (
    headerValue: string | undefined,
    secrets: readonly string[] = [WEBHOOK_SECRET],
    options: { body?: Buffer; at?: Date } = {},
  ) =>
    verifyDoitSignature({
      rawBody: options.body ?? rawBody,
      header: headerValue,
      secrets,
      now: options.at ?? now,
    });

  it("accepts a valid signature", () => {
    expect(verify(header(WEBHOOK_SECRET))).toBe(true);
  });

  it("signDoitWebhook produces a header that verifies and matches the documented format", () => {
    const signed = signDoitWebhook(rawBody, WEBHOOK_SECRET, now);
    expect(signed).toBe(header(WEBHOOK_SECRET));
    expect(verify(signed)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verify(header("another-secret-value"))).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    expect(verify(header(WEBHOOK_SECRET), [])).toBe(false);
  });

  it("rejects a body changed after signing", () => {
    const tampered = Buffer.from(rawBody.toString().replace("50000", "10"));
    expect(tampered.equals(rawBody)).toBe(false);
    expect(
      verify(header(WEBHOOK_SECRET), [WEBHOOK_SECRET], { body: tampered }),
    ).toBe(false);
  });

  it("rejects a timestamp that was changed after signing", () => {
    const mac = header(WEBHOOK_SECRET).split("v1=")[1];
    expect(verify(`t=${unix + 1},v1=${mac}`)).toBe(false);
  });

  it("signs the raw bytes, not a re-serialised JSON", () => {
    const spaced = Buffer.from(`{ "id": "evt_0002",  "type": "payment.paid" }`);
    expect(
      verify(header(WEBHOOK_SECRET, spaced), [WEBHOOK_SECRET], {
        body: spaced,
      }),
    ).toBe(true);
    const compact = Buffer.from(JSON.stringify(JSON.parse(spaced.toString())));
    expect(
      verify(header(WEBHOOK_SECRET, spaced), [WEBHOOK_SECRET], {
        body: compact,
      }),
    ).toBe(false);
  });

  it("accepts a timestamp up to 25 hours old or 5 minutes ahead, and rejects beyond", () => {
    const past = 25 * 3600;
    for (const offset of [-past, -past + 1, -86_400, -3600, -301, 0, 299, 300])
      expect(verify(header(WEBHOOK_SECRET, rawBody, unix + offset))).toBe(true);
    for (const offset of [-past - 1, -30 * 3600, 301, 3600])
      expect(verify(header(WEBHOOK_SECRET, rawBody, unix + offset))).toBe(
        false,
      );
  });

  it("accepts a retry that carries the original timestamp (24 h schedule)", () => {
    const retry = new Date(now.getTime() + 24 * 3600_000);
    expect(
      verify(header(WEBHOOK_SECRET), [WEBHOOK_SECRET], { at: retry }),
    ).toBe(true);
  });

  it("rejects a stale signature even if the MAC is correct", () => {
    const later = new Date(now.getTime() + 26 * 3600_000);
    expect(
      verify(header(WEBHOOK_SECRET), [WEBHOOK_SECRET], { at: later }),
    ).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["garbage", "garbage"],
    ["only a timestamp", `t=${unix}`],
    ["only a signature", `v1=${"a".repeat(64)}`],
    ["a non-numeric timestamp", `t=abc,v1=${"a".repeat(64)}`],
    ["a negative timestamp", `t=-5,v1=${"a".repeat(64)}`],
    ["a non-hex signature", `t=${unix},v1=${"z".repeat(64)}`],
    ["a short signature", `t=${unix},v1=abcd`],
    ["an empty signature", `t=${unix},v1=`],
    ["another scheme", `t=${unix},v0=${"a".repeat(64)}`],
  ])("rejects a header that is %s without throwing", (_name, value) => {
    expect(verify(value)).toBe(false);
  });

  it("supports secret rotation: either the old or the new secret verifies", () => {
    const oldSecret = "old-webhook-secret-1111";
    const newSecret = "new-webhook-secret-2222";
    const both = [newSecret, oldSecret];

    expect(verify(header(newSecret), both)).toBe(true);
    expect(verify(header(oldSecret), both)).toBe(true);
    expect(verify(header("third-secret-3333"), both)).toBe(false);
    // After rotation completes, the retired secret stops working.
    expect(verify(header(oldSecret), [newSecret])).toBe(false);
  });

  it("verification does not depend on secret order or duplicates", () => {
    expect(
      verify(header(WEBHOOK_SECRET), ["x", WEBHOOK_SECRET, WEBHOOK_SECRET]),
    ).toBe(true);
  });
});

describe("doitWebhookEventSchema", () => {
  const event = {
    id: "evt_0001",
    type: "payment.paid",
    created_at: "2026-11-08T09:59:50.000Z",
    data: qrisPayment({ status: "paid", flags: ["bayar_telat"] }),
  };

  it("parses a payment event in the documented shape", () => {
    const parsed = doitWebhookEventSchema.parse(event);
    expect(parsed.id).toBe("evt_0001");
    expect(parsed.type).toBe("payment.paid");
    expect(parsed.data.id).toBe("pay_0001");
    expect(parsed.data.status).toBe("paid");
    expect(parsed.data.amount).toBe(50_000);
    expect(parsed.data.total_amount).toBe(50_000);
    expect(parsed.data.flags).toEqual(["bayar_telat"]);
    expect(parsed.data).not.toHaveProperty("paid_amount");
  });

  it("parses a refunded payment", () => {
    const refunded = {
      ...event,
      type: "refund.succeeded",
      data: qrisPayment({ status: "refunded" }),
    };
    expect(doitWebhookEventSchema.parse(refunded).data.status).toBe("refunded");
  });

  it("reads the envelope of an event without a payment (webhook.test)", () => {
    const test = { ...event, type: "webhook.test", data: { hello: "world" } };
    expect(doitWebhookEventSchema.safeParse(test).success).toBe(false);
    expect(doitWebhookEnvelopeSchema.parse(test).type).toBe("webhook.test");
  });

  it("only payment.paid and payment.expired are payment events", () => {
    expect(isDoitPaymentEvent("payment.paid")).toBe(true);
    expect(isDoitPaymentEvent("payment.expired")).toBe(true);
    for (const type of [
      "invoice.created",
      "payment.proof_uploaded",
      "refund.succeeded",
      "refund.failed",
      "webhook.test",
      "payment.cancelled",
    ])
      expect(isDoitPaymentEvent(type)).toBe(false);
  });

  it("accepts an event type it does not know", () => {
    expect(
      doitWebhookEventSchema.safeParse({ ...event, type: "payout.created" })
        .success,
    ).toBe(true);
  });

  it.each([
    ["no id", { ...event, id: undefined }],
    ["no data", { ...event, data: undefined }],
    [
      "a data object without payment id",
      { ...event, data: { status: "paid" } },
    ],
    ["an unknown payment status", { ...event, data: payment({ status: "?" }) }],
    [
      "the removed cancelled status",
      { ...event, data: payment({ status: "cancelled" }) },
    ],
    ["a non-object", "payment.paid"],
  ])("rejects an event with %s", (_name, value) => {
    expect(doitWebhookEventSchema.safeParse(value).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// baseUrl SSRF guard
// --------------------------------------------------------------------------

describe("DOIT adapter: baseUrl guard", () => {
  it.each([
    "https://api.doit.example/",
    "https://api.doit.example/partner/",
    "https://api.doit.example:443/v1",
  ])("accepts public https host %s", (value) => {
    expect(parseDoitBaseUrl(value, false)).toBe(
      value.replace(":443", "").replace(/\/+$/, ""),
    );
  });

  it.each([
    "http://api.doit.example",
    "https://user:pass@api.doit.example",
    "https://api.doit.example:8443",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://2130706433",
    "https://0x7f.1",
    "https://[::1]",
    "https://localhost",
    "https://printer.local",
    "https://db.internal",
    "https://intranet",
    "ftp://api.doit.example",
    "not a url",
  ])("refuses %s outside tests", (value) => {
    expect(parseDoitBaseUrl(value, false)).toBeNull();
  });

  it("keeps a local http fake usable under test", () => {
    expect(parseDoitBaseUrl("http://127.0.0.1:4010", true)).toBe(
      "http://127.0.0.1:4010",
    );
    expect(parseDoitBaseUrl("http://user:pw@127.0.0.1:4010", true)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// DNS rebinding guard
// --------------------------------------------------------------------------

describe("DOIT adapter: DNS rebinding guard", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:c0a8:0101::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "203.0.113.10",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "2001:db8::1",
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  function guarded(addresses: string[] | Error) {
    const lookup = vi.fn(async (hostname: string) => {
      void hostname;
      if (addresses instanceof Error) throw addresses;
      return addresses.map((address) => ({ address }));
    });
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const gateway = createDoitGateway({
      loadCredentials: async () =>
        creds({
          integration: {
            id: INTEGRATION_ID,
            outletId: null,
            config: { baseUrl: "https://api.doit.example" },
          },
        }),
      fetch: fetchSpy as unknown as typeof fetch,
      lookup,
    });
    return { gateway, lookup, fetchSpy };
  }

  it("calls the provider when every answer is public", async () => {
    const { gateway, lookup, fetchSpy } = guarded(["8.8.8.8", "2606:4700::1"]);
    await expect(gateway.methods!(tenantContext)).resolves.toEqual([]);
    expect(lookup).toHaveBeenCalledWith("api.doit.example");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["private", ["10.0.0.8"]],
    ["link-local metadata", ["169.254.169.254"]],
    ["one bad among public", ["8.8.8.8", "192.168.0.10"]],
    ["IPv4-mapped", ["::ffff:127.0.0.1"]],
    ["unique-local", ["fd00::1"]],
    ["no answers", []],
  ])("fails closed on %s answers without any HTTP call", async (_n, list) => {
    const { gateway, fetchSpy } = guarded(list);
    await expect(gateway.methods!(tenantContext)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(gateway.health(tenantContext)).resolves.toEqual({
      status: "down",
    });
  });

  it("fails closed when the lookup itself fails", async () => {
    const { gateway, fetchSpy } = guarded(new Error("ENOTFOUND"));
    await expect(gateway.methods!(tenantContext)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-resolves before every request (no pinned answer)", async () => {
    const answers = [["8.8.8.8"], ["127.0.0.1"]];
    const lookup = vi.fn(async (hostname: string) => {
      void hostname;
      return (answers.shift() ?? []).map((address) => ({ address }));
    });
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const gateway = createDoitGateway({
      loadCredentials: async () =>
        creds({
          integration: {
            id: INTEGRATION_ID,
            outletId: null,
            config: { baseUrl: "https://api.doit.example" },
          },
        }),
      fetch: fetchSpy as unknown as typeof fetch,
      lookup,
      now: (() => {
        let t = 0;
        return () => new Date((t += 120_000));
      })(),
    });
    await gateway.methods!(tenantContext);
    await expect(gateway.methods!(tenantContext)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
