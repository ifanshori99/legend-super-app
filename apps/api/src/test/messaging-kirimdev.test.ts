// Kirimdev outbound WhatsApp adapter (legend-w8dfz) and webhook verification
// (legend-6qyk). Written from docs/briefs/sub-kirim-whatsapp.md ("Kontrak modul"
// and "Fakta API"), not from the implementation. `fetch` is always a mock: there
// is no sandbox and no real token.
//
// Assumptions (the brief is silent):
// - A Retry-After wait is jittered 0.75-1.25 and capped at 8 s; the test only
//   requires "within the jitter band" for small values and "at most 10 s" (8 s
//   plus the widest jitter) for large ones.
// - A non-https baseUrl is refused with a TypeError at construction.
// - A 2xx without a string `data.id` is `invalid_response` and not retryable.
// - verifyWebhook with an empty secret list rejects (at construction or call).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  KirimdevSendError,
  createKirimdevMessagingProvider,
  getKirimdevMessaging,
} from "../services/messaging-kirimdev";

const API_KEY = "kdv_live_" + "abcDEF123_-abcDEF123_-xy".slice(0, 24);
const SENDER_ID = "pn_test_0001";
const SECRET = "kirim-secret-current";
const OLD_SECRET = "kirim-secret-previous";
const NOW = 1_800_000_000;

const TENANT_ID = cafeLegendFixtures.tenant.id;
const [OUTLET_A, OUTLET_B] = cafeLegendFixtures.outlets.map((o) => o.id);
const tenant = establishTenantContext({
  tenantId: TENANT_ID,
  brandId: null,
  source: "session",
});
const tenantWide = establishScopedTenantContext(tenant, { kind: "tenant" });
const cashierA = establishScopedTenantContext(tenant, {
  kind: "outlets",
  outletIds: [OUTLET_A!],
});
const otherTenantContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: "99999999-9999-4999-8999-999999999999",
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

const RECIPIENT = "628123456789";
const TEXT = "Pesanan atas nama Budi sudah siap diambil";
const message = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID,
  outletId: OUTLET_A!,
  reference: "order-1001",
  recipient: RECIPIENT,
  text: TEXT,
  ...overrides,
});
const expectedKey = (reference = "order-1001", outletId = OUTLET_A) =>
  createHash("sha256")
    .update(`${TENANT_ID}:${outletId}:${reference}`)
    .digest("hex");

const okBody = (status = "queued") => ({
  data: { id: "msg_01HZZ", status },
  request_id: "req_ok",
});
const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const errorResponse = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
) =>
  json(
    status,
    {
      error: {
        type: "invalid_request_error",
        code,
        // Echoes personal data on purpose: the adapter must not repeat it.
        message: `cannot deliver to +${RECIPIENT}: ${TEXT} (${API_KEY})`,
        param: null,
        request_id: "req_err",
      },
    },
    headers,
  );

type Step = Response | Error | (() => Promise<Response>);
function setup(
  steps: Step[],
  options: {
    sender?: string | null;
    maxAttempts?: number;
    timeoutMs?: number;
    webhookSecrets?: readonly string[];
  } = {},
) {
  const queue = [...steps];
  const fetchMock = vi.fn<(url: unknown, init?: unknown) => Promise<Response>>(
    async () => {
      const step = queue.shift();
      if (step === undefined) throw new Error("unexpected extra fetch call");
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step() : step;
    },
  );
  const sleeps: number[] = [];
  const resolveSender = vi.fn<
    (
      context: unknown,
      scope: { outletId: string | null },
    ) => Promise<string | null>
  >(async () => (options.sender === undefined ? SENDER_ID : options.sender));
  const provider = createKirimdevMessagingProvider({
    apiKey: API_KEY,
    fetch: fetchMock as unknown as typeof fetch,
    resolveSender,
    webhookSecrets: options.webhookSecrets ?? [SECRET],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  const call = (index: number) => {
    const [url, init] = fetchMock.mock.calls[index] as [
      string,
      RequestInit & { headers?: Record<string, string> },
    ];
    return {
      url: String(url),
      init,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as unknown,
    };
  };
  return { provider, fetchMock, sleeps, resolveSender, call };
}

async function failure(promise: Promise<unknown>): Promise<KirimdevSendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KirimdevSendError);
    return error as KirimdevSendError;
  }
  throw new Error("expected send to fail");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createKirimdevMessagingProvider: construction", () => {
  const bad = [
    "",
    "kdv_test_abcDEF123_-abcDEF123_",
    "kdv_live_tooShort",
    "kdv_live_" + "a".repeat(25),
    "kdv_live_" + "!".repeat(24),
    "not-a-key",
  ];
  it.each(bad)(
    "rejects a malformed API key without printing it (%#)",
    (key) => {
      let thrown: unknown;
      try {
        createKirimdevMessagingProvider({
          apiKey: key,
          resolveSender: async () => SENDER_ID,
          webhookSecrets: [SECRET],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      if (key.length > 0) expect((thrown as Error).message).not.toContain(key);
    },
  );

  it("refuses a base URL that is not https", () => {
    expect(() =>
      createKirimdevMessagingProvider({
        apiKey: API_KEY,
        baseUrl: "http://api.kirimdev.com",
        resolveSender: async () => SENDER_ID,
        webhookSecrets: [SECRET],
      }),
    ).toThrow(TypeError);
  });

  it("sends to the origin only when the base URL has a path, query or fragment", async () => {
    const mock = vi.fn(async () => json(202, okBody()));
    const provider = createKirimdevMessagingProvider({
      apiKey: API_KEY,
      baseUrl: "https://api.kirimdev.com/admin/?debug=1#frag",
      fetch: mock as unknown as typeof fetch,
      resolveSender: async () => SENDER_ID,
      webhookSecrets: [SECRET],
    });
    await provider.send(tenantWide, message());
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0] as unknown[])[0]).toBe(
      `https://api.kirimdev.com/v1/${SENDER_ID}/messages`,
    );
  });

  it("getKirimdevMessaging is null when KIRIM_API_KEY is empty (outbound off)", () => {
    for (const KIRIM_API_KEY of [undefined, ""])
      expect(
        getKirimdevMessaging({
          resolveSender: async () => SENDER_ID,
          env: { KIRIM_API_KEY } as never,
        }),
      ).toBeNull();
  });
});

describe("send: request shape", () => {
  it("posts the documented request and accepts 202", async () => {
    const { provider, call, fetchMock, resolveSender } = setup([
      json(202, okBody()),
    ]);
    const result = await provider.send(tenantWide, message());
    expect(result).toEqual({ reference: "order-1001", accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveSender).toHaveBeenCalledTimes(1);

    const sent = call(0);
    expect(sent.url).toBe(`https://api.kirimdev.com/v1/${SENDER_ID}/messages`);
    expect(sent.init.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers.get("content-type")).toContain("application/json");
    expect(sent.headers.get("idempotency-key")).toBe(expectedKey());
    expect(sent.body).toEqual({
      messaging_product: "whatsapp",
      to: `+${RECIPIENT}`,
      type: "text",
      text: { body: TEXT },
    });
    expect(sent.init.signal).toBeDefined();
  });

  it("accepts 200 as success too", async () => {
    const { provider } = setup([json(200, okBody("sent"))]);
    await expect(provider.send(tenantWide, message())).resolves.toEqual({
      reference: "order-1001",
      accepted: true,
    });
  });

  it("uses a custom https base URL", async () => {
    const fetchMock = vi.fn<
      (url: unknown, init?: unknown) => Promise<Response>
    >(async () => json(202, okBody()));
    const provider = createKirimdevMessagingProvider({
      apiKey: API_KEY,
      baseUrl: "https://kirim.example.test",
      fetch: fetchMock as unknown as typeof fetch,
      resolveSender: async () => SENDER_ID,
      webhookSecrets: [SECRET],
    });
    await provider.send(tenantWide, message());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://kirim.example.test/v1/${SENDER_ID}/messages`,
    );
  });

  it("derives a stable Idempotency-Key from tenant, outlet and reference", async () => {
    const { provider, call } = setup([
      json(202, okBody()),
      json(202, okBody()),
      json(202, okBody()),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    await provider.send(tenantWide, message({ text: "teks lain" }));
    await provider.send(tenantWide, message({ reference: "order-1002" }));
    await provider.send(tenantWide, message({ outletId: OUTLET_B! }));
    const keys = [0, 1, 2, 3].map((i) =>
      call(i).headers.get("idempotency-key"),
    );
    // Same reference means the same message, whatever the text.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toBe(expectedKey());
    expect(keys[2]).toBe(expectedKey("order-1002"));
    expect(keys[3]).toBe(expectedKey("order-1001", OUTLET_B));
    expect(new Set([keys[0], keys[2], keys[3]]).size).toBe(3);
  });

  it("resolves the sender per call for the caller's context", async () => {
    const { provider, resolveSender } = setup([json(202, okBody())]);
    await provider.send(cashierA, message());
    // legend-nqxtb: the resolver also gets the accepted message's outlet, so
    // a per-outlet sender mapping can be looked up.
    expect(resolveSender).toHaveBeenCalledWith(cashierA, {
      outletId: OUTLET_A,
    });
  });

  it("passes each message's own outlet to the resolver", async () => {
    const { provider, resolveSender } = setup([
      json(202, okBody()),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message({ outletId: OUTLET_A! }));
    await provider.send(
      tenantWide,
      message({ outletId: OUTLET_B!, reference: "order-1002" }),
    );
    expect(resolveSender).toHaveBeenNthCalledWith(1, tenantWide, {
      outletId: OUTLET_A,
    });
    expect(resolveSender).toHaveBeenNthCalledWith(2, tenantWide, {
      outletId: OUTLET_B,
    });
  });
});

describe("send: retries", () => {
  it("retries a 429 after Retry-After and reuses the same Idempotency-Key", async () => {
    const { provider, call, sleeps, fetchMock } = setup([
      errorResponse(429, "rate_limit_exceeded", { "Retry-After": "2" }),
      json(202, okBody()),
    ]);
    await expect(provider.send(tenantWide, message())).resolves.toEqual({
      reference: "order-1001",
      accepted: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).headers.get("idempotency-key")).toBe(
      call(0).headers.get("idempotency-key"),
    );
    expect(call(1).body).toEqual(call(0).body);
    expect(sleeps).toHaveLength(1);
    // 2 s with jitter 0.75-1.25.
    expect(sleeps[0]).toBeGreaterThanOrEqual(1500);
    expect(sleeps[0]).toBeLessThanOrEqual(2500);
  });

  it("never waits much longer than 8 s, however large Retry-After is", async () => {
    const { provider, sleeps } = setup([
      errorResponse(429, "rate_limit_exceeded", { "Retry-After": "3600" }),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(10_000);
  });

  it("retries a 503 and then succeeds", async () => {
    const { provider, fetchMock, call } = setup([
      errorResponse(503, "service_unavailable", { "Retry-After": "1" }),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).headers.get("idempotency-key")).toBe(expectedKey());
  });

  it("retries a 502 whatsapp_upstream_error", async () => {
    const { provider, fetchMock } = setup([
      errorResponse(502, "whatsapp_upstream_error"),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 409 idempotency_in_progress with the same key", async () => {
    const { provider, fetchMock, call } = setup([
      errorResponse(409, "idempotency_in_progress"),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).headers.get("idempotency-key")).toBe(
      call(0).headers.get("idempotency-key"),
    );
  });

  it("retries a network error and then succeeds", async () => {
    const { provider, fetchMock } = setup([
      new TypeError("fetch failed"),
      json(202, okBody()),
    ]);
    await provider.send(tenantWide, message());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts (default 3) with a retryable error", async () => {
    const { provider, fetchMock } = setup([
      errorResponse(503, "service_unavailable"),
      errorResponse(503, "service_unavailable"),
      errorResponse(503, "service_unavailable"),
    ]);
    const error = await failure(provider.send(tenantWide, message()));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.status).toBe(503);
    expect(error.code).toBe("service_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.requestId).toBe("req_err");
  });

  it("honours a custom maxAttempts", async () => {
    const { provider, fetchMock } = setup(
      [errorResponse(502, "whatsapp_upstream_error"), json(202, okBody())],
      { maxAttempts: 1 },
    );
    const error = await failure(provider.send(tenantWide, message()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe("whatsapp_upstream_error");
    expect(error.retryable).toBe(true);
  });

  it("reports repeated network failures as code network, retryable, no status", async () => {
    const { provider, fetchMock } = setup([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const error = await failure(provider.send(tenantWide, message()));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe("network");
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("aborts a hung request after timeoutMs and reports code timeout", async () => {
    const hang = () =>
      new Promise<Response>(() => {
        /* never settles; only the abort signal ends the attempt */
      });
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) =>
      Promise.race([
        hang(),
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ]),
    );
    const provider = createKirimdevMessagingProvider({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      resolveSender: async () => SENDER_ID,
      webhookSecrets: [SECRET],
      timeoutMs: 25,
      maxAttempts: 1,
      sleep: async () => {},
    });
    const error = await failure(provider.send(tenantWide, message()));
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
    expect(error.status).toBeNull();
  });
});

describe("send: errors that must not be retried", () => {
  it.each([
    [400, "invalid_request"],
    [401, "invalid_api_key"],
    [402, "payment_required"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "outside_24h_window"],
    [422, "marketing_opted_out"],
    [422, "contact_blocked"],
    [422, "idempotency_key_reuse"],
  ])("%s %s is final after one call", async (status, code) => {
    const { provider, fetchMock, sleeps } = setup([
      errorResponse(status, code),
      json(202, okBody()),
    ]);
    const error = await failure(provider.send(tenantWide, message()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_err");
  });

  it("an outside_24h_window refusal is a clear, non-retryable error", async () => {
    const { provider } = setup([errorResponse(422, "outside_24h_window")]);
    const error = await failure(provider.send(tenantWide, message()));
    expect(error.name).toBeTruthy();
    expect(error.retryable).toBe(false);
  });

  it("a 2xx without data.id is invalid_response", async () => {
    for (const body of [
      { data: {}, request_id: "req_x" },
      { data: { id: 42 }, request_id: "req_x" },
      { request_id: "req_x" },
    ]) {
      const { provider } = setup([json(202, body)]);
      const error = await failure(provider.send(tenantWide, message()));
      expect(error.code).toBe("invalid_response");
    }
  });

  it("a 2xx that is not JSON is invalid_response", async () => {
    const { provider } = setup([
      new Response("<html>ok</html>", { status: 202 }),
    ]);
    const error = await failure(provider.send(tenantWide, message()));
    expect(error.code).toBe("invalid_response");
  });
});

describe("send: fail closed before any HTTP call", () => {
  it.each([
    "../admin",
    "pn/other",
    "pn?x=1",
    "pn#frag",
    "pn id",
    "pn%2Fother",
    "p".repeat(65),
  ])(
    "a sender that is not a plain token (%s) -> no_sender and no fetch",
    async (sender) => {
      const { provider, fetchMock } = setup([json(202, okBody())], { sender });
      const error = await failure(provider.send(tenantWide, message()));
      expect(error.code).toBe("no_sender");
      expect(error.retryable).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("never follows a redirect (the bearer token would travel with it)", async () => {
    const { provider, fetchMock, call } = setup([json(202, okBody())]);
    await provider.send(tenantWide, message());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).init.redirect).toBe("error");
  });

  it("no sender number for the tenant -> no_sender and no fetch", async () => {
    const { provider, fetchMock } = setup([json(202, okBody())], {
      sender: null,
    });
    const error = await failure(provider.send(tenantWide, message()));
    expect(error.code).toBe("no_sender");
    expect(error.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a message for another tenant than the caller's context", async () => {
    const { provider, fetchMock } = setup([json(202, okBody())]);
    await expect(
      provider.send(otherTenantContext, message()),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an outlet outside the caller's outlet scope", async () => {
    const { provider, fetchMock } = setup([json(202, okBody())]);
    await expect(
      provider.send(cashierA, message({ outletId: OUTLET_B! })),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an untrusted (hand-built) context", async () => {
    const { provider, fetchMock } = setup([json(202, okBody())]);
    const forged = {
      tenant: { tenantId: TENANT_ID, brandId: null, source: "session" },
      outletScope: { kind: "tenant", tenantId: TENANT_ID },
    };
    await expect(
      provider.send(forged as never, message()),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["recipient with a plus sign", { recipient: "+628123456789" }],
    ["recipient with spaces", { recipient: "0812 3456 789" }],
    ["empty text", { text: "" }],
    ["text over 4096 characters", { text: "x".repeat(4097) }],
    ["unknown field", { to: "628123456789" }],
  ])("rejects invalid input: %s", async (_name, overrides) => {
    const { provider, fetchMock } = setup([json(202, okBody())]);
    await expect(
      provider.send(tenantWide, message(overrides)),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("send: nothing sensitive leaks through errors or logs", () => {
  const secrets = [RECIPIENT, TEXT, API_KEY, "Budi", "Authorization"];

  it("keeps number, text, token and response body out of every error", async () => {
    const outputs: string[] = [];
    for (const [status, code] of [
      [422, "outside_24h_window"],
      [401, "invalid_api_key"],
      [400, "invalid_request"],
    ] as const) {
      const { provider } = setup([errorResponse(status, code)]);
      const error = await failure(provider.send(tenantWide, message()));
      outputs.push(error.message, String(error), JSON.stringify(error));
    }
    for (const attempt of [
      setup([new TypeError(`fetch failed for +${RECIPIENT} ${TEXT}`)], {
        maxAttempts: 1,
      }),
      setup([errorResponse(503, "service_unavailable")], { maxAttempts: 1 }),
      setup([json(202, { data: {}, note: `${RECIPIENT} ${TEXT}` })]),
      setup([json(202, okBody())], { sender: null }),
    ]) {
      const error = await failure(attempt.provider.send(tenantWide, message()));
      outputs.push(error.message, String(error), JSON.stringify(error));
    }
    const all = outputs.join("\n");
    for (const secret of secrets) expect(all).not.toContain(secret);
  });

  it("writes nothing sensitive to the console or stdout while sending and failing", async () => {
    const written: string[] = [];
    const record = (...args: unknown[]) => {
      written.push(args.map(String).join(" "));
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation(record);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      record(chunk);
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      record(chunk);
      return true;
    }) as never);

    const ok = setup([
      errorResponse(503, "service_unavailable"),
      json(202, okBody()),
    ]);
    await ok.provider.send(tenantWide, message());
    const bad = setup([errorResponse(422, "outside_24h_window")]);
    await failure(bad.provider.send(tenantWide, message()));
    vi.restoreAllMocks();

    const all = written.join("\n");
    for (const secret of secrets) expect(all).not.toContain(secret);
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: {} }] }] });
  const eventHeaders = (signature: string | undefined) => ({
    ...(signature === undefined ? {} : { "x-kirim-signature": signature }),
    "x-kirim-event-id": "wamid.TEST1",
  });
  const verify = (
    signature: string | undefined,
    options: { secrets?: readonly string[]; rawBody?: string } = {},
  ) =>
    setup([], {
      webhookSecrets: options.secrets ?? [SECRET],
    }).provider.verifyWebhook({
      rawBody: options.rawBody ?? body,
      headers: eventHeaders(signature),
    });
  const sign = (secret: string, timestamp: number, rawBody = body) =>
    signKirimWebhook({ rawBody, secret, timestamp });

  it("accepts a valid signature and returns the event id", async () => {
    const result = await verify(await sign(SECRET, NOW));
    expect(result.eventId).toBe("wamid.TEST1");
    expect(result.signedAt).toBe(NOW);
  });

  it("accepts either secret while rotating (two secrets configured)", async () => {
    const secrets = [SECRET, OLD_SECRET];
    await expect(
      verify(await sign(SECRET, NOW), { secrets }),
    ).resolves.toBeDefined();
    await expect(
      verify(await sign(OLD_SECRET, NOW), { secrets }),
    ).resolves.toBeDefined();
  });

  it("accepts a header carrying two v1 signatures when one secret matches", async () => {
    const current = await sign(SECRET, NOW);
    const previous = await sign(OLD_SECRET, NOW);
    const both = `${previous},v1=${current.split("v1=")[1]}`;
    await expect(verify(both)).resolves.toBeDefined();
  });

  it("rejects a secret that was rotated out", async () => {
    await expect(
      verify(await sign(OLD_SECRET, NOW), { secrets: [SECRET] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a wrong secret, a tampered body and a missing or malformed header", async () => {
    await expect(verify(await sign("wrong", NOW))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      verify(await sign(SECRET, NOW), { rawBody: body.replace("{}", "[]") }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verify(undefined)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(verify("garbage")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(verify(`t=${NOW},v1=${"a".repeat(64)}`)).rejects.toMatchObject(
      {
        code: "UNAUTHORIZED",
      },
    );
  });

  it("rejects a timestamp older than 300 s, accepts exactly 300 s", async () => {
    await expect(verify(await sign(SECRET, NOW - 301))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(verify(await sign(SECRET, NOW - 300))).resolves.toBeDefined();
  });

  it("rejects a timestamp more than 300 s in the future, accepts exactly 300 s", async () => {
    await expect(verify(await sign(SECRET, NOW + 301))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(verify(await sign(SECRET, NOW + 300))).resolves.toBeDefined();
  });

  it("rejects an empty secret list instead of accepting everything", async () => {
    const signature = await sign(SECRET, NOW);
    await expect(
      (async () =>
        setup([], { webhookSecrets: [] }).provider.verifyWebhook({
          rawBody: body,
          headers: eventHeaders(signature),
        }))(),
    ).rejects.toBeInstanceOf(Error);
  });
});

// The platform-mapping resolver (kirimdevSenderFromPlatformMapping) is tested
// against a real database in kirimdev-sender-mapping.test.ts.
