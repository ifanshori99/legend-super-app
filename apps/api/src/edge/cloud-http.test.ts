// Unit tests for the edge's cloud HTTP fetcher (bead legend-2lp.7). fetch is
// injected; nothing touches the network.
import { describe, expect, it, vi } from "vitest";
import type { ReceiptRunRefusalReason } from "@starter/shared/edge";
import {
  EdgeCloudHttpError,
  cloudGetJson,
  cloudHttpBaseUrl,
  createDeviceRecordsFetcher,
} from "./cloud-http.ts";

const INSTANCE = "0b6f4c1e-8f3a-4f55-9a52-3f1d2c4b5a60";
const CREDENTIAL = "edg1.tenant.outlet.node.s3cr3t-value";
// legend-hfq3z: refused run ids (RUN_A sorts before RUN_B).
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

/** A fetcher with an edge instance, as the edge runtime builds it. */
function refusalFetcher(fetchImpl: typeof fetch) {
  return createDeviceRecordsFetcher({
    cloudUrl: "wss://cloud.example.com/api/edge-link",
    credential: CREDENTIAL,
    fetchImpl,
    edgeInstanceId: INSTANCE,
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

  it("legend-zsdd sends edgeInstance next to receiptSequences when set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal);
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.searchParams.get("edgeInstance")).toBe(INSTANCE);
  });

  it("legend-zsdd HTTP 400 on a request with edgeInstance retries once without it and without receiptSequences", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })("v1", new AbortController().signal);
    expect(result).toEqual({ data: [] });
    // receiptWriteoffs retry, then the edgeInstance retry.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    const second = new URL((fetchImpl.mock.calls[2] as unknown as [string])[0]);
    expect(first.searchParams.get("edgeInstance")).toBe(INSTANCE);
    expect(second.searchParams.has("edgeInstance")).toBe(false);
    expect(second.searchParams.has("receiptSequences")).toBe(false);
    expect(second.searchParams.get("since")).toBe("v1");
    expect(second.searchParams.get("limit")).toBe("100");
  });

  it("legend-zsdd a second failure after the retry is thrown (HTTP_400 stays visible)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }));
    const error = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");

    const other = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const second = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: other as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal).catch((e: unknown) => e);
    expect((second as EdgeCloudHttpError).code).toBe("HTTP_503");
  });

  it("legend-yd0h8 sends the receipt run report sorted, and an empty report as an empty param", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const fetcher = createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    });
    await fetcher(
      null,
      new AbortController().signal,
      new Map([
        ["P3", 7],
        ["P1", 150],
      ]),
    );
    await fetcher(null, new AbortController().signal, new Map());
    await fetcher(null, new AbortController().signal);
    const urls = fetchImpl.mock.calls.map(
      (call) => new URL((call as unknown as [string])[0]),
    );
    expect(urls[0]!.searchParams.get("receiptRuns")).toBe("P1:150,P3:7");
    expect(urls[1]!.searchParams.get("receiptRuns")).toBe("");
    expect(urls[2]!.searchParams.has("receiptRuns")).toBe(false);
  });

  it("legend-yd0h8 HTTP 400 on a request with receiptRuns retries with edgeInstance but without receiptRuns", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })("v1", new AbortController().signal, new Map([["P1", 3]]));
    expect(result).toEqual({ data: [] });
    // receiptWriteoffs retry (still carries receiptRuns), then without receiptRuns.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    const second = new URL((fetchImpl.mock.calls[2] as unknown as [string])[0]);
    expect(first.searchParams.get("receiptRuns")).toBe("P1:3");
    expect(second.searchParams.has("receiptRuns")).toBe(false);
    expect(second.searchParams.get("receiptSequences")).toBe("1");
    expect(second.searchParams.get("edgeInstance")).toBe(INSTANCE);
    expect(second.searchParams.get("since")).toBe("v1");
  });

  it("legend-yd0h8 a second 400 retries without sequences and edgeInstance; a third failure is thrown", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal, new Map([["P1", 3]]));
    expect(result).toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const third = new URL((fetchImpl.mock.calls[3] as unknown as [string])[0]);
    expect(third.searchParams.has("receiptRuns")).toBe(false);
    expect(third.searchParams.has("edgeInstance")).toBe(false);
    expect(third.searchParams.has("receiptSequences")).toBe(false);

    const failing = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: failing as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal, new Map()).catch((e: unknown) => e);
    // receiptWriteoffs, receiptRuns, receiptRuns dropped, sequences dropped.
    expect(failing).toHaveBeenCalledTimes(4);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
  });

  it("legend-yd0h8 a non-400 failure on the receiptRuns request is not retried", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    const error = await createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      edgeInstanceId: INSTANCE,
    })(null, new AbortController().signal, new Map()).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_503");
  });

  // ---- legend-hfq3z: the receipt run refusal report (`receiptRefused`) -------
  // Assumption: `receiptRefused` is sent only together with receiptSequences=1
  // (brief point 2); ids are written lowercase and sorted by the codec.

  it("legend-hfq3z sends receiptRefused (sorted, lowercase) next to receiptSequences, edgeInstance and receiptRuns", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
      new Map([["P1", 0]]),
      new Map<string, ReceiptRunRefusalReason>([
        [RUN_B.toUpperCase(), "id_used"],
        [RUN_A, "prefix_used"],
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("receiptRefused")).toBe(
      `${RUN_A}:prefix_used,${RUN_B}:id_used`,
    );
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.searchParams.get("edgeInstance")).toBe(INSTANCE);
    expect(url.searchParams.get("receiptRuns")).toBe("P1:0");
    expect(url.searchParams.get("since")).toBe("v1");
  });

  it("legend-hfq3z sends no receiptRefused without refusals: absent, undefined or an empty report (old behaviour)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const fetcher = refusalFetcher(fetchImpl as unknown as typeof fetch);
    const signal = new AbortController().signal;
    await fetcher(null, signal, new Map([["P1", 2]]));
    await fetcher(null, signal, new Map([["P1", 2]]), undefined);
    await fetcher(null, signal, new Map([["P1", 2]]), new Map());
    await fetcher(null, signal);
    const urls = fetchImpl.mock.calls.map(
      (call) => new URL((call as unknown as [string])[0]),
    );
    expect(urls).toHaveLength(4);
    for (const url of urls)
      expect(url.searchParams.has("receiptRefused")).toBe(false);
    // The yd0h8 report is unchanged by the empty refusal report.
    expect(urls[2]!.searchParams.get("receiptRuns")).toBe("P1:2");
    expect(urls[0]!.toString()).toBe(urls[2]!.toString());
  });

  it("legend-hfq3z refusals alone (no receiptRuns) are still sent with the sequences", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      undefined,
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "prefix_used"]]),
    );
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("receiptRefused")).toBe(`${RUN_A}:prefix_used`);
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.searchParams.has("receiptRuns")).toBe(false);
  });

  it("legend-hfq3z HTTP 400 on a request with receiptRefused retries once without it, keeping receiptRuns, edgeInstance and sequences", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
      new Map([["P1", 3]]),
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "prefix_used"]]),
    );
    expect(result).toEqual({ data: [] });
    // receiptWriteoffs retry (still carries receiptRefused), then without it.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    const second = new URL((fetchImpl.mock.calls[2] as unknown as [string])[0]);
    expect(first.searchParams.get("receiptRefused")).toBe(
      `${RUN_A}:prefix_used`,
    );
    expect(second.searchParams.has("receiptRefused")).toBe(false);
    expect(second.searchParams.get("receiptRuns")).toBe("P1:3");
    expect(second.searchParams.get("receiptSequences")).toBe("1");
    expect(second.searchParams.get("edgeInstance")).toBe(INSTANCE);
    expect(second.searchParams.get("since")).toBe("v1");
    expect(second.searchParams.get("limit")).toBe("100");
  });

  it("legend-hfq3z a second 400 continues the old chain: without receiptRuns, then without sequences and edgeInstance", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map([["P1", 3]]),
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "id_used"]]),
    );
    expect(result).toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const urls = fetchImpl.mock.calls.map(
      (call) => new URL((call as unknown as [string])[0]),
    );
    expect(urls[2]!.searchParams.has("receiptRefused")).toBe(false);
    expect(urls[2]!.searchParams.get("receiptRuns")).toBe("P1:3");
    expect(urls[3]!.searchParams.has("receiptRefused")).toBe(false);
    expect(urls[3]!.searchParams.has("receiptRuns")).toBe(false);
    expect(urls[3]!.searchParams.get("receiptSequences")).toBe("1");
    expect(urls[3]!.searchParams.get("edgeInstance")).toBe(INSTANCE);
    for (const key of [
      "receiptRefused",
      "receiptRuns",
      "receiptSequences",
      "edgeInstance",
    ])
      expect(urls[4]!.searchParams.has(key), key).toBe(false);
  });

  it("legend-hfq3z refusals without receiptRuns: after the retry without them, the old chain drops the sequences; a final 400 is thrown", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const refusals = new Map<string, ReceiptRunRefusalReason>([
      [RUN_A, "prefix_used"],
    ]);
    await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      undefined,
      refusals,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const third = new URL((fetchImpl.mock.calls[3] as unknown as [string])[0]);
    expect(third.searchParams.has("receiptRefused")).toBe(false);
    expect(third.searchParams.has("receiptSequences")).toBe(false);
    expect(third.searchParams.has("edgeInstance")).toBe(false);

    const failing = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await refusalFetcher(failing as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map([["P1", 1]]),
      refusals,
    ).catch((e: unknown) => e);
    // receiptWriteoffs, refusals, receiptRuns, sequences.
    expect(failing).toHaveBeenCalledTimes(5);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
  });

  it("legend-hfq3z a non-400 failure is not retried, on the first request or on the retry without receiptRefused", async () => {
    const refusals = new Map<string, ReceiptRunRefusalReason>([
      [RUN_A, "prefix_used"],
    ]);
    const first = vi.fn(async () => new Response("{}", { status: 503 }));
    const firstError = await refusalFetcher(first as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map(),
      refusals,
    ).catch((e: unknown) => e);
    expect(first).toHaveBeenCalledTimes(1);
    expect((firstError as EdgeCloudHttpError).code).toBe("HTTP_503");

    const retry = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const retryError = await refusalFetcher(retry as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map(),
      refusals,
    ).catch((e: unknown) => e);
    expect(retry).toHaveBeenCalledTimes(3);
    expect((retryError as EdgeCloudHttpError).code).toBe("HTTP_503");
  });

  it("legend-hfq3z HTTP 400 without an edgeInstance is not retried, even with refusals", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map(),
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "prefix_used"]]),
    ).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
  });

  // ---- legend-jcby0: the receipt write-off opt-in (`receiptWriteoffs`) -------

  it("legend-jcby0 the first request sends receiptWriteoffs=1 next to receiptSequences and edgeInstance", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
      new Map([["P1", 3]]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("receiptWriteoffs")).toBe("1");
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.searchParams.get("edgeInstance")).toBe(INSTANCE);
  });

  it("legend-jcby0 a fetcher without an edgeInstance never sends receiptWriteoffs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await fetcherWith(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
      new Map([["P1", 3]]),
    );
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("receiptSequences")).toBe("1");
    expect(url.searchParams.has("receiptWriteoffs")).toBe(false);
  });

  it("legend-jcby0 HTTP 400 retries once without only receiptWriteoffs, keeping receiptRuns, receiptRefused, edgeInstance and sequences", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
      new Map([["P1", 3]]),
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "prefix_used"]]),
    );
    expect(result).toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    const second = new URL((fetchImpl.mock.calls[1] as unknown as [string])[0]);
    expect(first.searchParams.get("receiptWriteoffs")).toBe("1");
    expect(second.searchParams.has("receiptWriteoffs")).toBe(false);
    // E2 asks for token hashes with the write-offs, so the retry drops both.
    expect(first.searchParams.get("deviceTokenHashes")).toBe("1");
    expect(second.searchParams.has("deviceTokenHashes")).toBe(false);
    // Everything else is the same request.
    first.searchParams.delete("receiptWriteoffs");
    first.searchParams.delete("deviceTokenHashes");
    expect(second.toString()).toBe(first.toString());
    expect(second.searchParams.get("receiptRuns")).toBe("P1:3");
    expect(second.searchParams.get("receiptRefused")).toBe(
      `${RUN_A}:prefix_used`,
    );
    expect(second.searchParams.get("receiptSequences")).toBe("1");
    expect(second.searchParams.get("edgeInstance")).toBe(INSTANCE);
  });

  it("legend-jcby0 two 400s continue into the old chain and no later request sends receiptWriteoffs; a final 400 is thrown", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
      new Map([["P1", 3]]),
      new Map<string, ReceiptRunRefusalReason>([[RUN_A, "id_used"]]),
    );
    expect(result).toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const urls = fetchImpl.mock.calls.map(
      (call) => new URL((call as unknown as [string])[0]),
    );
    expect(urls[0]!.searchParams.get("receiptWriteoffs")).toBe("1");
    for (const url of urls.slice(1))
      expect(url.searchParams.has("receiptWriteoffs")).toBe(false);
    // The chain after the write-off retry is unchanged.
    expect(urls[1]!.searchParams.get("receiptRefused")).toBe(
      `${RUN_A}:id_used`,
    );
    expect(urls[2]!.searchParams.has("receiptRefused")).toBe(false);
    expect(urls[2]!.searchParams.get("receiptRuns")).toBe("P1:3");
    expect(urls[3]!.searchParams.has("receiptRuns")).toBe(false);
    expect(urls[3]!.searchParams.get("receiptSequences")).toBe("1");
    expect(urls[4]!.searchParams.has("receiptSequences")).toBe(false);

    const failing = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await refusalFetcher(failing as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    // receiptWriteoffs, then straight to the final request without sequences.
    expect(failing).toHaveBeenCalledTimes(3);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
  });

  it("legend-jcby0 a non-400 failure on the receiptWriteoffs request or on its retry is not retried further", async () => {
    const first = vi.fn(async () => new Response("{}", { status: 503 }));
    const firstError = await refusalFetcher(first as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(first).toHaveBeenCalledTimes(1);
    expect((firstError as EdgeCloudHttpError).code).toBe("HTTP_503");

    const retry = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const retryError = await refusalFetcher(retry as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(retry).toHaveBeenCalledTimes(2);
    expect((retryError as EdgeCloudHttpError).code).toBe("HTTP_503");
  });

  it("legend-jcby0 HTTP 400 without an edgeInstance is not retried, so no request without receiptWriteoffs follows", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
  });

  it("legend-jcby0 the sequences-off request (final stage) never carries receiptWriteoffs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    await refusalFetcher(fetchImpl as unknown as typeof fetch)(
      "v1",
      new AbortController().signal,
    );
    const last = new URL((fetchImpl.mock.calls[2] as unknown as [string])[0]);
    expect(last.searchParams.has("receiptSequences")).toBe(false);
    expect(last.searchParams.has("receiptWriteoffs")).toBe(false);
    expect(last.searchParams.get("since")).toBe("v1");
  });

  it("legend-zsdd HTTP 400 without an edgeInstance is not retried", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const error = await fetcherWith(fetchImpl as unknown as typeof fetch)(
      null,
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
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

// 533b P1: every pull response is evidence of the cloud's time. The fetchers
// accept a new option shared by all of them (CloudGetOptions):
//   onServerTime?: (serverTime: Date) => void
// It is called with the parsed `Date` response header of a successful (2xx)
// response, never for a missing or unparseable header, never for an error
// response (assumption: only trusted successful pulls count), and a throwing
// callback must not fail the pull. The runtime wires it to the same proof
// callback as the link client's `onServerTime`.
describe("533b cloud pull responses report the cloud's server time", () => {
  const SERVER_TIME = new Date("2026-11-11T03:05:07.000Z");

  function responseWithDate(date: string | null, status = 200) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (date !== null) headers.Date = date;
    return new Response(JSON.stringify({ data: [] }), { status, headers });
  }

  const pull = (fetchImpl: unknown, onServerTime: (serverTime: Date) => void) =>
    createDeviceRecordsFetcher({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      onServerTime,
    } as Parameters<typeof createDeviceRecordsFetcher>[0])(
      null,
      new AbortController().signal,
    );

  it("calls onServerTime with the Date header of a successful pull", async () => {
    const seen: Date[] = [];
    const fetchImpl = vi.fn(async () =>
      responseWithDate(SERVER_TIME.toUTCString()),
    );
    await pull(fetchImpl, (date) => seen.push(date));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Date);
    expect(seen[0]!.getTime()).toBe(SERVER_TIME.getTime());
  });

  it("also reports from the generic cloudGetJson helper", async () => {
    const seen: Date[] = [];
    const fetchImpl = vi.fn(async () =>
      responseWithDate(SERVER_TIME.toUTCString()),
    );
    await cloudGetJson({
      cloudUrl: "wss://cloud.example.com/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      path: "/api/edge-sync/anything",
      onServerTime: (date: Date) => seen.push(date),
    } as Parameters<typeof cloudGetJson>[0]);
    expect(seen.map((date) => date.getTime())).toEqual([SERVER_TIME.getTime()]);
  });

  it("does not call onServerTime when the Date header is missing or unparseable", async () => {
    const seen: Date[] = [];
    await pull(
      vi.fn(async () => responseWithDate(null)),
      (date) => seen.push(date),
    );
    await pull(
      vi.fn(async () => responseWithDate("not a date")),
      (date) => seen.push(date),
    );
    expect(seen).toEqual([]);
  });

  it("does not call onServerTime for an error response", async () => {
    const seen: Date[] = [];
    await expect(
      pull(
        vi.fn(async () => responseWithDate(SERVER_TIME.toUTCString(), 500)),
        (date) => seen.push(date),
      ),
    ).rejects.toBeInstanceOf(EdgeCloudHttpError);
    expect(seen).toEqual([]);
  });

  it("still returns the page when the onServerTime callback throws", async () => {
    const result = await pull(
      vi.fn(async () => responseWithDate(SERVER_TIME.toUTCString())),
      () => {
        throw new Error("clock sink failed");
      },
    );
    expect(result).toEqual({ data: [] });
  });
});
