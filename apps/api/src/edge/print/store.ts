// PostgreSQL PrintStore of the edge Print Agent (bead legend-46p; PRD v1.7 §3
// F5 "Print Agent", "Fallback Berlapis", §3 F12 "Fallback Cetak", EDG-05).
//
// One store is bound to ONE outlet: the single outlet of the edge node's own
// scope (never a client-supplied one, TEN-02). Every method runs in its own
// `withTenant` transaction, so tenant + outlet RLS bound it even if a filter
// were missing; each query still filters on tenant and outlet explicitly.
//
// Queue rules:
// - claimNext takes the oldest queued job of a printer (created_at, id) with
//   FOR UPDATE SKIP LOCKED, so two processes never print the same job.
// - Status changes are validated with `transitionPrintJob` (shared contract).
// - Job content, kind, idempotency key and reprint link are immutable (DB
//   trigger edge_print_jobs_guard).
// Printer content is never logged and never placed in an error message.
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlidFactory,
  ulidSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { transitionPrintJob, type PrintJob } from "@starter/shared/edge";
import type * as schema from "../../db/schema/index.ts";
import {
  edgePrintAlerts,
  edgePrintJobs,
  edgePrinters,
} from "../../db/schema/edge-print.ts";
import { withTenant } from "../../db/tenant.ts";
import type {
  NewPrintJob,
  PrintAlert,
  PrintJobListQuery,
  PrintJobPage,
  PrintJobRecord,
  PrintStore,
  PrinterConfig,
  PrinterStatus,
} from "./types.ts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PrinterRow = typeof edgePrinters.$inferSelect;
type JobRow = typeof edgePrintJobs.$inferSelect;

export type DbPrintStoreOptions = {
  db: Database;
  /** Server-minted, scoped to exactly one outlet. */
  context: ScopedTenantContext;
  /** Test seam: creation time of new jobs and alerts. */
  now?: () => Date;
};

const MAX_ERROR_LENGTH = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printerNotFound(): CoreError {
  return new CoreError("NOT_FOUND", "Printer tidak ditemukan.");
}
function jobNotFound(): CoreError {
  return new CoreError("NOT_FOUND", "Tugas cetak tidak ditemukan.");
}

function toPrinterConfig(row: PrinterRow): PrinterConfig {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    label: row.label,
    role: row.role,
    stationId: row.stationId,
    transport:
      row.transport === "network"
        ? { kind: "network", host: row.host ?? "", port: row.port ?? 9100 }
        : { kind: "usb", devicePath: row.devicePath ?? "" },
    paperWidth: row.paperWidth,
    fallbackPrinterId: row.fallbackPrinterId,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    offlineSince: row.offlineSince,
  };
}

function toJobRecord(row: JobRow): PrintJobRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    printerId: row.printerId,
    kind: row.kind,
    status: row.status,
    content: row.content,
    attempts: row.attempts,
    lastError: row.lastError,
    failurePhase: row.failurePhase,
    reprintOf: row.reprintOf,
    printedFallback: row.printedFallback,
    fallbackReason: row.fallbackReason,
    originalPrinterId: row.originalPrinterId,
    sourceRef: row.sourceRef,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    printedAt: row.printedAt,
  };
}

/** Shared contract shape of a job; `content` is base64 of the ESC/POS bytes. */
export function toPrintJobDto(record: PrintJobRecord): PrintJob {
  return {
    tenantId: record.tenantId as PrintJob["tenantId"],
    outletId: record.outletId as PrintJob["outletId"],
    id: record.id as PrintJob["id"],
    printerId: record.printerId as PrintJob["printerId"],
    kind: record.kind,
    format: "esc_pos",
    content: Buffer.from(record.content).toString("base64"),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    reprintOf: record.reprintOf as PrintJob["reprintOf"],
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const invalid = () =>
    new CoreError("VALIDATION_ERROR", "Kursor tidak valid.");
  const [iso, id, ...rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!iso || !id || rest.length > 0) throw invalid();
  const createdAt = new Date(iso);
  // Only canonical 4-digit years: PostgreSQL rejects the extended ISO years
  // (+275760-...) that are still valid JavaScript dates.
  if (
    Number.isNaN(createdAt.getTime()) ||
    !/^\d{4}-/.test(createdAt.toISOString())
  )
    throw invalid();
  const parsedId = ulidSchema.safeParse(id);
  if (!parsedId.success) throw invalid();
  return { createdAt, id: parsedId.data };
}

export function createDbPrintStore(options: DbPrintStoreOptions): PrintStore {
  const { db, context } = options;
  const now = options.now ?? (() => new Date());
  assertTrustedScopedContext(context);
  const scope = context.outletScope;
  if (scope.kind !== "outlets" || scope.outletIds.length !== 1)
    throw new CoreError(
      "OUTLET_OUT_OF_SCOPE",
      "Print agent hanya melayani satu outlet.",
    );
  const outletId = scope.outletIds[0]!;
  assertOutletInScope(scope, outletId);
  const tenantId = context.tenant.tenantId;
  const nextUlid = createUlidFactory({ now: () => now().getTime() });

  const run = <T>(work: (tx: Tx) => Promise<T>) =>
    withTenant(db, context, work);
  const printerScope = () =>
    and(
      eq(edgePrinters.tenantId, tenantId),
      eq(edgePrinters.outletId, outletId),
    );
  const jobScope = () =>
    and(
      eq(edgePrintJobs.tenantId, tenantId),
      eq(edgePrintJobs.outletId, outletId),
    );
  const alertScope = () =>
    and(
      eq(edgePrintAlerts.tenantId, tenantId),
      eq(edgePrintAlerts.outletId, outletId),
    );

  // A retired printer (deleted in the cloud, kept for its jobs) counts as
  // unknown: no new job and no reroute target. Old jobs stay readable.
  async function printerExists(tx: Tx, printerId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: edgePrinters.id })
      .from(edgePrinters)
      .where(
        and(
          printerScope(),
          eq(edgePrinters.id, printerId),
          isNull(edgePrinters.retiredAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Locks one job row of this outlet; NOT_FOUND when it is not visible. */
  async function lockJob(tx: Tx, jobId: string): Promise<JobRow> {
    try {
      ulidToUuid(jobId);
    } catch {
      throw jobNotFound();
    }
    const rows = await tx
      .select()
      .from(edgePrintJobs)
      .where(and(jobScope(), eq(edgePrintJobs.id, jobId)))
      .for("update");
    const row = rows[0];
    if (!row) throw jobNotFound();
    return row;
  }

  async function updateJob(
    tx: Tx,
    jobId: string,
    values: Partial<typeof edgePrintJobs.$inferInsert>,
  ): Promise<JobRow> {
    const rows = await tx
      .update(edgePrintJobs)
      .set({ ...values, updatedAt: now() })
      .where(and(jobScope(), eq(edgePrintJobs.id, jobId)))
      .returning();
    return rows[0]!;
  }

  return {
    async listPrinters() {
      return run(async (tx) => {
        const rows = await tx
          .select()
          .from(edgePrinters)
          .where(and(printerScope(), isNull(edgePrinters.retiredAt)))
          .orderBy(asc(edgePrinters.createdAt), asc(edgePrinters.id));
        return rows.map(toPrinterConfig);
      });
    },

    async getPrinter(printerId) {
      if (!UUID_PATTERN.test(printerId)) return null;
      return run(async (tx) => {
        const rows = await tx
          .select()
          .from(edgePrinters)
          .where(
            and(
              printerScope(),
              eq(edgePrinters.id, printerId),
              isNull(edgePrinters.retiredAt),
            ),
          )
          .limit(1);
        return rows[0] ? toPrinterConfig(rows[0]) : null;
      });
    },

    async setPrinterStatus(printerId, status: PrinterStatus, at) {
      await run(async (tx) => {
        const patch: Partial<typeof edgePrinters.$inferInsert> = {
          status,
          updatedAt: now(),
        };
        if (status === "online") {
          patch.lastSeenAt = at;
          patch.offlineSince = null;
        }
        const set =
          status === "offline"
            ? {
                ...patch,
                // Keep the start of the episode when already offline.
                offlineSince: sql<Date>`COALESCE(${edgePrinters.offlineSince}, ${at.toISOString()}::timestamptz)`,
              }
            : patch;
        const rows = await tx
          .update(edgePrinters)
          .set(set)
          .where(and(printerScope(), eq(edgePrinters.id, printerId)))
          .returning({ id: edgePrinters.id });
        if (rows.length === 0) throw printerNotFound();
      });
    },

    async enqueue(job: NewPrintJob) {
      return run(async (tx) => {
        if (!(await printerExists(tx, job.printerId))) throw printerNotFound();
        const createdAt = now();
        const inserted = await tx
          .insert(edgePrintJobs)
          .values({
            id: nextUlid(),
            tenantId: tenantId,
            outletId: outletId,
            printerId: job.printerId,
            kind: job.kind,
            content: job.content,
            idempotencyKey: job.idempotencyKey,
            sourceRef: job.sourceRef ?? null,
            reprintOf: job.reprintOf ?? null,
            printedFallback: job.printedFallback ?? false,
            fallbackReason: job.fallbackReason ?? null,
            originalPrinterId: job.originalPrinterId ?? null,
            createdBy: job.createdBy ?? null,
            createdAt,
            updatedAt: createdAt,
          })
          .onConflictDoNothing({
            target: [
              edgePrintJobs.tenantId,
              edgePrintJobs.outletId,
              edgePrintJobs.idempotencyKey,
            ],
          })
          .returning();
        if (inserted[0])
          return { job: toJobRecord(inserted[0]), created: true };
        const existing = await tx
          .select()
          .from(edgePrintJobs)
          .where(
            and(
              jobScope(),
              eq(edgePrintJobs.idempotencyKey, job.idempotencyKey),
            ),
          )
          .limit(1);
        return { job: toJobRecord(existing[0]!), created: false };
      });
    },

    async claimNext(printerId) {
      return run(async (tx) => {
        const candidate = await tx
          .select()
          .from(edgePrintJobs)
          .where(
            and(
              jobScope(),
              eq(edgePrintJobs.printerId, printerId),
              eq(edgePrintJobs.status, "queued"),
            ),
          )
          .orderBy(asc(edgePrintJobs.createdAt), asc(edgePrintJobs.id))
          .limit(1)
          .for("update", { skipLocked: true });
        const row = candidate[0];
        if (!row) return null;
        const next = transitionPrintJob(row.status, "start");
        const claimed = await updateJob(tx, row.id, {
          status: next,
          attempts: row.attempts + 1,
          startedAt: now(),
        });
        return toJobRecord(claimed);
      });
    },

    async markPrinted(jobId, at) {
      await run(async (tx) => {
        const row = await lockJob(tx, jobId);
        const next = transitionPrintJob(row.status, "succeed");
        await updateJob(tx, jobId, {
          status: next,
          printedAt: at,
          lastError: null,
        });
      });
    },

    async markFailed(jobId, error, phase) {
      await run(async (tx) => {
        const row = await lockJob(tx, jobId);
        const next = transitionPrintJob(row.status, "fail");
        await updateJob(tx, jobId, {
          status: next,
          lastError: error.slice(0, MAX_ERROR_LENGTH),
          failurePhase: phase,
        });
      });
    },

    async requeue(jobId) {
      return run(async (tx) => {
        const row = await lockJob(tx, jobId);
        const next = transitionPrintJob(row.status, "retry");
        return toJobRecord(
          await updateJob(tx, jobId, { status: next, failurePhase: null }),
        );
      });
    },

    async releaseClaim(jobId, error) {
      try {
        ulidToUuid(jobId);
      } catch {
        throw jobNotFound();
      }
      await run(async (tx) => {
        // One statement: no-op when the job is no longer printing.
        await tx
          .update(edgePrintJobs)
          .set({
            status: "queued",
            lastError: error.slice(0, MAX_ERROR_LENGTH),
            failurePhase: null,
            startedAt: null,
            updatedAt: now(),
          })
          .where(
            and(
              jobScope(),
              eq(edgePrintJobs.id, jobId),
              eq(edgePrintJobs.status, "printing"),
            ),
          );
      });
    },

    async failStaleClaims(startedBefore, error) {
      return run(async (tx) => {
        const failed = await tx
          .update(edgePrintJobs)
          .set({
            status: "failed",
            lastError: error.slice(0, MAX_ERROR_LENGTH),
            failurePhase: "stale",
            updatedAt: now(),
          })
          .where(
            and(
              jobScope(),
              eq(edgePrintJobs.status, "printing"),
              lt(edgePrintJobs.startedAt, startedBefore),
            ),
          )
          .returning();
        return failed.map(toJobRecord);
      });
    },

    async reroute(fromPrinterId, toPrinterId) {
      if (fromPrinterId === toPrinterId)
        throw new CoreError(
          "CONFLICT",
          "Printer tujuan sama dengan printer asal.",
        );
      return run(async (tx) => {
        if (!(await printerExists(tx, toPrinterId))) throw printerNotFound();
        const moved = await tx
          .update(edgePrintJobs)
          .set({
            printerId: toPrinterId,
            originalPrinterId: sql`COALESCE(${edgePrintJobs.originalPrinterId}, ${edgePrintJobs.printerId})`,
            printedFallback: true,
            fallbackReason: "printer_offline",
            updatedAt: now(),
          })
          .where(
            and(
              jobScope(),
              eq(edgePrintJobs.printerId, fromPrinterId),
              eq(edgePrintJobs.status, "queued"),
            ),
          )
          .returning({ id: edgePrintJobs.id });
        return moved.length;
      });
    },

    async getJob(jobId) {
      try {
        ulidToUuid(jobId);
      } catch {
        return null;
      }
      return run(async (tx) => {
        const rows = await tx
          .select()
          .from(edgePrintJobs)
          .where(and(jobScope(), eq(edgePrintJobs.id, jobId)))
          .limit(1);
        return rows[0] ? toJobRecord(rows[0]) : null;
      });
    },

    async listJobs(query: PrintJobListQuery): Promise<PrintJobPage> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      return run(async (tx) => {
        const conditions: (SQL | undefined)[] = [jobScope()];
        if (query.status)
          conditions.push(eq(edgePrintJobs.status, query.status));
        if (cursor)
          conditions.push(
            sql`(${edgePrintJobs.createdAt}, ${edgePrintJobs.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${ulidToUuid(cursor.id)}::uuid)`,
          );
        const rows = await tx
          .select()
          .from(edgePrintJobs)
          .where(and(...conditions))
          .orderBy(desc(edgePrintJobs.createdAt), desc(edgePrintJobs.id))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page.map(toJobRecord),
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor(last.createdAt, last.id)
              : null,
        };
      });
    },

    async recordAlert(alert: PrintAlert, notify) {
      // The local alert and every delivery attempt share one event id, even
      // when the notifier and agent are recreated after a process restart.
      const alertId = (alert.id ??= nextUlid());
      const insert = async (tx: Tx) => {
        await tx.insert(edgePrintAlerts).values({
          id: alertId,
          tenantId: tenantId,
          outletId: outletId,
          kind: alert.kind,
          // A job id is a ULID; the column is a plain uuid.
          subjectId: UUID_PATTERN.test(alert.subjectId)
            ? alert.subjectId
            : ulidToUuid(alert.subjectId),
          stationId: alert.stationId,
          detail: alert.detail,
          occurredAt: alert.occurredAt,
        });
      };
      try {
        await run(async (tx) => {
          await insert(tx);
          await notify?.(alert, tx);
          if (notify) {
            await tx
              .update(edgePrintAlerts)
              .set({ notificationEnqueuedAt: now() })
              .where(and(alertScope(), eq(edgePrintAlerts.id, alertId)));
          }
        });
      } catch (error) {
        if (!notify) throw error;
        // A failed queue write rolls back the first insert. Preserve the local
        // evidence in a fresh transaction, then let the agent retry delivery.
        await run(insert);
        return false;
      }
      return true;
    },

    async retryPendingAlerts(notify) {
      await run(async (tx) => {
        const alerts = await tx
          .select()
          .from(edgePrintAlerts)
          .where(
            and(
              alertScope(),
              isNull(edgePrintAlerts.notificationEnqueuedAt),
              inArray(edgePrintAlerts.kind, ["printer_offline", "job_failed"]),
            ),
          )
          .orderBy(asc(edgePrintAlerts.occurredAt), asc(edgePrintAlerts.id))
          .limit(100)
          .for("update", { skipLocked: true });
        for (const row of alerts) {
          try {
            // A failed enqueue rolls back only this delivery. The durable
            // pending row remains, while later alerts can still be delivered.
            await tx.transaction(async (delivery) => {
              await notify(
                {
                  id: row.id,
                  kind: row.kind,
                  subjectId:
                    row.kind === "job_failed"
                      ? uuidToUlid(row.subjectId)
                      : row.subjectId,
                  stationId: row.stationId,
                  detail: row.detail,
                  occurredAt: row.occurredAt,
                },
                delivery,
              );
              await delivery
                .update(edgePrintAlerts)
                .set({ notificationEnqueuedAt: now() })
                .where(and(alertScope(), eq(edgePrintAlerts.id, row.id)));
            });
          } catch {
            // The next sweep retries the same persisted event id.
          }
        }
      });
    },
  };
}
