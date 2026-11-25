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
// - The cash & bank entity lock is taken before the UPDATE, so a reversal and
//   an automatic match insert of the same entity run one after the other. The
//   caller already holds the journal row lock; the matching paths only read
//   journals (no row lock), so the order journal row, then entity lock cannot
//   cycle. The atomic UPDATE on the match row stays the idempotency guard.
// - The case never fails the reversal: the owner is the person who matched
//   (`matched_by`, who holds accounting.reconcile) and no role check runs.

import { and, eq, isNull, or } from "drizzle-orm";
import {
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  bankReconciliationCaseEvents,
  bankReconciliationCases,
  bankStatementLineMatches,
} from "../db/schema/accounting-cash-bank.ts";
import { paymentSettlements } from "../db/schema/payment-settlement.ts";
import { HttpError } from "../lib/http-error.ts";
import { auditApFa } from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { loadReconciliationPolicyInTx } from "./accounting-finance-policy.service.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

const DAY_MS = 86_400_000;
const SETTLEMENT_SOURCE = "gateway_settlement";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 1269 C4a (legend-osqou.42): a settlement journal that carries a fee is never
 * reversed by hand; reversing it would also erase the fee expense, so any
 * correction goes through a manual journal. Anything in doubt (no readable
 * report, a fee) refuses.
 */
export async function assertSettlementJournalReversibleByHand(
  tx: TenantTransaction,
  tenantId: TenantId,
  journal: { sourceType: string; sourceId: string | null },
): Promise<void> {
  if (journal.sourceType !== SETTLEMENT_SOURCE) return;
  const [report] =
    journal.sourceId !== null && UUID.test(journal.sourceId)
      ? await tx
          .select({ feeIdr: paymentSettlements.feeIdr })
          .from(paymentSettlements)
          .where(
            and(
              eq(paymentSettlements.tenantId, tenantId),
              eq(paymentSettlements.id, journal.sourceId),
            ),
          )
      : [];
  if (!report || report.feeIdr !== 0)
    throw new HttpError(
      409,
      "SETTLEMENT_JOURNAL_LOCKED",
      "Jurnal settlement gateway ber-fee tidak dapat dibalik; koreksi lewat jurnal manual.",
    );
}

export async function markMatchStaleForReversedJournal(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    legalEntityId: string;
    outletId: string | null;
    journalEntryId: string;
    /** The reversed journal's source: a settlement journal stales its settlement match. */
    sourceType: string;
    sourceId: string | null;
    reversalEntryId: string;
    reversedBy: UserId | null;
    reason: string;
  },
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await entityLock(tx, tenantId, input.legalEntityId);
  // A settlement is matched as itself (`gateway_settlement`), not as its journal.
  const settlementId =
    input.sourceType === SETTLEMENT_SOURCE &&
    input.sourceId !== null &&
    UUID.test(input.sourceId)
      ? input.sourceId
      : null;
  const staled = await tx
    .update(bankStatementLineMatches)
    .set({ staleAt: now, staleByReversalEntryId: input.reversalEntryId })
    .where(
      and(
        eq(bankStatementLineMatches.tenantId, tenantId),
        or(
          and(
            eq(bankStatementLineMatches.refType, "journal_entry"),
            eq(bankStatementLineMatches.refId, input.journalEntryId),
          ),
          settlementId === null
            ? undefined
            : and(
                eq(bankStatementLineMatches.refType, SETTLEMENT_SOURCE),
                eq(bankStatementLineMatches.refId, settlementId),
              ),
        ),
        isNull(bankStatementLineMatches.staleAt),
      ),
    )
    .returning();
  if (staled.length === 0) return;
  const caseOutletId =
    input.outletId === null ? null : outletIdSchema.parse(input.outletId);
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
    const ownerId = match.matchedBy;
    const [opened] = await tx
      .insert(bankReconciliationCases)
      .values({
        tenantId,
        legalEntityId: input.legalEntityId,
        outletId: caseOutletId,
        type: "bank_statement",
        differenceIdr: match.amountIdr,
        ownerId,
        status: "open",
        dueAt: new Date(now.getTime() + caseDueDays * DAY_MS),
        refs: [
          ...(match.refType === SETTLEMENT_SOURCE
            ? [{ type: "gateway_settlement" as const, id: match.refId }]
            : []),
          { type: "journal_entry", id: input.journalEntryId },
        ],
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
