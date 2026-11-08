// Approver re-check for manual / recurring journals (bead legend-vmyg; AUTH-06,
// §3 F7 "Kotak Approval").
//
// An approval chain can be decided in the inbox by anyone holding a matrix
// role for `manual_journal`. Before the effect reaches the ledger, the final
// approver must ALSO hold `accounting.journal.post` over the journal's scope:
// the tenant for an entity-level journal (outletId null), else its outlet.
// Read on the caller's transaction, so the decision and the write see one
// access snapshot. Deny by default: no assignment, no permission.

import type { ScopedTenantContext } from "@starter/shared/core";
import type { TenantTransaction } from "./accounting-shared.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";

export const JOURNAL_APPROVE_PERMISSION = "accounting.journal.post";

/**
 * True when `userId` may post the journal: `accounting.journal.post` over the
 * header outlet (tenant-wide when null) AND over every outlet a line books to
 * (outlet P&L, ACC-03), so an outlet-scoped approver cannot post into another
 * outlet through a line.
 */
export async function approverMayPostJournal(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  userId: string,
  journal: {
    readonly outletId: string | null;
    readonly lines: readonly { readonly outletId: string | null }[];
  },
  now: Date,
): Promise<boolean> {
  const data = await loadTenantAccessInTransaction(tx, context, userId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId,
    ...data,
    mfaVerified: false,
    now,
  });
  const outlets = new Set<string | null>([journal.outletId]);
  for (const line of journal.lines) outlets.add(line.outletId);
  for (const outletId of outlets)
    if (
      !snapshot.allows(
        JOURNAL_APPROVE_PERMISSION,
        outletId === null
          ? { type: "tenant" }
          : { type: "outlet", id: outletId },
      )
    )
      return false;
  return true;
}
