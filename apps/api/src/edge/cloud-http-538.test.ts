import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptRunReport } from "@starter/shared/edge";
import { logger } from "../lib/logger.ts";
import {
  cloudGetJson,
  cloudGetJsonConditional,
  createDeviceRecordsFetcher,
  EdgeCloudHttpError,
} from "./cloud-http.ts";

const CAP = 8 * 1024 * 1024;
const CLOUD = "wss://cloud.example.com/api/edge-link";
const INSTANCE = "0b6f4c1e-8f3a-4f55-9a52-3f1d2c4b5a60";
const RUN = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = "edg1.secret-never-log";
const signal = () => new AbortController().signal;
const ok = () => new Response('{"data":[]}', { status: 200 });

function fetcher(fetchImpl: typeof fetch) {
  return createDeviceRecordsFetcher({
    cloudUrl: CLOUD,
    credential: CREDENTIAL,
    edgeInstanceId: INSTANCE,
    fetchImpl,
  });
}

function options(fetchImpl: typeof fetch) {
  return {
    cloudUrl: CLOUD,
    credential: CREDENTIAL,
    path: "/api/edge-sync/device-records",
    fetchImpl,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("legend-8gws cloud response byte cap", () => {
  it("accepts valid JSON at exactly 8 MiB", async () => {
    const body = `"${"x".repeat(CAP - 2)}"`;
    const fetchImpl = vi.fn(async () => new Response(body));
    expect(await cloudGetJson(options(fetchImpl))).toHaveLength(CAP - 2);
  });

  it("rejects an oversized advertised response and cancels its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          headers: { "Content-Length": String(CAP + 1) },
        }),
    );
    await expect(cloudGetJson(options(fetchImpl))).rejects.toBeInstanceOf(
      EdgeCloudHttpError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("counts streamed UTF-8 bytes without Content-Length and cancels before draining", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const chunk = new TextEncoder().encode("é".repeat(512 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks === 1) controller.enqueue(new TextEncoder().encode('"'));
        else if (chunks <= 11) controller.enqueue(chunk);
        else {
          controller.enqueue(new TextEncoder().encode('"'));
          controller.close();
        }
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body));
    await expect(cloudGetJson(options(fetchImpl))).rejects.toBeInstanceOf(
      EdgeCloudHttpError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThan(12);
  });

  it("enforces the same streamed cap on conditional 200 responses despite a false small length", async () => {
    const body = `"${"x".repeat(CAP)}"`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          headers: { "Content-Length": "1", ETag: "v2" },
        }),
    );
    await expect(
      cloudGetJsonConditional({ ...options(fetchImpl), etag: "v1" }),
    ).rejects.toBeInstanceOf(EdgeCloudHttpError);
  });

  it("preserves BAD_JSON for a small malformed body", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid"));
    await expect(cloudGetJson(options(fetchImpl))).rejects.toMatchObject({
      code: "BAD_JSON",
    });
  });
});

describe("legend-6xzec validates local receipt reports before transport", () => {
  const tooMany = new Map(Array.from({ length: 501 }, (_, i) => [`P${i}`, i]));
  const tooLong = new Map([["P".repeat(12_001), 0]]);
  it.each<[string, ReceiptRunReport]>([
    ["invalid prefix", new Map([["secret-invalid-prefix", 0]])],
    ["501 runs", tooMany],
    ["over 12000 characters", tooLong],
    ["negative counter", new Map([["P1", -1]])],
    ["unsafe counter", new Map([["P1", 1_000_000_000]])],
  ])(
    "rejects %s without sending or entering the old-cloud fallback",
    async (_label, report) => {
      const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
      await expect(
        fetcher(fetchImpl)(null, signal(), report),
      ).rejects.toBeInstanceOf(Error);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain("secret-invalid-prefix");
      expect(logged).not.toContain(CREDENTIAL);
    },
  );

  it("continues to send an empty valid report explicitly", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request) => {
      void _input;
      return ok();
    });
    await fetcher(fetchImpl)(null, signal(), new Map());
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("receiptRuns")).toBe("");
  });
});

describe("legend-c4ejw caches confirmed receipt refusal incompatibility", () => {
  const refusals = new Map([[RUN, "prefix_used" as const]]);
  const runs = new Map([["P1", 7]]);

  it("skips refused report on later pulls of one fetcher and warns only once about it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return url.searchParams.has("receiptRefused")
        ? new Response("{}", { status: 400 })
        : ok();
    });
    const pull = fetcher(fetchImpl);
    await pull("first", signal(), runs, refusals);
    const firstCount = urls.length;
    expect(firstCount).toBe(3);
    await pull("second", signal(), runs, refusals);
    expect(urls).toHaveLength(firstCount + 1);
    const latest = urls.at(-1)!;
    expect(latest.searchParams.has("receiptRefused")).toBe(false);
    expect(latest.searchParams.get("receiptRuns")).toBe("P1:7");
    expect(latest.searchParams.get("edgeInstance")).toBe(INSTANCE);
    expect(latest.searchParams.get("receiptSequences")).toBe("1");
    expect(latest.searchParams.get("since")).toBe("second");
    expect(
      warn.mock.calls.filter((call) =>
        JSON.stringify(call).includes("receipt run refusal report"),
      ),
    ).toHaveLength(1);

    await fetcher(fetchImpl)(null, signal(), runs, refusals);
    expect(urls[firstCount + 1]!.searchParams.has("receiptRefused")).toBe(true);
  });

  it("does not cache rejection when the refusal-free attempt also fails", async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return new Response("{}", {
        status: url.searchParams.has("receiptRefused") ? 400 : 503,
      });
    });
    const pull = fetcher(fetchImpl);
    await expect(pull(null, signal(), runs, refusals)).rejects.toMatchObject({
      code: "HTTP_503",
    });
    const firstCount = urls.length;
    await expect(pull(null, signal(), runs, refusals)).rejects.toMatchObject({
      code: "HTTP_503",
    });
    expect(urls[firstCount]!.searchParams.has("receiptRefused")).toBe(true);
  });
});
