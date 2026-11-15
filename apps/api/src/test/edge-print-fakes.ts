// In-memory PrintStore and helpers shared by the edge Print Agent tests
// (bead legend-46p). No database.

import { CoreError } from "@starter/shared/core";
import type {
  Clock,
  NewPrintJob,
  PrintAlert,
  PrintJobListQuery,
  PrintJobPage,
  PrintJobRecord,
  PrinterConfig,
  PrinterStatus,
  PrintStore,
} from "../edge/print/types.ts";

export const TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const OUTLET_ID = "00000000-0000-4000-8000-000000000002";

export type FakeClock = Clock & { ms: number; advance(ms: number): void };

export function createFakeClock(startMs = Date.UTC(2026, 10, 8, 7, 0, 0)) {
  const clock: FakeClock = {
    ms: startMs,
    now: () => new Date(clock.ms),
    advance(ms: number) {
      clock.ms += ms;
    },
  };
  return clock;
}

export function makePrinter(
  id: string,
  overrides: Partial<PrinterConfig> = {},
): PrinterConfig {
  return {
    id,
    tenantId: TENANT_ID,
    outletId: OUTLET_ID,
    label: id,
    role: "receipt",
    stationId: null,
    transport: { kind: "network", host: "192.168.1.50", port: 9100 },
    paperWidth: 32,
    fallbackPrinterId: null,
    status: "unknown",
    lastSeenAt: null,
    offlineSince: null,
    ...overrides,
  };
}

export type FakeStore = PrintStore & {
  jobs: PrintJobRecord[];
  alerts: PrintAlert[];
  printers: Map<string, PrinterConfig>;
  alertKinds(): string[];
};

export function createFakeStore(
  clock: Clock,
  printers: PrinterConfig[],
): FakeStore {
  const printerMap = new Map(printers.map((p) => [p.id, { ...p }]));
  const jobs: PrintJobRecord[] = [];
  const alerts: PrintAlert[] = [];
  const startedAt = new Map<string, Date>();
  let seq = 0;

  const find = (jobId: string): PrintJobRecord => {
    const job = jobs.find((item) => item.id === jobId);
    if (!job) throw new CoreError("NOT_FOUND", "Tugas cetak tidak ditemukan.");
    return job;
  };

  const store: FakeStore = {
    jobs,
    alerts,
    printers: printerMap,
    alertKinds: () => alerts.map((alert) => alert.kind),
    async listPrinters() {
      return [...printerMap.values()];
    },
    async getPrinter(printerId) {
      return printerMap.get(printerId) ?? null;
    },
    async setPrinterStatus(printerId, status: PrinterStatus, at) {
      const printer = printerMap.get(printerId);
      if (!printer) return;
      printer.status = status;
      if (status === "online") {
        printer.lastSeenAt = at;
        printer.offlineSince = null;
      } else if (status === "offline") {
        printer.offlineSince = at;
      }
    },
    async enqueue(job: NewPrintJob) {
      const existing = jobs.find(
        (item) => item.idempotencyKey === job.idempotencyKey,
      );
      if (existing) return { job: existing, created: false };
      seq += 1;
      const record: PrintJobRecord = {
        id: `job-${String(seq).padStart(4, "0")}`,
        tenantId: TENANT_ID,
        outletId: OUTLET_ID,
        printerId: job.printerId,
        kind: job.kind,
        status: "queued",
        content: job.content,
        attempts: 0,
        lastError: null,
        failurePhase: null,
        reprintOf: job.reprintOf ?? null,
        printedFallback: job.printedFallback ?? false,
        fallbackReason: job.fallbackReason ?? null,
        originalPrinterId: job.originalPrinterId ?? null,
        sourceRef: job.sourceRef ?? null,
        idempotencyKey: job.idempotencyKey,
        createdBy: job.createdBy ?? null,
        createdAt: clock.now(),
        printedAt: null,
      };
      jobs.push(record);
      return { job: record, created: true };
    },
    async checkStationTicketDestination() {
      return true;
    },
    async claimNext(printerId) {
      const next = jobs
        .filter((job) => job.status === "queued" && job.printerId === printerId)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )[0];
      if (!next) return null;
      next.status = "printing";
      next.attempts += 1;
      startedAt.set(next.id, clock.now());
      return { ...next };
    },
    async markPrinted(jobId, at) {
      const job = find(jobId);
      job.status = "printed";
      job.printedAt = at;
    },
    async markFailed(jobId, error, phase) {
      const job = find(jobId);
      job.status = "failed";
      job.lastError = error;
      job.failurePhase = phase;
    },
    async requeue(jobId) {
      const job = find(jobId);
      if (job.status !== "failed") {
        throw new CoreError("CONFLICT", "Tugas cetak tidak bisa diulang.");
      }
      job.status = "queued";
      job.failurePhase = null;
      return { ...job };
    },
    async releaseClaim(jobId, error) {
      const job = jobs.find((item) => item.id === jobId);
      if (!job || job.status !== "printing") return;
      job.status = "queued";
      job.lastError = error;
      job.failurePhase = null;
      startedAt.delete(job.id);
    },
    async failStaleClaims(startedBefore, error) {
      const failed: PrintJobRecord[] = [];
      for (const job of jobs) {
        const started = startedAt.get(job.id);
        if (
          job.status !== "printing" ||
          !started ||
          started.getTime() >= startedBefore.getTime()
        )
          continue;
        job.status = "failed";
        job.lastError = error.slice(0, 500);
        job.failurePhase = "stale";
        failed.push({ ...job });
      }
      return failed;
    },
    async reroute(fromPrinterId, toPrinterId) {
      let moved = 0;
      for (const job of jobs) {
        if (job.status !== "queued" || job.printerId !== fromPrinterId)
          continue;
        job.originalPrinterId ??= job.printerId;
        job.printerId = toPrinterId;
        job.printedFallback = true;
        job.fallbackReason = "printer_offline";
        moved += 1;
      }
      return moved;
    },
    async getJob(jobId) {
      return jobs.find((job) => job.id === jobId) ?? null;
    },
    async listJobs(query: PrintJobListQuery): Promise<PrintJobPage> {
      const items = jobs
        .filter((job) => !query.status || job.status === query.status)
        .slice(0, query.limit);
      return { items, nextCursor: null };
    },
    async recordAlert(alert) {
      alerts.push(alert);
    },
  };
  return store;
}
