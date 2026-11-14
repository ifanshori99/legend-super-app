// MOCK/DEMO ONLY (VITE_API_MOCK=true): a scripted stand-in for the staff
// emergency WebSocket so the panic alert screens can be previewed without the
// server. The scenario comes from localStorage["legend.mock.panic"]; the
// default is "incoming". Frames use the real contract (panicRealtimeFrameSchema),
// so the realtime client parses them exactly like frames from the API.
import { cafeLegendFacilityFixtures as fx } from "@starter/shared/facility";
import type { PanicSocket } from "./panic-realtime.ts";

export const PANIC_MOCK_STORAGE_KEY = "legend.mock.panic";

export const PANIC_MOCK_SCENARIOS = [
  "incoming",
  "multiple",
  "acknowledged",
  "reconnecting",
  "unreachable",
  "revoked",
  "idle",
] as const;
export type PanicMockScenario = (typeof PANIC_MOCK_SCENARIOS)[number];

export function readPanicMockScenario(): PanicMockScenario {
  try {
    const value = (
      globalThis as unknown as { localStorage?: Storage }
    ).localStorage?.getItem(PANIC_MOCK_STORAGE_KEY);
    return (PANIC_MOCK_SCENARIOS as readonly unknown[]).includes(value)
      ? (value as PanicMockScenario)
      : "incoming";
  } catch {
    return "incoming";
  }
}

type Timer = { setTimeout(fn: () => void, ms: number): unknown };

export type MockPanicSocketOptions = {
  /** Defaults to the scenario in localStorage, read per socket. */
  scenario?: () => PanicMockScenario;
  scheduler?: Timer;
  now?: () => Date;
};

const alertId = (n: number) =>
  `00000000-0000-4000-8000-${String(8800 + n).padStart(12, "0")}`;

/** Units of the mock unit board (features/facility-staff/mock.ts). */
const UNIT_IDS = [fx.ids.unitP2, fx.ids.unitW1, fx.ids.unitP1];

/** Reconnect attempts of the "reconnecting" scenario that fail at once. */
const RECONNECTING_FAILS = 4;

/**
 * Returns a `socketFactory` for `createPanicRealtimeClient`. The factory keeps
 * the connection count, so build one per client.
 */
export function createMockPanicSocket(options: MockPanicSocketOptions = {}) {
  const {
    scenario = readPanicMockScenario,
    scheduler = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    },
    now = () => new Date(),
  } = options;
  let connections = 0;

  return function socketFactory(): PanicSocket {
    connections += 1;
    const attempt = connections;
    const name = scenario();
    let closed = false;

    const socket: PanicSocket = {
      send() {},
      close() {
        // A client-initiated close is not reported back (stop() is silent).
        closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    const later = (ms: number, fn: () => void) =>
      scheduler.setTimeout(() => {
        if (!closed) fn();
      }, ms);
    const open = () => socket.onopen?.({});
    const drop = (code: number) => {
      closed = true;
      socket.onclose?.({ code });
    };
    const frame = (n: number, unitId: string | null) => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "panic",
          alertId: alertId(n),
          outletId: fx.outlet.id,
          unitId,
          receivedAt: now().toISOString(),
          kind: "press",
        }),
      });
    };

    later(0, () => {
      switch (name) {
        case "idle":
          open();
          return;
        case "incoming":
        case "acknowledged":
          open();
          later(800, () => frame(1, UNIT_IDS[0]));
          return;
        case "multiple":
          open();
          later(800, () => frame(1, UNIT_IDS[0]));
          later(2_500, () => frame(2, UNIT_IDS[1]));
          later(4_200, () => frame(3, UNIT_IDS[2]));
          return;
        case "revoked":
          open();
          later(1_200, () => drop(4401));
          return;
        case "unreachable":
          // Refused upgrade: closes without ever opening.
          drop(1006);
          return;
        case "reconnecting":
          if (attempt === 1) {
            open();
            later(800, () => frame(1, UNIT_IDS[0]));
            later(2_500, () => drop(1006));
          } else if (attempt <= RECONNECTING_FAILS) {
            drop(1006);
          }
          // Later attempts hang: the screen keeps showing the connection
          // banner instead of tipping into "unreachable".
          return;
      }
    });

    return socket;
  };
}
