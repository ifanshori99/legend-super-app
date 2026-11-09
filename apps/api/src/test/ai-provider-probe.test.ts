// Tenant AI provider plumbing without DB or network (bead legend-dwrr): the
// guarded fetch, the connection probe, the network seam, and the tenant
// provider factory. fetch and the host resolver are doubles.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuardedFetch,
  toFetchResponse,
} from "../lib/ai/guarded-fetch.ts";
import { isBlockedIp } from "../lib/ai/url-guard.ts";
import { probeOpenAiCompatible } from "../lib/ai/provider-probe.ts";
import {
  aiProviderNetwork,
  buildTenantAiProvider,
  isAiProviderOverridden,
  setAiProviderForTests,
  setAiProviderNetworkForTests,
} from "../lib/ai/provider-factory.ts";
import { createFakeProvider } from "../lib/ai/fake.ts";
import {
  currentSealVersion,
  openSecret,
  sealSecret,
  sealedVersion,
} from "../lib/secrets.ts";

const KEY = "sk-test-0123456789abcdef";
const publicHost = async () => [{ address: "93.184.216.34", family: 4 }];
const privateHost = async () => [{ address: "10.0.0.5", family: 4 }];

function probe(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof probeOpenAiCompatible>[0]> = {},
) {
  return probeOpenAiCompatible({
    baseUrl: "https://llm.example.com/v1",
    apiKey: KEY,
    model: "gpt-test",
    timeoutMs: 5000,
    fetch: fetchImpl,
    resolve: publicHost,
    ...overrides,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  setAiProviderNetworkForTests(null);
  setAiProviderForTests(undefined);
});

describe("guarded fetch", () => {
  it("refuses a name that resolves to a private address", async () => {
    const guarded = createGuardedFetch(privateHost);
    await expect(guarded("https://llm.example.com/v1")).rejects.toMatchObject({
      code: "EAI_BLOCKED",
    });
  });

  it("refuses when any resolved address is private", async () => {
    const guarded = createGuardedFetch(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(guarded("https://llm.example.com/v1")).rejects.toMatchObject({
      code: "EAI_BLOCKED",
    });
  });

  it("refuses IP literals in blocked ranges without resolving", async () => {
    const resolve = vi.fn(publicHost);
    const guarded = createGuardedFetch(resolve);
    for (const url of [
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
    ])
      await expect(guarded(url)).rejects.toMatchObject({
        code: "EAI_BLOCKED",
      });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows https only", async () => {
    const guarded = createGuardedFetch(publicHost);
    await expect(guarded("http://llm.example.com/v1")).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("rejects with the abort reason when already aborted", async () => {
    const guarded = createGuardedFetch(publicHost);
    const signal = AbortSignal.abort();
    await expect(
      guarded("https://llm.example.com/v1", { signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("toFetchResponse builds a Response for a normal status", async () => {
    const response = toFetchResponse(
      200,
      new Headers({ "content-type": "text/plain" }),
      Buffer.from("hi"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi");
    expect(
      toFetchResponse(204, new Headers(), Buffer.from("x")).body,
    ).toBeNull();
  });

  it("toFetchResponse throws a plain Error for a status outside 200-599", () => {
    for (const status of [0, 100, 101, 199, 600, 999])
      expect(() =>
        toFetchResponse(status, new Headers(), Buffer.alloc(0)),
      ).toThrow(/status/i);
  });
});

describe("isBlockedIp", () => {
  it("blocks the local NAT64 range 64:ff9b:1::/48 and the well-known one", () => {
    expect(isBlockedIp("64:ff9b:1::1")).toBe(true);
    expect(isBlockedIp("64:ff9b:1:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isBlockedIp("64:ff9b::808:808")).toBe(true);
  });

  it("still allows a public IPv4 and IPv6 address", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("probeOpenAiCompatible", () => {
  it("returns ok for a 2xx with choices and sends key, model, no redirects", async () => {
    const fetchMock = vi.fn(async () =>
      json({ choices: [{ message: { content: "OK" } }] }),
    );
    const result = await probe(fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "ok", errorCode: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-test", stream: false });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it.each([
    [200, { nope: true }, "BAD_RESPONSE"],
    [401, { error: "bad key sk-secret" }, "AUTH_FAILED"],
    [403, {}, "AUTH_FAILED"],
    [404, {}, "NOT_FOUND"],
    [400, {}, "REQUEST_REJECTED"],
    [422, {}, "REQUEST_REJECTED"],
    [429, {}, "RATE_LIMITED"],
    [500, {}, "PROVIDER_ERROR"],
    [503, {}, "PROVIDER_ERROR"],
  ])("maps status %i to %s", async (status, body, code) => {
    const result = await probe((async () =>
      json(body, status)) as unknown as typeof fetch);
    expect(result).toEqual({ status: "failed", errorCode: code });
  });

  it("returns BAD_RESPONSE for broken JSON", async () => {
    const result = await probe(
      (async () =>
        new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    );
    expect(result).toEqual({ status: "failed", errorCode: "BAD_RESPONSE" });
  });

  it("treats a 302 as REDIRECT_REFUSED and never fetches the target", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.net/steal" },
        }),
    );
    const result = await probe(fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ status: "failed", errorCode: "REDIRECT_REFUSED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://169.254.169.254/v1",
    "https://localhost/v1",
    "http://llm.example.com/v1",
  ])("blocks %s without fetching", async (baseUrl) => {
    const fetchMock = vi.fn();
    const result = await probe(fetchMock as unknown as typeof fetch, {
      baseUrl,
    });
    expect(result).toEqual({ status: "failed", errorCode: "URL_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a name that resolves to a private address", async () => {
    const fetchMock = vi.fn();
    const result = await probe(fetchMock as unknown as typeof fetch, {
      resolve: privateHost,
    });
    expect(result).toEqual({ status: "failed", errorCode: "URL_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a connect-time EAI_BLOCKED to URL_BLOCKED", async () => {
    const result = await probe((async () => {
      throw Object.assign(new Error("blocked"), { code: "EAI_BLOCKED" });
    }) as unknown as typeof fetch);
    expect(result).toEqual({ status: "failed", errorCode: "URL_BLOCKED" });
  });

  it("maps timeout and abort errors to TIMEOUT", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const result = await probe((async () => {
        throw Object.assign(new Error("slow"), { name });
      }) as unknown as typeof fetch);
      expect(result).toEqual({ status: "failed", errorCode: "TIMEOUT" });
    }
  });

  it("maps other throws to NETWORK_ERROR and never leaks key or message", async () => {
    const result = await probe((async () => {
      throw new Error(`connect failed with ${KEY}`);
    }) as unknown as typeof fetch);
    expect(result).toEqual({ status: "failed", errorCode: "NETWORK_ERROR" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("caps the timeout signal at 15 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await probe(
      (async () => json({ choices: [] })) as unknown as typeof fetch,
      {
        timeoutMs: 120_000,
      },
    );
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it("uses the shared network seam by default", async () => {
    const fetchMock = vi.fn(async () => json({ choices: [] }));
    setAiProviderNetworkForTests({
      fetch: fetchMock as unknown as typeof fetch,
      resolve: publicHost,
    });
    const result = await probeOpenAiCompatible({
      baseUrl: "https://llm.example.com/v1",
      apiKey: KEY,
      model: "gpt-test",
      timeoutMs: 5000,
    });
    expect(result.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("provider factory seams", () => {
  it("restores the default network after a null reset", () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    setAiProviderNetworkForTests({ fetch: fetchMock, resolve: publicHost });
    expect(aiProviderNetwork().fetch).toBe(fetchMock);
    setAiProviderNetworkForTests(null);
    expect(aiProviderNetwork().fetch).not.toBe(fetchMock);
  });

  it("reports whether a test provider overrides the env one", () => {
    expect(isAiProviderOverridden()).toBe(false);
    setAiProviderForTests(null);
    expect(isAiProviderOverridden()).toBe(true);
    setAiProviderForTests(createFakeProvider());
    expect(isAiProviderOverridden()).toBe(true);
    setAiProviderForTests(undefined);
    expect(isAiProviderOverridden()).toBe(false);
  });

  it("builds a tenant provider that calls the tenant URL, key, and model", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        choices: [{ message: { content: "halo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    setAiProviderNetworkForTests({
      fetch: fetchMock as unknown as typeof fetch,
      resolve: publicHost,
    });
    const provider = buildTenantAiProvider({
      baseUrl: "https://tenant.example.com/v1/",
      apiKey: KEY,
      model: "tenant-model",
    });
    await provider.complete({
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 16,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://tenant.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(init.body as string).model).toBe("tenant-model");
    expect(init.redirect).toBe("error");
  });

  it("refuses a tenant URL that resolves to a private address, without fetching", async () => {
    const fetchMock = vi.fn();
    setAiProviderNetworkForTests({
      fetch: fetchMock as unknown as typeof fetch,
      resolve: privateHost,
    });
    const provider = buildTenantAiProvider({
      baseUrl: "https://tenant.example.com/v1",
      apiKey: KEY,
      model: "m",
    });
    await expect(
      provider.complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        maxTokens: 16,
      }),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("seal version helpers", () => {
  it("reads the envelope version and matches the current one", () => {
    const sealed = sealSecret(KEY, "ai_provider_config:t:r");
    expect(sealedVersion(sealed)).toBe(currentSealVersion());
    expect(openSecret(sealed, "ai_provider_config:t:r")).toBe(KEY);
  });

  it("rejects an empty envelope", () => {
    expect(() => sealedVersion("")).toThrow();
  });
});
