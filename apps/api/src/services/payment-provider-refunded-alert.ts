// Supervisor alert of money the provider refunded after we recorded it (bead
// legend-7uqbs, 958): a payment parked as unallocated funds, or a bill settled
// paid, whose provider payment now answers `refunded`. The money went back to
// the payer, so staff must not refund it again and must decide about the books
// (nothing is reversed automatically). One alert per (tenant, intent, provider
// transaction): the id is derived from them, the notification consumer ignores
// an event id it has seen, and the caller sends it only for the answer that won
// the conditional UPDATE, so a webhook and a poller racing still yield one.
import { createHash } from "node:crypto";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import type { Tx } from "./permission-resolver.ts";

export type ProviderRefundedAfterRecorded = {
  intentId: string;
  outletId: string;
  /** The provider transaction that answered `refunded`. */
  providerRef: string;
  /** Parked funds just marked (may be empty when only the bill was marked). */
  fundIds: readonly string[];
  /** The settled (paid) intent was just marked. */
  paidIntent: boolean;
  amountIdr: number;
};

/** Stable alert id for one intent and provider transaction. */
export function providerRefundedAlertId(
  tenantId: string,
  intentId: string,
  providerRef: string,
): string {
  const hex = createHash("sha256")
    .update(
      `payment.provider_refunded_after_recorded\0${tenantId}\0${intentId.toLowerCase()}\0${providerRef}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * Alerts the outlet supervisors (and owners) inside the caller's transaction.
 * A savepoint keeps a failed alarm from aborting the marking and the audit row
 * that already carry the fact.
 */
export async function alertProviderRefundedAfterRecorded(
  tx: Tx,
  context: ScopedTenantContext,
  refunded: ProviderRefundedAfterRecorded,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = providerRefundedAlertId(
    tenantId,
    refunded.intentId,
    refunded.providerRef,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(refunded.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          // An outlet with nobody to receive it still keeps the record.
          recordEmpty: true,
          id,
          eventName: "payment.provider_refunded_after_recorded",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: refunded.intentId,
            funds: String(refunded.fundIds.length),
            paidIntent: refunded.paidIntent ? "true" : "false",
          },
          title: "Pembayaran sudah dikembalikan oleh penyedia",
          body: `Penyedia pembayaran sudah mengembalikan Rp ${refunded.amountIdr.toLocaleString("id-ID")} ke pembayar untuk uang yang sudah tercatat. Jangan refund lagi; periksa pembukuan dan putuskan koreksinya. Tidak ada jurnal yang dibalik otomatis.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: refunded.intentId },
      "Provider refunded after recorded: notification failed",
    );
  }
}

export type ProviderPartialRefundAlert = {
  intentId: string;
  outletId: string;
  providerRefundId: string;
  /** What this one provider refund returned. */
  amountIdr: number;
  /** What the provider refunded in total for the intent so far. */
  cumulativeIdr: number;
};

/** Stable alert id for one provider refund of one intent (967): each distinct
 * refund is one alert, a webhook, a poller and a retry of it are the same. */
export function providerPartialRefundAlertId(
  tenantId: string,
  intentId: string,
  providerRefundId: string,
): string {
  const hex = createHash("sha256")
    .update(
      `payment.provider_refunded_partial\0${tenantId}\0${intentId.toLowerCase()}\0${providerRefundId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * legend-30hfs (967): alerts the supervisors that the provider refunded part
 * (or all) of a payment on its own. Sent only by the winner of the insert of
 * that refund (`recordProviderRefundInTx`). Same savepoint rule as above.
 */
export async function alertProviderPartialRefund(
  tx: Tx,
  context: ScopedTenantContext,
  refunded: ProviderPartialRefundAlert,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const id = providerPartialRefundAlertId(
    tenantId,
    refunded.intentId,
    refunded.providerRefundId,
  );
  try {
    await tx.transaction(async (savepoint) => {
      await notifyOutletSupervisors(
        savepoint,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(refunded.outletId),
          category: "operational_anomaly",
          alsoOwners: true,
          recordEmpty: true,
          id,
          eventName: "payment.provider_refunded_partial",
          aggregateType: "payment",
          aggregateId: id,
          payload: {
            intentId: refunded.intentId,
            amountIdr: String(refunded.amountIdr),
            cumulativeIdr: String(refunded.cumulativeIdr),
          },
          title: "Penyedia mengembalikan sebagian pembayaran",
          body: `Penyedia pembayaran mengembalikan Rp ${refunded.amountIdr.toLocaleString("id-ID")} ke pembayar untuk pembayaran yang sudah tercatat (total dikembalikan penyedia Rp ${refunded.cumulativeIdr.toLocaleString("id-ID")}). Jumlah yang masih bisa di-refund dikurangi sebesar itu. Periksa pembukuan dan putuskan koreksinya; tidak ada jurnal yang dibalik otomatis.`,
        },
        now,
      );
    });
  } catch (err) {
    logger.warn(
      { err, tenantId, intentId: refunded.intentId },
      "Provider partial refund: notification failed",
    );
  }
}
