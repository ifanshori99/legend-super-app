// The single period checkpoint for manual and recurring journals (bead
// legend-vmyg; ACC-02 "Transaksi di periode yang sudah ditutup ditolak").
//
// Every manual / recurring journal path (submit, approve, scheduled
// generation) calls `assertJournalPeriodPostable` before it touches the
// ledger. Today it delegates to the accounting core guard
// (`assertPeriodOpenForPosting`: locks the fiscal period row and refuses a
// closed month). The fiscal-close lock (branch ws/fiscal-close-lock) is wired
// HERE when that branch merges, so this module needs no other change.
// `postJournalInTransaction` re-checks the period on the same transaction, so
// the ledger never relies on this function alone.

import type { BusinessDate, ScopedTenantContext } from "@starter/shared/core";
import type { TenantTransaction } from "./accounting-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { assertPeriodOpenForPosting } from "./accounting-period.service.ts";

/** approval_requests.source_module of every chain this feature opens. */
export const JOURNAL_APPROVAL_SOURCE_MODULE = "accounting";
/** approval_requests.object_type for a manual journal. */
export const MANUAL_JOURNAL_OBJECT_TYPE = "manual_journal";
/** approval_requests.object_type for a recurring journal template. */
export const RECURRING_JOURNAL_OBJECT_TYPE = "recurring_journal";

/**
 * Throws PERIOD_CLOSED (or the core period errors) when a journal dated
 * `entryDate` may not post into its legal entity's fiscal period.
 */
export async function assertJournalPeriodPostable(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: { readonly legalEntityId: string; readonly entryDate: BusinessDate },
): Promise<void> {
  // Canonical lock order (legend-f250r): entity advisory lock, then the entity
  // row share and period row inside the core guard, then journal/template
  // rows. postJournalInTransaction takes the entity lock first for a petty
  // cash credit; a caller that gated the period first would deadlock with it.
  await entityLock(tx, context.tenant.tenantId, input.legalEntityId);
  await assertPeriodOpenForPosting(tx, context, {
    legalEntityId: input.legalEntityId,
    entryDate: input.entryDate,
  });
}
