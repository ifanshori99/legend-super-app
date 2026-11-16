// Heartbeat monitor of the edge Print Agent (bead legend-46p; PRD v1.7 §3 F5
// "Fallback Berlapis", F12 "Fallback Cetak", EDG-05: a failing printer or KDS
// screen is detected within 30 seconds so the agent can fall back and tell
// the supervisor).
//
// Printers are probed every tick (the agent ticks every 5 s, probe timeout
// 2 s). A printer is offline after `offlineAfterMs` without a successful
// probe, so worst-case detection is offlineAfterMs + tick + probe timeout
// (15 + 5 + 2 = 22 s). KDS screens report heartbeats; a screen is down after
// `kdsDownAfterMs` of silence after at least one real heartbeat. A station
// that has never reported remains unknown. Time comes from the injected Clock.
import type { Clock, PrinterConfig } from "./types.ts";
import type { TransportFactory } from "./transport.ts";

export type PrinterMonitorStatus = "online" | "offline";
export type KdsMonitorStatus = "up" | "down";

export type HealthMonitorOptions = {
  clock: Clock;
  listPrinters: () => Promise<PrinterConfig[]>;
  transportFor: TransportFactory;
  offlineAfterMs?: number;
  kdsDownAfterMs?: number;
  probeTimeoutMs?: number;
  onPrinterChange?: (
    printer: PrinterConfig,
    status: PrinterMonitorStatus,
    at: Date,
  ) => void | Promise<void>;
  onKdsChange?: (
    stationId: string,
    status: KdsMonitorStatus,
    at: Date,
  ) => void | Promise<void>;
};

export type HealthMonitor = {
  /** Probes every printer and re-evaluates every watched KDS station. */
  tick(): Promise<void>;
  /** A KDS screen is alive. A down station comes back up immediately. */
  recordKdsHeartbeat(stationId: string, at?: Date): void;
  /** The last real screen heartbeat; watching a station does not create one. */
  getLastKdsHeartbeatAt(stationId: string): Date | null;
  /** False only after the station was reported down (unwatched = assumed up). */
  isKdsUp(stationId: string): boolean;
  /** False only after the printer was reported offline (unknown = try it). */
  isPrinterOnline(printerId: string): boolean;
  /** A send failed: the next failed probe reports offline without waiting. */
  markSuspect(printerId: string): void;
  /** Starts tracking a station that has not sent a heartbeat yet. */
  watchKds(stationId: string): void;
};

type PrinterState = {
  status: "unknown" | PrinterMonitorStatus;
  lastSeenMs: number | null;
  suspect: boolean;
};

type KdsState = {
  status: "unknown" | KdsMonitorStatus;
  lastHeartbeatMs: number | null;
};

const DEFAULT_OFFLINE_AFTER_MS = 15_000;
const DEFAULT_KDS_DOWN_AFTER_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export function createHealthMonitor(
  options: HealthMonitorOptions,
): HealthMonitor {
  const { clock, listPrinters, transportFor, onPrinterChange, onKdsChange } =
    options;
  const offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  const kdsDownAfterMs = options.kdsDownAfterMs ?? DEFAULT_KDS_DOWN_AFTER_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAtMs = clock.now().getTime();

  const printers = new Map<string, PrinterState>();
  const stations = new Map<string, KdsState>();
  let running: Promise<void> | null = null;

  // A listener failure must never break the monitor (and so the agent tick).
  const notifyKds = (
    stationId: string,
    status: KdsMonitorStatus,
    at: Date,
  ): Promise<void> => {
    try {
      return Promise.resolve(onKdsChange?.(stationId, status, at)).catch(
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  };

  const notifyPrinter = (
    printer: PrinterConfig,
    status: PrinterMonitorStatus,
    at: Date,
  ): Promise<void> => {
    try {
      return Promise.resolve(onPrinterChange?.(printer, status, at)).catch(
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  };

  const probe = async (printer: PrinterConfig): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), probeTimeoutMs);
    });
    try {
      return await Promise.race([
        transportFor(printer)
          .probe()
          .catch(() => false),
        timeout,
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const stateOfPrinter = (printerId: string): PrinterState => {
    let state = printers.get(printerId);
    if (!state) {
      state = { status: "unknown", lastSeenMs: null, suspect: false };
      printers.set(printerId, state);
    }
    return state;
  };

  const watch = (stationId: string): KdsState => {
    let state = stations.get(stationId);
    if (!state) {
      state = { status: "unknown", lastHeartbeatMs: null };
      stations.set(stationId, state);
    }
    return state;
  };

  const checkPrinter = async (printer: PrinterConfig): Promise<void> => {
    const alive = await probe(printer);
    const now = clock.now();
    const nowMs = now.getTime();
    const state = stateOfPrinter(printer.id);

    if (alive) {
      state.lastSeenMs = nowMs;
      state.suspect = false;
      if (state.status !== "online") {
        state.status = "online";
        await notifyPrinter(printer, "online", now);
      }
      return;
    }

    const silentSinceMs = state.lastSeenMs ?? startedAtMs;
    const expired = nowMs - silentSinceMs >= offlineAfterMs;
    if ((expired || state.suspect) && state.status !== "offline") {
      state.status = "offline";
      state.suspect = false;
      await notifyPrinter(printer, "offline", now);
    }
  };

  const checkStations = async (): Promise<void> => {
    const now = clock.now();
    const nowMs = now.getTime();
    for (const [stationId, state] of stations) {
      if (state.lastHeartbeatMs === null) continue;
      if (
        nowMs - state.lastHeartbeatMs >= kdsDownAfterMs &&
        state.status !== "down"
      ) {
        state.status = "down";
        await notifyKds(stationId, "down", now);
      }
    }
  };

  const runTick = async (): Promise<void> => {
    const list = await listPrinters();
    await Promise.all(list.map(checkPrinter));
    await checkStations();
  };

  return {
    tick() {
      // Overlapping ticks share one run, so one printer is never probed twice.
      if (!running) {
        running = runTick().finally(() => {
          running = null;
        });
      }
      return running;
    },

    recordKdsHeartbeat(stationId, at) {
      const when = at ?? clock.now();
      const state = watch(stationId);
      state.lastHeartbeatMs = when.getTime();
      const wasDown = state.status === "down";
      state.status = "up";
      if (wasDown) void notifyKds(stationId, "up", when);
    },

    getLastKdsHeartbeatAt(stationId) {
      const lastHeartbeatMs = stations.get(stationId)?.lastHeartbeatMs;
      return lastHeartbeatMs == null ? null : new Date(lastHeartbeatMs);
    },

    isKdsUp(stationId) {
      // Unknown stations cannot trigger fallback. Once a real heartbeat has
      // arrived, evaluate its age now rather than waiting for the next tick.
      const state = watch(stationId);
      if (state.lastHeartbeatMs === null) return true;
      if (state.status === "down") return false;
      return clock.now().getTime() - state.lastHeartbeatMs < kdsDownAfterMs;
    },

    isPrinterOnline(printerId) {
      return stateOfPrinter(printerId).status !== "offline";
    },

    markSuspect(printerId) {
      stateOfPrinter(printerId).suspect = true;
    },

    watchKds(stationId) {
      watch(stationId);
    },
  };
}
