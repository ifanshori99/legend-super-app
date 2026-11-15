import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  createDuitkuGateway,
  duitkuCredentialSet,
} from "../services/payment-duitku";

// Loaders are injected in every test: keep the DB-backed store out of the
// import graph.
vi.mock("../services/platform-integration.service", () => ({
  loadActiveIntegrationCredentials: vi.fn(),
  loadIntegrationCredentialsById: vi.fn(),
}));

const TENANT_ID = "0b1f2c3d-0000-4000-8000-000000000001";
const OUTLET_ID = "0b1f2c3d-0000-4000-8000-0000000000a1";
const INTEGRATION_ID = "0b1f2c3d-0000-4000-8000-0000000000b1";
const INTENT_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-10T03:00:00.000Z"); // 10:00:00 WIB
const API_KEY = "api-key-SECRET-current";
const OLD_API_KEY = "api-key-SECRET-previous";

const context = {
  tenant: { tenantId: TENANT_ID },
  outletScope: { kind: "all", tenantId: TENANT_ID },
} as unknown as ScopedTenantContext;
const outletContext = {
  tenant: { tenantId: TENANT_ID },
  outletScope: { kind: "outlets", tenantId: TENANT_ID, outletIds: [OUTLET_ID] },
} as unknown as ScopedTenantContext;

type Loaded = {
  integration: {
    id: string;
    outletId: string | null;
    config: Record<string, unknown>;
  };
  credentials: Record<string, string>;
};

function loaded(overrides: Partial<Loaded> = {}): Loaded {
  return {
    integration: {
      id: INTEGRATION_ID,
      outletId: null,
      config: {
        environment: "sandbox",
        notificationEmail: "owner@example.test",
      },
    },
    credentials: { merchantCode: "DS1234", apiKey: API_KEY },
    ...overrides,
  };
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

const METHOD_ROWS = [
  { paymentMethod: "SP", paymentName: "ShopeePay QRIS", totalFee: "0" },
  { paymentMethod: "BC", paymentName: "BCA Virtual Account", totalFee: "0" },
  { paymentMethod: "I1", paymentName: "BNI Virtual Account", totalFee: "0" },
  { paymentMethod: "OV", paymentName: "OVO", totalFee: "0" },
  { paymentMethod: "VC", paymentName: "Credit Card", totalFee: "2500" },
  { paymentMethod: "FT", paymentName: "Retail", totalFee: "0" },
  { paymentMethod: "DN", paymentName: "Indodana", totalFee: "0" },
];

type Call = { url: string; body: Record<string, unknown> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes by URL tail; `answers` can override or throw per endpoint. */
function fakeFetch(
  answers: Partial<
    Record<
      "getpaymentmethod" | "inquiry" | "transactionStatus",
      (call: Call) => Response
    >
  > = {},
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(call);
    const tail = call.url.endsWith("getpaymentmethod")
      ? "getpaymentmethod"
      : call.url.endsWith("inquiry")
        ? "inquiry"
        : "transactionStatus";
    const answer = answers[tail];
    if (answer) return answer(call);
    if (tail === "getpaymentmethod")
      return json({ responseCode: "00", paymentFee: METHOD_ROWS });
    if (tail === "inquiry")
      return json({
        statusCode: "00",
        reference: "REF-1",
        paymentUrl: "https://sandbox.duitku.com/pay/REF-1",
        vaNumber: "8800123456789",
        qrString: "00020101021226QRSTRING",
        amount: String(call.body.paymentAmount),
      });
    return json({
      merchantOrderId: call.body.merchantOrderId,
      statusCode: "00",
      reference: "REF-1",
      amount: "50000",
    });
  });
  return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

function gateway(
  options: {
    fetch?: typeof fetch;
    row?: Loaded | null;
    byId?: Loaded | null;
    now?: () => Date;
  } = {},
) {
  const row = options.row === undefined ? loaded() : options.row;
  const loadCredentials = vi.fn(async () => row);
  const loadCredentialsById = vi.fn(async () =>
    options.byId === undefined ? row : options.byId,
  );
  const port = createDuitkuGateway({
    fetch: options.fetch ?? fakeFetch().fn,
    now: options.now ?? (() => NOW),
    callbackBaseUrl: "https://api.example.test/",
    returnUrl: "https://app.example.test/paid",
    loadCredentials,
    loadCredentialsById,
  });
  return { port, loadCredentials, loadCredentialsById };
}

const intentRequest = (
  overrides: Partial<
    Parameters<ReturnType<typeof gateway>["port"]["createIntent"]>[0]
  > = {},
) => ({
  context,
  provider: "duitku",
  intentId: INTENT_ID,
  method: "qris" as const,
  channelCode: null,
  amountIdr: 50_000,
  idempotencyKey: "idem-1",
  expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  ...overrides,
});

async function expectCoreError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
  return error as CoreError;
}

describe("duitkuCredentialSet", () => {
  const base = {
    integration: { config: { environment: "production" } },
    credentials: { merchantCode: "DS1", apiKey: "k1" },
  };

  it("returns the current credentials with the environment from config", () => {
    expect(duitkuCredentialSet(base, NOW)).toEqual([
      { merchantCode: "DS1", apiKey: "k1", environment: "production" },
    ]);
  });

  it("adds the previous generation while now < previousValidUntil", () => {
    const set = duitkuCredentialSet(
      {
        ...base,
        credentials: {
          ...base.credentials,
          previousMerchantCode: "DS0",
          previousApiKey: "k0",
          previousValidUntil: new Date(NOW.getTime() + 1000).toISOString(),
        },
      },
      NOW,
    );
    expect(set).toEqual([
      { merchantCode: "DS1", apiKey: "k1", environment: "production" },
      { merchantCode: "DS0", apiKey: "k0", environment: "production" },
    ]);
  });

  it("drops the previous generation at and after previousValidUntil", () => {
    const credentials = {
      ...base.credentials,
      previousMerchantCode: "DS0",
      previousApiKey: "k0",
      previousValidUntil: NOW.toISOString(),
    };
    expect(duitkuCredentialSet({ ...base, credentials }, NOW)).toHaveLength(1);
    expect(
      duitkuCredentialSet(
        { ...base, credentials },
        new Date(NOW.getTime() + 1),
      ),
    ).toHaveLength(1);
  });

  it("ignores an incomplete or unreadable previous generation", () => {
    const extras: Record<string, string>[] = [
      { previousApiKey: "k0", previousValidUntil: "2999-01-01T00:00:00Z" },
      { previousMerchantCode: "DS0", previousApiKey: "k0" },
      {
        previousMerchantCode: "DS0",
        previousApiKey: "k0",
        previousValidUntil: "not a date",
      },
    ];
    for (const extra of extras)
      expect(
        duitkuCredentialSet(
          { ...base, credentials: { ...base.credentials, ...extra } },
          NOW,
        ),
      ).toHaveLength(1);
  });

  it("is empty when the current credentials or environment are unusable", () => {
    expect(
      duitkuCredentialSet(
        { ...base, credentials: { merchantCode: "DS1" } },
        NOW,
      ),
    ).toEqual([]);
    expect(
      duitkuCredentialSet(
        { ...base, integration: { config: { environment: "staging" } } },
        NOW,
      ),
    ).toEqual([]);
    expect(
      duitkuCredentialSet({ ...base, integration: { config: {} } }, NOW),
    ).toEqual([]);
  });
});

describe("duitku adapter: createIntent", () => {
  it("sends the inquiry per D23 and returns QRIS instructions", async () => {
    const { fn, calls } = fakeFetch();
    const { port } = gateway({ fetch: fn });
    const intent = await port.createIntent(intentRequest());

    const inquiry = calls.find((c) => c.url.endsWith("v2/inquiry"));
    expect(inquiry?.url).toBe(
      "https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry",
    );
    expect(inquiry?.body).toMatchObject({
      merchantCode: "DS1234",
      merchantOrderId: INTENT_ID,
      paymentAmount: 50_000,
      paymentMethod: "SP",
      expiryPeriod: 10,
      email: "owner@example.test",
      customerVaName: "Legend",
      callbackUrl: `https://api.example.test/api/webhooks/payments/duitku/${TENANT_ID}`,
      returnUrl: "https://app.example.test/paid",
      signature: hmac(`DS1234${INTENT_ID}50000`, API_KEY),
    });
    expect(String(inquiry?.body.productDetails)).toBe("Pembayaran 11111111");
    expect(intent).toEqual({
      providerRef: "REF-1",
      instructions: {
        method: "qris",
        qrPayload: "00020101021226QRSTRING",
        issuer: null,
      },
      expiresAt: intentRequest().expiresAt,
      integrationId: INTEGRATION_ID,
    });
  });

  it("rounds expiryPeriod up to whole minutes, minimum 1", async () => {
    for (const [offsetMs, minutes] of [
      [90_000, 2],
      [60_000, 1],
      [1_000, 1],
      [-5_000, 1],
    ] as const) {
      const { fn, calls } = fakeFetch();
      await gateway({ fetch: fn }).port.createIntent(
        intentRequest({
          expiresAt: new Date(NOW.getTime() + offsetMs).toISOString(),
        }),
      );
      expect(
        calls.find((c) => c.url.endsWith("v2/inquiry"))?.body.expiryPeriod,
      ).toBe(minutes);
    }
  });

  it("uses config.vaName and the production host from config", async () => {
    const { fn, calls } = fakeFetch();
    const row = loaded();
    row.integration.config = {
      environment: "production",
      notificationEmail: "owner@example.test",
      vaName: "Kopi Legend",
    };
    await gateway({ fetch: fn, row }).port.createIntent(intentRequest());
    const inquiry = calls.find((c) => c.url.endsWith("v2/inquiry"));
    expect(inquiry?.url).toBe(
      "https://passport.duitku.com/webapi/api/merchant/v2/inquiry",
    );
    expect(inquiry?.body.customerVaName).toBe("Kopi Legend");
  });

  it("asks getpaymentmethod at the real amount with the WIB datetime", async () => {
    const { fn, calls } = fakeFetch();
    await gateway({ fetch: fn }).port.createIntent(intentRequest());
    const methods = calls.find((c) => c.url.endsWith("getpaymentmethod"));
    expect(methods?.body).toMatchObject({
      merchantcode: "DS1234",
      amount: 50_000,
      datetime: "2026-11-10 10:00:00",
      signature: hmac(`DS123450000${"2026-11-10 10:00:00"}`, API_KEY),
    });
  });

  it("creates a VA for an enabled channel code", async () => {
    const { fn, calls } = fakeFetch();
    const intent = await gateway({ fetch: fn }).port.createIntent(
      intentRequest({ method: "va", channelCode: "BC" }),
    );
    expect(
      calls.find((c) => c.url.endsWith("v2/inquiry"))?.body.paymentMethod,
    ).toBe("BC");
    expect(intent.instructions).toEqual({
      method: "va",
      channelCode: "BC",
      channelName: "BCA Virtual Account",
      virtualAccountNumber: "8800123456789",
    });
  });

  it("refuses a channel that is missing, of another category or not enabled", async () => {
    for (const request of [
      { method: "va" as const, channelCode: null },
      { method: "va" as const, channelCode: "OV" },
      { method: "va" as const, channelCode: "M2" },
      { method: "ewallet" as const, channelCode: "BC" },
    ]) {
      const { fn, calls } = fakeFetch();
      await expectCoreError(
        gateway({ fetch: fn }).port.createIntent(intentRequest(request)),
        "VALIDATION_ERROR",
      );
      expect(calls.some((c) => c.url.endsWith("v2/inquiry"))).toBe(false);
    }
  });

  it("refuses bank_transfer and QRIS when no QRIS code is enabled", async () => {
    const { fn } = fakeFetch();
    await expectCoreError(
      gateway({ fetch: fn }).port.createIntent(
        intentRequest({ method: "bank_transfer", channelCode: "BC" }),
      ),
      "VALIDATION_ERROR",
    );
    const noQris = fakeFetch({
      getpaymentmethod: () =>
        json({
          responseCode: "00",
          paymentFee: METHOD_ROWS.filter((row) => row.paymentMethod !== "SP"),
        }),
    });
    await expectCoreError(
      gateway({ fetch: noQris.fn }).port.createIntent(intentRequest()),
      "VALIDATION_ERROR",
    );
  });

  it("answers 503 when the integration is missing or incomplete", async () => {
    const { fn, calls } = fakeFetch();
    await expectCoreError(
      gateway({ fetch: fn, row: null }).port.createIntent(intentRequest()),
      "SERVICE_UNAVAILABLE",
    );
    const noEmail = loaded();
    noEmail.integration.config = { environment: "sandbox" };
    await expectCoreError(
      gateway({ fetch: fn, row: noEmail }).port.createIntent(intentRequest()),
      "SERVICE_UNAVAILABLE",
    );
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when Duitku gives no usable QR string or VA number", async () => {
    for (const [request, patch] of [
      [{}, { qrString: null }],
      [{ method: "va" as const, channelCode: "BC" }, { vaNumber: "12" }],
    ] as const) {
      const { fn } = fakeFetch({
        inquiry: (call) => {
          const body: Record<string, unknown> = {
            statusCode: "00",
            reference: "REF-1",
            paymentUrl: "https://sandbox.duitku.com/pay/REF-1",
            vaNumber: "8800123456789",
            qrString: "00020101",
            amount: String(call.body.paymentAmount),
          };
          return json(Object.assign(body, patch));
        },
      });
      await expectCoreError(
        gateway({ fetch: fn }).port.createIntent(intentRequest(request)),
        "SERVICE_UNAVAILABLE",
      );
    }
  });

  it("uses the outlet of the request to pick the integration", async () => {
    const { port, loadCredentials } = gateway();
    await port.createIntent(intentRequest({ outletId: OUTLET_ID }));
    expect(loadCredentials).toHaveBeenCalledWith(context, OUTLET_ID);
    await port.createIntent(intentRequest({ context: outletContext }));
    expect(loadCredentials).toHaveBeenLastCalledWith(outletContext, OUTLET_ID);
  });

  it("always signs with the current credentials, never the previous", async () => {
    const { fn, calls } = fakeFetch();
    const row = loaded();
    row.credentials = {
      ...row.credentials,
      previousMerchantCode: "DS0001",
      previousApiKey: OLD_API_KEY,
      previousValidUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    await gateway({ fetch: fn, row }).port.createIntent(intentRequest());
    for (const call of calls)
      expect(JSON.stringify(call.body)).not.toContain("DS0001");
  });
});

describe("duitku adapter: methods and channels", () => {
  it("groups getpaymentmethod rows per D24", async () => {
    const { fn, calls } = fakeFetch();
    const { port } = gateway({ fetch: fn });
    const methods = await port.methods?.(context, OUTLET_ID);
    expect(calls[0]?.body.amount).toBe(10_000);
    expect(methods).toEqual([
      { method: "qris", enabled: true, channels: [] },
      {
        method: "va",
        enabled: true,
        channels: [
          { code: "BC", name: "BCA Virtual Account" },
          { code: "I1", name: "BNI Virtual Account" },
        ],
      },
      { method: "bank_transfer", enabled: false, channels: [] },
      {
        method: "ewallet",
        enabled: true,
        channels: [{ code: "OV", name: "OVO" }],
      },
      {
        method: "card",
        enabled: true,
        channels: [{ code: "VC", name: "Credit Card" }],
      },
    ]);
  });

  it("reports a category with no enabled code as disabled", async () => {
    const { fn } = fakeFetch({
      getpaymentmethod: () =>
        json({
          responseCode: "00",
          paymentFee: [
            { paymentMethod: "FT", paymentName: "Retail", totalFee: "0" },
          ],
        }),
    });
    const methods = await gateway({ fetch: fn }).port.methods?.(context);
    expect(methods?.map((m) => [m.method, m.enabled])).toEqual([
      ["qris", false],
      ["va", false],
      ["bank_transfer", false],
      ["ewallet", false],
      ["card", false],
    ]);
  });

  it("channels() lists enabled VA codes and nothing for other methods", async () => {
    const { port } = gateway();
    expect(await port.channels(context, "va", OUTLET_ID)).toEqual([
      { code: "BC", name: "BCA Virtual Account" },
      { code: "I1", name: "BNI Virtual Account" },
    ]);
    expect(await port.channels(context, "qris")).toEqual([]);
    expect(await port.channels(context, "bank_transfer")).toEqual([]);
  });

  it("caches getpaymentmethod 60 s per integration", async () => {
    let at = NOW;
    const { fn, mock } = fakeFetch();
    const { port } = gateway({ fetch: fn, now: () => at });
    await port.methods?.(context);
    await port.channels(context, "va");
    await port.health(context);
    expect(mock).toHaveBeenCalledTimes(1);
    at = new Date(NOW.getTime() + 59_000);
    await port.methods?.(context);
    expect(mock).toHaveBeenCalledTimes(1);
    at = new Date(NOW.getTime() + 61_000);
    await port.methods?.(context);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("answers 503 for methods when unconfigured", async () => {
    const { port } = gateway({ row: null });
    await expectCoreError(
      Promise.resolve(port.methods?.(context)),
      "SERVICE_UNAVAILABLE",
    );
    expect(await port.channels(context, "va")).toEqual([]);
  });
});

describe("duitku adapter: health", () => {
  it("is down and unconfigured without an integration or credentials", async () => {
    expect(await gateway({ row: null }).port.health(context)).toEqual({
      status: "down",
      reason: "unconfigured",
    });
    const noKey = loaded();
    noKey.credentials = { merchantCode: "DS1234" };
    expect(await gateway({ row: noKey }).port.health(context)).toEqual({
      status: "down",
      reason: "unconfigured",
    });
  });

  it("is up when getpaymentmethod answers, down when it fails", async () => {
    expect(await gateway().port.health(context)).toEqual({
      status: "available",
    });
    const failing = fakeFetch({
      getpaymentmethod: () => json({ error: "x" }, 500),
    });
    expect(await gateway({ fetch: failing.fn }).port.health(context)).toEqual({
      status: "down",
    });
  });

  it("is down (not unconfigured) when the credential loader throws", async () => {
    const port = createDuitkuGateway({
      fetch: fakeFetch().fn,
      now: () => NOW,
      callbackBaseUrl: "https://api.example.test",
      returnUrl: "https://app.example.test/paid",
      loadCredentials: async () => {
        throw new Error("db down");
      },
      loadCredentialsById: async () => null,
    });
    expect(await port.health(context)).toEqual({ status: "down" });
  });
});

describe("duitku adapter: getStatus", () => {
  const statusRequest = (
    overrides: Record<string, unknown> = {},
  ): Parameters<ReturnType<typeof gateway>["port"]["getStatus"]>[0] => ({
    context,
    integrationId: INTEGRATION_ID,
    providerRef: "REF-1",
    intentId: INTENT_ID,
    ...overrides,
  });

  it("maps 00 to paid with the amount, 01 to pending, 02 to expired", async () => {
    for (const [code, expected] of [
      ["00", { status: "paid", amountIdr: 50_000 }],
      ["01", { status: "pending", amountIdr: null }],
      ["02", { status: "expired", amountIdr: null }],
    ] as const) {
      const { fn, calls } = fakeFetch({
        transactionStatus: (call) =>
          json({
            merchantOrderId: call.body.merchantOrderId,
            statusCode: code,
            reference: "REF-1",
            amount: "50000",
          }),
      });
      const { port, loadCredentialsById } = gateway({ fetch: fn });
      expect(await port.getStatus(statusRequest())).toEqual({
        ...expected,
        rawStatus: code,
        providerRef: "REF-1",
        paidAt: null,
      });
      expect(calls[0]?.body).toMatchObject({
        merchantCode: "DS1234",
        merchantOrderId: INTENT_ID,
        signature: hmac(`DS1234${INTENT_ID}`, API_KEY),
      });
      expect(loadCredentialsById).toHaveBeenCalledWith(context, INTEGRATION_ID);
    }
  });

  it("refuses a status that carries another reference", async () => {
    const { fn } = fakeFetch({
      transactionStatus: (call) =>
        json({
          merchantOrderId: call.body.merchantOrderId,
          statusCode: "00",
          reference: "OTHER-REF",
          amount: "50000",
        }),
    });
    await expectCoreError(
      gateway({ fetch: fn }).port.getStatus(statusRequest()),
      "SERVICE_UNAVAILABLE",
    );
  });

  it("requires the intent id (merchantOrderId)", async () => {
    const { fn, calls } = fakeFetch();
    await expectCoreError(
      gateway({ fetch: fn }).port.getStatus(
        statusRequest({ intentId: undefined }),
      ),
      "SERVICE_UNAVAILABLE",
    );
    expect(calls).toHaveLength(0);
  });

  it("loads by outlet when no integration id is given", async () => {
    const { port, loadCredentials } = gateway();
    await port.getStatus(
      statusRequest({ integrationId: undefined, outletId: OUTLET_ID }),
    );
    expect(loadCredentials).toHaveBeenCalledWith(context, OUTLET_ID);
  });

  it("answers 503 when the integration cannot be loaded", async () => {
    await expectCoreError(
      gateway({ byId: null }).port.getStatus(statusRequest()),
      "SERVICE_UNAVAILABLE",
    );
  });

  describe("intent minted with the previous merchant code", () => {
    const rotated = () => {
      const row = loaded();
      row.credentials = {
        merchantCode: "DS9999",
        apiKey: API_KEY,
        previousMerchantCode: "DS1234",
        previousApiKey: OLD_API_KEY,
        previousValidUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      };
      return row;
    };
    const byMerchant = (call: Call) =>
      call.body.merchantCode === "DS1234"
        ? json({
            merchantOrderId: call.body.merchantOrderId,
            statusCode: "00",
            reference: "REF-1",
            amount: "50000",
          })
        : json({ statusCode: "01", statusMessage: "not found" }, 404);

    it("retries once with the previous credentials while in grace", async () => {
      const { fn, calls } = fakeFetch({ transactionStatus: byMerchant });
      const status = await gateway({
        fetch: fn,
        row: rotated(),
      }).port.getStatus(statusRequest());
      expect(status.status).toBe("paid");
      expect(calls.map((c) => c.body.merchantCode)).toEqual([
        "DS9999",
        "DS1234",
      ]);
      expect(calls[1]?.body.signature).toBe(
        hmac(`DS1234${INTENT_ID}`, OLD_API_KEY),
      );
    });

    it("does not retry after the grace window", async () => {
      const { fn, calls } = fakeFetch({ transactionStatus: byMerchant });
      await expectCoreError(
        gateway({
          fetch: fn,
          row: rotated(),
          now: () => new Date(NOW.getTime() + 60_000),
        }).port.getStatus(statusRequest()),
        "SERVICE_UNAVAILABLE",
      );
      expect(calls).toHaveLength(1);
    });

    it("does not retry when the current credentials answer", async () => {
      const { fn, calls } = fakeFetch();
      await gateway({ fetch: fn, row: rotated() }).port.getStatus(
        statusRequest(),
      );
      expect(calls).toHaveLength(1);
    });
  });
});

describe("duitku adapter: testConnection", () => {
  it("works on any row status and returns the method availability", async () => {
    const { port, loadCredentialsById } = gateway();
    const result = await port.testConnection?.(context, INTEGRATION_ID);
    expect(loadCredentialsById).toHaveBeenCalledWith(context, INTEGRATION_ID);
    expect(result).toMatchObject({ ok: true });
    expect(
      result?.ok && result.methods.map((m) => [m.method, m.enabled]),
    ).toEqual([
      ["qris", true],
      ["va", true],
      ["bank_transfer", false],
      ["ewallet", true],
      ["card", true],
    ]);
  });

  it("bypasses the 60 s cache", async () => {
    const { fn, mock } = fakeFetch();
    const { port } = gateway({ fetch: fn });
    await port.methods?.(context);
    await port.testConnection?.(context, INTEGRATION_ID);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("maps failures to codes without provider text", async () => {
    const cases: Array<[() => Response | never, string]> = [
      [() => json({ Message: "bad" }, 401), "GATEWAY_AUTH_FAILED"],
      [() => json({ Message: "bad" }, 403), "GATEWAY_AUTH_FAILED"],
      [() => json({ Message: "bad" }, 503), "GATEWAY_UNREACHABLE"],
      [
        () => {
          throw new TypeError("fetch failed");
        },
        "GATEWAY_UNREACHABLE",
      ],
      [() => json({ responseCode: "99" }), "GATEWAY_REJECTED"],
      [() => json({ Message: "bad" }, 400), "GATEWAY_REJECTED"],
    ];
    for (const [answer, code] of cases) {
      const { fn } = fakeFetch({ getpaymentmethod: answer });
      expect(
        await gateway({ fetch: fn }).port.testConnection?.(
          context,
          INTEGRATION_ID,
        ),
      ).toEqual({ ok: false, code });
    }
  });

  it("is rejected when the row is missing or incomplete", async () => {
    expect(
      await gateway({ byId: null }).port.testConnection?.(
        context,
        INTEGRATION_ID,
      ),
    ).toEqual({ ok: false, code: "GATEWAY_REJECTED" });
  });
});

describe("duitku adapter: secrets stay out of errors", () => {
  it("never puts the api key, merchant code or provider body in a thrown error", async () => {
    const leaky = fakeFetch({
      inquiry: () =>
        json(
          { Message: `bad ${API_KEY} DS1234 signature`, statusCode: "99" },
          400,
        ),
    });
    const { port } = gateway({ fetch: leaky.fn });
    const error = await port.createIntent(intentRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CoreError);
    const text = JSON.stringify({
      message: (error as CoreError).message,
      code: (error as CoreError).code,
      stack: (error as Error).stack,
    });
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("DS1234");
    expect(text).not.toContain("bad ");
  });

  it("has no cancel (Duitku codes are not cancellable here)", () => {
    expect(gateway().port.cancel).toBeUndefined();
    expect(gateway().port.provider).toBe("duitku");
  });
});
