// legend-e3k4p: periodically report a fresh ledger snapshot. The transaction
// that builds it finishes before the HTTP request, so an offline cloud cannot
// hold the cursor lock or stall local sales. Repeated reports are read-only
// comparisons in the cloud; a failed request can safely send a newer digest.
import type { EdgeTxnDigest } from "../services/edge-txn-ledger.service.ts";
import { cloudHttpBaseUrl, EdgeCloudHttpError } from "./cloud-http.ts";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const STOP_BOUND_MS = 2_000;

type EdgeRequestInit = RequestInit & { cache: "no-store" };

export type EdgeReconciliationSenderOptions = {
  cloudUrl: string;
  credential: string;
  edgeNodeId: string;
  /** `signal` aborts on timeout or stop(); the build must roll back and reject. */
  buildDigest: (signal: AbortSignal) => Promise<EdgeTxnDigest>;
  /**
   * legend-9z10p: only the primary reports. A standby never drains edge_to_cloud
   * (no cursor), so its digest would always look behind/stale. Default primary.
   */
  role?: "primary" | "standby";
  fetch?: typeof fetch;
  intervalMs?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
};

export type EdgeReconciliationSender = {
  /** Runs immediately, then schedules after each completed report. */
  start(): void;
  /** Concurrent calls share the same attempt. True means the cloud accepted it. */
  runOnce(): Promise<boolean>;
  /** Cancels the timer, aborts the HTTP request and awaits the active attempt. */
  stop(): Promise<void>;
};

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return timer;
}

function defaultClearTimer(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

export function createEdgeReconciliationSender(
  options: EdgeReconciliationSenderOptions,
): EdgeReconciliationSender {
  const url = `${cloudHttpBaseUrl(options.cloudUrl)}/api/edge-nodes/${encodeURIComponent(options.edgeNodeId)}/reconciliation`;
  const fetchImpl = options.fetch ?? fetch;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_INTERVAL_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<boolean> | null = null;
  let controller: AbortController | null = null;
  let failures = 0;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(accepted: boolean): void {
    if (!started || stopped) return;
    const delay = accepted
      ? intervalMs
      : Math.min(maxBackoffMs, retryBaseMs * 2 ** Math.min(failures - 1, 30));
    timer = setTimer(() => {
      timer = null;
      void runOnce();
    }, delay);
  }

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // A broken logger must not break the schedule.
    }
  }

  async function execute(run: AbortController): Promise<boolean> {
    let accepted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      // One timeout covers the digest build and the HTTP request.
      timeout = setTimeout(() => {
        timedOut = true;
        run.abort();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref();
      let digest: EdgeTxnDigest;
      try {
        digest = await options.buildDigest(run.signal);
      } catch (error) {
        if (timedOut) throw new EdgeCloudHttpError("TIMEOUT");
        throw error;
      }
      if (run.signal.aborted) {
        if (timedOut) throw new EdgeCloudHttpError("TIMEOUT");
        return false;
      }
      if (digest.edgeNodeId !== options.edgeNodeId)
        throw new EdgeCloudHttpError("NODE_MISMATCH");
      const init: EdgeRequestInit = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(digest),
        redirect: "error",
        cache: "no-store",
        signal: run.signal,
      };
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch {
        throw new EdgeCloudHttpError(timedOut ? "TIMEOUT" : "NETWORK");
      }
      // Only the status matters. Response contents never enter errors or logs.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new EdgeCloudHttpError(`HTTP_${response.status}`);
      accepted = true;
      failures = 0;
      return true;
    } catch (error) {
      if (!stopped) {
        failures += 1;
        reportError(error);
      }
      return false;
    } finally {
      clearTimeout(timeout);
      schedule(accepted);
    }
  }

  function runOnce(): Promise<boolean> {
    if (options.role === "standby") return Promise.resolve(false);
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve(false);
    cancelTimer();
    const run = new AbortController();
    controller = run;
    const promise = execute(run).finally(() => {
      if (inFlight === promise) inFlight = null;
      if (controller === run) controller = null;
    });
    inFlight = promise;
    return promise;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void runOnce();
    },
    runOnce,
    async stop() {
      stopped = true;
      cancelTimer();
      controller?.abort();
      if (!inFlight) return;
      // A build that ignores the abort must not hang shutdown.
      let bound: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            bound = setTimeout(resolve, STOP_BOUND_MS);
            bound.unref();
          }),
        ]);
      } finally {
        clearTimeout(bound);
      }
    },
  };
}
