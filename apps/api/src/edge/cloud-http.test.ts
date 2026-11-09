// Unit tests for the edge's cloud HTTP fetcher (bead legend-2lp.7). fetch is
// injected; nothing touches the network.
import { describe, expect, it, vi } from "vitest";
import {
  EdgeCloudHttpError,
  cloudHttpBaseUrl,
  createDeviceRecordsFetcher,
} from "./cloud-http.ts";

const CREDENTIAL = "edg1.tenant.outlet.node.s3cr3t-value";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetcherWith(
  fetchImpl: typeof fetch,
  extra: { timeoutMs?: number; limit?: number } = {},
) {
  return createDeviceRecordsFetcher({
    cloudUrl: "wss://cloud.example.com/api/edge-link",
    credential: CREDENTIAL,
    fetchImpl,
    ...extra,
  });
}

describe("cloudHttpBaseUrl", () => {
  it("legend-2lp.7 maps wss to https and ws to http, keeping the port", () => {
    expect(cloudHttpBaseUrl("wss://cloud.example.com/api/edge-link")).toBe(
      "https://cloud.example.com",
    );
    expect(cloudHttpBaseUrl("wss://cloud.example.com:8443/api/edge-link")).toBe(
      "https://cloud.example.com:8443",
    );
    expect(cloudHttpBaseUrl("ws://localhost:3001/api/edge-link")).toBe(
      "http://localhost:3001",
    );
  });

  it("legend-2lp.7 rejects non-websocket and invalid URLs", () => {
    expect(() => cloudHttpBaseUrl("https://cloud.example.com")).toThrow();
    expect(() => cloudHttpBaseUrl("not a url")).toThrow();
  });
});

describe("createDeviceRecordsFetcher", () => {
  it("legend-2lp.7 sends GET with bearer credential, limit, no since on first pull", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    );
    expect(result).toEqual({ data: [] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit & { cache?: string },
    ];
    expect(url).toBe(
      "https://cloud.example.com/api/edge-sync/device-records?limit=100&receiptSequences=1",
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${CREDENTIAL}`,
      Accept: "application/json",
    });
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
  });

  it("legend-2lp.7 url-encodes since and honours a custom limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const since = "2026-11-08T10:00:00.000Z|id/1+2";
    await fetcherWith(fetchImpl as unknown as typeof fetch, { limit: 25 })(
      since,
      new AbortController().signal,
    );
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("since")).toBe(since);
    expect(url.searchParams.get("limit")).toBe("25");
    // legend-3yqy: the edge always opts in to device receipt sequences.
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.search).toContain("since=2026-11-08T10%3A00%3A00.000Z");
    expect(url.toString()).not.toContain(CREDENTIAL);
  });

  it("legend-2lp.7 non-2xx becomes EdgeCloudHttpError with the status code only", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("secret body " + CREDENTIAL, { status: 503 }),
    );
    const error = await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).name).toBe("EdgeCloudHttpError");
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_503");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain(CREDENTIAL);
  });

  it("legend-2lp.7 a network failure never leaks the credential or the cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${CREDENTIAL}`);
    });
    const error = (await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e)) as EdgeCloudHttpError;
    expect(error.code).toBe("NETWORK");
    expect(error.message).not.toContain(CREDENTIAL);
    expect(error.cause).toBeUndefined();
  });

  it("legend-2lp.7 invalid JSON on a 200 is BAD_JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    );
    const error = (await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e)) as EdgeCloudHttpError;
    expect(error.code).toBe("BAD_JSON");
  });

  it("legend-2lp.7 times out as TIMEOUT", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const error = (await fetcherWith(fetchImpl as unknown as typeof fetch, {
      timeoutMs: 10,
    })(null, new AbortController().signal).catch(
      (e: unknown) => e,
    )) as EdgeCloudHttpError;
    expect(error.code).toBe("TIMEOUT");
  });

  it("legend-2lp.7 a caller abort cancels the request and reports ABORTED", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      controller.signal,
    ).catch((e: unknown) => e);
    controller.abort();
    expect(((await pending) as EdgeCloudHttpError).code).toBe("ABORTED");
  });
});
