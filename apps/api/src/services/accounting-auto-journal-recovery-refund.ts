// Auto-journal reversal of a rejected recovery refund (legend-94q2l, putaran 4).
// A `system:recovery` refund of a failed QR pay-first item ended `rejected`, so
// the money never left: payment-admin emits
// `order_issue.refund_reversal_requested` and the `aj:order-refund:<issueId>`
// journal (booked by order.refunded) is reversed, never re-derived, like
// order.voided reverses its sale (accounting-auto-journal-void.ts).
//
// The refund journal is a fact that may not exist yet (order.refunded still in
// the outbox or parked retryable): the reversal waits retryably. When it never
// posted, or finance already reversed it (state "none"), there is nothing to
// reverse: ignored.

import type { ScopedTenantContext } from "@starter/shared/core";
import {
  boundedKey,
  orderIssueRefundReversalStoredSchema,
  type StoredAutoJournalEvent,
} from "./accounting-auto-journal-amounts.ts";
import {
  backingStateOf,
  postedEntryIdOf,
} from "./accounting-auto-journal-guards.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

/** The reversal met its refund before the refund journal posted: parked retryable. */
export class AutoJournalRecoveryRefundPending extends Error {
  readonly code = "AUTO_JOURNAL_RECOVERY_REFUND_PENDING";
}

export type AutoJournalRecoveryRefundFact = {
  /** The refund journal the consumer reverses. */
  readonly refundEntryId: string;
  readonly sourceId: string;
  readonly outletId: string;
  readonly moneyTime: Date;
};

/**
 * Reversal input of one stored `order_issue.refund_reversal_requested` event,
 * or null when there is no live refund journal to reverse.
 */
export async function recoveryRefundFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalRecoveryRefundFact | null> {
  const p = orderIssueRefundReversalStoredSchema.parse(stored.payload);
  const state = await backingStateOf(tx, tenantId, {
    kind: "qrRefund",
    refundId: p.orderIssueId,
  });
  if (state === "pending")
    throw new AutoJournalRecoveryRefundPending(
      "Refund journal is not posted yet",
    );
  // "none": never posted, or finance already reversed it.
  if (state === "none") return null;
  const refundEntryId = await postedEntryIdOf(
    tx,
    tenantId,
    boundedKey(`aj:order-refund:${p.orderIssueId}`),
  );
  // Posted per the state, yet not readable by key: the sweep re-reads it.
  if (refundEntryId === null)
    throw new AutoJournalRecoveryRefundPending(
      "Refund journal entry not found",
    );
  return {
    refundEntryId,
    sourceId: p.orderIssueId,
    outletId: stored.outletId,
    moneyTime: new Date(p.rejectedAt),
  };
}
