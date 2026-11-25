// Late adjustment of edge POS facts (legend-k0i8, CTO decision 2026-11-08): a
// sale, void or shift of a business day the cloud already closed is accepted,
// never changes the frozen pos_daily_closes recap, and is posted to the next
// open business day with a flag, an audit row and one alert to the outlet's
// supervisors. The edge's own close is mirrored only once every sale and shift
// of its recap is in the cloud (shift-day-applier.ts), so whatever still
// arrives for a closed day is not in the recap.
import { createHash } from "node:crypto";
import {
  businessDateSchema,
  createUlid,
  toIsoDateTime,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { logger } from "../lib/logger.ts";
import { recordAudit } from "../services/core-audit.ts";
import { notifyOutletSupervisors } from "../services/edge-sync-conflict-alert.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { isBusinessDayClosed } from "../services/pos-cash-guard.ts";

/** More consecutive closed days than this means bad data, not a late sale. */
const MAX_CLOSED_DAYS = 400;

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The business date a fact of `businessDate` is posted to: its own date while
 * that day is open, else the next open one (null when none is found). Holds
 * the day locks, so the answer stays true until the transaction ends.
 */
export async function openBusinessDateFrom(
  tx: EdgeTx,
  context: ScopedTenantContext,
  outletId: OutletId,
  businessDate: string,
): Promise<string | null> {
  let date = businessDate;
  for (let step = 0; step <= MAX_CLOSED_DAYS; step += 1) {
    const closed = await isBusinessDayClosed(tx, context, {
      outletId,
      businessDates: [date],
    });
    if (!closed) return businessDateSchema.parse(date);
    date = nextDate(date);
  }
  return null;
}

/** Deterministic alert id: the notification consumer dedupes on it. */
export function edgeAlertId(...parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

const AUDIT_FIELDS = ["originalBusinessDate", "lateBusinessDate"] as const;

/**
 * Audit row of one late fact (always) and one supervisor alert per outlet and
 * closed day (best effort: a missing alert must not lose the money record).
 */
export async function recordLateAdjustment(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    action:
      | "order.late_adjusted"
      | "order.void_late_adjusted"
      | "pos_shift.late_adjusted";
    objectType: "order" | "pos_shift";
    objectId: string;
    originalBusinessDate: string;
    lateBusinessDate: string;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: input.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: null,
      maskedChanges: {
        before: null,
        after: {
          originalBusinessDate: input.originalBusinessDate,
          lateBusinessDate: input.lateBusinessDate,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_FIELDS,
  );
  await alertSupervisors(tx, context, {
    outletId: input.outletId,
    id: edgeAlertId(
      "edge_late_adjustment",
      tenantId,
      input.outletId,
      input.originalBusinessDate,
      input.lateBusinessDate,
    ),
    eventName: "edge_late_adjustment.recorded",
    aggregateType: input.objectType,
    aggregateId: input.objectId,
    payload: {
      originalBusinessDate: input.originalBusinessDate,
      lateBusinessDate: input.lateBusinessDate,
    },
    title: "Transaksi terlambat dari server lokal",
    body: `Ada transaksi hari ${input.originalBusinessDate} yang masuk setelah Tutup Hari. Transaksi dicatat di hari ${input.lateBusinessDate} sebagai penyesuaian terlambat.`,
  });
}

/** One in-app alert; failure is logged and never stops the receive batch. */
export async function alertSupervisors(
  tx: EdgeTx,
  context: ScopedTenantContext,
  alert: {
    outletId: OutletId;
    id: string;
    eventName: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, string>;
    title: string;
    body: string;
  },
): Promise<void> {
  try {
    await tx.transaction((sp) =>
      notifyOutletSupervisors(
        sp,
        context,
        { ...alert, tenantId: context.tenant.tenantId },
        new Date(),
      ),
    );
  } catch {
    logger.warn({ eventName: alert.eventName }, "Edge POS alert failed");
  }
}
