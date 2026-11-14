// A device receipt that arrives for a number the owner already wrote off
// (legend-refx7). The receipt is still stored (a sale must never lose its
// receipt); the owner's write-off turns out to be wrong, so the arrival is
// audited and the outlet's supervisors get an alarm.
//
// The caller (mergeDeviceReceiptRun) holds the `receipt_sequences` row lock
// FOR UPDATE, the same lock the write-off takes first, so the write-off read
// here is final for this transaction: a write-off cannot commit between this
// read and the receipt insert, and a merge never stores a receipt without
// seeing a write-off that committed before it.
//
// Database trigger check (0166, receipt_number_writeoffs_check_insert_trg):
// it fires only on INSERT into receipt_number_writeoffs. Nothing on
// pos_receipts reads the write-off table, so storing the receipt for a
// written-off number is accepted by the database; the write-off row stays
// (append-only) and gap counting keeps treating the number as present.

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  createUlid,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { formatReceiptNumber } from "@starter/shared/pos";
import { logger } from "../lib/logger.ts";
import { receiptNumberWriteoffs } from "../db/schema/pos-receipt-writeoff.ts";
import { recordAudit } from "./core-audit.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import type { Tx } from "./permission-resolver.ts";

const AUDIT_SAFE_FIELDS = [
  "outletId",
  "prefix",
  "sequenceNumber",
  "number",
  "writeoffId",
] as const;

const ALERT_EVENT = "pos_receipt.arrived_after_writeoff";

/** Stable per sequence and number: the notification consumer dedupes on it. */
function alertIdFor(
  tenantId: TenantId,
  sequenceId: string,
  sequenceNumber: number,
): string {
  const hex = createHash("sha256")
    .update(`${ALERT_EVENT}\0${tenantId}\0${sequenceId}\0${sequenceNumber}`)
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * For receipts just stored on one sequence run: audits and alarms each one
 * whose number has a write-off. No-op (one query) when none does.
 */
export async function reportReceiptsArrivedAfterWriteoff(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    sequenceId: string;
    prefix: string;
    stored: readonly { sequenceNumber: number }[];
    now: Date;
  },
): Promise<number> {
  if (input.stored.length === 0) return 0;
  const tenantId = context.tenant.tenantId;
  const writeoffs = await tx
    .select({
      id: receiptNumberWriteoffs.id,
      sequenceNumber: receiptNumberWriteoffs.sequenceNumber,
    })
    .from(receiptNumberWriteoffs)
    .where(
      and(
        eq(receiptNumberWriteoffs.tenantId, tenantId),
        eq(receiptNumberWriteoffs.sequenceId, input.sequenceId),
        inArray(
          receiptNumberWriteoffs.sequenceNumber,
          input.stored.map((receipt) => receipt.sequenceNumber),
        ),
      ),
    );
  for (const writeoff of writeoffs) {
    const number = formatReceiptNumber(input.prefix, writeoff.sequenceNumber);
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(input.now.getTime()),
        tenantId,
        outletId: input.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "pos_receipt.arrived_after_writeoff",
        objectType: "receipt_number_writeoff",
        objectId: writeoff.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: {
            outletId: input.outletId,
            prefix: input.prefix,
            sequenceNumber: writeoff.sequenceNumber,
            number,
            writeoffId: writeoff.id,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: input.now.toISOString(),
      },
      AUDIT_SAFE_FIELDS,
    );
    const alertId = alertIdFor(
      tenantId,
      input.sequenceId,
      writeoff.sequenceNumber,
    );
    // The alarm must never lose the receipt: a savepoint keeps a failed
    // notification from aborting the merge transaction.
    try {
      await tx.transaction(async (savepoint) => {
        await notifyOutletSupervisors(
          savepoint,
          context,
          {
            tenantId,
            outletId: input.outletId,
            category: "operational_anomaly",
            id: alertId,
            eventName: ALERT_EVENT,
            // The envelope rule: the event name starts with its aggregate type.
            aggregateType: "pos_receipt",
            aggregateId: writeoff.id,
            payload: {
              writeoffId: writeoff.id,
              prefix: input.prefix,
              number,
            },
            title: "Struk tiba untuk nomor yang sudah di-write-off",
            body: `Struk ${number} tiba dari perangkat kasir dan sudah disimpan, padahal nomor ini pernah di-write-off sebagai hilang. Periksa ulang write-off dan laporan penjualan.`,
          },
          input.now,
        );
      });
    } catch (err) {
      logger.warn(
        { err, tenantId, writeoffId: writeoff.id },
        "Receipt arrived after write-off alarm failed",
      );
    }
  }
  return writeoffs.length;
}
