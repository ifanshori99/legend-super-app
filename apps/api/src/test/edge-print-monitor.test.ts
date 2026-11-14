import { describe, expect, it } from "vitest";
import { createHealthMonitor } from "../edge/print/monitor.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import type { Clock, PrinterConfig } from "../edge/print/types.ts";

class FakeClock implements Clock {
  constructor(private ms = Date.parse("2026-11-08T07:00:00.000Z")) {}
  now(): Date {
    return new Date(this.ms);
  }
  get ms_(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const TICK_MS = 5000;

function printer(id: string): PrinterConfig {
  return {
    id,
    tenantId: "tenant-1",
    outletId: "outlet-1",
    label: id,
    role: "receipt",
    stationId: null,
    transport: { kind: "network", host: "192.168.1.50", port: 9100 },
    paperWidth: 48,
    fallbackPrinterId: null,
    status: "unknown",
    lastSeenAt: null,
    offlineSince: null,
  };
}

function setup() {
  const clock = new FakeClock();
  const startMs = clock.ms_;
  const transports = new Map<string, FakePrinterTransport>();
  const printers = [printer("p1"), printer("p2")];
  for (const p of printers) transports.set(p.id, new FakePrinterTransport());
  const printerEvents: { id: string; status: string; atMs: number }[] = [];
  const kdsEvents: { id: string; status: string; atMs: number }[] = [];
  const monitor = createHealthMonitor({
    clock,
    listPrinters: async () => printers,
    transportFor: (p) => transports.get(p.id)!,
    onPrinterChange: (p, status, at) => {
      printerEvents.push({ id: p.id, status, atMs: at.getTime() });
    },
    onKdsChange: (id, status, at) => {
      kdsEvents.push({ id, status, atMs: at.getTime() });
    },
  });
  const tickFor = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      clock.advance(TICK_MS);
      await monitor.tick();
    }
  };
  return {
    clock,
    startMs,
    transports,
    monitor,
    printerEvents,
    kdsEvents,
    tickFor,
  };
}

describe("health monitor: printers", () => {
  it("reports a printer online once on the first successful probe", async () => {
    const { monitor, printerEvents, tickFor } = setup();
    await monitor.tick();
    await tickFor(30_000);
    expect(printerEvents.filter((e) => e.id === "p1")).toEqual([
      expect.objectContaining({ status: "online" }),
    ]);
    expect(monitor.isPrinterOnline("p1")).toBe(true);
  });

  it("reports a pulled printer offline within 30 s, at the exact tick", async () => {
    const { monitor, transports, printerEvents, tickFor, startMs } = setup();
    await monitor.tick(); // t0: last successful probe
    // Pulled right after the last good probe: worst case.
    transports.get("p1")!.online = false;
    await tickFor(10_000); // t0+5s, t0+10s: still inside the 15 s window
    expect(monitor.isPrinterOnline("p1")).toBe(true);
    await tickFor(5000); // t0+15s: 15 000 ms without a probe -> offline
    const offline = printerEvents.find(
      (e) => e.id === "p1" && e.status === "offline",
    );
    expect(offline?.atMs).toBe(startMs + 15_000);
    expect(offline!.atMs - startMs).toBeLessThanOrEqual(30_000);
    expect(monitor.isPrinterOnline("p1")).toBe(false);
    // The healthy printer is untouched.
    expect(monitor.isPrinterOnline("p2")).toBe(true);
  });

  it("does not repeat the offline event while the printer stays down", async () => {
    const { monitor, transports, printerEvents, tickFor } = setup();
    await monitor.tick();
    transports.get("p1")!.online = false;
    await tickFor(60_000);
    expect(
      printerEvents.filter((e) => e.id === "p1" && e.status === "offline"),
    ).toHaveLength(1);
  });

  it("fires online once on recovery and no duplicate afterwards", async () => {
    const { monitor, transports, printerEvents, tickFor } = setup();
    await monitor.tick();
    transports.get("p1")!.online = false;
    await tickFor(20_000);
    transports.get("p1")!.online = true;
    await tickFor(30_000);
    expect(
      printerEvents.filter((e) => e.id === "p1").map((e) => e.status),
    ).toEqual(["online", "offline", "online"]);
    expect(monitor.isPrinterOnline("p1")).toBe(true);
  });

  it("a printer that never answers goes offline 15 s after monitor start", async () => {
    const { monitor, transports, printerEvents, tickFor, startMs } = setup();
    transports.get("p1")!.online = false;
    await tickFor(10_000);
    expect(printerEvents.filter((e) => e.id === "p1")).toHaveLength(0);
    expect(monitor.isPrinterOnline("p1")).toBe(true);
    await tickFor(5000);
    expect(printerEvents.find((e) => e.id === "p1")).toEqual({
      id: "p1",
      status: "offline",
      atMs: startMs + 15_000,
    });
  });

  it("markSuspect makes the next failed probe report offline at once", async () => {
    const { monitor, transports, printerEvents, clock, startMs } = setup();
    await monitor.tick();
    transports.get("p1")!.online = false;
    monitor.markSuspect("p1");
    clock.advance(TICK_MS);
    await monitor.tick();
    expect(
      printerEvents.find((e) => e.id === "p1" && e.status === "offline")?.atMs,
    ).toBe(startMs + TICK_MS);
  });

  it("markSuspect is cleared when the probe still succeeds", async () => {
    const { monitor, transports, printerEvents, clock } = setup();
    await monitor.tick();
    monitor.markSuspect("p1");
    clock.advance(TICK_MS);
    await monitor.tick();
    transports.get("p1")!.online = false;
    clock.advance(TICK_MS);
    await monitor.tick(); // no longer suspect: needs the full 15 s window
    expect(monitor.isPrinterOnline("p1")).toBe(true);
    expect(printerEvents.filter((e) => e.status === "offline")).toHaveLength(0);
  });

  it("treats a probe that hangs as a failure after the probe timeout", async () => {
    const clock = new FakeClock();
    const events: string[] = [];
    const monitor = createHealthMonitor({
      clock,
      listPrinters: async () => [printer("p1")],
      transportFor: () => ({
        send: async () => undefined,
        probe: () => new Promise<boolean>(() => undefined),
      }),
      probeTimeoutMs: 20,
      offlineAfterMs: 0,
      onPrinterChange: (_p, status) => {
        events.push(status);
      },
    });
    await monitor.tick();
    expect(events).toEqual(["offline"]);
  });

  it("survives a throwing listener", async () => {
    const clock = new FakeClock();
    const monitor = createHealthMonitor({
      clock,
      listPrinters: async () => [printer("p1")],
      transportFor: () => new FakePrinterTransport(),
      onPrinterChange: () => {
        throw new Error("boom");
      },
    });
    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(monitor.isPrinterOnline("p1")).toBe(true);
  });
});

describe("health monitor: KDS", () => {
  it("reports a station down within 30 s once its heartbeats stop", async () => {
    const { monitor, kdsEvents, clock, tickFor } = setup();
    monitor.watchKds("st1");
    // Heartbeat every 5 s for a while.
    for (let i = 0; i < 4; i += 1) {
      monitor.recordKdsHeartbeat("st1");
      clock.advance(TICK_MS);
      await monitor.tick();
    }
    const lastHeartbeatMs = clock.ms_ - TICK_MS; // sent before the last advance
    expect(monitor.isKdsUp("st1")).toBe(true);
    await tickFor(15_000);
    const down = kdsEvents.find((e) => e.status === "down");
    expect(down).toBeDefined();
    expect(down!.atMs).toBe(lastHeartbeatMs + 15_000);
    expect(down!.atMs - lastHeartbeatMs).toBeLessThanOrEqual(30_000);
    expect(monitor.isKdsUp("st1")).toBe(false);
  });

  it("fires down only once per episode", async () => {
    const { monitor, kdsEvents, tickFor } = setup();
    monitor.recordKdsHeartbeat("st1");
    await tickFor(90_000);
    expect(kdsEvents.filter((e) => e.status === "down")).toHaveLength(1);
  });

  it("brings a station back up immediately when a heartbeat resumes", async () => {
    const { monitor, kdsEvents, clock, tickFor } = setup();
    monitor.recordKdsHeartbeat("st1");
    await tickFor(20_000);
    expect(monitor.isKdsUp("st1")).toBe(false);
    clock.advance(1000);
    monitor.recordKdsHeartbeat("st1");
    expect(monitor.isKdsUp("st1")).toBe(true);
    expect(kdsEvents.map((e) => e.status)).toEqual(["down", "up"]);
    expect(kdsEvents[1]!.atMs).toBe(clock.ms_);
    // Steady heartbeats: no further events.
    for (let i = 0; i < 4; i += 1) {
      clock.advance(TICK_MS);
      monitor.recordKdsHeartbeat("st1");
      await monitor.tick();
    }
    expect(kdsEvents).toHaveLength(2);
  });

  it("does not fire up for the very first heartbeat of a station", () => {
    const { monitor, kdsEvents } = setup();
    monitor.recordKdsHeartbeat("st1");
    expect(kdsEvents).toHaveLength(0);
    expect(monitor.isKdsUp("st1")).toBe(true);
  });

  it("keeps a watched station unknown until its first genuine heartbeat", async () => {
    const { monitor, kdsEvents, tickFor } = setup();
    monitor.watchKds("st1");
    await tickFor(10_000);
    expect(monitor.isKdsUp("st1")).toBe(true);
    expect(kdsEvents).toHaveLength(0);
    await tickFor(90_000);
    expect(monitor.isKdsUp("st1")).toBe(true);
    expect(kdsEvents).toHaveLength(0);
  });

  it("tracks stations independently", async () => {
    const { monitor, clock } = setup();
    monitor.watchKds("a");
    monitor.recordKdsHeartbeat("b");
    for (let i = 0; i < 6; i += 1) {
      monitor.recordKdsHeartbeat("a");
      clock.advance(TICK_MS);
      await monitor.tick();
    }
    expect(monitor.isKdsUp("a")).toBe(true);
    expect(monitor.isKdsUp("b")).toBe(false);
  });

  it("does not infer a down screen merely by asking about an unwatched station", async () => {
    const { monitor, tickFor } = setup();
    expect(monitor.isKdsUp("ghost")).toBe(true);
    await tickFor(15_000);
    expect(monitor.isKdsUp("ghost")).toBe(true);
  });
});
