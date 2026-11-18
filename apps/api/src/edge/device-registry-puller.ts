// Periodic device-registry pull on the edge node (bead legend-2lp.7; PRD v1.7
// §3 F5 "Server Lokal", device revocation must reach the edge replica). Runs
// one pull at boot, then re-schedules itself after every run: `intervalMs`
// after a success, capped exponential backoff with jitter after failures.
// Never overlaps (a second caller shares the in-flight run), and a failed pull
// leaves the watermark and last-success time untouched so the replica stays in
// use and the next run retries from the same cursor.
//
// Pure scheduling: the pull itself, the checkpoint store, the clock and the
// timers are injected (see runtime.ts and the unit tests). The state exposes
// error name/code only, never a message that could carry data.

export type DeviceRegistrySyncState = {
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  /** Computed on read: no success yet, or the last one is older than staleAfterMs. */
  readonly stale: boolean;
  /**
   * legend-2lgu, computed on read: the last success (or, with none yet, the
   * time this puller started) is older than the hard limit. Past it the edge
   * refuses NEW device sessions.
   */
  readonly hardStale: boolean;
  /** The hard limit in seconds (0 when the puller has none). */
  readonly maxStaleSeconds: number;
  /** legend-zsdd: sequences the last successful pull refused (0 until one). */
  readonly receiptSequencesRefused: number;
  /** Time of the last successful pull that refused at least one, else null. */
  readonly receiptSequencesRefusedAt: string | null;
  /** legend-yd0h8: the last successful pull saw the cloud's restore alert. */
  readonly receiptRunAlert: boolean;
  /** Time of the last successful pull with the alert, else null. */
  readonly receiptRunAlertAt: string | null;
  /**
   * legend-sduiq: local receipt runs the last successful pull retired because
   * the cloud no longer lists them (that device stops numbering).
   */
  readonly receiptSequencesRetired: number;
  /** Time of the last successful pull that retired at least one, else null. */
  readonly receiptSequencesRetiredAt: string | null;
};

export type DeviceRegistryPuller = {
  /** Runs one pull immediately (boot), then self-schedules. Idempotent. */
  start(): void;
  /** True = success. While a pull is in flight, returns that same promise. */
  runOnce(): Promise<boolean>;
  /** Clears the timer, aborts the in-flight fetch and awaits it. Idempotent. */
  stop(): Promise<void>;
  getState(): DeviceRegistrySyncState;
  /** legend-2lgu: hard-stale predicate at `at` (default: now). */
  isHardStale(at?: Date): boolean;
  /**
   * True once the local checkpoint was read, so the replica's age can be
   * judged. Does not wait for the cloud.
   */
  isCheckpointLoaded(): boolean;
};

export type DeviceRegistryPullerDeps = {
  pull(
    since: string | null,
    signal: AbortSignal,
  ): Promise<{
    watermark: string | null;
    receiptSequencesRefused?: number;
    /** legend-yd0h8 */
    receiptRunAlert?: boolean;
    /** legend-sduiq */
    receiptSequencesRetired?: number;
  }>;
  /** Called once, lazily, before the first pull (retried next run if it throws). */
  load(): Promise<{ watermark: string | null; lastSuccessAt: Date | null }>;
  /** After every successful pull. */
  save(input: { watermark: string | null; succeededAt: Date }): Promise<void>;
  intervalMs: number;
  staleAfterMs: number;
  /** legend-2lgu: hard limit in ms; absent = never hard stale. */
  hardStaleAfterMs?: number;
  maxBackoffMs: number;
  now?: () => Date;
  random?: () => number;
  /** Default: setTimeout + unref. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Fired on transitions (and once after the first run), checked after each run. */
  onStaleChange?: (stale: boolean) => void;
  /** legend-2lgu: same, for the hard limit (fired on transitions only). */
  onHardStaleChange?: (hardStale: boolean) => void;
  onError?: (error: unknown) => void;
};

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/** Error name/code only: messages may carry data. */
function errorLabel(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.name === "string") return candidate.name;
  return "Error";
}

export function createDeviceRegistryPuller(
  deps: DeviceRegistryPullerDeps,
): DeviceRegistryPuller {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;

  let loaded = false;
  let watermark: string | null = null;
  let lastSuccessAt: Date | null = null;
  let lastAttemptAt: Date | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let receiptSequencesRefused = 0;
  let receiptSequencesRefusedAt: Date | null = null;
  let receiptRunAlert = false;
  let receiptRunAlertAt: Date | null = null;
  let receiptSequencesRetired = 0;
  let receiptSequencesRetiredAt: Date | null = null;

  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<boolean> | null = null;
  let controller: AbortController | null = null;
  let reportedStale: boolean | null = null;
  let reportedHardStale = false;
  // legend-2lgu: no success yet counts from here, so the first minutes after
  // boot are never hard stale.
  let startedAt = now();

  function isStale(): boolean {
    if (!lastSuccessAt) return true;
    const age = now().getTime() - lastSuccessAt.getTime();
    // A success "in the future" means the clock moved back: trust nothing.
    return age < 0 || age > deps.staleAfterMs;
  }

  function isHardStale(at: Date = now()): boolean {
    if (deps.hardStaleAfterMs === undefined) return false;
    const base = lastSuccessAt ?? startedAt;
    const age = at.getTime() - base.getTime();
    // A clock that moved back proves no age: not hard stale (the soft flag
    // already fails visible).
    return age > deps.hardStaleAfterMs;
  }

  function checkHardStale(): void {
    const hardStale = isHardStale();
    if (hardStale === reportedHardStale) return;
    reportedHardStale = hardStale;
    try {
      deps.onHardStaleChange?.(hardStale);
    } catch {
      // Same as onStaleChange: never stop the schedule.
    }
  }

  function checkStale(): void {
    checkHardStale();
    const stale = isStale();
    if (stale === reportedStale) return;
    reportedStale = stale;
    try {
      deps.onStaleChange?.(stale);
    } catch {
      // A broken logger must not stop the schedule (the replica would go stale
      // with no further pulls).
    }
  }

  function nextDelayMs(): number {
    if (consecutiveFailures === 0) return deps.intervalMs;
    const exponent = Math.min(consecutiveFailures - 1, 30);
    const delay = Math.min(deps.maxBackoffMs, deps.intervalMs * 2 ** exponent);
    return Math.floor(delay / 2 + random() * (delay / 2));
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(): void {
    cancelTimer();
    if (stopped || !started) return;
    timer = setTimer(() => {
      timer = null;
      void runOnce();
    }, nextDelayMs());
  }

  async function execute(signal: AbortSignal): Promise<boolean> {
    lastAttemptAt = now();
    let ok = false;
    try {
      if (!loaded) {
        const stored = await deps.load();
        watermark = stored.watermark;
        lastSuccessAt = stored.lastSuccessAt;
        // Report an old checkpoint before a successful first pull replaces it.
        checkHardStale();
        loaded = true;
      }
      const result = await deps.pull(watermark, signal);
      const succeededAt = now();
      await deps.save({ watermark: result.watermark, succeededAt });
      watermark = result.watermark;
      lastSuccessAt = succeededAt;
      receiptSequencesRefused = result.receiptSequencesRefused ?? 0;
      if (receiptSequencesRefused > 0) receiptSequencesRefusedAt = succeededAt;
      // legend-yd0h8: same pattern as the refused count above.
      receiptRunAlert = result.receiptRunAlert === true;
      if (receiptRunAlert) receiptRunAlertAt = succeededAt;
      // legend-sduiq: same pattern; the time stays after the count drops to 0.
      receiptSequencesRetired = result.receiptSequencesRetired ?? 0;
      if (receiptSequencesRetired > 0) receiptSequencesRetiredAt = succeededAt;
      lastError = null;
      consecutiveFailures = 0;
      ok = true;
    } catch (error) {
      // A pull cut short by stop() is not a failure of the cloud.
      if (!signal.aborted) {
        consecutiveFailures += 1;
        lastError = errorLabel(error);
        try {
          deps.onError?.(error);
        } catch {
          // A broken logger must not break the schedule.
        }
      }
    }
    if (!stopped) {
      checkStale();
      schedule();
    }
    return ok;
  }

  function runOnce(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve(false);
    cancelTimer();
    const run = new AbortController();
    controller = run;
    const promise = execute(run.signal).finally(() => {
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
      startedAt = now();
      void runOnce();
    },
    runOnce,
    async stop() {
      stopped = true;
      cancelTimer();
      controller?.abort();
      if (inFlight) await inFlight;
    },
    isHardStale,
    isCheckpointLoaded: () => loaded,
    getState() {
      return {
        lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
        lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
        lastError,
        consecutiveFailures,
        stale: isStale(),
        hardStale: isHardStale(),
        maxStaleSeconds: Math.floor((deps.hardStaleAfterMs ?? 0) / 1000),
        receiptSequencesRefused,
        receiptSequencesRefusedAt: receiptSequencesRefusedAt
          ? receiptSequencesRefusedAt.toISOString()
          : null,
        receiptRunAlert,
        receiptRunAlertAt: receiptRunAlertAt
          ? receiptRunAlertAt.toISOString()
          : null,
        receiptSequencesRetired,
        receiptSequencesRetiredAt: receiptSequencesRetiredAt
          ? receiptSequencesRetiredAt.toISOString()
          : null,
      };
    },
  };
}

/**
 * One pull from `since`; when that cursor is refused (the cloud changed its
 * cursor format, or the stored checkpoint is corrupt), one more pull from the
 * start instead of failing forever. Safe: applying records is idempotent and a
 * device's token floor only moves forward.
 */
export async function pullWithCursorRecovery<R>(
  pull: (since: string | null) => Promise<R>,
  since: string | null,
  isRejectedCursor: (error: unknown) => boolean,
  onRestart?: () => void,
): Promise<R> {
  try {
    return await pull(since);
  } catch (error) {
    if (since === null || !isRejectedCursor(error)) throw error;
    onRestart?.();
    return pull(null);
  }
}
