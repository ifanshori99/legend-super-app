// legend-e3k4p: a scheduled report uses the edge credential, never an operator
// session, and failures keep retrying without overlapping an in-flight report.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EdgeTxnDigest } from "@starter/shared/edge/reconciliation";
import {
  createEdgeReconciliationSender,
  type EdgeReconciliationSenderOptions,
} from "../edge/reconciliation-sender.ts";

const INTERVAL = 300_000;
const RETRY = 30_000;
const MAX_RETRY = 120_000;
type Timer = { fn: () => void; ms: number; cleared: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<EdgeReconciliationSenderOptions> = {}) {
  const edgeNodeId = randomUUID();
  const digest: EdgeTxnDigest = {
    edgeNodeId,
    edgeInstanceId: randomUUID(),
    fromLinkSeq: 0,
    throughLinkSeq: 12,
    totals: { "order.paid": { count: 3, amountIdr: "135000", idHash: "28" } },
  };
  const timers: Timer[] = [];
  const buildDigest = vi.fn(async () => digest);
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: { status: "ok" } }),
  );
  const onError = vi.fn<(error: unknown) => void>();
  const sender = createEdgeReconciliationSender({
    edgeNodeId,
    cloudUrl: "wss://cloud.reconciliation.test/api/edge-link",
    credential: "private-edge-credential",
    buildDigest,
    fetch,
    intervalMs: INTERVAL,
    retryBaseMs: RETRY,
    maxBackoffMs: MAX_RETRY,
    setTimer: (fn, ms) => {
      const timer: Timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    onError,
    ...overrides,
  });
  const activeTimers = () => timers.filter((timer) => !timer.cleared);
  return {
    digest,
    sender,
    buildDigest,
    fetch,
    onError,
    activeTimers,
    async fire() {
      const timer = activeTimers().at(-1);
      if (!timer) throw new Error("No scheduled report");
      timer.cleared = true;
      timer.fn();
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("legend-e3k4p scheduled edge reconciliation sender", () => {
  it("posts at startup with the edge credential and then schedules another fresh digest", async () => {
    const t = setup();
    t.sender.start();
    await flush();
    expect(t.buildDigest).toHaveBeenCalledTimes(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const [input, init] = t.fetch.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://cloud.reconciliation.test/api/edge-nodes/${t.digest.edgeNodeId}/reconciliation`,
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer private-edge-credential",
    );
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(init?.credentials).not.toBe("include");
    expect(init?.redirect).toBe("error");
    expect((init as RequestInit & { cache?: string })?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual(t.digest);
    expect(t.activeTimers()).toHaveLength(1);
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);

    t.buildDigest.mockResolvedValue({ ...t.digest, throughLinkSeq: 13 });
    await t.fire();
    expect(t.buildDigest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(t.fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      throughLinkSeq: 13,
    });
    expect(t.activeTimers()).toHaveLength(1);
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);
    await t.sender.stop();
  });

  it("retries network and HTTP failures with bounded backoff, then resets after recovery", async () => {
    const t = setup();
    t.fetch
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    t.sender.start();
    await flush();
    expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    await t.fire();
    expect(t.activeTimers()[0]?.ms).toBe(RETRY * 2);
    await t.fire();
    expect(t.activeTimers()[0]?.ms).toBe(MAX_RETRY);
    await t.fire();
    expect(t.activeTimers()[0]?.ms).toBe(MAX_RETRY);
    await t.fire();
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);

    t.fetch.mockRejectedValueOnce(new TypeError("offline again"));
    await t.fire();
    expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    expect(t.buildDigest).toHaveBeenCalledTimes(6);
    await t.sender.stop();
  });

  it("a digest-build failure also retries without making a cloud request", async () => {
    const t = setup();
    t.buildDigest.mockRejectedValueOnce(
      new Error("database temporarily unavailable"),
    );
    t.sender.start();
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    await t.fire();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);
    await t.sender.stop();
  });

  it("times out a pending POST, aborts it, and retries without leaking request details", async () => {
    const t = setup({ timeoutMs: 10 });
    const signals: AbortSignal[] = [];
    t.fetch.mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Scheduled requests must be abortable");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("private-edge-credential from untrusted network")),
        );
      });
    });
    t.sender.start();
    expect(await t.sender.runOnce()).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(t.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TIMEOUT" }),
    );
    expect(String(t.onError.mock.calls[0]?.[0])).not.toContain(
      "private-edge-credential",
    );
    expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    await t.fire();
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);
    await t.sender.stop();
  });

  it("rejects a digest for another node before sending and keeps the retry schedule", async () => {
    const t = setup();
    t.buildDigest.mockResolvedValueOnce({
      ...t.digest,
      edgeNodeId: randomUUID(),
    });
    t.sender.start();
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NODE_MISMATCH" }),
    );
    expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    await t.fire();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.activeTimers()[0]?.ms).toBe(INTERVAL);
    await t.sender.stop();
  });

  it("concurrent runOnce calls share one report and cannot post overlapping digests", async () => {
    const t = setup();
    const gate = deferred<Response>();
    t.fetch.mockImplementationOnce(() => gate.promise);
    const first = t.sender.runOnce();
    const second = t.sender.runOnce();
    await flush();
    expect(t.buildDigest).toHaveBeenCalledTimes(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    gate.resolve(Response.json({ data: { status: "ok" } }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await t.sender.stop();
  });

  it("stop cancels the schedule and aborts a pending POST without scheduling a retry", async () => {
    const t = setup();
    const signals: AbortSignal[] = [];
    t.fetch.mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Scheduled requests must be abortable");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    t.sender.start();
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await t.sender.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(t.activeTimers()).toHaveLength(0);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("stop removes an idle timer and a stopped timer callback cannot send again", async () => {
    const t = setup();
    t.sender.start();
    await flush();
    expect(t.activeTimers()).toHaveLength(1);
    const pending = t.activeTimers()[0]!;
    await t.sender.stop();
    expect(pending.cleared).toBe(true);
    pending.fn();
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.activeTimers()).toHaveLength(0);
  });

  // legend-9z10p (fail-first). Assumption: the sender has no notion of role
  // today (runtime.ts passes none), so the contract tested here is a `role`
  // option: only "primary" reports. A standby never holds an edge_to_cloud
  // cursor, so its report would always be stale/behind.
  it("legend-9z10p a standby node never builds or posts a report", async () => {
    const t = setup({
      role: "standby",
    } as Partial<EdgeReconciliationSenderOptions>);
    t.sender.start();
    await flush();
    expect(await t.sender.runOnce()).toBe(false);
    expect(t.buildDigest).not.toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
    await t.sender.stop();
  });

  it("legend-9z10p a primary node still reports at startup", async () => {
    const t = setup({
      role: "primary",
    } as Partial<EdgeReconciliationSenderOptions>);
    t.sender.start();
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await t.sender.stop();
  });
});

// legend-1rfy7 (fail-first, second-opinion F2). Contract assumed from the card:
// buildDigest receives an AbortSignal, `buildDigest(signal)`. The run timeout
// (timeoutMs) covers digest build plus HTTP, and stop() aborts a pending build
// and resolves within a short bound, with no POST and no retry timer left.
// Assumption: a build that rejects because its signal aborted ends the run as
// code TIMEOUT when the timeout fired, and silently when stop() fired.
describe("legend-1rfy7 digest build honours timeout and shutdown", () => {
  type SignalAwareBuild = (signal: AbortSignal) => Promise<EdgeTxnDigest>;
  const asOption = (build: SignalAwareBuild) =>
    build as unknown as EdgeReconciliationSenderOptions["buildDigest"];
  const sleep = (ms: number) =>
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), ms),
    );

  /** A digest build that never finishes by itself but rejects when aborted. */
  function stuckBuild() {
    const signals: AbortSignal[] = [];
    const rejects: ((error: Error) => void)[] = [];
    const build = vi.fn<SignalAwareBuild>((signal) => {
      signals.push(signal);
      return new Promise<EdgeTxnDigest>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        rejects.push(reject);
      });
    });
    return {
      build,
      signals,
      // Test cleanup only: frees a build the sender failed to abort.
      unstick: () =>
        rejects.forEach((reject) => reject(new Error("test cleanup"))),
    };
  }

  it("passes a live AbortSignal to buildDigest", async () => {
    const t = setup();
    const seen: unknown[] = [];
    t.buildDigest.mockImplementation(((signal: unknown) => {
      seen.push(signal);
      return Promise.resolve(t.digest);
    }) as never);
    t.sender.start();
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect((seen[0] as AbortSignal).aborted).toBe(false);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await t.sender.stop();
  });

  it("times out a digest build that never resolves, without any POST", async () => {
    const stuck = stuckBuild();
    const t = setup({ timeoutMs: 20, buildDigest: asOption(stuck.build) });
    try {
      t.sender.start();
      const outcome = await Promise.race([t.sender.runOnce(), sleep(1_000)]);
      expect(outcome).toBe(false);
      expect(t.fetch).not.toHaveBeenCalled();
      expect(stuck.signals).toHaveLength(1);
      expect(stuck.signals[0]?.aborted).toBe(true);
      expect(t.onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "TIMEOUT" }),
      );
      expect(t.activeTimers()[0]?.ms).toBe(RETRY);
    } finally {
      stuck.unstick();
      await Promise.race([t.sender.stop(), sleep(1_000)]);
    }
  });

  it("stop aborts a pending digest build and resolves within the shutdown bound", async () => {
    const stuck = stuckBuild();
    const t = setup({ buildDigest: asOption(stuck.build) });
    try {
      t.sender.start();
      await flush();
      expect(stuck.signals).toHaveLength(1);
      expect(stuck.signals[0]?.aborted).toBe(false);
      const startedAt = Date.now();
      const outcome = await Promise.race([t.sender.stop(), sleep(500)]);
      expect(outcome).not.toBe("timed-out");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(stuck.signals[0]?.aborted).toBe(true);
      expect(t.fetch).not.toHaveBeenCalled();
      expect(t.activeTimers()).toHaveLength(0);
    } finally {
      stuck.unstick();
      await Promise.race([t.sender.stop(), sleep(1_000)]);
    }
  });
});
