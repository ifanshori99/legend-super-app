// MOCK/DEMO ONLY (VITE_API_MOCK=true): a scripted stand-in for the staff
// emergency WebSocket so the panic alert screens can be previewed without the
// server. The scenario comes from localStorage["legend.mock.panic"]; the
// default is "idle": the layer sits on every /fasilitas screen, so a demo alert
// only appears when a scenario is picked on purpose. Frames use the real contract (panicRealtimeFrameSchema),
// so the realtime client parses them exactly like frames from the API.
import { cafeLegendFacilityFixtures as fx } from "@starter/shared/facility";
import type { PanicRealtimeFrame } from "@starter/shared/facility";
import type { PanicSocket } from "./panic-realtime.ts";

export const PANIC_MOCK_STORAGE_KEY = "legend.mock.panic";

export const PANIC_MOCK_SCENARIOS = [
  "incoming",
  "multiple",
  "acknowledged",
  "taken-remote",
  "restore",
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
      : "idle";
  } catch {
    return "idle";
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

/** Open (not yet acknowledged) mock alerts, like GET /api/emergency/open-alerts. */
const openAlerts = new Map<string, PanicRealtimeFrame>();
let restoreSeeded = false;

export function listMockOpenAlerts(): PanicRealtimeFrame[] {
  seedRestoreAlerts(readPanicMockScenario(), () => new Date());
  return [...openAlerts.values()];
}

export function closeMockOpenAlert(id: string): void {
  openAlerts.delete(id);
}

function mockPanicFrame(
  n: number,
  unitId: string | null,
  receivedAt: string,
): PanicRealtimeFrame {
  const unit = fx.units.find((candidate) => candidate.id === unitId);
  const area = fx.areas.find((candidate) => candidate.id === unit?.areaId);
  return {
    type: "panic",
    alertId: alertId(n),
    outletId: fx.outlet.id,
    unitId,
    unitCode: unit?.code ?? null,
    areaName: area?.name ?? null,
    receivedAt,
    kind: "press",
  };
}

/** "restore" mimics a page reload: the alerts exist only on the server side. */
function seedRestoreAlerts(name: PanicMockScenario, now: () => Date) {
  if (name !== "restore" || restoreSeeded) return;
  restoreSeeded = true;
  const receivedAt = now().toISOString();
  for (const [n, unitId] of [
    [1, UNIT_IDS[0]],
    [2, UNIT_IDS[1]],
  ] as const) {
    const frame = mockPanicFrame(n, unitId, receivedAt);
    openAlerts.set(frame.alertId, frame);
  }
}

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
      const panic = mockPanicFrame(n, unitId, now().toISOString());
      openAlerts.set(panic.alertId, panic);
      socket.onmessage?.({ data: JSON.stringify(panic) });
    };
    const acknowledged = (n: number, byName: string) => {
      openAlerts.delete(alertId(n));
      socket.onmessage?.({
        data: JSON.stringify({
          type: "acknowledged",
          alertId: alertId(n),
          acknowledgedAt: now().toISOString(),
          byName,
        }),
      });
    };

    later(0, () => {
      switch (name) {
        case "idle":
          open();
          return;
        case "restore":
          // No frames: the alerts only come from the open-alerts sync.
          seedRestoreAlerts(name, now);
          open();
          return;
        case "taken-remote":
          open();
          later(800, () => frame(1, UNIT_IDS[0]));
          later(3_500, () => acknowledged(1, "Rina"));
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
