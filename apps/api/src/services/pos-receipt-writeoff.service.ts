// Audited write-off of a lost receipt number (legend-0hzqw).
//
// Since legend-6b0ld the day close refuses (RECEIPT_SEQUENCE_GAP) while a run
// of the outlet is missing an ordinal, with no way out. The tenant owner marks
// one number (prefix + ordinal) as permanently lost, with a reason; gap checks
// then count it as present and reports show it as written off. Cloud only (the
// number ranges are decided there); append-only; the table triggers in
// pos-receipt-writeoff.custom.sql are the backstop for the checks below.

import { and, desc, eq } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  formatReceiptNumber,
  receiptNumberWriteoffSchema,
  type ReceiptNumberWriteoff,
  type ReceiptNumberWriteoffInput,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { receiptNumberWriteoffs } from "../db/schema/pos-receipt-writeoff.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { recordAudit } from "./core-audit.ts";

export interface ReceiptWriteoffCaller {
  userId: UserId;
}

const AUDIT_SAFE_FIELDS = [
  "outletId",
  "prefix",
  "sequenceNumber",
  "number",
] as const;

/** Same rule as pos-receipt.service.ts: the static setting counts too. */
function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

function uniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

type WriteoffRow = typeof receiptNumberWriteoffs.$inferSelect;

function toWriteoff(row: WriteoffRow): ReceiptNumberWriteoff {
  return receiptNumberWriteoffSchema.parse({
    id: row.id,
    outletId: row.outletId,
    prefix: row.prefix,
    sequenceNumber: row.sequenceNumber,
    number: formatReceiptNumber(row.prefix, row.sequenceNumber),
    reason: row.reason,
    writtenOffBy: row.writtenOffBy,
    createdAt: row.createdAt.toISOString(),
  });
}

const CLOUD_ONLY =
  "Write-off nomor struk dan riwayatnya hanya ada di cloud, bukan di edge.";

const ALREADY_WRITTEN_OFF = "Nomor struk ini sudah di-write-off.";

const FAILOVER_RUN =
  "Nomor struk mode cloud (F) tidak dapat di-write-off. Celahnya tetap dilaporkan; hubungi tim teknis.";

/** Marks one lost number of an outlet run as written off; owner only (route). */
export async function writeOffReceiptNumber(
  context: ScopedTenantContext,
  caller: ReceiptWriteoffCaller,
  outletId: OutletId,
  input: ReceiptNumberWriteoffInput,
): Promise<ReceiptNumberWriteoff> {
  if (isEdgeProcess()) throw new CoreError("CONFLICT", CLOUD_ONLY);
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(caller.userId);
  const now = new Date();
  try {
    return await withTenant(db, context, async (tx) => {
      const [sequence] = await tx
        .select()
        .from(receiptSequences)
        .where(
          and(
            eq(receiptSequences.tenantId, tenantId),
            eq(receiptSequences.outletId, outletId),
            eq(receiptSequences.prefix, input.prefix),
          ),
        )
        .for("update");
      if (!sequence)
        throw new CoreError(
          "NOT_FOUND",
          "Prefiks nomor struk tidak ditemukan.",
        );
      // 1271 review K F1: the cloud numbers an F (failover) run inside the
      // sale's transaction, so a missing F number is a fault to investigate:
      // its gap stays reported, it is never written off.
      if (sequence.series === "failover")
        throw new CoreError("CONFLICT", FAILOVER_RUN);
      // legend-drzaf: an edge-bound run is numbered by the edge, so its cloud
      // lastNumber stays 0 (legend-ol6v). Its bound is the high-water the
      // edge reported (never decreases; every number up to it was committed
      // on the edge). 0 on unbound runs. Same bound as the 0166 trigger.
      if (
        input.sequenceNumber >
        Math.max(sequence.lastNumber, sequence.edgeReportedNumber)
      )
        throw new CoreError(
          "CONFLICT",
          "Nomor struk di luar rentang yang sudah terbit.",
        );
      const [receipt] = await tx
        .select({ id: posReceipts.id })
        .from(posReceipts)
        .where(
          and(
            eq(posReceipts.tenantId, tenantId),
            eq(posReceipts.sequenceId, sequence.id),
            eq(posReceipts.sequenceNumber, input.sequenceNumber),
          ),
        )
        .limit(1);
      if (receipt)
        throw new CoreError("CONFLICT", "Nomor struk ini sudah punya struk.");
      const [existing] = await tx
        .select({ id: receiptNumberWriteoffs.id })
        .from(receiptNumberWriteoffs)
        .where(
          and(
            eq(receiptNumberWriteoffs.tenantId, tenantId),
            eq(receiptNumberWriteoffs.sequenceId, sequence.id),
            eq(receiptNumberWriteoffs.sequenceNumber, input.sequenceNumber),
          ),
        )
        .limit(1);
      if (existing) throw new CoreError("CONFLICT", ALREADY_WRITTEN_OFF);

      const [row] = await tx
        .insert(receiptNumberWriteoffs)
        .values({
          tenantId,
          outletId,
          sequenceId: sequence.id,
          prefix: sequence.prefix,
          sequenceNumber: input.sequenceNumber,
          reason: input.reason,
          writtenOffBy: actorId,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("Receipt write-off insert returned no row");

      const writeoff = toWriteoff(row);
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId,
          actorType: "user",
          actorId,
          deviceId: null,
          action: "pos.receipt.written_off",
          objectType: "receipt_number_writeoff",
          objectId: row.id,
          reason: input.reason,
          maskedChanges: {
            before: null,
            after: maskAuditChanges(
              {
                outletId,
                prefix: writeoff.prefix,
                sequenceNumber: writeoff.sequenceNumber,
                number: writeoff.number,
              },
              AUDIT_SAFE_FIELDS,
            ),
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        AUDIT_SAFE_FIELDS,
      );
      return writeoff;
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new CoreError("CONFLICT", ALREADY_WRITTEN_OFF);
    throw error;
  }
}

/** The outlet's write-offs, newest first (runbook lookup). */
export async function listReceiptNumberWriteoffs(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<ReceiptNumberWriteoff[]> {
  if (isEdgeProcess()) throw new CoreError("CONFLICT", CLOUD_ONLY);
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(receiptNumberWriteoffs)
      .where(
        and(
          eq(receiptNumberWriteoffs.tenantId, tenantId),
          eq(receiptNumberWriteoffs.outletId, outletId),
        ),
      )
      .orderBy(
        desc(receiptNumberWriteoffs.createdAt),
        desc(receiptNumberWriteoffs.sequenceNumber),
      );
    return rows.map(toWriteoff);
  });
}
