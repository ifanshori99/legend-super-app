// EDC agent service on the edge node (bead legend-apt; PRD v1.7 §3 F5 "EDC
// Agent", §3 F10a, §4 Alur W, criteria EDC-01/02/03).
//
// Money rules this file enforces:
// - Write-ahead: the `pending` row is committed BEFORE the sale reaches the
//   terminal, so a crash mid-sale leaves a trace that `recoverInFlight` turns
//   into `unknown` (never silently lost, never `failed`).
// - Status inquiry before retry (EDC-03): an `unknown` row for a POS reference
//   is inquired at the terminal before any new sale for that reference. A
//   sale is never resent for the same idempotency key.
// - Whatever the terminal answer cannot prove is `unknown`: timeout,
//   disconnect, garbage frame, and an approved answer whose amount differs
//   from the request (EDC-01). Only a clean `approved` with a matching amount
//   is `approved`.
// - One ECR exchange at a time per terminal (FIFO, in-process). The database
//   is never held in a transaction while the terminal is called. The terminal
//   lock is released only when the adapter's promise settles, not when the
//   agent's timeout fires: a late reply from a call we gave up on can never be
//   read as the answer to the next exchange. Meanwhile new sales and
//   inquiries on that terminal fail fast.
// - One agent process per outlet (Postgres advisory lock taken in `start`):
//   the in-memory queue and `inFlight` set are only correct with one owner.
// - A sale is marked dispatched (guarded UPDATE, inside the terminal lock)
//   right before it reaches the terminal. `dispatched_at IS NULL` proves the
//   terminal never saw it, so only then may it be cancelled or failed locally.
//   A terminal's `not_found` is trusted only from a by-trace provider after
//   the sale is old enough that it cannot still be in transit, and only while
//   the terminal's open batch equals the batch known at dispatch (a closed
//   batch hides the sale from inquiry).
//
// No domain events here: whether approval or settlement marks a bill paid
// belongs to the POS payment flow (legend-m0k) and settlement (legend-cs7).
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EdcError,
  ecrInquiryResultSchema,
  ecrResultSchema,
  edcConnectionSchema,
  edcPaymentRequestSchema,
  edcTransactionRefSchema,
  edcTransactionSchema,
  EcrTransportError,
  isEdcFinalStatus,
  type EcrInquiryResult,
  type EcrResult,
  type EcrTerminal,
  type EdcBank,
  type EdcPaymentRequest,
  type EdcProvider,
  type EdcProviderCapabilities,
  type EdcTransaction,
  type EdcTransactionEventName,
  type EdcTransactionRef,
  type EdcTransactionStatus,
} from "@starter/shared/edc";
import { withTenant } from "../../db/tenant.ts";
import { edcTransactions, paymentEdcTerminals } from "../../db/schema/index.ts";
import type * as schema from "../../db/schema/index.ts";
import { logger } from "../../lib/logger.ts";
import {
  assertPaymentPermission,
  uniqueViolation,
} from "../../services/payment-support.ts";
import { assertEdcSaleBillPayable } from "../../services/pos-order-support.ts";
import { emitEdcTransactionEvent } from "./events.ts";
import { EDC_LATE_RESPONSE_WINDOW_MS } from "./late-response.ts";
import type { EdcProviderRegistry } from "./registry.ts";

export type Database = NodePgDatabase<typeof schema>;
type Ownership =
  { client: PoolClient; lockName: string; lost: () => void } | undefined;
type Hold = <R>(
  call: () => Promise<R>,
  signal: AbortSignal,
  /** Row whose exchange this is: `holding` has it until the call settles. */
  rowId?: string,
) => Promise<R>;
/** Who may use the terminal: the outlet and the ownership token taken when
 * the operation began. An operation without a live token never sends. */
type Gate = { readonly key: string; readonly ownership: Ownership };
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EdcRow = typeof edcTransactions.$inferSelect;
type TerminalRow = typeof paymentEdcTerminals.$inferSelect;

export type EdcAgentDeps = {
  db: Database;
  /** Pool behind `db`, for the per-outlet advisory lock. Defaults to
   * `db.$client` (set by `drizzle(pool)`). */
  pool?: Pool;
  registry: Pick<EdcProviderRegistry, "get">;
  saleTimeoutMs?: number;
  inquiryTimeoutMs?: number;
  cancelTimeoutMs?: number;
  /** Extra wait, on top of `saleTimeoutMs`, before an inquiry `not_found`
   * counts as "the terminal never got the sale". Default 30s. */
  notFoundGraceMs?: number;
  /** An inquiry `not_found` is trusted only while the sale is at most this
   * old: `by_trace` sees the current batch only, so after settlement it
   * proves nothing. Older: `unknown` + `needs_reconciliation`. Default 15 min. */
  notFoundTrustWindowMs?: number;
  now?: () => Date;
  newTrace?: () => string;
};

export interface EdcAgent {
  /** Takes ownership of every outlet in `ctx.outletScope` (one process per
   * outlet, Postgres advisory lock), then runs `recoverInFlight`. Throws
   * `EDC_AGENT_NOT_READY` when another process owns an outlet or the scope is
   * not a list of outlets. Every other operation needs this first. */
  start(ctx: ScopedTenantContext): Promise<void>;
  /** Releases the outlets of `ctx`, or every outlet this instance owns. */
  stop(ctx?: ScopedTenantContext): Promise<void>;
  requestPayment(
    ctx: ScopedTenantContext,
    actorUserId: string,
    input: EdcPaymentRequest,
  ): Promise<EdcTransaction>;
  inquire(
    ctx: ScopedTenantContext,
    actorUserId: string,
    ref: EdcTransactionRef,
  ): Promise<EdcTransaction>;
  cancel(
    ctx: ScopedTenantContext,
    actorUserId: string,
    ref: EdcTransactionRef,
  ): Promise<EdcTransaction>;
  get(
    ctx: ScopedTenantContext,
    actorUserId: string,
    ref: EdcTransactionRef,
  ): Promise<EdcTransaction>;
  /** Rows left `pending` by a crashed process become `unknown`. Returns the
   * count. Called by `start`; needs the outlets of `ctx` to be owned. */
  recoverInFlight(ctx: ScopedTenantContext): Promise<number>;
}

const PERMISSION = "pos.payment.accept" as const;
const TRACE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const OPEN_STATUSES = ["pending", "unknown"] as const;
const MAX_ATTEMPTS = 3;
const DEFAULT_NOT_FOUND_TRUST_WINDOW_MS = 15 * 60_000;

const MESSAGE_UNKNOWN = "Jawaban terminal tidak diterima. Cek status terminal.";
const MESSAGE_NOT_FOUND = "Terminal tidak menerima transaksi ini.";
const MESSAGE_NOT_FOUND_UNCONFIRMED =
  "Terminal belum menemukan transaksi ini, tetapi belum pasti. Cek status terminal.";
const MESSAGE_NOT_FOUND_STALE =
  "Terminal tidak lagi dapat memastikan transaksi ini. Rekonsiliasi manual.";
const MESSAGE_NOT_FOUND_BATCH =
  "Batch terminal berubah atau tidak diketahui, transaksi tidak dapat dipastikan. Rekonsiliasi manual.";
const MESSAGE_TRACE_MISMATCH =
  "Jawaban terminal bukan untuk transaksi ini. Cek status terminal.";
const MESSAGE_APPROVED_TWICE = "approved twice: void + reconcile";
const MESSAGE_NEVER_SENT = "Transaksi tidak pernah dikirim ke terminal.";
const MESSAGE_CANCELLED_UNSENT = "Dibatalkan sebelum dikirim ke terminal.";
const IDEMPOTENCY_CONSTRAINT = "edc_transactions_tenant_idempotency_key";
const MESSAGE_RECOVERED = "Agent EDC berhenti saat transaksi berjalan.";
const MESSAGE_CANCEL_AWAITING_SALE =
  "Pembatalan diterima terminal; menunggu jawaban penjualan.";

function defaultTrace(): string {
  let trace = "";
  for (let i = 0; i < 12; i += 1)
    trace += TRACE_ALPHABET[randomInt(TRACE_ALPHABET.length)];
  return trace;
}

/** The owner check refused a call right before the terminal: nothing was
 * sent. Distinct from an adapter failure, which may have reached the wire. */
class NotSentError extends EdcError {
  constructor() {
    super("EDC_AGENT_NOT_READY");
  }
}

function notFound(): CoreError {
  return new CoreError("NOT_FOUND", "Transaksi EDC tidak ditemukan.");
}

/** Stable hash of what the key promises: same key, same request. */
function fingerprintOf(input: EdcPaymentRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.outletId.toLowerCase(),
        input.terminalId.toLowerCase(),
        input.reference,
        input.amountIdr,
        input.method,
      ]),
    )
    .digest("hex");
}

function assertScope(
  ctx: ScopedTenantContext,
  tenantId: string,
  outletId: string,
): void {
  if (tenantId.toLowerCase() !== ctx.tenant.tenantId.toLowerCase())
    throw new CoreError("FORBIDDEN", "TENANT");
  assertOutletInScope(ctx.outletScope, outletId);
}

function toDto(row: EdcRow): EdcTransaction {
  return edcTransactionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    terminalId: row.terminalId,
    bank: row.bank,
    reference: row.reference,
    idempotencyKey: row.idempotencyKey,
    amountIdr: row.amountIdr,
    method: row.method,
    status: row.status,
    trace: row.trace,
    approvalCode: row.approvalCode,
    rrn: row.rrn,
    cardType: row.cardType,
    maskedPan: row.maskedPan,
    responseCode: row.responseCode,
    message: row.message,
    invoiceNo: row.invoiceNo,
    batchNo: row.batchNo,
    needsReconciliation: row.needsReconciliation,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    inquiryCount: row.inquiryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function toEcrTerminal(terminal: TerminalRow, bank: EdcBank): EcrTerminal {
  const connection = edcConnectionSchema.safeParse(terminal.connection);
  if (!connection.success) throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
  return {
    tenantId: terminal.tenantId,
    outletId: terminal.outletId,
    id: terminal.id,
    bank,
    terminalId: terminal.terminalId,
    merchantId: terminal.merchantId,
    connection: connection.data,
    ipAddress: terminal.ipAddress,
  };
}

/** What to write after a terminal answer. No `status`: leave it as is. */
type Patch = {
  status?: EdcTransactionStatus;
  /** Set when only a human can settle the row (stale evidence). */
  needsReconciliation?: true;
  details?: Partial<
    Pick<
      EdcRow,
      | "approvalCode"
      | "rrn"
      | "cardType"
      | "maskedPan"
      | "responseCode"
      | "message"
      | "invoiceNo"
      | "batchNo"
    >
  >;
};

function detailsOf(result: EcrResult | EcrInquiryResult): Patch["details"] {
  return {
    approvalCode: result.approvalCode,
    rrn: result.rrn,
    cardType: result.cardType,
    maskedPan: result.maskedPan,
    responseCode: result.responseCode,
    message: result.message,
    invoiceNo: result.invoiceNo,
    batchNo: result.batchNo,
  };
}

/** What the patch needs to know about the provider and the clock. */
type AnswerContext = {
  readonly capabilities: EdcProviderCapabilities;
  readonly nowMs: number;
  /** Inquiry `not_found` is trusted once the sale is at least this old. */
  readonly notFoundAfterMs: number;
  /** Inquiry `not_found` is not trusted once the sale is older than this. */
  readonly notFoundTrustWindowMs: number;
  /** Inquiry answers must echo our trace; a missing echo settles nothing. */
  readonly strictTrace: boolean;
};

/** Terminal answer -> ledger patch. Only an answer that provably belongs to
 * this exchange and this amount is final; anything else is `unknown` for a
 * human to reconcile (EDC-01, EDC-03):
 * - the amount must be reported and equal the request;
 * - the trace echo must equal ours; a missing echo is never accepted from an
 *   inquiry (it may answer for another transaction), and from a sale or cancel
 *   by any provider except a `last_only` one (its terminal may answer for
 *   another transaction);
 * - `not_found` means `failed` only when the sale was never dispatched, or a
 *   by-trace provider says so after the sale is too old to be in transit and
 *   still young enough for the batch to hold it; older than that it is
 *   `unknown` for a human (`needsReconciliation`);
 * - a dispatched row's `not_found` also needs the answer's batch to equal the
 *   batch known at dispatch (both known): a settlement in between hides the
 *   sale from inquiry, so a changed or unknown batch is `unknown` too. */
function patchFromAnswer(
  row: EdcRow,
  result: EcrResult | EcrInquiryResult,
  answerCtx: AnswerContext,
): Patch {
  if (result.outcome === "in_progress") return {};
  // The echo is checked before any outcome, `not_found` included: an answer
  // that names another transaction's trace, or none, says nothing about this
  // one (it must never turn this row `failed`, which frees a second charge).
  const traceOk =
    result.trace === row.trace ||
    (result.trace === null &&
      !answerCtx.strictTrace &&
      answerCtx.capabilities.inquiry !== "last_only");
  if (!traceOk) {
    logger.warn(
      { edcTransactionId: row.id, trace: row.trace },
      "EDC terminal answer does not echo the request trace",
    );
    // An inquiry answers by asking: a wrong or missing echo means another
    // transaction's answer, so nothing of it is recorded on this row. A sale
    // or cancel reply may really be the charge: keep it as evidence and flag
    // the row for a human.
    if (answerCtx.strictTrace)
      return {
        status: "unknown",
        details: { message: MESSAGE_TRACE_MISMATCH },
      };
    return {
      ...unknownEvidencePatch(result, MESSAGE_TRACE_MISMATCH),
      needsReconciliation: true,
    };
  }
  if (result.outcome === "not_found") {
    const dispatchedAt = row.dispatchedAt;
    const ageMs =
      dispatchedAt === null ? 0 : answerCtx.nowMs - dispatchedAt.getTime();
    if (dispatchedAt !== null && ageMs > answerCtx.notFoundTrustWindowMs)
      return {
        status: "unknown",
        needsReconciliation: true,
        details: { message: MESSAGE_NOT_FOUND_STALE },
      };
    const trusted =
      dispatchedAt === null ||
      (answerCtx.capabilities.inquiry === "by_trace" &&
        ageMs >= answerCtx.notFoundAfterMs);
    if (
      trusted &&
      dispatchedAt !== null &&
      !(
        result.batchNo !== null &&
        row.dispatchBatchNo !== null &&
        result.batchNo === row.dispatchBatchNo
      )
    )
      return {
        status: "unknown",
        needsReconciliation: true,
        details: { message: MESSAGE_NOT_FOUND_BATCH },
      };
    return trusted
      ? { status: "failed", details: { message: MESSAGE_NOT_FOUND } }
      : {
          status: "unknown",
          details: { message: MESSAGE_NOT_FOUND_UNCONFIRMED },
        };
  }
  switch (result.outcome) {
    case "approved":
      if (result.amountIdr === null || result.amountIdr !== row.amountIdr) {
        logger.warn(
          { edcTransactionId: row.id, trace: row.trace },
          "EDC terminal amount is missing or differs from the request",
        );
        return {
          ...unknownEvidencePatch(
            result,
            new EdcError("EDC_AMOUNT_MISMATCH").message,
          ),
          needsReconciliation: true,
        };
      }
      return { status: "approved", details: detailsOf(result) };
    case "declined":
      return { status: "declined", details: detailsOf(result) };
    case "cancelled":
      return { status: "cancelled", details: detailsOf(result) };
  }
}

/** `unknown` that keeps what the terminal sent, as evidence for a human. */
function unknownEvidencePatch(
  result: EcrResult | EcrInquiryResult,
  message: string,
): Patch {
  return {
    status: "unknown",
    details: {
      approvalCode: result.approvalCode,
      rrn: result.rrn,
      responseCode: result.responseCode,
      invoiceNo: result.invoiceNo,
      batchNo: result.batchNo,
      message,
    },
  };
}

/** Outbox event for a row that just reached `row.status` (EDC-05). `pending`
 * has none here: `created` is emitted by the write-ahead insert. */
function eventNameFor(row: EdcRow): EdcTransactionEventName | null {
  switch (row.status) {
    case "approved":
      return "edc_transaction.approved";
    case "declined":
      return "edc_transaction.declined";
    case "failed":
      return "edc_transaction.failed";
    case "cancelled":
      return "edc_transaction.cancelled";
    case "unknown":
      return "edc_transaction.flagged";
    default:
      return null;
  }
}

function unknownPatch(): Patch {
  return { status: "unknown", details: { message: MESSAGE_UNKNOWN } };
}

/** Rejects with a timeout when `signal` aborts, even if the provider ignores
 * it: the answer is then unknown, and a hung provider cannot hold the
 * terminal queue forever. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new EcrTransportError("timeout", "EDC call timed out"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Ledger status is stored as plain text; the CHECK constraint keeps it in the enum. */
function isFinal(status: string): boolean {
  return isEdcFinalStatus(status as EdcTransactionStatus);
}

function errorKind(error: unknown): string {
  return error instanceof EcrTransportError ? error.kind : "error";
}

/** Name of the violated constraint, looked up through wrapped driver errors. */
function violatedConstraint(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  if (typeof candidate.constraint === "string") return candidate.constraint;
  return violatedConstraint(candidate.cause, depth + 1);
}

export function createEdcAgent(deps: EdcAgentDeps): EdcAgent {
  const { db, registry } = deps;
  const saleTimeoutMs = deps.saleTimeoutMs ?? 120_000;
  // The late-response window must outlast the sale call, or a row could
  // leave the window while its adapter call is still running.
  if (saleTimeoutMs >= EDC_LATE_RESPONSE_WINDOW_MS)
    throw new Error(
      `EDC saleTimeoutMs (${saleTimeoutMs} ms) must be shorter than the late-response window (${EDC_LATE_RESPONSE_WINDOW_MS} ms)`,
    );
  const inquiryTimeoutMs = deps.inquiryTimeoutMs ?? 15_000;
  const cancelTimeoutMs = deps.cancelTimeoutMs ?? 15_000;
  const notFoundGraceMs = deps.notFoundGraceMs ?? 30_000;
  const notFoundTrustWindowMs =
    deps.notFoundTrustWindowMs ?? DEFAULT_NOT_FOUND_TRUST_WINDOW_MS;
  const now = deps.now ?? (() => new Date());
  const newTrace = deps.newTrace ?? defaultTrace;

  /** Rows whose sale this process is sending or waiting on. Registered before
   * the write-ahead commit so no reader sees `pending` without it. */
  const inFlight = new Set<string>();
  /** Rows whose adapter call outlived its timeout and is still running in
   * this process (their `sale_wire_open_at` is live, not stale). Added before
   * the marker write; removed once the call settles and the marker is
   * cleared. `clearStaleWireOpen` skips them. */
  const wireOpen = new Set<string>();
  /** FIFO tail per terminal: one ECR exchange at a time. */
  const tails = new Map<string, Promise<void>>();
  /** Terminals whose adapter call outlived the agent's timeout and has not
   * settled yet: the terminal is busy with an exchange we gave up on. */
  const stuck = new Set<string>();
  /** Rows whose own adapter call is running under the terminal lock. Cleared
   * when that call settles, not when the agent stops waiting for it. */
  const holding = new Set<string>();
  /** Bypass cancels in progress by row: a second cancel awaits the first
   * instead of putting another cancel frame on the wire. */
  const cancelling = new Map<string, Promise<EdcTransaction>>();
  /** Adapter cancel calls of bypass cancels still on the wire (settled or
   * not, whatever the agent waited for), by row. The terminal lock of the
   * sale they interrupt is not freed before they settle. */
  const bypassWire = new Map<string, Promise<void>>();
  /** Outlets this instance owns (advisory lock), by tenant+outlet. */
  const owned = new Map<
    string,
    { client: PoolClient; lockName: string; lost: () => void }
  >();
  /** Sales (queued or on the wire) per owned outlet. `stop` waits for them
   * before it frees the outlet lock, so a replacement agent never sends next
   * to an operation of this one. */
  const sales = new Map<string, Set<Promise<unknown>>>();
  /** Every adapter call on the wire per owned outlet (sale, inquiry, cancel,
   * bypass cancel), until it settles, whatever the agent waited for. `stop`
   * waits for them too: a call that outlived its timeout is still the
   * terminal's business. */
  const wires = new Map<string, Set<Promise<unknown>>>();

  function trackWire(key: string, call: Promise<unknown>): void {
    const set = wires.get(key) ?? new Set<Promise<unknown>>();
    wires.set(key, set);
    const settled = call.then(
      () => undefined,
      () => undefined,
    );
    set.add(settled);
    void settled.then(() => {
      set.delete(settled);
      if (set.size === 0 && wires.get(key) === set) wires.delete(key);
    });
  }

  /** Same tick as the wire: refuses unless the instance that began the
   * operation still holds the outlet. */
  function assertOwnedFor(gate: Gate): void {
    if (gate.ownership === undefined || owned.get(gate.key) !== gate.ownership)
      throw new NotSentError();
  }

  function ownedKey(tenantId: string, outletId: string): string {
    return `${tenantId.toLowerCase()}:${outletId.toLowerCase()}`;
  }

  function assertReady(tenantId: string, outletId: string): void {
    if (!owned.has(ownedKey(tenantId, outletId)))
      throw new EdcError("EDC_AGENT_NOT_READY");
  }

  function scopeOutletIds(
    ctx: ScopedTenantContext,
  ): readonly EdcRow["outletId"][] {
    if (ctx.outletScope.kind !== "outlets")
      throw new EdcError(
        "EDC_AGENT_NOT_READY",
        "Agent EDC dijalankan per outlet; scope outlet diperlukan.",
      );
    return ctx.outletScope.outletIds;
  }

  async function releaseOutlet(key: string): Promise<void> {
    const entry = owned.get(key);
    if (!entry) return;
    // Out of `owned` first: a sale still queued sees the lost ownership and
    // does not go out. The ones already on the wire are awaited, then the
    // lock is freed.
    owned.delete(key);
    // Sales first, then every call still on the wire (a timed-out call or a
    // bypass cancel is not a sale). Nothing new starts: each call re-checks
    // ownership in the tick it goes out.
    for (;;) {
      const pending = [...(sales.get(key) ?? []), ...(wires.get(key) ?? [])];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    let broken: Error | undefined;
    try {
      await entry.client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [entry.lockName],
      );
    } catch (error) {
      // Destroying the connection drops the session lock all the same.
      broken = error instanceof Error ? error : new Error(String(error));
    }
    // The client goes back to the pool: drop our listeners so they do not
    // pile up on a reused connection.
    entry.client.removeListener("error", entry.lost);
    entry.client.removeListener("end", entry.lost);
    entry.client.release(broken);
  }

  /** Takes one outlet. The lock lives on a dedicated connection: if that
   * connection dies the lock is gone and the outlet stops being ready. */
  async function acquireOutlet(
    tenantId: string,
    outletId: string,
  ): Promise<void> {
    const key = ownedKey(tenantId, outletId);
    if (owned.has(key)) return;
    const lockName = `edc-agent:${key}`;
    const pool = deps.pool ?? (db as { $client?: Pool }).$client;
    if (!pool) throw new EdcError("EDC_AGENT_NOT_READY");
    const client = await pool.connect();
    const lost = () => {
      if (owned.get(key)?.client !== client) return;
      owned.delete(key);
      logger.error(
        { tenantId, outletId },
        "EDC agent lost its database connection: outlet is no longer ready",
      );
    };
    client.on("error", lost);
    client.on("end", lost);
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [lockName],
      );
      locked = result.rows[0]?.locked === true;
    } catch (error) {
      client.removeListener("error", lost);
      client.removeListener("end", lost);
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (!locked) {
      client.removeListener("error", lost);
      client.removeListener("end", lost);
      client.release();
      throw new EdcError("EDC_AGENT_NOT_READY");
    }
    owned.set(key, { client, lockName, lost });
  }

  /** Runs `run` as the only ECR exchange on the terminal. `hold` runs the
   * adapter call: the lock is then freed when that call settles, never
   * earlier, even if the agent stopped waiting for it (abort). A call that
   * outlives its abort marks the terminal `stuck` until it settles. */
  async function withTerminalLock<T>(
    terminalRowId: string,
    gate: Gate,
    run: (hold: Hold) => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(terminalRowId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    tails.set(terminalRowId, tail);
    await previous;
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      release();
      if (tails.get(terminalRowId) === tail) tails.delete(terminalRowId);
    };
    let held = false;
    function hold<R>(
      call: () => Promise<R>,
      signal: AbortSignal,
      rowId?: string,
    ): Promise<R> {
      // The last check before the terminal, in the tick of the call: ownership
      // may have gone while this exchange queued or while the claim awaited.
      assertOwnedFor(gate);
      held = true;
      if (rowId) holding.add(rowId);
      const work = new Promise<R>((resolve) => {
        resolve(call());
      });
      trackWire(gate.key, work);
      let settled = false;
      const onSettle = () => {
        settled = true;
        if (rowId) holding.delete(rowId);
        // A bypass cancel of this row may still be on the wire: the terminal
        // stays `stuck` and locked until that cancel settles too.
        const bypass = rowId ? bypassWire.get(rowId) : undefined;
        if (bypass) {
          stuck.add(terminalRowId);
          void bypass.then(() => {
            stuck.delete(terminalRowId);
            free();
          });
          return;
        }
        stuck.delete(terminalRowId);
        free();
      };
      work.then(onSettle, onSettle);
      return raceAbort(work, signal).catch((error: unknown) => {
        if (!settled && signal.aborted) {
          stuck.add(terminalRowId);
          logger.error(
            { terminalRowId },
            "EDC adapter call outlived its timeout: terminal stays locked until it settles",
          );
        }
        throw error;
      });
    }
    try {
      return await run(hold);
    } finally {
      if (!held) free();
    }
  }

  async function selectTerminal(
    tx: Tx,
    ctx: ScopedTenantContext,
    outletId: EdcRow["outletId"],
    terminalRowId: string,
  ): Promise<TerminalRow | undefined> {
    const [terminal] = await tx
      .select()
      .from(paymentEdcTerminals)
      .where(
        and(
          eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
          eq(paymentEdcTerminals.outletId, outletId),
          eq(paymentEdcTerminals.id, terminalRowId),
        ),
      )
      .limit(1);
    return terminal;
  }

  async function selectByKey(
    tx: Tx,
    ctx: ScopedTenantContext,
    idempotencyKey: string,
  ): Promise<EdcRow | undefined> {
    const [row] = await tx
      .select()
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, ctx.tenant.tenantId),
          eq(edcTransactions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row;
  }

  async function reload(
    ctx: ScopedTenantContext,
    id: string,
  ): Promise<EdcRow | undefined> {
    return withTenant(db, ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(edcTransactions)
        .where(
          and(
            eq(edcTransactions.tenantId, ctx.tenant.tenantId),
            eq(edcTransactions.id, id),
          ),
        )
        .limit(1);
      return row;
    });
  }

  /** Permission + the row inside the caller's tenant and outlet. */
  async function loadOwned(
    ctx: ScopedTenantContext,
    actorUserId: string,
    rawRef: EdcTransactionRef,
  ): Promise<EdcRow> {
    assertTrustedScopedContext(ctx);
    const ref = edcTransactionRefSchema.parse(rawRef);
    assertScope(ctx, ref.tenantId, ref.outletId);
    assertReady(ctx.tenant.tenantId, ref.outletId);
    const row = await withTenant(db, ctx, async (tx) => {
      await assertPaymentPermission(
        tx,
        ctx,
        actorUserId,
        PERMISSION,
        { type: "outlet", id: ref.outletId },
        now(),
      );
      const [found] = await tx
        .select()
        .from(edcTransactions)
        .where(
          and(
            eq(edcTransactions.tenantId, ctx.tenant.tenantId),
            eq(edcTransactions.id, ref.transactionId),
          ),
        )
        .limit(1);
      return found;
    });
    if (!row || row.outletId.toLowerCase() !== ref.outletId.toLowerCase())
      throw notFound();
    return row;
  }

  /** Guarded write: only an open row (`pending`/`unknown`) changes, so a
   * cancel or inquiry that already resolved the row is never overwritten.
   * Returns the row as stored afterwards. */
  async function applyPatch(
    ctx: ScopedTenantContext,
    row: EdcRow,
    patch: Patch,
    options: {
      inquiry?: boolean;
      undispatchedOnly?: boolean;
      /** The sale was claimed at this instant but never sent: clear the claim
       * with the status change. */
      revokeDispatch?: Date | null;
      /** A late sale answer settled the adapter call: clear
       * `saleWireOpenAt` in the same transaction, whatever the row's status. */
      clearWireOpen?: boolean;
    } = {},
  ): Promise<EdcRow> {
    const at = now();
    const status = patch.status;
    const set = {
      updatedAt: at,
      ...(status
        ? {
            status,
            completedAt: isEdcFinalStatus(status) ? at : null,
          }
        : {}),
      ...(patch.details ?? {}),
      ...(patch.needsReconciliation ? { needsReconciliation: true } : {}),
      ...(options.revokeDispatch
        ? { dispatchedAt: null, dispatchBatchNo: null }
        : {}),
      ...(options.clearWireOpen ? { saleWireOpenAt: null } : {}),
      ...(options.inquiry
        ? {
            inquiryCount: sql`${edcTransactions.inquiryCount} + 1`,
            lastInquiryAt: at,
          }
        : {}),
    };
    const write = (values: typeof set & { needsReconciliation?: boolean }) =>
      withTenant(db, ctx, async (tx) => {
        // Lock the row first: the event is emitted only for a real change,
        // judged against what is stored, not against the caller's snapshot.
        const [before] = await tx
          .select({
            status: edcTransactions.status,
            needsReconciliation: edcTransactions.needsReconciliation,
          })
          .from(edcTransactions)
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, row.id),
            ),
          )
          .for("update")
          .limit(1);
        const [updated] = await tx
          .update(edcTransactions)
          .set(values)
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, row.id),
              inArray(edcTransactions.status, [...OPEN_STATUSES]),
              options.undispatchedOnly
                ? isNull(edcTransactions.dispatchedAt)
                : undefined,
              options.revokeDispatch
                ? eq(edcTransactions.dispatchedAt, options.revokeDispatch)
                : undefined,
            ),
          )
          .returning();
        if (updated) {
          const name = eventNameFor(updated);
          const changed =
            before?.status !== updated.status ||
            (updated.needsReconciliation && !before?.needsReconciliation);
          if (name && changed)
            await emitEdcTransactionEvent(tx, ctx, {
              name,
              row: updated,
              now: at,
            });
          return updated;
        }
        // Not open any more (nothing written above): the wire is still done.
        if (options.clearWireOpen)
          await tx
            .update(edcTransactions)
            .set({ saleWireOpenAt: null })
            .where(
              and(
                eq(edcTransactions.tenantId, ctx.tenant.tenantId),
                eq(edcTransactions.id, row.id),
              ),
            );
        const [current] = await tx
          .select()
          .from(edcTransactions)
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, row.id),
            ),
          )
          .limit(1);
        return current;
      });
    let stored: EdcRow | undefined;
    try {
      stored = await write(set);
    } catch (error) {
      // Backstop: another approved row exists for this reference (the
      // customer was charged twice). Never two approvals: keep this one
      // `unknown`, flagged for a human to void one charge and reconcile.
      // Not turned into a domain event here: the POS payment flow
      // (legend-m0k) and settlement (legend-cs7) own that.
      if (status !== "approved" || !uniqueViolation(error)) throw error;
      logger.error(
        { edcTransactionId: row.id, trace: row.trace },
        "EDC approval conflicts with an earlier approval for the reference: approved twice",
      );
      stored = await write({
        ...set,
        status: "unknown",
        completedAt: null,
        needsReconciliation: true,
        message: MESSAGE_APPROVED_TWICE,
      });
    }
    if (!stored) throw notFound();
    if (
      status === "approved" &&
      isFinal(stored.status) &&
      stored.status !== "approved"
    ) {
      // Late approval: the terminal charged after the row was cancelled,
      // declined or failed locally. Keep the stored status, flag it so a
      // human voids the charge and reconciles.
      const lateStatus = stored.status;
      logger.error(
        { edcTransactionId: stored.id, trace: stored.trace, lateStatus },
        "EDC approval arrived after the row was final: approved late",
      );
      // The late approval's own evidence (what a human needs to void the
      // charge) is kept even when the row was already flagged.
      const evidence = Object.fromEntries(
        Object.entries(patch.details ?? {}).filter(
          ([name, value]) => name !== "message" && value != null,
        ),
      );
      const flagged = await withTenant(db, ctx, async (tx) => {
        const evidenced =
          Object.keys(evidence).length > 0
            ? (
                await tx
                  .update(edcTransactions)
                  .set({ updatedAt: at, ...evidence })
                  .where(
                    and(
                      eq(edcTransactions.tenantId, ctx.tenant.tenantId),
                      eq(edcTransactions.id, stored.id),
                      eq(edcTransactions.status, lateStatus),
                    ),
                  )
                  .returning()
              )[0]
            : undefined;
        const [updated] = await tx
          .update(edcTransactions)
          .set({
            updatedAt: at,
            needsReconciliation: true,
            message: `approved after ${lateStatus}: void + reconcile`,
          })
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, stored.id),
              eq(edcTransactions.status, lateStatus),
              eq(edcTransactions.needsReconciliation, false),
            ),
          )
          .returning();
        if (updated)
          await emitEdcTransactionEvent(tx, ctx, {
            name: "edc_transaction.flagged",
            row: updated,
            now: at,
          });
        return updated ?? evidenced;
      });
      return flagged ?? stored;
    }
    logger.info(
      {
        edcTransactionId: stored.id,
        trace: stored.trace,
        status: stored.status,
      },
      "EDC transaction updated",
    );
    return stored;
  }

  function answerContext(
    provider: EdcProvider,
    options: { strictTrace?: boolean } = {},
  ): AnswerContext {
    return {
      capabilities: provider.capabilities,
      nowMs: now().getTime(),
      notFoundAfterMs: saleTimeoutMs + notFoundGraceMs,
      notFoundTrustWindowMs,
      strictTrace: options.strictTrace ?? false,
    };
  }

  /** Status inquiry at the terminal for an open row. Never sends a sale. */
  async function inquireRow(
    ctx: ScopedTenantContext,
    row: EdcRow,
    ownership: Ownership,
  ): Promise<EdcRow> {
    if (isFinal(row.status)) return row;
    if (inFlight.has(row.id)) return (await reload(ctx, row.id)) ?? row;
    if (row.dispatchedAt === null) {
      // Never handed to the terminal (agent crashed before the dispatch):
      // there is nothing to ask, and nothing was charged.
      return applyPatch(
        ctx,
        row,
        { status: "failed", details: { message: MESSAGE_NEVER_SENT } },
        { undispatchedOnly: true },
      );
    }
    const terminal = await withTenant(db, ctx, (tx) =>
      selectTerminal(tx, ctx, row.outletId, row.terminalId),
    );
    if (!terminal) throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
    const provider = registry.get(row.bank);
    // No inquiry at this terminal: the cashier resolves it there.
    if (provider.capabilities.inquiry === "none") return row;
    const ecrTerminal = toEcrTerminal(terminal, provider.bank);
    if (stuck.has(terminal.id)) {
      logger.error(
        { terminalRowId: terminal.id, edcTransactionId: row.id },
        "EDC inquiry skipped: an earlier adapter call on this terminal is still running",
      );
      return (await reload(ctx, row.id)) ?? row;
    }
    const gate: Gate = { key: ownedKey(row.tenantId, row.outletId), ownership };
    return withTerminalLock(terminal.id, gate, async (hold) => {
      // The sale or another inquiry may have resolved the row while queued.
      const current = await reload(ctx, row.id);
      if (!current) throw notFound();
      if (isFinal(current.status) || inFlight.has(current.id)) return current;
      let patch: Patch;
      try {
        const signal = AbortSignal.timeout(inquiryTimeoutMs);
        const answer = ecrInquiryResultSchema.parse(
          await hold(
            () =>
              provider.inquiry({
                terminal: ecrTerminal,
                trace: current.trace,
                signal,
              }),
            signal,
          ),
        );
        patch = patchFromAnswer(
          current,
          answer,
          answerContext(provider, { strictTrace: true }),
        );
      } catch (error) {
        // Refused before the wire: nothing was asked, the row stays as it is.
        if (error instanceof NotSentError) throw error;
        logger.warn(
          {
            edcTransactionId: current.id,
            trace: current.trace,
            kind: errorKind(error),
          },
          "EDC inquiry gave no answer",
        );
        patch = unknownPatch();
      }
      return applyPatch(ctx, current, patch, { inquiry: true });
    });
  }

  /** Sends the sale of a committed `pending` row and records the answer. The
   * caller already put `row.id` in `inFlight`. */
  async function performSale(
    ctx: ScopedTenantContext,
    row: EdcRow,
    provider: EdcProvider,
    terminal: EcrTerminal,
    ownership: Ownership,
  ): Promise<EdcRow> {
    const key = ownedKey(row.tenantId, row.outletId);
    /** The outlet is still held by the instance that accepted the request. */
    const stillOwned = () =>
      ownership !== undefined && owned.get(key) === ownership;
    return withTerminalLock(terminal.id, { key, ownership }, async (hold) => {
      // Ownership may have gone while this sale queued (stop, lost
      // connection): another agent may now drive the terminal. Nothing is
      // claimed or sent; the owner's recovery settles the pending row.
      if (!stillOwned()) throw new EdcError("EDC_AGENT_NOT_READY");
      // Dispatch claim: only a row still `pending` and never sent goes out. A
      // cancel that won the race while this sale was queued means no sale.
      // The row joins `holding` only when `hold` invokes the sale call, never
      // earlier: a cancel that finds the row dispatched but not yet on the
      // wire queues behind this lock, so it cannot reach an idle terminal
      // before the sale frame does.
      const claimed = await withTenant(db, ctx, async (tx) => {
        // The terminal's last known batch: kept on the row so a later
        // `not_found` can be checked against a settlement in between.
        const [lastBatch] = await tx
          .select({ batchNo: edcTransactions.batchNo })
          .from(edcTransactions)
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.terminalId, row.terminalId),
              isNotNull(edcTransactions.batchNo),
            ),
          )
          .orderBy(sql`${edcTransactions.completedAt} DESC NULLS LAST`)
          .limit(1);
        const [updated] = await tx
          .update(edcTransactions)
          .set({
            dispatchedAt: now(),
            dispatchBatchNo: lastBatch?.batchNo ?? null,
          })
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, row.id),
              eq(edcTransactions.status, "pending"),
              isNull(edcTransactions.dispatchedAt),
            ),
          )
          .returning();
        return updated;
      });
      if (!claimed) return (await reload(ctx, row.id)) ?? row;
      let patch: Patch;
      const signal = AbortSignal.timeout(saleTimeoutMs);
      /** The adapter's own promise: it may still settle after the timeout. */
      const wire: { call?: Promise<unknown>; settled?: true } = {};
      try {
        const answer = ecrResultSchema.parse(
          await hold(
            () => {
              // `hold` re-checked ownership in this tick: the claim above
              // awaited the database.
              const call = provider.sale({
                terminal,
                trace: claimed.trace,
                amountIdr: claimed.amountIdr,
                method: claimed.method as EdcPaymentRequest["method"],
                reference: claimed.reference,
                signal,
              });
              wire.call = call;
              const done = () => {
                wire.settled = true;
              };
              call.then(done, done);
              return call;
            },
            signal,
            claimed.id,
          ),
        );
        patch = patchFromAnswer(claimed, answer, answerContext(provider));
      } catch (error) {
        if (error instanceof NotSentError) {
          // The owner check refused the sale after the dispatch claim: the
          // terminal never saw it. Say so (failed, not dispatched) instead of
          // leaving an `unknown` row for a human to reconcile.
          await applyPatch(
            ctx,
            claimed,
            { status: "failed", details: { message: MESSAGE_NEVER_SENT } },
            { revokeDispatch: claimed.dispatchedAt },
          );
          throw error;
        }
        logger.warn(
          {
            edcTransactionId: claimed.id,
            trace: claimed.trace,
            kind: errorKind(error),
          },
          "EDC sale gave no answer",
        );
        patch = unknownPatch();
        // Timed out on our side only: the terminal may still answer the sale
        // later. That answer decides the row while it is open (`applyPatch`
        // writes only an open row; a late approval after final keeps its
        // evidence and is flagged). `sale_wire_open_at` tells reconciliation
        // the terminal is still busy; the late write (or an adapter error)
        // clears it. Tracked at once so `stop` waits for the late write.
        // Never throws: a failed late write is logged.
        const call = wire.call;
        if (signal.aborted && call) {
          const marked = wire.settled
            ? Promise.resolve()
            : setSaleWireOpen(ctx, claimed, true);
          const late = marked
            .then(() =>
              call.then(
                async (raw) => {
                  let answer: EcrResult | undefined;
                  try {
                    answer = ecrResultSchema.parse(raw);
                    await applyPatch(
                      ctx,
                      claimed,
                      patchFromAnswer(claimed, answer, answerContext(provider)),
                      { clearWireOpen: true },
                    );
                  } catch (lateError) {
                    logger.error(
                      {
                        edcTransactionId: claimed.id,
                        trace: claimed.trace,
                        kind: errorKind(lateError),
                        outcome: answer?.outcome,
                        approvalCode: answer?.approvalCode,
                        rrn: answer?.rrn,
                        amountIdr: claimed.amountIdr,
                      },
                      "EDC late sale answer could not be recorded",
                    );
                    await setSaleWireOpen(ctx, claimed, false);
                  }
                },
                () => setSaleWireOpen(ctx, claimed, false),
              ),
            )
            .finally(() => wireOpen.delete(claimed.id));
          trackWire(key, late);
          await marked;
        }
      }
      return applyPatch(ctx, claimed, patch);
    });
  }

  /** Same key seen again: same request returns the row (inquiring when it is
   * still open), another request is refused. Never a second sale. */
  async function replay(
    ctx: ScopedTenantContext,
    row: EdcRow,
    fingerprint: string,
    ownership: Ownership,
  ): Promise<EdcTransaction> {
    if (row.requestFingerprint !== fingerprint)
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key sudah dipakai untuk permintaan EDC yang berbeda.",
      );
    try {
      return toDto(await inquireRow(ctx, row, ownership));
    } catch (error) {
      if (error instanceof EdcError) return toDto(row);
      throw error;
    }
  }

  /** Retry guard (EDC-03) over the earlier attempts of one POS reference. */
  async function guardRetry(
    ctx: ScopedTenantContext,
    earlier: readonly EdcRow[],
    ownership: Ownership,
  ): Promise<void> {
    if (earlier.some((row) => row.status === "approved"))
      throw new EdcError("EDC_ALREADY_APPROVED");
    // Approved late (cancelled/failed/declined locally, charged on the
    // terminal) or flagged by a stale inquiry: a human voids and reconciles.
    if (earlier.some((row) => row.needsReconciliation))
      throw new EdcError("EDC_NEEDS_RECONCILIATION");
    // A row still in flight is being answered by this agent, whatever status
    // it shows right now. A pending row nobody is working on (stale) is
    // inquired like an unknown one.
    if (earlier.some((row) => inFlight.has(row.id)))
      throw new EdcError("EDC_STATUS_UNKNOWN");
    let unresolved = false;
    let approved = false;
    for (const row of earlier.filter(
      (r) => r.status === "unknown" || r.status === "pending",
    )) {
      try {
        const resolved = await inquireRow(ctx, row, ownership);
        if (resolved.status === "approved") approved = true;
        else if (!isFinal(resolved.status)) unresolved = true;
      } catch (error) {
        if (!(error instanceof EdcError)) throw error;
        unresolved = true;
      }
    }
    if (approved) throw new EdcError("EDC_ALREADY_APPROVED");
    if (unresolved) throw new EdcError("EDC_STATUS_UNKNOWN");
  }

  type WriteAhead =
    | {
        kind: "created";
        row: EdcRow;
        /** The terminal as read inside the write-ahead transaction. */
        terminal: TerminalRow;
        provider: EdcProvider;
      }
    | { kind: "existing"; row: EdcRow }
    | { kind: "retry" };

  async function writeAhead(
    ctx: ScopedTenantContext,
    input: EdcPaymentRequest,
    values: { id: string; trace: string; fingerprint: string },
  ): Promise<WriteAhead> {
    try {
      return await withTenant(db, ctx, async (tx): Promise<WriteAhead> => {
        // Serialise attempts for one reference, then re-check under the lock:
        // two cashiers with different keys cannot both start a sale.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenant.tenantId}), hashtext(${`${input.outletId}:${input.reference}`}))`,
        );
        const blocking = await tx
          .select({ id: edcTransactions.id })
          .from(edcTransactions)
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.outletId, input.outletId),
              eq(edcTransactions.reference, input.reference),
              or(
                inArray(edcTransactions.status, [
                  "approved",
                  "pending",
                  "unknown",
                ]),
                eq(edcTransactions.needsReconciliation, true),
              ),
            ),
          )
          .limit(1);
        if (blocking.length > 0) return { kind: "retry" };
        // The terminal is only asked for what the bill still owes right now. A
        // POS screen that went stale (another tender, a discount) would
        // otherwise take money the tender step can never book (it requires
        // the request amount to equal the tender). Read under the same
        // advisory lock every tender/edit takes, so check and insert are
        // atomic against them; the order row is not locked here (lock order).
        await assertEdcSaleBillPayable(tx, ctx, {
          outletId: input.outletId,
          reference: input.reference,
          amountIdr: input.amountIdr,
        });
        // The terminal is read again here, locked against a concurrent edit
        // (`FOR KEY SHARE` conflicts with the admin's `FOR UPDATE`): the sale
        // goes out to the identity this row was written for, and the admin's
        // busy check sees this row once it commits.
        const [terminal] = await tx
          .select()
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
              eq(paymentEdcTerminals.outletId, input.outletId),
              eq(paymentEdcTerminals.id, input.terminalId),
            ),
          )
          .for("key share")
          .limit(1);
        if (
          !terminal ||
          terminal.status !== "active" ||
          !terminal.supportedMethods.includes(input.method)
        )
          throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
        const provider = registry.get(terminal.bankCode);
        const at = now();
        const [row] = await tx
          .insert(edcTransactions)
          .values({
            id: values.id,
            tenantId: ctx.tenant.tenantId,
            outletId: input.outletId,
            terminalId: input.terminalId,
            bank: provider.bank,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: values.fingerprint,
            amountIdr: input.amountIdr,
            method: input.method,
            status: "pending",
            trace: values.trace,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new Error("EDC transaction insert returned no row");
        await emitEdcTransactionEvent(tx, ctx, {
          name: "edc_transaction.created",
          row,
          now: at,
        });
        return { kind: "created", row, terminal, provider };
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      // Same key raced in (rule 2) or the trace collided (new trace, retry).
      const existing = await withTenant(db, ctx, (tx) =>
        selectByKey(tx, ctx, input.idempotencyKey),
      );
      if (existing) return { kind: "existing", row: existing };
      // The key is taken but RLS hides the row (another outlet): never loop.
      if (violatedConstraint(error) === IDEMPOTENCY_CONSTRAINT)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key sudah dipakai untuk permintaan EDC yang berbeda.",
        );
      return { kind: "retry" };
    }
  }

  /** Marks (or clears) "the adapter call of this sale is still running". Set
   * when the agent gives up waiting; cleared when the call settles. A plain
   * update by id, any status. Never throws: the 10-minute dispatch window
   * still guards the row if this write fails. */
  async function setSaleWireOpen(
    ctx: ScopedTenantContext,
    row: EdcRow,
    open: boolean,
  ): Promise<void> {
    if (open) wireOpen.add(row.id);
    try {
      await withTenant(db, ctx, (tx) =>
        tx
          .update(edcTransactions)
          .set({ saleWireOpenAt: open ? now() : null })
          .where(
            and(
              eq(edcTransactions.tenantId, ctx.tenant.tenantId),
              eq(edcTransactions.id, row.id),
            ),
          ),
      );
    } catch (error) {
      logger.error(
        {
          edcTransactionId: row.id,
          trace: row.trace,
          open,
          kind: errorKind(error),
        },
        "EDC sale wire marker could not be written",
      );
    }
  }

  /** An outlet this instance just acquired: a `saleWireOpenAt` left by the
   * previous process is stale (its adapter call died with it). */
  async function clearStaleWireOpen(
    ctx: ScopedTenantContext,
    outletIds: readonly EdcRow["outletId"][],
  ): Promise<void> {
    if (outletIds.length === 0) return;
    await withTenant(db, ctx, async (tx) => {
      // `wireOpen` is read here, in the same tick that issues the UPDATE: a
      // call of this process that is still running keeps its marker.
      const live = [...wireOpen];
      await tx
        .update(edcTransactions)
        .set({ saleWireOpenAt: null })
        .where(
          and(
            eq(edcTransactions.tenantId, ctx.tenant.tenantId),
            inArray(edcTransactions.outletId, [...outletIds]),
            isNotNull(edcTransactions.saleWireOpenAt),
            live.length > 0 ? notInArray(edcTransactions.id, live) : undefined,
          ),
        );
    });
  }

  /** Pending -> unknown for `outletIds` (default: the outlets of `ctx`), which
   * must be owned: only the owner knows which pending rows are really in
   * flight. `start` passes only the outlets it just acquired: a second
   * `start` must not flip a live sale of an outlet this process already ran. */
  async function recoverPending(
    ctx: ScopedTenantContext,
    outletIds: readonly EdcRow["outletId"][] = scopeOutletIds(ctx),
  ): Promise<number> {
    if (outletIds.length === 0) return 0;
    for (const outletId of outletIds)
      assertReady(ctx.tenant.tenantId, outletId);
    const at = now();
    const recovered = await withTenant(db, ctx, async (tx) => {
      // `inFlight` is read here, in the same tick that issues the UPDATE, not
      // before the transaction opens: a sale registered meanwhile is kept. A
      // row created after this call began (never dispatched) is a live sale
      // too, never a crashed one.
      const live = [...inFlight];
      const rows = await tx
        .update(edcTransactions)
        .set({
          status: "unknown",
          message: MESSAGE_RECOVERED,
          updatedAt: at,
        })
        .where(
          and(
            eq(edcTransactions.tenantId, ctx.tenant.tenantId),
            inArray(edcTransactions.outletId, [...outletIds]),
            eq(edcTransactions.status, "pending"),
            or(
              isNotNull(edcTransactions.dispatchedAt),
              lt(edcTransactions.createdAt, at),
            ),
            live.length > 0 ? notInArray(edcTransactions.id, live) : undefined,
          ),
        )
        .returning();
      for (const row of rows)
        await emitEdcTransactionEvent(tx, ctx, {
          name: "edc_transaction.flagged",
          row,
          now: at,
        });
      return rows;
    });
    if (recovered.length > 0)
      logger.warn(
        { count: recovered.length },
        "EDC pending transactions recovered as unknown",
      );
    return recovered.length;
  }

  return {
    async requestPayment(ctx, actorUserId, rawInput) {
      assertTrustedScopedContext(ctx);
      const input = edcPaymentRequestSchema.parse(rawInput);
      assertScope(ctx, input.tenantId, input.outletId);
      assertReady(ctx.tenant.tenantId, input.outletId);
      const salesKey = ownedKey(ctx.tenant.tenantId, input.outletId);
      const ownership = owned.get(salesKey);
      const fingerprint = fingerprintOf(input);

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const pre = await withTenant(db, ctx, async (tx) => {
          await assertPaymentPermission(
            tx,
            ctx,
            actorUserId,
            PERMISSION,
            { type: "outlet", id: input.outletId },
            now(),
          );
          const existing = await selectByKey(tx, ctx, input.idempotencyKey);
          if (existing) return { kind: "existing", existing } as const;
          const earlier = await tx
            .select()
            .from(edcTransactions)
            .where(
              and(
                eq(edcTransactions.tenantId, ctx.tenant.tenantId),
                eq(edcTransactions.outletId, input.outletId),
                eq(edcTransactions.reference, input.reference),
              ),
            );
          const terminal = await selectTerminal(
            tx,
            ctx,
            input.outletId,
            input.terminalId,
          );
          return { kind: "fresh", earlier, terminal } as const;
        });
        if (pre.kind === "existing")
          return replay(ctx, pre.existing, fingerprint, ownership);

        await guardRetry(ctx, pre.earlier, ownership);

        const { terminal } = pre;
        if (
          !terminal ||
          terminal.status !== "active" ||
          !terminal.supportedMethods.includes(input.method)
        )
          throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
        // An adapter call on this terminal is still running: fail before any
        // row exists rather than queue a sale behind an unknown exchange.
        if (stuck.has(terminal.id)) {
          logger.error(
            { terminalRowId: terminal.id },
            "EDC sale refused: an earlier adapter call on this terminal is still running",
          );
          throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
        }
        // Unknown bank fails here, before any row exists.
        registry.get(terminal.bankCode);

        const id = randomUUID();
        inFlight.add(id);
        try {
          const created = await writeAhead(ctx, input, {
            id,
            trace: newTrace(),
            fingerprint,
          });
          if (created.kind === "existing") {
            inFlight.delete(id);
            return replay(ctx, created.row, fingerprint, ownership);
          }
          if (created.kind === "retry") {
            inFlight.delete(id);
            continue;
          }
          const selling = performSale(
            ctx,
            created.row,
            created.provider,
            toEcrTerminal(created.terminal, created.provider.bank),
            ownership,
          );
          const tracked = sales.get(salesKey) ?? new Set<Promise<unknown>>();
          sales.set(salesKey, tracked);
          tracked.add(selling);
          const untrack = () => {
            tracked.delete(selling);
            if (tracked.size === 0 && sales.get(salesKey) === tracked)
              sales.delete(salesKey);
          };
          selling.then(untrack, untrack);
          return toDto(await selling);
        } finally {
          inFlight.delete(id);
        }
      }
      throw new EdcError("EDC_STATUS_UNKNOWN");
    },

    async inquire(ctx, actorUserId, ref) {
      const row = await loadOwned(ctx, actorUserId, ref);
      const ownership = owned.get(ownedKey(row.tenantId, row.outletId));
      return toDto(await inquireRow(ctx, row, ownership));
    },

    async cancel(ctx, actorUserId, ref) {
      let row = await loadOwned(ctx, actorUserId, ref);
      if (row.status === "cancelled") return toDto(row);
      if (isFinal(row.status)) throw new EdcError("EDC_NOT_CANCELLABLE");

      if (row.status === "pending" && row.dispatchedAt === null) {
        // Still queued behind another sale: the terminal never saw it, so
        // cancel it here. Guarded: a sale that gets dispatched first wins.
        const at = now();
        const cancelled = await withTenant(db, ctx, async (tx) => {
          const [updated] = await tx
            .update(edcTransactions)
            .set({
              status: "cancelled",
              message: MESSAGE_CANCELLED_UNSENT,
              updatedAt: at,
              completedAt: at,
            })
            .where(
              and(
                eq(edcTransactions.tenantId, ctx.tenant.tenantId),
                eq(edcTransactions.id, row.id),
                eq(edcTransactions.status, "pending"),
                isNull(edcTransactions.dispatchedAt),
              ),
            )
            .returning();
          if (updated)
            await emitEdcTransactionEvent(tx, ctx, {
              name: "edc_transaction.cancelled",
              row: updated,
              now: at,
            });
          return updated;
        });
        if (cancelled) return toDto(cancelled);
        row = (await reload(ctx, row.id)) ?? row;
        if (row.status === "cancelled") return toDto(row);
        if (isFinal(row.status)) throw new EdcError("EDC_NOT_CANCELLABLE");
      }

      const cancelGate: Gate = {
        key: ownedKey(row.tenantId, row.outletId),
        ownership: owned.get(ownedKey(row.tenantId, row.outletId)),
      };
      const terminal = await withTenant(db, ctx, (tx) =>
        selectTerminal(tx, ctx, row.outletId, row.terminalId),
      );
      if (!terminal) throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
      const provider = registry.get(row.bank);
      if (!provider.capabilities.cancelInProgress)
        throw new EdcError("EDC_CANCEL_UNSUPPORTED");
      const ecrTerminal = toEcrTerminal(terminal, provider.bank);
      if (stuck.has(terminal.id)) {
        logger.error(
          { terminalRowId: terminal.id, edcTransactionId: row.id },
          "EDC cancel refused: an earlier adapter call on this terminal is still running",
        );
        throw new EdcError("EDC_TERMINAL_UNAVAILABLE");
      }

      const sendCancel = async (
        current: EdcRow,
        hold?: Hold,
      ): Promise<EdcTransaction> => {
        let answer: EcrResult | null = null;
        try {
          const signal = AbortSignal.timeout(cancelTimeoutMs);
          const call = () =>
            provider.cancel({
              terminal: ecrTerminal,
              trace: current.trace,
              signal,
            });
          if (hold) {
            answer = ecrResultSchema.parse(await hold(call, signal));
          } else {
            // Same tick as the frame: refused if the outlet is no longer ours.
            assertOwnedFor(cancelGate);
            const wire = new Promise<EcrResult>((resolve) => {
              resolve(call());
            });
            // Chain onto an earlier bypass cancel of this row that timed out
            // but whose frame may still be on the wire: the lock is freed only
            // after every one of them settles.
            const earlier = bypassWire.get(current.id);
            const settled = wire.then(
              () => undefined,
              () => undefined,
            );
            const done = earlier
              ? Promise.all([earlier, settled]).then(() => undefined)
              : settled;
            bypassWire.set(current.id, done);
            trackWire(cancelGate.key, done);
            void done.then(() => {
              if (bypassWire.get(current.id) === done)
                bypassWire.delete(current.id);
            });
            answer = ecrResultSchema.parse(await raceAbort(wire, signal));
          }
        } catch (error) {
          // Refused before the wire: nothing was sent, nothing to record.
          if (error instanceof NotSentError) throw error;
          logger.warn(
            {
              edcTransactionId: current.id,
              trace: current.trace,
              kind: errorKind(error),
            },
            "EDC cancel gave no answer",
          );
        }
        if (answer) {
          const patch = patchFromAnswer(
            current,
            answer,
            answerContext(provider),
          );
          // A cancel answer alone is not proof the sale is over: a dispatched
          // sale's own answer may still be approved (bypass: its call is on
          // the wire; queued: it may have charged before the cancel). A final
          // non-approved cancel answer never finalizes a dispatched row; the
          // sale's own answer decides. Never-dispatched rows keep the answer.
          if (
            current.dispatchedAt !== null &&
            patch.status !== undefined &&
            patch.status !== "approved" &&
            isFinal(patch.status)
          ) {
            return toDto(
              await applyPatch(ctx, current, {
                details: { message: MESSAGE_CANCEL_AWAITING_SALE },
              }),
            );
          }
          // `approved` here means the customer already paid: recorded as such.
          return toDto(await applyPatch(ctx, current, patch));
        }
        if (current.status === "pending" && !inFlight.has(current.id))
          return toDto(await applyPatch(ctx, current, unknownPatch()));
        const latest = await reload(ctx, current.id);
        return toDto(latest ?? current);
      };

      // Only the sale whose adapter call holds the terminal lock right now is
      // cancelled around the queue (cancel must reach it). Anything else,
      // including a sale still waiting for its turn, queues like every other
      // exchange: the lock frees when the call settles, before `inFlight`
      // clears, so `inFlight` alone would let a cancel meet the next sale.
      if (holding.has(row.id)) {
        const running = cancelling.get(row.id);
        if (running) return running;
        // `sendCancel` puts its frame on the wire before its first await, in
        // this same tick, so no other caller can slip in between.
        const run: Promise<EdcTransaction> = sendCancel(row).finally(() => {
          if (cancelling.get(row.id) === run) cancelling.delete(row.id);
        });
        cancelling.set(row.id, run);
        return run;
      }
      return withTerminalLock(terminal.id, cancelGate, async (hold) => {
        const current = await reload(ctx, row.id);
        if (!current) throw notFound();
        if (current.status === "cancelled") return toDto(current);
        if (isFinal(current.status)) throw new EdcError("EDC_NOT_CANCELLABLE");
        return sendCancel(current, hold);
      });
    },

    async get(ctx, actorUserId, ref) {
      return toDto(await loadOwned(ctx, actorUserId, ref));
    },

    async start(ctx) {
      assertTrustedScopedContext(ctx);
      const outletIds = scopeOutletIds(ctx);
      const acquired: string[] = [];
      const acquiredOutletIds: EdcRow["outletId"][] = [];
      try {
        for (const outletId of outletIds) {
          const key = ownedKey(ctx.tenant.tenantId, outletId);
          if (owned.has(key)) continue;
          await acquireOutlet(ctx.tenant.tenantId, outletId);
          acquired.push(key);
          acquiredOutletIds.push(outletId);
        }
        await clearStaleWireOpen(ctx, acquiredOutletIds);
        await recoverPending(ctx, acquiredOutletIds);
      } catch (error) {
        for (const key of acquired) await releaseOutlet(key);
        throw error;
      }
    },

    async stop(ctx) {
      if (!ctx) {
        for (const key of [...owned.keys()]) await releaseOutlet(key);
        return;
      }
      assertTrustedScopedContext(ctx);
      for (const outletId of scopeOutletIds(ctx))
        await releaseOutlet(ownedKey(ctx.tenant.tenantId, outletId));
    },

    async recoverInFlight(ctx) {
      assertTrustedScopedContext(ctx);
      return recoverPending(ctx);
    },
  };
}
