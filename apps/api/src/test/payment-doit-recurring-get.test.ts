// Bead 965 (P3): read-only GETs of the DOIT recurring client against the
// ASSUMED contract. Pure: injected fetch, no DB and no network.
import { describe, expect, it, vi } from "vitest";
import { createDoitRecurringClient } from "../services/payment-doit-recurring";

const SECRET = "doit_key_super_secret";
const sub = {
  id: "sub_1",
  plan_id: "plan_1",
  status: "active",
  first_invoice_url: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  lookup?: Parameters<typeof createDoitRecurringClient>[0]["lookup"],
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call.url, call.init);
  }) as unknown as typeof fetch;
  const client = createDoitRecurringClient({
    apiKey: SECRET,
    fetch: fetchFn,
    lookup,
  });
  return { client, calls };
}

describe("getSubscription", () => {
  it("GETs the encoded id without a body or Idempotency-Key", async () => {
    const { client, calls } = clientWith(() => json(sub));
    const answer = await client.getSubscription("sub/1 x");
    expect(answer).toEqual({ ...sub, reference: null });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.endsWith("/v1/recurring/subscriptions/sub%2F1%20x")).toBe(true);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("maps provider errors without leaking body or key", async () => {
    const { client } = clientWith(
      () => new Response(`boom ${SECRET}`, { status: 500 }),
    );
    const error = await client.getSubscription("sub_1").catch((e) => e);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(String(error.message)).not.toContain(SECRET);
    expect(String(error.message)).not.toContain("boom");
  });

  it("rejects a malformed answer", async () => {
    const { client } = clientWith(() => json({ id: "sub_1" }));
    const error = await client.getSubscription("sub_1").catch((e) => e);
    expect(error.code).toBeDefined();
    expect(error.message).not.toContain("sub_1");
  });

  it("fails closed when the host resolves to a blocked address", async () => {
    const { client, calls } = clientWith(
      () => json(sub),
      async () => [{ address: "127.0.0.1" }],
    );
    await expect(client.getSubscription("sub_1")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(calls).toHaveLength(0);
  });

  it("turns a network failure into SERVICE_UNAVAILABLE", async () => {
    const { client } = clientWith(() => {
      throw new Error(`socket ${SECRET}`);
    });
    const error = await client.getSubscription("sub_1").catch((e) => e);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(String(error.message)).not.toContain(SECRET);
  });
});

describe("findSubscriptionByReference", () => {
  const reference = "0b0b3c9e-5a6f-4f0e-9d5e-0f3f6f0e1a11";

  it("GETs by reference and returns the array", async () => {
    const { client, calls } = clientWith(() => json({ data: [sub] }));
    const answer = await client.findSubscriptionByReference(reference);
    expect(answer).toEqual([{ ...sub, reference: null }]);
    const { url, init } = calls[0]!;
    expect(
      url.endsWith(`/v1/recurring/subscriptions?reference=${reference}`),
    ).toBe(true);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(
      (init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeUndefined();
  });

  it("returns an empty array when DOIT has none", async () => {
    const { client } = clientWith(() => json({ data: [] }));
    expect(await client.findSubscriptionByReference(reference)).toEqual([]);
  });

  it("encodes the reference in the query", async () => {
    const { client, calls } = clientWith(() => json({ data: [] }));
    await client.findSubscriptionByReference("a&b=c");
    expect(calls[0]!.url.endsWith("?reference=a%26b%3Dc")).toBe(true);
  });

  it("throws, never returns empty, on a provider error", async () => {
    const { client } = clientWith(() => new Response("{}", { status: 503 }));
    await expect(
      client.findSubscriptionByReference(reference),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("throws on a bare array or one malformed entry", async () => {
    const bare = clientWith(() => json([sub]));
    await expect(
      bare.client.findSubscriptionByReference(reference),
    ).rejects.toBeDefined();
    const partial = clientWith(() => json({ data: [sub, { id: "x" }] }));
    await expect(
      partial.client.findSubscriptionByReference(reference),
    ).rejects.toBeDefined();
  });
});
