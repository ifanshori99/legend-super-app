// Shared types of the edge Print Agent (bead legend-46p; PRD v1.7 §3 F5
// "Print Agent", "Fallback Berlapis", §3 F12 "Fallback Cetak", EDG-05).
//
// The agent runs inside the edge node process (EDGE_MODE). It owns one
// outlet: every store call is bound to the edge node's own tenant + outlet
// (its credential), never to a client-supplied scope (TEN-02).
//
// Pieces, each in its own file:
// - escpos.ts / templates.ts: pure ESC/POS byte builder and the three
//   templates (receipt, station ticket, shift report).
// - transport.ts: PrinterTransport over TCP 9100 or a USB device file, plus a
//   fake for tests.
// - monitor.ts: heartbeat monitor for printers (probe) and KDS screens
//   (reported heartbeats); detects failure within 30 seconds (EDG-05).
// - store.ts: PrintStore over PostgreSQL (edge_printers, edge_print_jobs,
//   edge_print_alerts) under tenant + outlet RLS.
// - agent.ts: per-printer serial queue, offline reroute, KDS-down fallback
//   and supervisor alerts.
import type { PrintJob } from "@starter/shared/edge";
import type { EdgeTx } from "../../services/edge-queue.service.ts";

export type PrinterTransportKind = "network" | "usb";
/** receipt: cashier printer; station: production station backup printer. */
export type PrinterRole = "receipt" | "station";
export type PrinterStatus = "unknown" | "online" | "offline";
/** Characters per line: 32 for 58 mm paper, 48 for 80 mm paper. */
export type PaperWidth = 32 | 48;

export type PrinterTransportConfig =
  | { kind: "network"; host: string; port: number }
  | { kind: "usb"; devicePath: string };

export type PrinterConfig = {
  /** Printer device id (devices registry, legend-165; plain UUID until it lands). */
  id: string;
  tenantId: string;
  outletId: string;
  label: string;
  role: PrinterRole;
  /** Production station this printer backs (stations.id), role "station" only. */
  stationId: string | null;
  transport: PrinterTransportConfig;
  paperWidth: PaperWidth;
  /** Printer that takes over this printer's queue while it is offline. */
  fallbackPrinterId: string | null;
  status: PrinterStatus;
  lastSeenAt: Date | null;
  offlineSince: Date | null;
};

export type PrintJobKind = PrintJob["kind"];
export type PrintJobStatus = PrintJob["status"];
/** Why a job is not on its normal printer / not on the KDS screen. */
export type FallbackReason = "kds_down" | "printer_offline";
/**
 * Why a job is `failed`: `write` (bytes may be partly printed), `stale`
 * (claim swept, outcome unknown) or `other`. Connect-phase failures never
 * fail a job (the claim is released). A retry of a `write` / `stale` job
 * prints a marked reprint, never a silent second original.
 */
export type FailurePhase = "write" | "stale" | "other";

export type PrintJobRecord = {
  /** ULID. */
  id: string;
  tenantId: string;
  outletId: string;
  printerId: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  /** Raw ESC/POS bytes. The API exposes them base64-encoded (`content`). */
  content: Uint8Array;
  attempts: number;
  lastError: string | null;
  /** Set while status is failed; null otherwise. */
  failurePhase: FailurePhase | null;
  /** ULID of the original job when this one is a "cetak ulang". */
  reprintOf: string | null;
  /** Printed because the KDS screen or the normal printer was unavailable. */
  printedFallback: boolean;
  fallbackReason: FallbackReason | null;
  /** The printer the job was first queued on, when rerouted. */
  originalPrinterId: string | null;
  /** Caller reference (receipt number, KDS ticket id, shift id). */
  sourceRef: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  createdAt: Date;
  printedAt: Date | null;
};

export type NewPrintJob = {
  printerId: string;
  kind: PrintJobKind;
  content: Uint8Array;
  /** Unique per outlet; a repeated key returns the existing job. */
  idempotencyKey: string;
  sourceRef?: string | null;
  reprintOf?: string | null;
  printedFallback?: boolean;
  fallbackReason?: FallbackReason | null;
  /** The printer the job was meant for when it is queued on a fallback. */
  originalPrinterId?: string | null;
  createdBy?: string | null;
};

export type PrintAlertKind =
  | "printer_offline"
  | "printer_online"
  | "kds_down"
  | "kds_up"
  | "fallback_printed"
  | "job_failed";

/** Supervisor alert (EDG-05). Persisted, then handed to the notifier port. */
export type PrintAlert = {
  kind: PrintAlertKind;
  /** Printer id, station id (KDS) or job id, depending on kind. */
  subjectId: string;
  stationId: string | null;
  detail: Record<string, string | number | boolean | null>;
  occurredAt: Date;
};

export type PrintJobListQuery = {
  status?: PrintJobStatus;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
  limit: number;
};

export type PrintJobPage = {
  items: PrintJobRecord[];
  nextCursor: string | null;
};

/**
 * Persistence for the agent and the print service. One instance is bound to
 * one tenant + outlet context; every method runs in its own tenant
 * transaction (withTenant) unless noted.
 */
export interface PrintStore {
  /** Revalidate station ticket destination and station binding immediately before sending. */
  checkStationTicketDestination(job: PrintJobRecord): Promise<boolean>;
  listPrinters(): Promise<PrinterConfig[]>;
  getPrinter(printerId: string): Promise<PrinterConfig | null>;
  /** Records a status change; `at` becomes last_seen_at when online. */
  setPrinterStatus(
    printerId: string,
    status: PrinterStatus,
    at: Date,
  ): Promise<void>;
  /** Idempotent on (outlet, idempotencyKey): `created` false returns the existing job. */
  enqueue(job: NewPrintJob): Promise<{ job: PrintJobRecord; created: boolean }>;
  /**
   * Claims the oldest queued job of the printer (created_at, id order):
   * queued → printing, attempts + 1. Uses FOR UPDATE SKIP LOCKED so two
   * processes never print the same job. Null when the queue is empty.
   */
  claimNext(printerId: string): Promise<PrintJobRecord | null>;
  /** printing → printed. */
  markPrinted(jobId: string, at: Date): Promise<void>;
  /** printing → failed, keeping the error text (no secrets, max 500 chars). */
  markFailed(
    jobId: string,
    error: string,
    phase: Exclude<FailurePhase, "stale">,
  ): Promise<void>;
  /** failed → queued (transitionPrintJob "retry"), clearing failurePhase. Returns the updated job. */
  requeue(jobId: string): Promise<PrintJobRecord>;
  /**
   * printing → queued in one statement, keeping attempts and the error text:
   * the claim is released because nothing reached the printer (connect-phase
   * failure). No-op when the job is no longer printing.
   */
  releaseClaim(jobId: string, error: string): Promise<void>;
  /**
   * Jobs left in printing with started_at before `startedBefore` (crash or
   * DB error after the claim): printing → failed with `error`, so staff
   * retry deliberately (failurePhase "stale"). Returns the failed jobs.
   */
  failStaleClaims(
    startedBefore: Date,
    error: string,
  ): Promise<PrintJobRecord[]>;
  /**
   * Moves every queued job of `fromPrinterId` to `toPrinterId`, setting
   * printed_fallback, fallback_reason = "printer_offline" and
   * original_printer_id (first printer only). Returns the moved count.
   */
  reroute(fromPrinterId: string, toPrinterId: string): Promise<number>;
  getJob(jobId: string): Promise<PrintJobRecord | null>;
  listJobs(query: PrintJobListQuery): Promise<PrintJobPage>;
  recordAlert(
    alert: PrintAlert,
    notify?: (alert: PrintAlert, tx?: EdgeTx) => void | Promise<void>,
  ): Promise<void | boolean>;
}

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

// Template inputs: narrow on purpose. The POS receipt document
// (ws/pos-receipt), KDS tickets (ws/kds) and the shift report (ws/pos-shift)
// map their own data to these shapes; amounts are whole rupiah.

export type ReceiptLine = {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  note?: string | null;
};

export type ReceiptData = {
  outletName: string;
  outletAddress?: string | null;
  receiptNumber: string;
  cashierName: string;
  issuedAt: Date;
  lines: ReceiptLine[];
  subtotal: number;
  discount?: number;
  serviceCharge?: number;
  tax?: number;
  total: number;
  payments: { method: string; amount: number }[];
  change?: number;
  footer?: string | null;
  /** Training-mode sale (F5 Mode Latihan): printed with a "LATIHAN" banner. */
  trainingMode?: boolean;
};

export type StationTicketItem = {
  name: string;
  qty: number;
  modifiers?: string[];
  note?: string | null;
};

export type StationTicketData = {
  stationName: string;
  ticketNumber: string;
  /** Table, queue number or customer label shown large. */
  orderLabel: string;
  orderType?: string | null;
  createdAt: Date;
  items: StationTicketItem[];
  /** Printed because the KDS screen is down (F12 Fallback Cetak). */
  fallback?: boolean;
};

export type ShiftReportData = {
  outletName: string;
  cashierName: string;
  shiftOpenedAt: Date;
  shiftClosedAt: Date;
  openingCash: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  sales: { method: string; count: number; amount: number }[];
  totalSales: number;
  refunds?: number;
  voids?: number;
  /** Blind count per denomination (founder decision, 8 Nov). */
  denominations?: { label: string; count: number; amount: number }[];
};
