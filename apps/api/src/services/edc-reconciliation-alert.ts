// EDC reconciliation alerts (X1 legend-wasr7.10, cloud-only release §3).
// Manual EDC is the normal path: a hand-keyed slip books the bill but stays
// `needs_reconciliation` ("perlu dicek") until a person matches it to the bank
// settlement. Two alerts reach the outlet supervisors and the owners:
//
// - amount mismatch: the bank evidence states another amount than the row.
//   The resolve is refused (EDC_AMOUNT_MISMATCH), the row stays flagged, and
//   one alert per (row, stated amount) is sent in its own transaction.
// - overdue: a flagged sale that backs a live tender is still unmatched more
//   than a day after it was keyed. One alert per shift that took it.
//
// Ids are sha256 -> uuid of a stable key, so the notification consumer
// (notification_outbox, ON CONFLICT DO NOTHING) sends each alert once.
import { createHash } from "node:crypto";
import { and, eq, lte, notInArray, sql } from "drizzle-orm";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { posOrderTenders, posOrders } from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";

/** H+1: a manual slip unmatched this long warns its shift. */
export const EDC_RECONCILIATION_OVERDUE_MS = 24 * 60 * 60 * 1000;
const OVERDUE_BATCH_LIMIT = 500;

function alertUlid(key: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(key))
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

const rupiah = (value: number) => `Rp ${value.toLocaleString("id-ID")}`;

export type EdcReconciliationMismatch = {
  edcTransactionId: string;
  outletId: string;
  amountIdr: number;
  chargedAmountIdr: number;
};

/**
 * Alerts once per row and stated amount. Runs in its own tenant transaction
 * (the refused resolve rolled back); never throws.
 */
export async function alertEdcReconciliationMismatch(
  context: ScopedTenantContext,
  mismatch: EdcReconciliationMismatch,
  now: Date = new Date(),
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = alertUlid([
    "edc_transaction.reconciliation_mismatch",
    tenantId,
    mismatch.edcTransactionId.toLowerCase(),
    String(mismatch.chargedAmountIdr),
  ]);
  try {
    await withTenant(db, context, (tx) =>
      notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(mismatch.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "edc_transaction.reconciliation_mismatch",
          aggregateType: "edc_transaction",
          aggregateId: id,
          payload: {
            edcTransactionId: mismatch.edcTransactionId,
            amountIdr: String(mismatch.amountIdr),
            chargedAmountIdr: String(mismatch.chargedAmountIdr),
          },
          title: "Selisih rekonsiliasi EDC",
          body: `Bukti bank menyebut ${rupiah(mismatch.chargedAmountIdr)}, tercatat ${rupiah(mismatch.amountIdr)}. Transaksi tetap perlu dicek; periksa slip dan laporan bank sebelum memutuskan koreksi.`,
        },
        now,
      ),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId, edcTransactionId: mismatch.edcTransactionId },
      "EDC reconciliation mismatch alert failed",
    );
  }
}

export type EdcOverdueAlertResult = { shifts: number; rows: number };

/**
 * Warns each shift that holds a flagged EDC sale booked as a live tender and
 * keyed more than a day ago. One alert per shift (a later run adds nothing);
 * a failing shift never stops the others.
 */
export async function alertOverdueEdcReconciliation(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<EdcOverdueAlertResult> {
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(now.getTime() - EDC_RECONCILIATION_OVERDUE_MS);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: edcTransactions.id,
        outletId: edcTransactions.outletId,
        amountIdr: edcTransactions.amountIdr,
        // A non-cash tender carries a shift only for a captain bill; every
        // other bill's shift is the order's own.
        shiftId: sql<
          string | null
        >`coalesce(${posOrderTenders.shiftId}, ${posOrders.shiftId})`,
      })
      .from(edcTransactions)
      .innerJoin(
        posOrderTenders,
        and(
          eq(posOrderTenders.tenantId, edcTransactions.tenantId),
          eq(posOrderTenders.edcTransactionId, edcTransactions.id),
          notInArray(posOrderTenders.status, ["voided", "failed"]),
        ),
      )
      .leftJoin(
        posOrders,
        and(
          eq(posOrders.tenantId, posOrderTenders.tenantId),
          eq(posOrders.orderId, posOrderTenders.orderId),
        ),
      )
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.type, "sale"),
          eq(edcTransactions.needsReconciliation, true),
          lte(edcTransactions.createdAt, cutoff),
        ),
      )
      .orderBy(sql`${edcTransactions.createdAt} asc`)
      .limit(OVERDUE_BATCH_LIMIT),
  );
  // A tender without a shift is its own group (keyed by the ledger row).
  const groups = new Map<
    string,
    { outletId: string; shiftId: string | null; count: number; total: number }
  >();
  for (const row of rows) {
    const key = row.shiftId ? `shift:${row.shiftId}` : `row:${row.id}`;
    const group = groups.get(key) ?? {
      outletId: row.outletId,
      shiftId: row.shiftId,
      count: 0,
      total: 0,
    };
    group.count += 1;
    group.total += Number(row.amountIdr);
    groups.set(key, group);
  }
  const result: EdcOverdueAlertResult = { shifts: 0, rows: rows.length };
  for (const [key, group] of groups) {
    const id = alertUlid([
      "pos_shift.edc_reconciliation_overdue",
      tenantId,
      key.toLowerCase(),
    ]);
    try {
      await withTenant(db, context, (tx) =>
        notifyOutletSupervisors(
          tx,
          context,
          {
            tenantId,
            outletId: outletIdSchema.parse(group.outletId),
            category: "operational_anomaly",
            alsoOwners: true,
            recordEmpty: true,
            id,
            eventName: "pos_shift.edc_reconciliation_overdue",
            aggregateType: "pos_shift",
            aggregateId: id,
            payload: {
              outletId: group.outletId,
              shiftId: group.shiftId ?? "",
              count: String(group.count),
              totalIdr: String(group.total),
            },
            title: "EDC manual belum cocok",
            body: `${group.count} pembayaran EDC manual (${rupiah(group.total)}) di shift ini belum cocok dengan laporan bank lebih dari 1 hari. Cocokkan di halaman rekonsiliasi EDC.`,
          },
          now,
        ),
      );
      result.shifts += 1;
    } catch (err) {
      logger.warn(
        { err, tenantId, shiftId: group.shiftId },
        "EDC reconciliation overdue alert failed",
      );
    }
  }
  return result;
}
