// Print queue service for staff screens (bead legend-46p; PRD v1.7 §3 F5
// "Print Agent", §3 F12 "Fallback Cetak", EDG-05). Served by the edge node
// for its own outlet: the context is the node's trusted scope, never a
// client-supplied one (TEN-02).
//
// - list: the print queue, newest first, with an opaque cursor.
// - reprint ("cetak ulang"): a NEW job on the same printer that references the
//   original, with a visible reprint line. Fraud-sensitive (a receipt can be
//   handed out twice), so the insert and the audit row share one transaction.
// - retry: failed -> queued through the store (transitionPrintJob), except a
//   job that failed mid-write or went stale: its bytes may be half printed, so
//   retry makes a marked reprint and the original stays failed.
// - printers: heartbeat status of the outlet's printers.
//
// Never log or audit printer content: it carries receipt lines and names.
import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  printerStatusViewSchema,
  transitionPrintJob,
  type PrintJob,
  type PrinterStatusView,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { edgePrintJobs } from "../db/schema/edge-print.ts";
import { withTenant } from "../db/tenant.ts";
import { markReprint } from "../edge/print/escpos.ts";
import { createDbPrintStore, toPrintJobDto } from "../edge/print/store.ts";
import type {
  FailurePhase,
  PrintJobListQuery,
  PrintJobRecord,
} from "../edge/print/types.ts";
import { recordAudit } from "./audit-writer.ts";

type JobRow = typeof edgePrintJobs.$inferSelect;

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * What the caller may see and hand out, computed by the route from the access
 * snapshot on the node's outlet. `content`: may see receipt bytes
 * (`pos.sale.create`). `shiftReport`: may also see or reprint shift reports
 * (`shift.cash.view_all` or `shift.cash.approve_close`).
 */
export type PrintAccess = { content: boolean; shiftReport: boolean };

const notFound = () =>
  new CoreError("NOT_FOUND", "Tugas cetak tidak ditemukan.");

const shiftReportDenied = () =>
  new AccessError(
    "PERMISSION_DENIED",
    "Akun Anda tidak dapat mencetak ulang laporan shift outlet ini.",
  );

/** Shift report bytes carry cash totals: they need the shift permission too. */
function mayHandOut(access: PrintAccess, kind: PrintJob["kind"]): boolean {
  return access.content && (kind !== "shift_report" || access.shiftReport);
}

/** The job as the caller may see it: `content` is null when they may not read the bytes. */
function toVisibleDto(record: PrintJobRecord, access: PrintAccess): PrintJob {
  const dto = toPrintJobDto(record);
  return mayHandOut(access, record.kind) ? dto : { ...dto, content: null };
}

/** The single outlet this edge node serves. */
function nodeOutletId(context: ScopedTenantContext): OutletId {
  assertTrustedScopedContext(context);
  const scope = context.outletScope;
  if (scope.kind !== "outlets" || scope.outletIds.length !== 1)
    throw new CoreError(
      "FORBIDDEN",
      "Antrean cetak hanya melayani satu outlet.",
    );
  const [outletId] = scope.outletIds;
  assertOutletInScope(scope, outletId);
  return outletId;
}

function toRecord(row: JobRow): PrintJobRecord {
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
    failurePhase: row.failurePhase as FailurePhase | null,
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

export async function listPrintJobsForOutlet(input: {
  context: ScopedTenantContext;
  query: PrintJobListQuery;
  access: PrintAccess;
}): Promise<{
  data: PrintJob[];
  meta: { limit: number; nextCursor: string | null };
}> {
  nodeOutletId(input.context);
  const store = createDbPrintStore({ db, context: input.context });
  const page = await store.listJobs(input.query);
  return {
    data: page.items.map((item) => toVisibleDto(item, input.access)),
    meta: { limit: input.query.limit, nextCursor: page.nextCursor },
  };
}

/**
 * Insert the "cetak ulang" of `original` and its audit row in the caller's
 * transaction. The unique (tenant, outlet, idempotency key) index arbitrates
 * concurrent requests: the loser inserts nothing and reads the winner's row.
 */
async function insertReprint(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    original: JobRow;
    idempotencyKey: string;
    actorUserId: string;
    reason: string | null;
  },
): Promise<PrintJobRecord> {
  const { original, idempotencyKey, actorUserId, reason } = input;
  const tenantId = original.tenantId;
  const outletId = original.outletId;
  const [inserted] = await tx
    .insert(edgePrintJobs)
    .values({
      id: createUlid(),
      tenantId,
      outletId,
      printerId: original.printerId,
      kind: original.kind,
      content: markReprint(original.content),
      idempotencyKey,
      sourceRef: original.sourceRef,
      reprintOf: original.id,
      createdBy: actorUserId,
    })
    .onConflictDoNothing({
      target: [
        edgePrintJobs.tenantId,
        edgePrintJobs.outletId,
        edgePrintJobs.idempotencyKey,
      ],
    })
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(edgePrintJobs)
      .where(
        and(
          eq(edgePrintJobs.tenantId, tenantId),
          eq(edgePrintJobs.outletId, outletId),
          eq(edgePrintJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Print job conflict row not found");
    // A repeated key returns the reprint it made the first time.
    if (existing.reprintOf !== original.id)
      throw new CoreError(
        "CONFLICT",
        "Kunci idempotensi sudah dipakai untuk tugas cetak lain.",
      );
    return toRecord(existing);
  }
  await recordAudit(
    {
      tenantId,
      outletId,
      actorType: "user",
      actorId: actorUserId,
      deviceId: null,
      action: "print_job.reprinted",
      objectType: "print_job",
      objectId: inserted.id,
      reason,
      before: null,
      after: {
        originalJobId: original.id,
        kind: original.kind,
        printerId: original.printerId,
        sourceRef: original.sourceRef,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  return toRecord(inserted);
}

export async function reprintPrintJobForOutlet(input: {
  context: ScopedTenantContext;
  printJobId: string;
  idempotencyKey: string;
  actorUserId: string;
  access: PrintAccess;
}): Promise<PrintJob> {
  const { context, printJobId, idempotencyKey, actorUserId, access } = input;
  const outletId = nodeOutletId(context);
  const tenantId = context.tenant.tenantId;
  const record = await withTenant(db, context, async (tx) => {
    const [original] = await tx
      .select()
      .from(edgePrintJobs)
      .where(
        and(
          eq(edgePrintJobs.tenantId, tenantId),
          eq(edgePrintJobs.outletId, outletId),
          eq(edgePrintJobs.id, printJobId),
        ),
      )
      .limit(1);
    if (!original) throw notFound();
    if (original.kind === "shift_report" && !access.shiftReport)
      throw shiftReportDenied();

    // Only a finished print can be reprinted; a failed job goes through retry.
    if (original.status !== "printed")
      throw new CoreError(
        "CONFLICT",
        "Hanya tugas cetak yang sudah tercetak yang dapat dicetak ulang. Gunakan ulangi untuk tugas gagal.",
      );
    return insertReprint(tx, context, {
      original,
      idempotencyKey,
      actorUserId,
      reason: null,
    });
  });
  return toVisibleDto(record, access);
}

/**
 * Retry a failed job. `other` failures go back to the queue. A `write` or
 * `stale` failure may have left half a receipt on paper (or an unknown
 * outcome), so a silent second original is a duplicate-receipt risk: make a
 * marked reprint instead, with the reprint permissions, and leave the original
 * failed. Returns the job that will print.
 */
export async function retryPrintJobForOutlet(input: {
  context: ScopedTenantContext;
  printJobId: string;
  idempotencyKey: string;
  actorUserId: string;
  access: PrintAccess;
}): Promise<PrintJob> {
  const { context, printJobId, idempotencyKey, actorUserId, access } = input;
  const outletId = nodeOutletId(context);
  const tenantId = context.tenant.tenantId;
  try {
    ulidToUuid(printJobId);
  } catch {
    throw notFound();
  }
  const record = await withTenant(db, context, async (tx) => {
    const scope = and(
      eq(edgePrintJobs.tenantId, tenantId),
      eq(edgePrintJobs.outletId, outletId),
      eq(edgePrintJobs.id, printJobId),
    );
    const [job] = await tx
      .select()
      .from(edgePrintJobs)
      .where(scope)
      .for("update");
    if (!job) throw notFound();
    // Only a failed job goes back to the queue (CONFLICT otherwise).
    const next = transitionPrintJob(job.status, "retry");
    // Shift report bytes carry cash totals: every retry path needs the shift permission.
    if (job.kind === "shift_report" && !access.shiftReport)
      throw shiftReportDenied();
    if (job.failurePhase === "write" || job.failurePhase === "stale") {
      // One reprint per failed job: a new key may not make a second copy.
      // The same key replays the reprint it made the first time.
      const [existingReprint] = await tx
        .select({ idempotencyKey: edgePrintJobs.idempotencyKey })
        .from(edgePrintJobs)
        .where(
          and(
            eq(edgePrintJobs.tenantId, tenantId),
            eq(edgePrintJobs.outletId, outletId),
            eq(edgePrintJobs.reprintOf, job.id),
          ),
        )
        .limit(1);
      if (existingReprint && existingReprint.idempotencyKey !== idempotencyKey)
        throw new CoreError("CONFLICT", "Tugas ini sudah dicetak ulang.");
      return insertReprint(tx, context, {
        original: job,
        idempotencyKey,
        actorUserId,
        reason: "retry",
      });
    }
    const [updated] = await tx
      .update(edgePrintJobs)
      .set({ status: next, failurePhase: null, updatedAt: new Date() })
      .where(scope)
      .returning();
    if (!updated) throw new Error("Print job update returned nothing");
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "print_job.retried",
        objectType: "print_job",
        objectId: updated.id,
        reason: null,
        before: { status: job.status },
        after: {
          status: updated.status,
          kind: job.kind,
          printerId: job.printerId,
          sourceRef: job.sourceRef,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toRecord(updated);
  });
  return toVisibleDto(record, access);
}

export async function listPrintersForOutlet(input: {
  context: ScopedTenantContext;
}): Promise<PrinterStatusView[]> {
  nodeOutletId(input.context);
  const store = createDbPrintStore({ db, context: input.context });
  const printers = await store.listPrinters();
  return printers.map((printer) =>
    printerStatusViewSchema.parse({
      tenantId: printer.tenantId,
      outletId: printer.outletId,
      id: printer.id,
      label: printer.label,
      role: printer.role,
      stationId: printer.stationId,
      status: printer.status,
      lastSeenAt: printer.lastSeenAt?.toISOString() ?? null,
      offlineSince: printer.offlineSince?.toISOString() ?? null,
      fallbackPrinterId: printer.fallbackPrinterId,
    }),
  );
}
