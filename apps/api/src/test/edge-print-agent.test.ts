// Print Agent tests (bead legend-46p; PRD v1.7 §3 F5 "Fallback Berlapis",
// F12 "Fallback Cetak", EDG-05: failure detected in 30 seconds or less).
// In-memory store, fake transports and a fake clock. No database.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPrintAgent,
  setPrintAlertNotifier,
} from "../edge/print/agent.ts";
import {
  FakePrinterTransport,
  type PrinterTransport,
} from "../edge/print/transport.ts";
import type {
  PrintAlert,
  PrintStore,
  StationTicketData,
} from "../edge/print/types.ts";
import {
  createFakeClock,
  createFakeStore,
  makePrinter,
} from "./edge-print-fakes.ts";

const TICK_MS = 5000;

const ticket: StationTicketData = {
  stationName: "Bar",
  ticketNumber: "T-12",
  orderLabel: "Meja 4",
  createdAt: new Date(Date.UTC(2026, 10, 8, 7, 0, 0)),
  items: [{ name: "Es Kopi", qty: 2 }],
};

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

function setup(
  printerDefs = [makePrinter("A"), makePrinter("B")],
  notify?: (alert: PrintAlert) => void,
) {
  const clock = createFakeClock();
  const startMs = clock.ms;
  const store = createFakeStore(clock, printerDefs);
  const transports = new Map<string, FakePrinterTransport>(
    printerDefs.map((printer) => [printer.id, new FakePrinterTransport()]),
  );
  const agent = createPrintAgent({
    store,
    clock,
    notify,
    transportFor: (printer) => transports.get(printer.id)!,
  });
  const tick = async () => {
    clock.advance(TICK_MS);
    await agent.tick();
  };
  return { clock, startMs, store, transports, agent, tick };
}

afterEach(() => {
  setPrintAlertNotifier(null);
  vi.useRealTimers();
});

describe("print agent queue", () => {
  it("prints the jobs of one printer oldest first", async () => {
    const { agent, store, transports } = setup();
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await agent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(text),
        idempotencyKey: `k-${index}`,
      });
      // Same createdAt for all jobs: order falls back to the id.
    }
    await agent.tick();
    expect(transports.get("A")!.printed.map(textOf)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(store.jobs.map((job) => job.status)).toEqual([
      "printed",
      "printed",
      "printed",
    ]);
  });

  it("never prints two jobs of one printer at the same time", async () => {
    const { clock, store } = setup([makePrinter("A")]);
    let active = 0;
    let maxActive = 0;
    const printed: string[] = [];
    const slow: PrinterTransport = {
      async send(bytes) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        printed.push(textOf(bytes));
        active -= 1;
      },
      async probe() {
        return true;
      },
    };
    const slowAgent = createPrintAgent({
      store,
      clock,
      transportFor: () => slow,
    });
    for (const text of ["a", "b", "c", "d"]) {
      await slowAgent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(text),
        idempotencyKey: text,
      });
    }
    await Promise.all([
      slowAgent.drain("A"),
      slowAgent.drain("A"),
      slowAgent.tick(),
    ]);
    expect(maxActive).toBe(1);
    expect(printed).toEqual(["a", "b", "c", "d"]);
  });

  it("requeues after a connect failure and prints once the printer is back", async () => {
    const { agent, store, transports, tick } = setup();
    const job = await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "k",
    });
    transports.get("A")!.failNextSend = "connect";
    await tick();
    expect(store.jobs[0]).toMatchObject({
      id: job.id,
      status: "queued",
      attempts: 1,
    });
    expect(transports.get("A")!.printed).toHaveLength(0);
    await tick();
    expect(transports.get("A")!.printed.map(textOf)).toEqual(["r"]);
    expect(store.jobs[0]).toMatchObject({ status: "printed", attempts: 2 });
  });

  it("keeps a job failed after a write failure, alerts, and prints after a manual retry", async () => {
    const { agent, store, transports, tick } = setup();
    const job = await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "k",
    });
    transports.get("A")!.failNextSend = "write";
    await tick();
    expect(store.jobs[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      failurePhase: "write",
    });
    expect(store.alerts.filter((a) => a.kind === "job_failed")).toHaveLength(1);
    expect(store.alerts[0]?.subjectId).toBe(job.id);
    // No automatic retry: staff decide (a duplicate print is possible).
    await tick();
    expect(store.jobs[0]?.status).toBe("failed");
    await store.requeue(job.id);
    expect(store.jobs[0]?.failurePhase).toBeNull();
    await tick();
    expect(store.jobs[0]).toMatchObject({ status: "printed", attempts: 2 });
    expect(transports.get("A")!.printed.map(textOf)).toEqual(["r"]);
  });

  it("marks a non-transport failure with phase other", async () => {
    const { clock, store } = setup([makePrinter("A")]);
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: () => ({
        send: async () => {
          throw new Error("boom");
        },
        probe: async () => true,
      }),
    });
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "k-other",
    });
    await agent.tick();
    expect(store.jobs[0]).toMatchObject({
      status: "failed",
      failurePhase: "other",
    });
  });
});

describe("printer offline fallback", () => {
  const withFallback = () =>
    setup([makePrinter("A", { fallbackPrinterId: "B" }), makePrinter("B")]);

  it("reports a pulled printer offline at exactly 15 s and reroutes queued jobs", async () => {
    const { agent, store, transports, tick, clock, startMs } = withFallback();
    await agent.tick(); // t0: both printers alive
    for (const text of ["x", "y"]) {
      await agent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(text),
        idempotencyKey: text,
      });
    }
    // Pull the cable before the jobs print.
    transports.get("A")!.online = false;
    await agent.drain("B");
    let offlineAt: number | null = null;
    while (offlineAt === null && clock.ms - startMs <= 30_000) {
      await tick();
      const alert = store.alerts.find((a) => a.kind === "printer_offline");
      if (alert) offlineAt = alert.occurredAt.getTime() - startMs;
    }
    expect(offlineAt).not.toBeNull();
    expect(offlineAt!).toBeLessThanOrEqual(30_000);
    // The first failed send marks A suspect, so it goes offline at the next tick.
    expect(offlineAt).toBe(10_000);
    const alert = store.alerts.find((a) => a.kind === "printer_offline")!;
    expect(alert.detail).toMatchObject({
      movedCount: 2,
      fallbackPrinterId: "B",
    });
    expect(store.printers.get("A")!.status).toBe("offline");
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["x", "y"]);
    expect(store.jobs.every((job) => job.printerId === "B")).toBe(true);
    expect(store.jobs[0]).toMatchObject({
      printedFallback: true,
      fallbackReason: "printer_offline",
      originalPrinterId: "A",
      status: "printed",
    });
    // One alert per episode, none per fallback job.
    expect(
      store.alertKinds().filter((k) => k === "fallback_printed"),
    ).toHaveLength(0);
    expect(
      store.alertKinds().filter((k) => k === "printer_offline"),
    ).toHaveLength(1);
  });

  it("detects an idle printer by heartbeat alone at exactly 15 s", async () => {
    const { agent, store, transports, tick, startMs } = withFallback();
    await agent.tick();
    transports.get("A")!.online = false;
    for (let i = 0; i < 2; i += 1) {
      await tick();
      expect(store.alertKinds()).not.toContain("printer_offline");
    }
    await tick();
    const alert = store.alerts.find((a) => a.kind === "printer_offline")!;
    expect(alert.occurredAt.getTime() - startMs).toBe(15_000);
    expect(alert.detail).toMatchObject({ movedCount: 0 });
  });

  it("fires one online alert on recovery and no duplicates", async () => {
    const { agent, store, transports, tick } = withFallback();
    await agent.tick();
    transports.get("A")!.online = false;
    for (let i = 0; i < 6; i += 1) await tick();
    expect(
      store.alertKinds().filter((k) => k === "printer_offline"),
    ).toHaveLength(1);
    transports.get("A")!.online = true;
    for (let i = 0; i < 3; i += 1) await tick();
    expect(
      store.alertKinds().filter((k) => k === "printer_online"),
    ).toHaveLength(1);
    expect(store.printers.get("A")!.status).toBe("online");
  });

  it("queues new jobs of an offline printer on its online fallback", async () => {
    const { agent, transports, tick } = withFallback();
    await agent.tick();
    transports.get("A")!.online = false;
    for (let i = 0; i < 3; i += 1) await tick();
    const job = await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("late"),
      idempotencyKey: "late",
    });
    expect(job).toMatchObject({
      printerId: "B",
      printedFallback: true,
      fallbackReason: "printer_offline",
    });
    await agent.drain();
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["late"]);
    expect(transports.get("A")!.printed).toHaveLength(0);
  });

  it("moves a job released back onto an offline printer to its fallback and prints it", async () => {
    const { agent, store, transports, tick } = withFallback();
    await agent.tick();
    const job = await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("released"),
      idempotencyKey: "released",
    });
    // Claimed while A was alive, so the offline reroute cannot move it.
    expect(await store.claimNext("A")).toMatchObject({ id: job.id });
    transports.get("A")!.online = false;
    for (let i = 0; i < 3; i += 1) await tick();
    expect(store.printers.get("A")!.status).toBe("offline");
    expect(store.jobs[0]).toMatchObject({ status: "printing", printerId: "A" });
    // The claim is released after the reroute already ran: queued on A again.
    await store.releaseClaim(job.id, "connect failed");
    expect(store.jobs[0]).toMatchObject({ status: "queued", printerId: "A" });
    await tick();
    await tick();
    expect(store.jobs[0]).toMatchObject({
      status: "printed",
      printerId: "B",
      printedFallback: true,
      fallbackReason: "printer_offline",
      originalPrinterId: "A",
    });
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["released"]);
    expect(transports.get("A")!.printed).toHaveLength(0);
  });

  it("prints a retried failed job on the fallback when its printer is offline", async () => {
    const { agent, store, transports, tick } = withFallback();
    await agent.tick();
    const job = await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("retry"),
      idempotencyKey: "retry",
    });
    transports.get("A")!.failNextSend = "write";
    await tick();
    expect(store.jobs[0]).toMatchObject({ status: "failed", printerId: "A" });
    transports.get("A")!.online = false;
    for (let i = 0; i < 3; i += 1) await tick();
    expect(store.printers.get("A")!.status).toBe("offline");
    // A failed job is not queued, so the offline reroute left it on A.
    expect(store.jobs[0]).toMatchObject({ status: "failed", printerId: "A" });
    await store.requeue(job.id);
    expect(store.jobs[0]).toMatchObject({ status: "queued", printerId: "A" });
    await tick();
    await tick();
    expect(store.jobs[0]).toMatchObject({
      status: "printed",
      printerId: "B",
      originalPrinterId: "A",
    });
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["retry"]);
    expect(transports.get("A")!.printed).toHaveLength(0);
  });
});

describe("KDS down fallback", () => {
  const withStation = () =>
    setup([
      makePrinter("R"),
      makePrinter("S", { role: "station", stationId: "bar" }),
    ]);

  it("never prints a station that has not sent a heartbeat", async () => {
    const { agent, clock, store } = withStation();
    clock.advance(20_000);
    await agent.tick();
    expect(
      await agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: "unheard",
        ticket: { ...ticket, createdAt: clock.now() },
      }),
    ).toEqual({ printed: false });
    expect(store.jobs).toHaveLength(0);
    expect(store.alertKinds()).not.toContain("kds_down");
  });

  it("does not print a ticket older than six hours after a known screen stops", async () => {
    const { agent, clock, store } = withStation();
    agent.recordKdsHeartbeat("bar");
    clock.advance(7 * 60 * 60 * 1000);
    await agent.tick();
    expect(
      await agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: "stale-ticket",
        ticket: {
          ...ticket,
          createdAt: new Date(clock.ms - 6 * 60 * 60 * 1000 - 1),
        },
      }),
    ).toEqual({ printed: false });
    expect(store.jobs).toHaveLength(0);
  });

  it("a twenty-second gap prints only tickets newer than its last heartbeat", async () => {
    const { agent, clock, store, transports } = withStation();
    const lastHeartbeatAt = clock.now();
    agent.recordKdsHeartbeat("bar");
    clock.advance(20_000);
    await agent.tick();
    const route = (key: string, createdAt: Date) =>
      agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: key,
        ticket: { ...ticket, createdAt },
      });
    expect(
      await route("already-seen", new Date(lastHeartbeatAt.getTime() - 1)),
    ).toEqual({ printed: false });
    expect(await route("at-heartbeat", lastHeartbeatAt)).toEqual({
      printed: false,
    });
    expect(
      (await route("new-during-gap", new Date(lastHeartbeatAt.getTime() + 1)))
        .printed,
    ).toBe(true);
    await agent.drain();
    expect(store.jobs).toHaveLength(1);
    expect(transports.get("S")!.printed).toHaveLength(1);
  });

  it("does not enqueue an empty ticket after a known screen stops", async () => {
    const { agent, clock, store } = withStation();
    agent.recordKdsHeartbeat("bar");
    clock.advance(20_000);
    await agent.tick();
    expect(
      await agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: "empty-ticket",
        ticket: { ...ticket, createdAt: clock.now(), items: [] },
      }),
    ).toEqual({ printed: false });
    expect(store.jobs).toHaveLength(0);
  });

  it("does not print when a heartbeat returns during an awaited printer lookup", async () => {
    const clock = createFakeClock();
    const store = createFakeStore(clock, [
      makePrinter("S", { role: "station", stationId: "bar" }),
    ]);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const agent = createPrintAgent({
      store: {
        ...store,
        async listPrinters() {
          started();
          await blocked;
          return store.listPrinters();
        },
      },
      clock,
      transportFor: () => new FakePrinterTransport(),
    });
    agent.recordKdsHeartbeat("bar");
    clock.advance(20_000);
    const routing = agent.routeStationTicket({
      stationId: "bar",
      idempotencyKey: "recovered-during-read",
      ticket: { ...ticket, createdAt: clock.now() },
    });
    await lookupStarted;
    agent.recordKdsHeartbeat("bar");
    release();
    expect(await routing).toEqual({ printed: false });
    expect(store.jobs).toHaveLength(0);
  });

  it("prints nothing while the KDS screen is alive", async () => {
    const { agent, store, tick } = withStation();
    agent.recordKdsHeartbeat("bar");
    await tick();
    agent.recordKdsHeartbeat("bar");
    const result = await agent.routeStationTicket({
      stationId: "bar",
      idempotencyKey: "t1",
      ticket,
    });
    expect(result).toEqual({ printed: false });
    expect(store.jobs).toHaveLength(0);
  });

  it("prints a banner ticket on the station printer within 30 s of silence", async () => {
    const { agent, store, transports, tick, startMs, clock } = withStation();
    agent.recordKdsHeartbeat("bar");
    let downAt: number | null = null;
    while (downAt === null && clock.ms - startMs <= 30_000) {
      await tick();
      const alert = store.alerts.find((a) => a.kind === "kds_down");
      if (alert) downAt = alert.occurredAt.getTime() - startMs;
    }
    expect(downAt).toBe(15_000);
    const result = await agent.routeStationTicket({
      stationId: "bar",
      idempotencyKey: "t1",
      sourceRef: "ticket-12",
      ticket: { ...ticket, createdAt: clock.now() },
    });
    expect(result.printed).toBe(true);
    if (!result.printed) return;
    expect(result.job).toMatchObject({
      printerId: "S",
      kind: "station_ticket",
      printedFallback: true,
      fallbackReason: "kds_down",
      sourceRef: "ticket-12",
    });
    await agent.drain();
    const printed = transports.get("S")!.printed;
    expect(printed).toHaveLength(1);
    expect(textOf(printed[0]!)).toContain("KDS MATI");
    expect(textOf(printed[0]!)).toContain("Es Kopi");
  });

  it("sends one kds_down alert per episode and kds_up on recovery", async () => {
    const { agent, store, tick } = withStation();
    agent.recordKdsHeartbeat("bar");
    for (let i = 0; i < 6; i += 1) await tick();
    expect(store.alertKinds().filter((k) => k === "kds_down")).toHaveLength(1);
    agent.recordKdsHeartbeat("bar");
    await agent.tick();
    expect(store.alertKinds().filter((k) => k === "kds_up")).toHaveLength(1);
    expect(
      await agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: "t2",
        ticket,
      }),
    ).toEqual({ printed: false });
    for (let i = 0; i < 4; i += 1) await tick();
    expect(store.alertKinds().filter((k) => k === "kds_down")).toHaveLength(2);
  });

  it("does not infer a missing screen from a station that has never sent a heartbeat", async () => {
    const { agent, tick } = withStation();
    const route = (key: string) =>
      agent.routeStationTicket({
        stationId: "bar",
        idempotencyKey: key,
        ticket,
      });
    expect(await route("g1")).toEqual({ printed: false });
    await tick();
    await tick();
    expect(await route("g2")).toEqual({ printed: false });
    await tick();
    expect(await route("g3")).toEqual({ printed: false });
  });

  it("uses the station printer's fallback when that printer is offline", async () => {
    const { agent, transports, tick, clock } = setup([
      makePrinter("R"),
      makePrinter("S", {
        role: "station",
        stationId: "bar",
        fallbackPrinterId: "R",
      }),
    ]);
    await agent.tick();
    agent.recordKdsHeartbeat("bar");
    transports.get("S")!.online = false;
    for (let i = 0; i < 4; i += 1) await tick();
    const result = await agent.routeStationTicket({
      stationId: "bar",
      idempotencyKey: "t3",
      ticket: { ...ticket, createdAt: clock.now() },
    });
    expect(result.printed && result.job.printerId).toBe("R");
  });
});

describe("alerts and notifier", () => {
  it("keeps ticking when the notifier throws", async () => {
    const notify = vi.fn(() => {
      throw new Error("notifier down");
    });
    const { agent, store, transports, tick } = setup(
      [makePrinter("A", { fallbackPrinterId: "B" }), makePrinter("B")],
      notify,
    );
    await agent.tick();
    transports.get("A")!.online = false;
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "k",
    });
    for (let i = 0; i < 4; i += 1) await tick();
    expect(notify).toHaveBeenCalled();
    expect(store.alertKinds()).toContain("printer_offline");
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["r"]);
  });

  it("hands alerts to the module-level notifier", async () => {
    const seen: PrintAlert[] = [];
    setPrintAlertNotifier((alert) => {
      seen.push(alert);
    });
    const { agent, tick } = setup();
    agent.recordKdsHeartbeat("bar");
    for (let i = 0; i < 4; i += 1) await tick();
    expect(seen.map((a) => a.kind)).toEqual(["kds_down"]);
  });
});

describe("agent loop", () => {
  it("waits for a pending offline notification before stopping", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notified = false;
    const { agent, transports, clock } = setup(
      [makePrinter("A")],
      async (alert) => {
        if (alert.kind === "printer_offline") {
          notified = true;
          await gate;
        }
      },
    );
    agent.start();
    transports.get("A")!.online = false;
    for (let i = 0; i < 6; i += 1) {
      clock.advance(TICK_MS);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    expect(notified).toBe(true);
    let stopped = false;
    const stopping = agent.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("ticks on an interval after start() and stops cleanly", async () => {
    vi.useFakeTimers();
    const { agent, store, transports, clock } = setup([makePrinter("A")]);
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "k",
    });
    agent.start();
    agent.start(); // second start is a no-op
    clock.advance(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await agent.stop();
    expect(transports.get("A")!.printed.map(textOf)).toEqual(["r"]);
    expect(store.jobs[0]?.status).toBe("printed");
  });

  it("detects another printer offline within 30 s while a send hangs", async () => {
    vi.useFakeTimers();
    const printerDefs = [makePrinter("A"), makePrinter("B")];
    const clock = createFakeClock();
    const store = createFakeStore(clock, printerDefs);
    let sends = 0;
    let release: () => void = () => undefined;
    const hanging: PrinterTransport = {
      send() {
        sends += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async probe() {
        return true;
      },
    };
    const b = new FakePrinterTransport();
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: (printer) => (printer.id === "A" ? hanging : b),
    });
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("slow"),
      idempotencyKey: "slow",
    });
    agent.start();
    b.online = false;
    for (let i = 0; i < 6; i += 1) {
      clock.advance(TICK_MS);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    // 30 s on: A is still stuck in send, B was reported offline anyway.
    expect(sends).toBe(1);
    expect(store.jobs[0]?.status).toBe("printing");
    expect(
      store.alerts.filter(
        (alert) => alert.kind === "printer_offline" && alert.subjectId === "B",
      ),
    ).toHaveLength(1);
    release();
    await agent.stop();
    expect(store.jobs[0]?.status).toBe("printed");
  });

  it("prints a job enqueued while the loop runs without waiting for a tick", async () => {
    vi.useFakeTimers();
    const { agent, store, transports } = setup([makePrinter("A")]);
    agent.start();
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("now"),
      idempotencyKey: "now",
    });
    await vi.advanceTimersByTimeAsync(0);
    await agent.stop();
    expect(transports.get("A")!.printed.map(textOf)).toEqual(["now"]);
    expect(store.jobs[0]?.status).toBe("printed");
  });
});

describe("stale claims", () => {
  const STALE_MS = 120_000;

  it("fails only claims older than staleClaimMs and alerts once per job", async () => {
    const { agent, store, clock } = setup([makePrinter("A")]);
    for (const key of ["old", "fresh"]) {
      await agent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(key),
        idempotencyKey: key,
      });
    }
    await store.claimNext("A"); // old
    clock.advance(STALE_MS + 1);
    await store.claimNext("A"); // fresh
    const failed = await agent.sweepStaleClaims();
    expect(failed.map((job) => job.idempotencyKey)).toEqual(["old"]);
    expect(store.jobs.map((job) => job.status)).toEqual(["failed", "printing"]);
    expect(store.jobs[0]?.lastError).toContain("periksa printer");
    expect(store.jobs[0]?.failurePhase).toBe("stale");
    const alerts = store.alerts.filter((a) => a.kind === "job_failed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subjectId).toBe(store.jobs[0]?.id);
    // Already failed: a second sweep finds nothing.
    expect(await agent.sweepStaleClaims()).toHaveLength(0);
  });

  it("sweeps on start()", async () => {
    vi.useFakeTimers();
    const { agent, store, clock } = setup([makePrinter("A")]);
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("x"),
      idempotencyKey: "x",
    });
    await store.claimNext("A");
    clock.advance(STALE_MS + 1);
    agent.start();
    await agent.stop();
    expect(store.jobs[0]?.status).toBe("failed");
  });

  it("sweeps every 12 health ticks", async () => {
    vi.useFakeTimers();
    const { agent, store, clock } = setup([makePrinter("A")]);
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("x"),
      idempotencyKey: "x",
    });
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    await store.claimNext("A");
    for (let i = 0; i < 11; i += 1) {
      clock.advance(TICK_MS * 4);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    expect(store.jobs[0]?.status).toBe("printing");
    clock.advance(TICK_MS * 4);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await agent.stop();
    expect(store.jobs[0]?.status).toBe("failed");
  });
});

describe("store failures during a drain", () => {
  it("stops the printer when markPrinted throws and does not crash", async () => {
    const { clock, store: base, transports } = setup([makePrinter("A")]);
    const store: PrintStore = {
      ...base,
      markPrinted: async () => {
        throw new Error("db down");
      },
    };
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: (printer) => transports.get(printer.id)!,
    });
    for (const key of ["one", "two"]) {
      await agent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(key),
        idempotencyKey: key,
      });
    }
    await expect(agent.tick()).resolves.toBeUndefined();
    // First job printed, then the printer stopped: the second was not claimed.
    expect(transports.get("A")!.printed.map(textOf)).toEqual(["one"]);
    expect(base.jobs.map((job) => job.status)).toEqual(["printing", "queued"]);
  });

  it("stops the printer when markFailed throws", async () => {
    const { clock, store: base, transports } = setup([makePrinter("A")]);
    const store: PrintStore = {
      ...base,
      markFailed: async () => {
        throw new Error("db down");
      },
    };
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: (printer) => transports.get(printer.id)!,
    });
    for (const key of ["one", "two"]) {
      await agent.enqueue({
        printerId: "A",
        kind: "receipt",
        content: bytesOf(key),
        idempotencyKey: key,
      });
    }
    transports.get("A")!.failNextSend = "write";
    await expect(agent.tick()).resolves.toBeUndefined();
    expect(base.jobs.map((job) => job.status)).toEqual(["printing", "queued"]);
    expect(base.alerts.filter((a) => a.kind === "job_failed")).toHaveLength(0);
  });
});

describe("enqueue race", () => {
  it("reroutes to the fallback when the printer goes offline while saving", async () => {
    const printerDefs = [
      makePrinter("A", { fallbackPrinterId: "B" }),
      makePrinter("B"),
    ];
    const clock = createFakeClock();
    const base = createFakeStore(clock, printerDefs);
    const transports = new Map(
      printerDefs.map((p) => [p.id, new FakePrinterTransport()]),
    );
    const store: PrintStore = {
      ...base,
      enqueue: async (job) => {
        // The probe fails while the job is being saved: the offline reroute
        // runs before the job exists, so it cannot move it.
        transports.get("A")!.online = false;
        agent.monitor.markSuspect("A");
        await agent.monitor.tick();
        return base.enqueue(job);
      },
    };
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: (printer) => transports.get(printer.id)!,
    });
    await agent.enqueue({
      printerId: "A",
      kind: "receipt",
      content: bytesOf("r"),
      idempotencyKey: "race",
    });
    expect(base.jobs[0]).toMatchObject({
      printerId: "B",
      originalPrinterId: "A",
      printedFallback: true,
      fallbackReason: "printer_offline",
    });
    await agent.tick();
    expect(transports.get("B")!.printed.map(textOf)).toEqual(["r"]);
  });
});
