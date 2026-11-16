// Stale bank match when its journal is reversed (bead legend-fnxl.10, WS-07;
// PRD v1.7 §3.19 Kas & Bank, ACC-04 "setiap selisih menjadi kasus dengan PIC").
//
// Called from `reverseJournalInTransaction`, after the reversal is inserted and
// in the same transaction. A `journal_entry` match of the reversed journal is
// kept (never deleted, amount untouched) but marked stale, and one open
// reconciliation case of type `bank_statement` is opened so a person decides.
// The type is reused on purpose: the case type CHECK, the shared contract and
// the web labels stay as they are; the ref (`journal_entry`) says what it is.
//
// - Idempotent: only a live match (`stale_at IS NULL`) turns stale, and only
//   that turn opens a case, so a retry or a second call never doubles it.
// - No entity lock here: the caller already holds the journal row lock, and the
//   cash & bank entity lock comes first in every other writer. The atomic
//   UPDATE on the match row is the guard.
// - The case never fails the reversal: the owner is the reverser (the matcher
//   for a system reversal) and no role check runs.

import { and, eq, isNull } from "drizzle-orm";
import { type ScopedTenantContext, type UserId } from "@starter/shared/core";
import {
  bankReconciliationCaseEvents,
  bankReconciliationCases,
  bankStatementLineMatches,
} from "../db/schema/accounting-cash-bank.ts";
import { auditApFa } from "./accounting-ap-fa-shared.ts";
import { loadReconciliationPolicyInTx } from "./accounting-finance-policy.service.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

const DAY_MS = 86_400_000;

export async function markMatchStaleForReversedJournal(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    legalEntityId: string;
    outletId: string | null;
    journalEntryId: string;
    reversalEntryId: string;
    reversedBy: UserId | null;
    reason: string;
  },
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const staled = await tx
    .update(bankStatementLineMatches)
    .set({ staleAt: now, staleByReversalEntryId: input.reversalEntryId })
    .where(
      and(
        eq(bankStatementLineMatches.tenantId, tenantId),
        eq(bankStatementLineMatches.refType, "journal_entry"),
        eq(bankStatementLineMatches.refId, input.journalEntryId),
        isNull(bankStatementLineMatches.staleAt),
      ),
    )
    .returning();
  if (staled.length === 0) return;
  const { caseDueDays } = await loadReconciliationPolicyInTx(tx, tenantId);
  for (const match of staled) {
    await auditApFa(tx, context, {
      actorId: input.reversedBy,
      action: "accounting.bank_statement_match.stale",
      objectType: "bank_statement_line",
      objectId: match.lineId,
      outletId: input.outletId,
      reason: input.reason,
      before: { stale: false },
      after: {
        stale: true,
        journalEntryId: input.journalEntryId,
        reversalEntryId: input.reversalEntryId,
      },
    });
    // The case needs a signed, non-zero difference; a match is never zero.
    if (match.amountIdr === 0) continue;
    const ownerId = input.reversedBy ?? match.matchedBy;
    const [opened] = await tx
      .insert(bankReconciliationCases)
      .values({
        tenantId,
        legalEntityId: input.legalEntityId,
        outletId: input.outletId,
        type: "bank_statement",
        differenceIdr: match.amountIdr,
        ownerId,
        status: "open",
        dueAt: new Date(now.getTime() + caseDueDays * DAY_MS),
        refs: [{ type: "journal_entry", id: input.journalEntryId }],
        openedBy: ownerId,
        openedAt: now,
      })
      .returning();
    if (!opened) throw new Error("Reconciliation case insert returned no row");
    await tx.insert(bankReconciliationCaseEvents).values({
      tenantId,
      caseId: opened.id,
      seq: 1,
      action: "open",
      actorId: ownerId,
      fromStatus: null,
      toStatus: "open",
      fromOwnerId: null,
      toOwnerId: ownerId,
      note: null,
      at: now,
    });
    await auditApFa(tx, context, {
      actorId: input.reversedBy,
      action: "accounting.reconciliation_case.opened",
      objectType: "reconciliation_case",
      objectId: opened.id,
      outletId: input.outletId,
      before: null,
      after: { status: "open", count: 1, source: "journal_reversed" },
    });
  }
}
