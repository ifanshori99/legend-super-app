// Finance command "jurnalkan penerimaan <id>" (legend-7e0q4, founder Q20,
// docs/briefs/ws-purchasing-posting-design.md section 9).
//
// A supplier invoice or return over a goods receipt that has no
// `aj:goods-receipt:<id>` journal is refused (GOODS_RECEIPT_NOT_JOURNALED). A
// receipt recorded while the posting flag was off, or one parked
// AUTO_JOURNAL_PAYLOAD_INVALID, would stay stuck. This command rebuilds the
// `goods_receipt.recorded` event from the stored receipt and hands it to the
// auto-journal consumer: same rule, same idempotency key, same guards. It is
// idempotent (a posted receipt answers `already_posted`), and a successful
// post also clears the receipt's parked unreadable-payload rows.
//
// The guards (purchasing-invoice, purchase-return) are not touched: they keep
// accepting only the consumer's own journal.

import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  goodsReceiptValueIdr,
  PurchasingError,
  type GoodsReceiptJournalized,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { autoJournalParked } from "../db/schema/accounting-auto-journal.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { goodsReceipts } from "../db/schema/inventory-receiving.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { invalidEventKeyOf } from "./accounting-auto-journal-amounts.ts";
import { deliverAutoJournalEvent } from "./accounting-auto-journal-consumer.ts";
import {
  buildReceiptRecordedEvent,
  detailOf,
} from "./inventory-receiving.service.ts";
import {
  recordOpsAudit,
  ROUNDING_MODE,
  translateInventoryError,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  guardMoneyMath,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";
import { purchasingPostingEnabled } from "./purchasing-posting-gate.ts";

const AUDIT_FIELDS = ["number", "status", "journalEntryId"] as const;

/**
 * Parked rows of an earlier unreadable `goods_receipt.recorded` delivery of
 * this receipt. They sit under `aj:invalid:<eventId>`, a key no retry reaches,
 * so they are cleared once the receipt is journaled.
 */
async function clearUnreadableParkedRows(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  goodsReceiptId: string,
): Promise<void> {
  const emitted = await tx
    .select({ event: domainEventOutbox.event })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateType, "goods_receipt"),
        eq(domainEventOutbox.aggregateId, goodsReceiptId),
      ),
    );
  for (const { event } of emitted)
    await tx
      .delete(autoJournalParked)
      .where(
        and(
          eq(autoJournalParked.tenantId, tenantId),
          eq(autoJournalParked.idempotencyKey, invalidEventKeyOf(event.id)),
          eq(autoJournalParked.eventName, "goods_receipt.recorded"),
          eq(autoJournalParked.errorCode, "AUTO_JOURNAL_PAYLOAD_INVALID"),
        ),
      );
}

/**
 * POST journalize one goods receipt. The route gate is the tenant-wide
 * `accounting.journal.post`; another tenant's or an unknown receipt is a 404.
 * Refused: 409 SUPPLIER_INVOICE_POSTING_DISABLED while the posting flag or the
 * tenant accounting module is off (the consumer would ignore the event), 422 for
 * a receipt worth 0 (it books nothing), 409 GOODS_RECEIPT_JOURNAL_PARKED when
 * the consumer cannot post now (mapping, period, ...; nothing is written, the
 * message names the cause).
 */
export async function journalizeGoodsReceipt(
  context: ScopedTenantContext,
  actorUserId: string,
  goodsReceiptId: string,
): Promise<GoodsReceiptJournalized> {
  try {
    return await withTenant(db, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      const [row] = await tx
        .select()
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.tenantId, tenantId),
            eq(goodsReceipts.id, goodsReceiptId),
          ),
        );
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "Goods receipt not found.");
      if (!purchasingPostingEnabled()) throw postingDisabled();
      const { receipt, lines } = await detailOf(tx, row);
      const receivedValueIdr = guardMoneyMath(() =>
        goodsReceiptValueIdr(lines, ROUNDING_MODE),
      );
      if (receivedValueIdr === 0)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "A goods receipt worth 0 has nothing to journalize.",
        );
      const result = await deliverAutoJournalEvent(
        context,
        // Same parse the worker does on an outbox row: a JSON-typed envelope.
        eventEnvelopeSchema.parse(
          buildReceiptRecordedEvent(
            tenantId,
            receipt,
            lines.length,
            receivedValueIdr,
          ),
        ),
        tx,
      );
      // Tenant accounting module off: the consumer ignores the event.
      if (result.status === "ignored") throw postingDisabled();
      if (result.status === "parked")
        throw new HttpError(
          409,
          "GOODS_RECEIPT_JOURNAL_PARKED",
          `The goods receipt journal cannot be posted now (${result.code}).`,
        );
      await clearUnreadableParkedRows(tx, tenantId, receipt.id);
      // A repeat that books nothing writes no audit row.
      if (result.status === "posted")
        await recordOpsAudit(tx, context, {
          actorUserId,
          outletId: receipt.outletId,
          action: "accounting.goods_receipt_journalized",
          objectType: "goods_receipt",
          objectId: receipt.id,
          before: null,
          after: {
            number: receipt.number,
            status: result.status,
            journalEntryId: result.journalEntryId,
          },
          safeFields: AUDIT_FIELDS,
        });
      return {
        goodsReceiptId: receipt.id,
        status: result.status,
        journalEntryId: result.journalEntryId,
      };
    });
  } catch (error) {
    throw translatePurchasingError(translateInventoryError(error));
  }
}

function postingDisabled(): PurchasingError {
  return new PurchasingError(
    "SUPPLIER_INVOICE_POSTING_DISABLED",
    "Goods receipt journals are switched off for this tenant.",
  );
}
