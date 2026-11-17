// Realtime client of one KDS station feed (WS-04, bead legend-4d5; hardening
// legend-dsbqr). Transport only, no UI. Same shape as
// features/facility-staff/panic-realtime.ts: the socket and scheduler are
// injected so the module is testable with fakes (tests/kds-realtime-client.test.mjs).
//
// - Opens KITCHEN_REALTIME_PATH with `?after=<cursor>` once a cursor is known.
//   The URL never carries a token: a browser cannot set WebSocket headers, so
//   the device token and the live acting-staff token ride as extra
//   subprotocols (`kitchenRealtimeProtocols`), read again on every connect.
// - Parses every frame with `kitchenRealtimeMessageSchema` (strict); anything
//   else is ignored. A `ticket` entry is passed on only when its sequence is
//   above the cursor, so a replay after a reconnect never shows a ticket twice.
// - Close code 4409 (`resync` frame: the cursor cannot be resumed) pauses the
//   client and calls `onResync`; the caller reloads the snapshot and calls
//   `resume(snapshot.sequence)`.
// - Close code 1008 (denied) stops for good. Every other close reconnects with
//   exponential backoff that resets once a socket opened; the reconnect asks
//   for the changes after the last applied sequence.
import {
  KITCHEN_REALTIME_PATH,
  KITCHEN_REALTIME_RESYNC_CLOSE_CODE,
  kitchenRealtimeMessageSchema,
  kitchenRealtimeProtocols,
  type KitchenFeedEntry,
} from "@starter/shared/kitchen";
import { readActingStaffToken } from "@/lib/api/acting-staff";
import { getDeviceToken } from "@/lib/device-token-store";

export type KdsRealtimeStatus =
  "connecting" | "open" | "reconnecting" | "resync" | "denied" | "stopped";

/** The slice of the browser `WebSocket` this client uses. */
export type KdsSocket = {
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type KdsScheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Close code of a socket the server refused on purpose ("denied"). */
export const KDS_DENIED_CLOSE_CODE = 1008;

export type KdsCredentialReaders = {
  getDeviceToken: () => string | null;
  /** Null when no token exists or it has expired. */
  readActingStaffToken: () => string | null;
};

/** Subprotocol list for the next connect; expired or missing tokens are left out. */
export function kdsRealtimeProtocols(
  readers: KdsCredentialReaders = { getDeviceToken, readActingStaffToken },
): string[] {
  return kitchenRealtimeProtocols({
    deviceToken: readers.getDeviceToken(),
    actingStaffToken: readers.readActingStaffToken(),
  });
}

/**
 * ws(s) URL of a station feed. `apiOrigin` is the http(s) origin of the API.
 * The cursor is the only query parameter; never add a credential here.
 */
export function kdsRealtimeUrl(
  apiOrigin: string,
  outletId: string,
  stationId: string,
  after: number | null,
): string {
  const path = KITCHEN_REALTIME_PATH.replace(
    ":outletId",
    encodeURIComponent(outletId),
  ).replace(":stationId", encodeURIComponent(stationId));
  const url = new URL(path, apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (after !== null) url.searchParams.set("after", String(after));
  return url.toString();
}

export type KdsRealtimeOptions = {
  /** http(s) origin of the API (API_URL). */
  apiOrigin: string;
  outletId: string;
  stationId: string;
  /** Snapshot cursor to resume from; null opens without `after`. */
  after: number | null;
  socketFactory: (url: string, protocols: string[]) => KdsSocket;
  /** Read per connect so a renewed acting-staff token is picked up. */
  getProtocols?: () => string[];
  /** A ticket change above the cursor, in sequence order. */
  onTicket: (entry: KitchenFeedEntry) => void;
  /** First frame: the station cursor when the socket opened. */
  onHello?: (sequence: number) => void;
  /** The cursor cannot be resumed: reload the snapshot, then `resume(...)`. */
  onResync?: (sequence: number | null) => void;
  onStatus?: (status: KdsRealtimeStatus) => void;
  scheduler?: KdsScheduler;
  /** delay = min(baseMs * 2^attempt, maxMs) */
  backoff?: { baseMs: number; maxMs: number };
};

export type KdsRealtimeClient = {
  start(): void;
  stop(): void;
  /** After a snapshot reload: continue from its cursor (also after a pause). */
  resume(after: number): void;
  /** Highest sequence applied so far (the `after` of the next connect). */
  cursor(): number | null;
};

const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };

const defaultScheduler: KdsScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createKdsRealtimeClient(
  options: KdsRealtimeOptions,
): KdsRealtimeClient {
  const {
    apiOrigin,
    outletId,
    stationId,
    socketFactory,
    getProtocols = kdsRealtimeProtocols,
    onTicket,
    onHello,
    onResync,
    onStatus,
    scheduler = defaultScheduler,
    backoff = DEFAULT_BACKOFF,
  } = options;

  let socket: KdsSocket | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = true;
  let paused = false;
  let after = options.after;
  let resyncSequence: number | null = null;

  function scheduleReconnect() {
    onStatus?.("reconnecting");
    const delay = Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
    attempt += 1;
    timer = scheduler.setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  function handleMessage(data: unknown) {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = kitchenRealtimeMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.stationId !== stationId) return;
    if (frame.type === "hello") {
      if (after === null) after = frame.sequence;
      onHello?.(frame.sequence);
      return;
    }
    if (frame.type === "resync") {
      resyncSequence = frame.sequence;
      return;
    }
    if (after !== null && frame.entry.sequence <= after) return;
    try {
      onTicket(frame.entry);
    } catch {
      // A failing listener must not break the stream, and the entry is not
      // marked applied: the next reconnect asks for it again.
      return;
    }
    after = frame.entry.sequence;
  }

  function handleClose(current: KdsSocket, code: number) {
    if (current !== socket) return;
    socket = null;
    if (stopped) return;
    if (code === KITCHEN_REALTIME_RESYNC_CLOSE_CODE) {
      paused = true;
      onStatus?.("resync");
      onResync?.(resyncSequence);
      resyncSequence = null;
      return;
    }
    if (code === KDS_DENIED_CLOSE_CODE) {
      stopped = true;
      onStatus?.("denied");
      return;
    }
    scheduleReconnect();
  }

  function connect() {
    if (stopped || paused) return;
    onStatus?.("connecting");
    let current: KdsSocket;
    try {
      current = socketFactory(
        kdsRealtimeUrl(apiOrigin, outletId, stationId, after),
        getProtocols(),
      );
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    current.onopen = () => {
      if (current !== socket || stopped) return;
      attempt = 0;
      onStatus?.("open");
    };
    current.onmessage = (event) => {
      if (current !== socket || stopped) return;
      handleMessage(event.data);
    };
    // An error is always followed by a close; reconnect from there only.
    current.onerror = () => {};
    current.onclose = (event) => handleClose(current, event.code);
  }

  function closeSocket() {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    const current = socket;
    socket = null;
    if (current !== null) current.close(1000, "stopped");
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      paused = false;
      attempt = 0;
      connect();
    },
    stop() {
      if (stopped && socket === null && timer === null) return;
      stopped = true;
      closeSocket();
      onStatus?.("stopped");
    },
    resume(next) {
      after = next;
      if (stopped && !paused) return;
      closeSocket();
      stopped = false;
      paused = false;
      attempt = 0;
      connect();
    },
    cursor() {
      return after;
    },
  };
}
