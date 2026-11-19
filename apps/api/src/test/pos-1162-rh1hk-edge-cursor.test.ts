import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../lib/logger.ts";
import { createDeviceRecordsFetcher } from "../edge/cloud-http.ts";

// legend-rh1hk (edge side): the pull report carries the outbox link cursor as
// `receiptRunsSeq`. The edge reads the cursor in `reportLocalRuns` (cloud side
// of the work); this file covers the HTTP fetcher: the parameter, its staged
// retry on a 400, and the one hour stop-sending window.

const CLOUD = "wss://cloud.example.com/api/edge-link";
const INSTANCE = "0b6f4c1e-8f3a-4f55-9a52-3f1d2c4b5a60";
const signal = () => new AbortController().signal;
const ok = () => new Response('{"data":[]}', { status: 200 });
const runs = new Map([["P1", 7]]);
const refusals = new Map([
  ["11111111-1111-4111-8111-111111111111", "prefix_used" as const],
]);

function fetcher(fetchImpl: typeof fetch, edgeInstanceId: string | undefined) {
  return createDeviceRecordsFetcher({
    cloudUrl: CLOUD,
    credential: "edg1.secret-never-log",
    ...(edgeInstanceId === undefined ? {} : { edgeInstanceId }),
    fetchImpl,
  });
}

function recorder(refuses: (url: URL) => boolean) {
  const urls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return refuses(url) ? new Response("{}", { status: 400 }) : ok();
  });
  return { urls, fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe("legend-rh1hk the edge sends receiptRunsSeq with receiptRuns", () => {
  it("first attempt carries receiptRunsSeq as a decimal string next to receiptRuns", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    await fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 42);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get("receiptRunsSeq")).toBe("42");
    expect(urls[0]!.searchParams.get("receiptRuns")).toBe("P1:7");
    expect(urls[0]!.searchParams.get("edgeInstance")).toBe(INSTANCE);
  });

  it("a cursor of 0 (no outbox row yet) is sent", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    await fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 0);
    expect(urls[0]!.searchParams.get("receiptRunsSeq")).toBe("0");
  });

  it("old behaviour: no cursor given means no parameter and no extra stage on a 400", async () => {
    const { urls, fetchImpl } = recorder(() => true);
    await expect(
      fetcher(fetchImpl, INSTANCE)(null, signal(), runs),
    ).rejects.toMatchObject({ code: "HTTP_400" });
    // first, writeoffs dropped, receiptRuns dropped, sequences dropped.
    expect(urls).toHaveLength(4);
    for (const url of urls)
      expect(url.searchParams.has("receiptRunsSeq")).toBe(false);
  });

  it("never sends the cursor without receiptRuns", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    await fetcher(fetchImpl, INSTANCE)(null, signal(), undefined, undefined, 5);
    expect(urls[0]!.searchParams.has("receiptRunsSeq")).toBe(false);
  });

  it("never sends the cursor without an edge instance", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    await fetcher(fetchImpl, undefined)(null, signal(), runs, undefined, 5);
    expect(urls[0]!.searchParams.has("receiptRunsSeq")).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, 1_000_000_000_000_000])(
    "drops an out-of-bound cursor (%s) instead of sending it",
    async (bad) => {
      const { urls, fetchImpl } = recorder(() => false);
      await fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, bad);
      expect(urls).toHaveLength(1);
      expect(urls[0]!.searchParams.has("receiptRunsSeq")).toBe(false);
    },
  );

  it("accepts the largest wire value", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    await fetcher(fetchImpl, INSTANCE)(
      null,
      signal(),
      runs,
      undefined,
      999_999_999_999_999,
    );
    expect(urls[0]!.searchParams.get("receiptRunsSeq")).toBe("999999999999999");
  });
});

describe("legend-rh1hk a 400 retries the same page without the cursor", () => {
  it("keeps receiptRuns, writeoffs, refusals, sequences and instance; drops only the cursor", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { urls, fetchImpl } = recorder((url) =>
      url.searchParams.has("receiptRunsSeq"),
    );
    await fetcher(fetchImpl, INSTANCE)("since-x", signal(), runs, refusals, 9);
    expect(urls).toHaveLength(2);
    const [first, second] = urls as [URL, URL];
    expect(first.searchParams.get("receiptRunsSeq")).toBe("9");
    expect(second.searchParams.has("receiptRunsSeq")).toBe(false);
    first.searchParams.delete("receiptRunsSeq");
    expect(second.search).toBe(first.search);
    expect(second.searchParams.get("receiptWriteoffs")).toBe("1");
    expect(second.searchParams.get("receiptRefused")).toBe(
      "11111111-1111-4111-8111-111111111111:prefix_used",
    );
    expect(second.searchParams.get("receiptRuns")).toBe("P1:7");
  });

  it("a second 400 runs the existing chain, none of it carrying the cursor", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { urls, fetchImpl } = recorder(() => true);
    await expect(
      fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 9),
    ).rejects.toMatchObject({ code: "HTTP_400" });
    // first, cursor dropped, writeoffs dropped, receiptRuns dropped, sequences
    // dropped.
    expect(urls).toHaveLength(5);
    expect(urls[0]!.searchParams.has("receiptRunsSeq")).toBe(true);
    for (const url of urls.slice(1))
      expect(url.searchParams.has("receiptRunsSeq")).toBe(false);
    // The chain did not stop at the cursor stage.
    expect(urls.at(-1)!.searchParams.has("receiptSequences")).toBe(false);
  });

  it("a non-400 failure on the cursor request is not retried", async () => {
    const { urls, fetchImpl } = recorder(() => false);
    fetchImpl.mockImplementationOnce(async (input) => {
      urls.push(new URL(String(input)));
      return new Response("{}", { status: 503 });
    });
    await expect(
      fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 9),
    ).rejects.toMatchObject({ code: "HTTP_503" });
    expect(urls).toHaveLength(1);
  });

  it("a non-400 failure on the cursor-free retry is thrown and does not start the stop-sending window", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return url.searchParams.has("receiptRunsSeq")
        ? new Response("{}", { status: 400 })
        : new Response("{}", { status: 503 });
    });
    const pull = fetcher(fetchImpl, INSTANCE);
    await expect(
      pull(null, signal(), runs, undefined, 9),
    ).rejects.toMatchObject({ code: "HTTP_503" });
    expect(urls).toHaveLength(2);
    await expect(
      pull(null, signal(), runs, undefined, 9),
    ).rejects.toMatchObject({ code: "HTTP_503" });
    expect(urls[2]!.searchParams.has("receiptRunsSeq")).toBe(true);
  });
});

describe("legend-rh1hk stop sending the cursor for one hour after a refused cursor", () => {
  it("suppresses for 1 h, then probes again and resumes for an upgraded cloud", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const started = Date.parse("2026-11-19T00:00:00Z");
    let now = started;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let oldCloud = true;
    const { urls, fetchImpl } = recorder(
      (url) => oldCloud && url.searchParams.has("receiptRunsSeq"),
    );
    const pull = fetcher(fetchImpl, INSTANCE);

    await pull("a", signal(), runs, undefined, 3);
    expect(urls).toHaveLength(2);

    now = started + 60 * 60_000 - 1;
    await pull("b", signal(), runs, undefined, 4);
    expect(urls).toHaveLength(3);
    expect(urls.at(-1)!.searchParams.has("receiptRunsSeq")).toBe(false);
    expect(urls.at(-1)!.searchParams.get("receiptWriteoffs")).toBe("1");
    expect(urls.at(-1)!.searchParams.get("receiptRuns")).toBe("P1:7");

    oldCloud = false;
    now = started + 60 * 60_000;
    await pull("c", signal(), runs, undefined, 5);
    expect(urls).toHaveLength(4);
    expect(urls.at(-1)!.searchParams.get("receiptRunsSeq")).toBe("5");

    await pull("d", signal(), runs, undefined, 6);
    expect(urls).toHaveLength(5);
    expect(urls.at(-1)!.searchParams.get("receiptRunsSeq")).toBe("6");
  });

  it("the window belongs to one fetcher: a new fetcher sends the cursor again", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { urls, fetchImpl } = recorder((url) =>
      url.searchParams.has("receiptRunsSeq"),
    );
    await fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 3);
    await fetcher(fetchImpl, INSTANCE)(null, signal(), runs, undefined, 3);
    expect(urls).toHaveLength(4);
    expect(urls[2]!.searchParams.has("receiptRunsSeq")).toBe(true);
  });
});
