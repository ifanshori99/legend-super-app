// Print Agent: per-printer serial queues, offline reroute, KDS-down fallback
// and supervisor alerts (bead legend-46p; PRD v1.7 §3 F5 "Print Agent" and
// "Fallback Berlapis", §3 F12 "Fallback Cetak", EDG-05: failure detected in
// 30 seconds or less, then fallback plus a supervisor notice).
//
// Time is injected (Clock) and `tick()` is public, so tests drive the agent
// without timers. `start()` runs the health loop on its own: draining (slow
// printer, backlog) is kicked in the background and never delays the next
// probe or KDS check. Printer content and PII are never logged or put in
// alerts.
import { CoreError } from "@starter/shared/core";
import { logger } from "../../lib/logger.ts";
import type { EdgeTx } from "../../services/edge-queue.service.ts";
import { createHealthMonitor } from "./monitor.ts";
import { renderStationTicket } from "./templates.ts";
import { PrintTransportError, type TransportFactory } from "./transport.ts";
import {
  systemClock,
  type Clock,
  type NewPrintJob,
  type PrintAlert,
  type PrintJobRecord,
  type PrinterConfig,
  type PrintStore,
  type StationTicketData,
} from "./types.ts";

export type PrintAlertNotifier = (
  alert: PrintAlert,
  tx?: EdgeTx,
) => void | Promise<void>;

// Notification port installed by the edge print runtime.
let moduleNotifier: PrintAlertNotifier | null = null;

export function setPrintAlertNotifier(fn: PrintAlertNotifier | null): void {
  moduleNotifier = fn;
}

export type PrintAgentOptions = {
  store: PrintStore;
  transportFor: TransportFactory;
  clock?: Clock;
  /** Interval of the background loop started by `start()`. */
  tickMs?: number;
  offlineAfterMs?: number;
  kdsDownAfterMs?: number;
  /** A job in printing longer than this is failed by the stale sweep. */
  staleClaimMs?: number;
  /** Overrides the module-level notifier (see `setPrintAlertNotifier`). */
  notify?: PrintAlertNotifier;
};

export type StationTicketInput = {
  stationId: string;
  idempotencyKey: string;
  sourceRef?: string;
  ticket: StationTicketData;
};

export type PrintAgent = ReturnType<typeof createPrintAgent>;

const STALE_CLAIM_MS = 120_000;
// Health ticks between stale sweeps (12 x 5 s = about 60 s).
const STALE_SWEEP_EVERY_TICKS = 12;
const STALE_CLAIM_ERROR =
  "Status cetak tidak diketahui; periksa printer lalu cetak ulang bila perlu.";

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 500);
  }
  return "Kesalahan cetak tidak dikenal.";
}

export function createPrintAgent(options: PrintAgentOptions) {
  const { store, transportFor } = options;
  const clock = options.clock ?? systemClock;
  const tickMs = options.tickMs ?? 5000;
  const staleClaimMs = options.staleClaimMs ?? STALE_CLAIM_MS;

  // Printer state as reported by the monitor callbacks. A printer without an
  // entry falls back to the status persisted in the store.
  const reported = new Map<string, "online" | "offline">();
  // Per-printer promise chain: one job at a time per printer.
  const chains = new Map<string, Promise<void>>();
  // Work started by monitor callbacks; tick() waits for it.
  const pending = new Set<Promise<void>>();
  // Background drains kicked by the health loop and by enqueue.
  const kicked = new Set<Promise<unknown>>();
  // Printers with a kicked drain in flight, and those that need another pass.
  const inflight = new Set<string>();
  const rerun = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<void> | null = null;
  let healthTicks = 0;

  async function emit(alert: PrintAlert): Promise<void> {
    const notify = options.notify ?? moduleNotifier;
    let notified = false;
    try {
      notified = (await store.recordAlert(alert, notify ?? undefined)) === true;
    } catch {
      logger.warn(
        { kind: alert.kind, subjectId: alert.subjectId },
        "Print alert could not be recorded",
      );
      // A failed alert write must not stop printing.
      return;
    }
    try {
      if (!notified) await notify?.(alert);
    } catch {
      // Notifier errors never break the agent.
    }
  }

  function track(work: Promise<void>): void {
    const settled = work.catch(() => undefined);
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  }

  function isOffline(printer: PrinterConfig): boolean {
    const state = reported.get(printer.id);
    return state ? state === "offline" : printer.status === "offline";
  }

  // The monitor flips before its callback has written `reported`.
  function isDown(printer: PrinterConfig): boolean {
    return isOffline(printer) || !monitor.isPrinterOnline(printer.id);
  }

  async function handlePrinterChange(
    printer: PrinterConfig,
    status: "online" | "offline",
    at: Date,
  ): Promise<void> {
    const wasOffline = isOffline(printer);
    reported.set(printer.id, status);
    await store.setPrinterStatus(printer.id, status, at);
    if (status === "online") {
      // First contact after start is not a recovery: no alert.
      if (!wasOffline) return;
      await emit({
        kind: "printer_online",
        subjectId: printer.id,
        stationId: printer.stationId,
        detail: { label: printer.label },
        occurredAt: at,
      });
      return;
    }
    let moved = 0;
    let fallbackPrinterId: string | null = null;
    if (printer.fallbackPrinterId) {
      const fallback = await store.getPrinter(printer.fallbackPrinterId);
      if (fallback && !isOffline(fallback)) {
        fallbackPrinterId = fallback.id;
        moved = await store.reroute(printer.id, fallback.id);
      }
    }
    await emit({
      kind: "printer_offline",
      subjectId: printer.id,
      stationId: printer.stationId,
      detail: { label: printer.label, movedCount: moved, fallbackPrinterId },
      occurredAt: at,
    });
  }

  const monitor = createHealthMonitor({
    clock,
    listPrinters: () => store.listPrinters(),
    transportFor,
    offlineAfterMs: options.offlineAfterMs,
    kdsDownAfterMs: options.kdsDownAfterMs,
    onPrinterChange: (printer, status, at) => {
      track(handlePrinterChange(printer, status, at));
    },
    onKdsChange: (stationId, status, at) => {
      track(
        emit({
          kind: status === "down" ? "kds_down" : "kds_up",
          subjectId: stationId,
          stationId,
          detail: {},
          occurredAt: at,
        }),
      );
    },
  });

  async function printOne(
    printer: PrinterConfig,
    job: PrintJobRecord,
  ): Promise<"continue" | "stop"> {
    if (
      job.kind === "station_ticket" ||
      printer.role === "station" ||
      job.originalPrinterId !== null
    ) {
      let valid = false;
      try {
        valid = await store.checkStationTicketDestination(job);
      } catch {
        // If the registry cannot be read, never send without verification.
      }
      if (!valid) {
        logger.warn(
          { jobId: job.id, printerId: printer.id },
          "Station printer validation failed",
        );
        try {
          await store.markFailed(
            job.id,
            "Printer stasiun tidak valid atau tidak dapat diverifikasi.",
            "other",
          );
        } catch {
          logger.error(
            { jobId: job.id, printerId: printer.id },
            "Invalid printer job could not be marked failed",
          );
          return "stop";
        }
        await emit({
          kind: "job_failed",
          subjectId: job.id,
          stationId: printer.stationId,
          detail: {
            printerId: printer.id,
            kind: job.kind,
            attempts: job.attempts,
            reason: "invalid_station_printer",
          },
          occurredAt: clock.now(),
        });
        return "continue";
      }
    }
    const transport = transportFor(printer);
    try {
      await transport.send(job.content);
    } catch (error) {
      const text = errorText(error);
      if (error instanceof PrintTransportError && error.phase === "connect") {
        // Nothing reached the printer: release the claim, print again later.
        monitor.markSuspect(printer.id);
        try {
          await store.releaseClaim(job.id, text);
        } catch {
          // The stale sweep fails the job later.
        }
        return "stop";
      }
      try {
        await store.markFailed(
          job.id,
          text,
          error instanceof PrintTransportError ? "write" : "other",
        );
      } catch {
        // The job stays printing; the stale sweep fails it later.
        return "stop";
      }
      await emit({
        kind: "job_failed",
        subjectId: job.id,
        stationId: printer.stationId,
        detail: {
          printerId: printer.id,
          kind: job.kind,
          attempts: job.attempts,
        },
        occurredAt: clock.now(),
      });
      if (error instanceof PrintTransportError) {
        // Bytes may be partly printed: staff retry manually (no silent duplicate).
        monitor.markSuspect(printer.id);
        return "stop";
      }
      return "continue";
    }
    const at = clock.now();
    // No alert per fallback job: supervisors get one kds_down /
    // printer_offline alert per episode, not one per ticket.
    try {
      await store.markPrinted(job.id, at);
    } catch {
      // Printed but not recorded: stop this printer, the stale sweep fails
      // the job later so staff check the paper before reprinting.
      return "stop";
    }
    return "continue";
  }

  async function drainPrinter(printerId: string): Promise<void> {
    const printer = await store.getPrinter(printerId);
    if (!printer) return;
    if (isDown(printer)) {
      // Jobs can land on an offline printer after its offline reroute ran
      // (a released claim, a staff retry, an enqueue race): keep moving them
      // to an online fallback on every drain. Only queued jobs move.
      if (printer.fallbackPrinterId) {
        const fallback = await store.getPrinter(printer.fallbackPrinterId);
        if (fallback && !isDown(fallback))
          await store.reroute(printer.id, fallback.id);
      }
      return;
    }
    for (;;) {
      const job = await store.claimNext(printer.id);
      if (!job) return;
      if ((await printOne(printer, job)) === "stop") return;
    }
  }

  function drain(printerId?: string): Promise<void> {
    if (printerId === undefined) {
      return store.listPrinters().then(async (printers) => {
        await Promise.all(printers.map((printer) => drain(printer.id)));
      });
    }
    const previous = chains.get(printerId) ?? Promise.resolve();
    const next = previous.then(() => drainPrinter(printerId));
    // The chain survives a failed run; the caller still sees the rejection.
    chains.set(
      printerId,
      next.catch(() => undefined),
    );
    return next;
  }

  function keep(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined);
    kicked.add(settled);
    void settled.finally(() => kicked.delete(settled));
  }

  // Starts a drain without waiting. One kicked drain per printer at a time;
  // a kick during a run schedules one more pass, so no job waits for a tick.
  function kickPrinter(printerId: string): void {
    if (inflight.has(printerId)) {
      rerun.add(printerId);
      return;
    }
    inflight.add(printerId);
    keep(
      (async () => {
        try {
          do {
            rerun.delete(printerId);
            await drain(printerId).catch(() => undefined);
          } while (rerun.has(printerId));
        } finally {
          inflight.delete(printerId);
        }
      })(),
    );
  }

  function kickAll(): void {
    keep(
      store.listPrinters().then((printers) => {
        for (const printer of printers) kickPrinter(printer.id);
      }),
    );
  }

  async function sweepStaleClaims(): Promise<PrintJobRecord[]> {
    const failed = await store.failStaleClaims(
      new Date(clock.now().getTime() - staleClaimMs),
      STALE_CLAIM_ERROR,
    );
    for (const job of failed) {
      let stationId: string | null = null;
      try {
        stationId = (await store.getPrinter(job.printerId))?.stationId ?? null;
      } catch {
        // The alert is still sent without the station.
      }
      await emit({
        kind: "job_failed",
        subjectId: job.id,
        stationId,
        detail: {
          printerId: job.printerId,
          kind: job.kind,
          attempts: job.attempts,
        },
        occurredAt: clock.now(),
      });
    }
    return failed;
  }

  // Tests: monitor tick plus an awaited drain of every printer.
  async function tick(): Promise<void> {
    await monitor.tick();
    await Promise.all([...pending]);
    await drain();
  }

  // Background loop step: health first, drains kicked after and not awaited.
  async function healthTick(): Promise<void> {
    // Alert side effects (reroute, recordAlert, notifier) are not awaited
    // here: a slow notifier or DB must not delay the next probe (EDG-05).
    await monitor.tick();
    healthTicks += 1;
    if (healthTicks % STALE_SWEEP_EVERY_TICKS === 0) {
      keep(sweepStaleClaims());
    }
    kickAll();
  }

  async function enqueue(job: NewPrintJob): Promise<PrintJobRecord> {
    const printer = await store.getPrinter(job.printerId);
    if (!printer) {
      throw new CoreError("NOT_FOUND", "Printer tidak ditemukan.");
    }
    let target = printer;
    let routed: NewPrintJob = job;
    if (isOffline(printer) && printer.fallbackPrinterId) {
      const fallback = await store.getPrinter(printer.fallbackPrinterId);
      if (fallback && !isOffline(fallback)) {
        target = fallback;
        routed = {
          ...job,
          printerId: fallback.id,
          printedFallback: true,
          fallbackReason: "printer_offline",
          originalPrinterId: printer.id,
        };
      }
    }
    const { job: record } = await store.enqueue(routed);
    // Race: the printer may have gone offline while the job was being saved,
    // after its offline reroute already ran. Move the job to the fallback.
    if (isDown(target) && target.fallbackPrinterId) {
      const fallback = await store.getPrinter(target.fallbackPrinterId);
      if (fallback && !isDown(fallback)) {
        await store.reroute(target.id, fallback.id);
        target = fallback;
      }
    }
    // Print soon when the background loop runs; tests call tick()/drain().
    if (timer) kickPrinter(target.id);
    return record;
  }

  async function routeStationTicket(
    input: StationTicketInput,
  ): Promise<{ printed: false } | { printed: true; job: PrintJobRecord }> {
    monitor.watchKds(input.stationId);
    if (monitor.isKdsUp(input.stationId)) return { printed: false };

    const printers = await store.listPrinters();
    const stationPrinter = printers.find(
      (printer) =>
        printer.role === "station" && printer.stationId === input.stationId,
    );
    if (!stationPrinter) {
      throw new CoreError(
        "NOT_FOUND",
        "Printer cadangan untuk stasiun ini tidak ditemukan.",
      );
    }
    let target = stationPrinter;
    if (isOffline(stationPrinter) && stationPrinter.fallbackPrinterId) {
      const fallback = printers.find(
        (printer) => printer.id === stationPrinter.fallbackPrinterId,
      );
      if (fallback && !isOffline(fallback)) target = fallback;
    }
    const content = renderStationTicket(
      { ...input.ticket, fallback: true },
      target.paperWidth,
    );
    const { job } = await store.enqueue({
      printerId: target.id,
      kind: "station_ticket",
      content,
      idempotencyKey: input.idempotencyKey,
      sourceRef: input.sourceRef ?? null,
      printedFallback: true,
      fallbackReason: "kds_down",
      originalPrinterId:
        target.id === stationPrinter.id ? null : stationPrinter.id,
    });
    if (timer) kickPrinter(target.id);
    return { printed: true, job };
  }

  function start(): void {
    if (timer) return;
    keep(sweepStaleClaims());
    timer = setInterval(() => {
      if (ticking) return;
      ticking = healthTick()
        .catch(() => undefined)
        .finally(() => {
          ticking = null;
        });
    }, tickMs);
    timer.unref();
  }

  async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    await ticking;
    while (pending.size > 0) await Promise.all([...pending]);
    while (kicked.size > 0) await Promise.all([...kicked]);
    await Promise.all([...chains.values()]);
  }

  return {
    start,
    stop,
    tick,
    drain,
    sweepStaleClaims,
    enqueue,
    routeStationTicket,
    recordKdsHeartbeat: (stationId: string) =>
      monitor.recordKdsHeartbeat(stationId, clock.now()),
    monitor,
  };
}
