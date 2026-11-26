// EDC reconciliation alerts (X1 legend-wasr7.10, cloud-only release §3).
// Manual EDC is the normal path: a hand-keyed slip books the bill but stays
// `needs_reconciliation` ("perlu dicek") until a person matches it to the bank
// settlement. Two alerts reach the outlet supervisors and the owners:
//
// - mismatch: the evidence states another amount than the row, or the bank
//   statement line of a manual slip names another reference. The resolve is
//   refused, the row stays flagged, and one alert per (row, kind, stated
//   amount) is sent in its own transaction.
// - overdue: a flagged sale that backs a live tender is still unmatched more
//   than a day after it was keyed. One alert per shift and due day (Asia/
//   Jakarta), grouped in SQL; groups already alerted are skipped there, before
//   the limit, so an old backlog never hides a newer group.
//
// Alert ids are uuids derived from a stable key (sha256 for a mismatch, md5
// in SQL for an overdue group so the query can skip it), so the notification
// consumer (notification_outbox, ON CONFLICT DO NOTHING) sends each once.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";

/** H+1: a manual slip unmatched this long warns its shift. */
export const EDC_RECONCILIATION_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** Groups (shift, due day) alerted per run; the rest wait for the next run. */
const OVERDUE_GROUP_LIMIT = 100;
const OVERDUE_EVENT = "pos_shift.edc_reconciliation_overdue";

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
  /** `amount`: another charged amount; `reference`: another bank RRN. */
  kind: "amount" | "reference";
  edcTransactionId: string;
  outletId: string;
  amountIdr: number;
  /** What the evidence states; null when it states no amount. */
  chargedAmountIdr: number | null;
};

/**
 * Alerts once per row, kind and stated amount. Runs in its own tenant
 * transaction (the refused resolve rolled back); never throws.
 */
export async function alertEdcReconciliationMismatch(
  context: ScopedTenantContext,
  mismatch: EdcReconciliationMismatch,
  now: Date = new Date(),
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const charged =
    mismatch.chargedAmountIdr === null ? "" : String(mismatch.chargedAmountIdr);
  const id = alertUlid([
    "edc_transaction.reconciliation_mismatch",
    tenantId,
    mismatch.edcTransactionId.toLowerCase(),
    mismatch.kind,
    charged,
  ]);
  const body =
    mismatch.kind === "amount" && mismatch.chargedAmountIdr !== null
      ? `Bukti bank menyebut ${rupiah(mismatch.chargedAmountIdr)}, tercatat ${rupiah(mismatch.amountIdr)}. Transaksi tetap perlu dicek; periksa slip dan laporan bank sebelum memutuskan koreksi.`
      : `Nomor referensi di laporan bank tidak sama dengan slip EDC manual yang dicatat kasir (${rupiah(mismatch.amountIdr)}). Transaksi tetap perlu dicek; periksa slip dan laporan bank sebelum memutuskan koreksi.`;
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
            kind: mismatch.kind,
            amountIdr: String(mismatch.amountIdr),
            chargedAmountIdr: charged,
          },
          title: "Selisih rekonsiliasi EDC",
          body,
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

type OverdueGroup = {
  alert_uuid: string;
  outlet_id: string;
  shift_id: string | null;
  group_key: string;
  due_date: string;
  row_count: number;
  total_idr: string;
};

/**
 * Warns each shift that holds flagged EDC sales booked as live tenders and
 * keyed more than a day ago: one alert per (shift, due day). A tender without
 * a shift is its own group (keyed by the ledger row). A failing group never
 * stops the others.
 */
export async function alertOverdueEdcReconciliation(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<EdcOverdueAlertResult> {
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(now.getTime() - EDC_RECONCILIATION_OVERDUE_MS);
  const groups = await withTenant(db, context, async (tx) => {
    const result = await tx.execute<OverdueGroup>(sql`
      WITH overdue AS (
        SELECT e.outlet_id,
               coalesce(t.shift_id, o.shift_id) AS shift_id,
               coalesce('shift:' || coalesce(t.shift_id, o.shift_id)::text,
                        'row:' || e.id::text) AS group_key,
               to_char(((e.created_at + interval '24 hours')
                          AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS due_date,
               e.amount_idr,
               e.created_at
        FROM edc_transactions e
        JOIN pos_order_tenders t
          ON t.tenant_id = e.tenant_id
         AND t.edc_transaction_id = e.id
         AND t.status NOT IN ('voided', 'failed')
        LEFT JOIN pos_orders o
          ON o.tenant_id = t.tenant_id AND o.order_id = t.order_id
        WHERE e.tenant_id = ${tenantId}::uuid
          AND e.type = 'sale'
          AND e.needs_reconciliation
          AND e.created_at <= ${cutoff.toISOString()}::timestamptz
      )
      , grouped AS (
        SELECT md5(concat_ws(':', ${OVERDUE_EVENT}::text, ${tenantId}::text,
                             group_key, due_date))::uuid AS alert_uuid,
               outlet_id, shift_id, group_key, due_date,
               count(*)::int AS row_count, sum(amount_idr) AS total_idr,
               min(created_at) AS oldest
        FROM overdue
        GROUP BY outlet_id, shift_id, group_key, due_date
      )
      SELECT g.alert_uuid::text AS alert_uuid, g.outlet_id::text AS outlet_id,
             g.shift_id::text AS shift_id, g.group_key, g.due_date, g.row_count,
             g.total_idr::text AS total_idr
      FROM grouped g
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_outbox n
        WHERE n.tenant_id = ${tenantId}::uuid AND n.source_event_id = g.alert_uuid
      )
      ORDER BY g.oldest ASC
      LIMIT ${OVERDUE_GROUP_LIMIT}
    `);
    return result.rows;
  });
  const result: EdcOverdueAlertResult = { shifts: 0, rows: 0 };
  for (const group of groups) {
    const id = uuidToUlid(group.alert_uuid);
    try {
      // A rerun of the same group is a no-op in the consumer (same id).
      await withTenant(db, context, (tx) =>
        notifyOutletSupervisors(
          tx,
          context,
          {
            tenantId,
            outletId: outletIdSchema.parse(group.outlet_id),
            category: "operational_anomaly",
            alsoOwners: true,
            recordEmpty: true,
            id,
            eventName: OVERDUE_EVENT,
            aggregateType: "pos_shift",
            aggregateId: id,
            payload: {
              outletId: group.outlet_id,
              shiftId: group.shift_id ?? "",
              dueDate: group.due_date,
              count: String(group.row_count),
              totalIdr: group.total_idr,
            },
            title: "EDC manual belum cocok",
            body: `${group.row_count} pembayaran EDC manual (${rupiah(Number(group.total_idr))}) di shift ini belum cocok dengan laporan bank lebih dari 1 hari. Cocokkan di halaman rekonsiliasi EDC.`,
          },
          now,
        ),
      );
      result.shifts += 1;
      result.rows += group.row_count;
    } catch (err) {
      logger.warn(
        { err, tenantId, shiftId: group.shift_id },
        "EDC reconciliation overdue alert failed",
      );
    }
  }
  return result;
}
