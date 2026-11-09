// POS EDC tender adapter (bead legend-dahk; EDC-01..EDC-03).
//
// The EDC agent (edge/edc) drives the terminal and writes the durable
// `edc_transactions` ledger. The POS tender never talks to a terminal: it
// settles a tender only against an APPROVED ecr sale of that ledger which
// belongs to this order, so a cashier cannot book an EDC payment the bank
// never approved, reuse one approval twice, or move it to another bill.
// Standalone terminal entries (keyed by hand) are not accepted here; they take
// the supervisor-approved path in pos-edc-standalone.ts (legend-m4fv).

import { and, eq, ne, sql } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import { hasPanLengthDigits } from "@starter/shared/edc";
import { edcTransactions } from "../db/schema/edc.ts";
import { posOrderTenders } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import type { PosExternalTenderPort } from "./pos-order-ports.ts";

const METHOD_OF_TENDER = { edc_card: "card", edc_qris: "qris" } as const;

export const edcTenderSettlement: PosExternalTenderPort = async (
  tx,
  context,
  input,
) => {
  const tenantId = context.tenant.tenantId;
  const edcMethod =
    METHOD_OF_TENDER[input.method as keyof typeof METHOD_OF_TENDER];
  if (!edcMethod)
    throw new CoreError("VALIDATION_ERROR", "Metode ini bukan pembayaran EDC.");
  if (!input.edcTransactionId)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pembayaran EDC mencantumkan transaksi EDC yang disetujui bank.",
    );
  // One approval, one tender, even when two requests race on it.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-edc-tender:${tenantId}:${input.edcTransactionId}`}, 0))`,
  );
  const [row] = await tx
    .select()
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.id, input.edcTransactionId),
      ),
    )
    .limit(1);
  // Same answer for "missing" and "another outlet's": no probing of ids.
  if (!row || row.outletId !== input.outletId)
    throw new CoreError("NOT_FOUND", "Transaksi EDC tidak ditemukan.");
  if (row.type !== "sale" || row.mode !== "ecr")
    throw new CoreError(
      "CONFLICT",
      "Hanya penjualan EDC dari terminal yang bisa dipakai sebagai pembayaran.",
    );
  if (row.status !== "approved")
    throw new CoreError(
      "CONFLICT",
      "Transaksi EDC belum disetujui bank; tunggu hasil atau cek status.",
    );
  // A row flagged for reconciliation (a second approval, or a hand-keyed
  // standalone entry) is settled only by the supervisor-approved standalone
  // path or by a human, never by this ecr path.
  if (row.needsReconciliation)
    throw new CoreError(
      "CONFLICT",
      "Transaksi EDC ini menunggu rekonsiliasi; hubungi supervisor.",
    );
  if (row.method !== edcMethod || row.amountIdr !== input.amountIdr)
    throw new CoreError(
      "CONFLICT",
      "Metode atau nominal transaksi EDC tidak sama dengan sisa tagihan.",
    );
  const [order] = await tx
    .select({ number: orders.number })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, input.orderId)))
    .limit(1);
  if (!order || row.reference !== order.number)
    throw new CoreError("CONFLICT", "Transaksi EDC ini milik tagihan lain.");
  const [taken] = await tx
    .select({ id: posOrderTenders.id })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.edcTransactionId, row.id),
        ne(posOrderTenders.status, "voided"),
        ne(posOrderTenders.status, "failed"),
      ),
    )
    .limit(1);
  if (taken)
    throw new CoreError(
      "CONFLICT",
      "Transaksi EDC ini sudah dipakai untuk pembayaran.",
    );
  return {
    // A card-number-like value never becomes the tender reference.
    reference:
      [row.rrn, row.approvalCode, row.reference].find(
        (candidate): candidate is string =>
          !!candidate && !hasPanLengthDigits(candidate),
      ) ?? null,
    approvedBy: null,
  };
};
