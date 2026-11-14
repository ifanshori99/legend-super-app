// Realtime client of the staff emergency stream (WS-02, bead legend-kpzmi;
// PRD v1.7 §3 F25 "Keselamatan", FAC-08; design docs/design/edge-emergency.md
// D-03, D-05). Transport only, no UI: the banner is a later gate-ui card.
//
// - Opens `/api/emergency/ws` with the `legend.emergency.v1` subprotocol; the
//   browser sends the receiver session cookie itself.
// - Parses every frame with `panicRealtimeFrameSchema` (strict); anything else
//   is ignored. The server resends an open alert every 3 s until the phone
//   answers `received`, so each valid frame is answered, but `onAlert` runs
//   once per alert id. A throwing `onAlert` sends no reply, so the resend
//   gives the phone another chance to show it.
// - Close code 4401 (receiver session revoked) stops for good; every other
//   close reconnects with exponential backoff that resets once a socket opened.
// - A refused upgrade (e.g. HTTP 401 on an invalid session) shows up as close
//   1006 on a socket that never opened. After 4 such closes in a row the client
//   reports "unreachable" once and keeps retrying at the backoff max; the next
//   successful open resets the count and the status.
// - The socket, scheduler and fetch are injected so the module is testable
//   with fakes (tests/panic-realtime-client.test.mjs).
import {
  EMERGENCY_REVOKED_CLOSE_CODE,
  EMERGENCY_WS_PROTOCOL,
  panicAcknowledgedFrameSchema,
  panicRealtimeFrameSchema,
  type PanicAcknowledgedFrame,
  type PanicReceivedFrame,
  type PanicRealtimeFrame,
} from "@starter/shared/facility";

export type PanicRealtimeStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unreachable"
  | "revoked"
  | "stopped";

/** The slice of the browser `WebSocket` this client uses. */
export type PanicSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type PanicScheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type PanicRealtimeOptions = {
  /** ws(s) URL of the receiver endpoint. */
  url: string;
  socketFactory: (url: string, protocols: string[]) => PanicSocket;
  onAlert: (frame: PanicRealtimeFrame) => void;
  /** A colleague answered an alert (no reply is sent for this frame). */
  onAcknowledged?: (frame: PanicAcknowledgedFrame) => void;
  onStatus?: (status: PanicRealtimeStatus) => void;
  /** Called once when the server closes with 4401. */
  onRevoked?: () => void;
  apiFetch?: (
    path: string,
    init: { method: "POST"; body: Record<string, never> },
  ) => Promise<unknown>;
  apiGet?: (path: string) => Promise<unknown>;
  scheduler?: PanicScheduler;
  /** delay = min(baseMs * 2^attempt, maxMs) */
  backoff?: { baseMs: number; maxMs: number };
};

export type PanicRealtimeClient = {
  start(): void;
  stop(): void;
  /** Acknowledge an alert ("I am on my way"); rejects with the API error. */
  ack(alertId: string): Promise<void>;
  /** Alerts still open on the server (catch-up after reload/reconnect). */
  openAlerts(): Promise<PanicRealtimeFrame[]>;
};

/** Consecutive closes without an open before the client reports "unreachable". */
const UNREACHABLE_AFTER = 4;

const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };

const defaultScheduler: PanicScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Loaded on first use: the framework client is not needed to build the module
// (and not available to the plain node test runner).
const defaultApiFetch: NonNullable<PanicRealtimeOptions["apiFetch"]> = async (
  path,
  init,
) => (await import("@/lib/api/client")).apiFetch(path, init);

const defaultApiGet: NonNullable<PanicRealtimeOptions["apiGet"]> = async (
  path,
) => (await import("@/lib/api/client")).apiFetch(path);

export function createPanicRealtimeClient(
  options: PanicRealtimeOptions,
): PanicRealtimeClient {
  const {
    url,
    socketFactory,
    onAlert,
    onAcknowledged,
    onStatus,
    onRevoked,
    apiFetch = defaultApiFetch,
    apiGet = defaultApiGet,
    scheduler = defaultScheduler,
    backoff = DEFAULT_BACKOFF,
  } = options;

  let socket: PanicSocket | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = true;
  let revoked = false;
  let failedAttempts = 0;
  let unreachable = false;
  const shown = new Set<string>();

  function status(next: PanicRealtimeStatus) {
    // Once unreachable, stay quiet until a socket opens (or stop/revoke).
    if (unreachable && (next === "connecting" || next === "reconnecting")) {
      return;
    }
    onStatus?.(next);
  }

  function scheduleReconnect(neverOpened: boolean) {
    status("reconnecting");
    if (neverOpened) {
      failedAttempts += 1;
      if (failedAttempts >= UNREACHABLE_AFTER && !unreachable) {
        unreachable = true;
        onStatus?.("unreachable");
      }
    }
    const delay = unreachable
      ? backoff.maxMs
      : Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
    attempt += 1;
    timer = scheduler.setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  function handleMessage(current: PanicSocket, data: unknown) {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = panicRealtimeFrameSchema.safeParse(json);
    if (!parsed.success) {
      const acknowledged = panicAcknowledgedFrameSchema.safeParse(json);
      if (acknowledged.success) {
        try {
          onAcknowledged?.(acknowledged.data);
        } catch {
          // A failing listener must not break the stream.
        }
      }
      return;
    }
    const frame = parsed.data;
    if (!shown.has(frame.alertId)) {
      try {
        onAlert(frame);
      } catch {
        // Not shown: no reply, so the server resends in 3 s.
        return;
      }
      shown.add(frame.alertId);
    }
    const reply: PanicReceivedFrame = {
      type: "received",
      alertId: frame.alertId,
    };
    current.send(JSON.stringify(reply));
  }

  function handleClose(current: PanicSocket, code: number, opened: boolean) {
    if (current !== socket) return;
    socket = null;
    if (stopped) return;
    if (code === EMERGENCY_REVOKED_CLOSE_CODE) {
      revoked = true;
      stopped = true;
      status("revoked");
      onRevoked?.();
      return;
    }
    scheduleReconnect(!opened);
  }

  function connect() {
    if (stopped) return;
    status("connecting");
    let current: PanicSocket;
    try {
      current = socketFactory(url, [EMERGENCY_WS_PROTOCOL]);
    } catch {
      scheduleReconnect(true);
      return;
    }
    socket = current;
    let opened = false;
    current.onopen = () => {
      if (current !== socket || stopped) return;
      opened = true;
      attempt = 0;
      failedAttempts = 0;
      unreachable = false;
      status("open");
    };
    current.onmessage = (event) => {
      if (current !== socket || stopped) return;
      handleMessage(current, event.data);
    };
    // An error is always followed by a close; reconnect from there only.
    current.onerror = () => {};
    current.onclose = (event) => handleClose(current, event.code, opened);
  }

  return {
    start() {
      if (revoked || !stopped) return;
      stopped = false;
      failedAttempts = 0;
      unreachable = false;
      connect();
    },
    stop() {
      if (stopped && socket === null && timer === null) return;
      stopped = true;
      if (timer !== null) {
        scheduler.clearTimeout(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      if (current !== null) current.close(1000, "stopped");
      status("stopped");
    },
    async ack(alertId) {
      await apiFetch(
        `/api/emergency/alerts/${encodeURIComponent(alertId)}/ack`,
        {
          method: "POST",
          body: {},
        },
      );
    },
    async openAlerts() {
      const body = (await apiGet("/api/emergency/open-alerts")) as {
        data?: { alerts?: unknown };
      } | null;
      const alerts = body?.data?.alerts;
      if (!Array.isArray(alerts)) return [];
      const frames: PanicRealtimeFrame[] = [];
      for (const raw of alerts) {
        const parsed = panicRealtimeFrameSchema.safeParse(raw);
        if (parsed.success) frames.push(parsed.data);
      }
      return frames;
    },
  };
}
