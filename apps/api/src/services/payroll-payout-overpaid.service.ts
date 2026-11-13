// Payroll payout: an attempt turns out paid twice (bead legend-qxkm6; design
// docs/design/payroll-disbursement.md 5.2, 7.9, 8). Kept apart from
// payroll-payout-gl.service.ts, which re-exports it.
//
// Money rules held here (nobody is paid twice without the PT noticing):
// - A `failed` attempt whose payslip already has another `succeeded` attempt
//   and then turns out to have reached the employee becomes `overpaid`. It is
//   not a payment: no attempt, batch or payslip status is created or changed,
//   the settle journal of the paid attempt stays whole and the run stays paid.
// - The PT is owed the money back: one journal Dr employee_receivable /
//   Cr the source account, key `payroll-payout-overpaid:<itemId>`, one
//   `overpaid` posting row, and the item linked to it, all in one transaction.
// - Without another paid attempt the item stays `failed`: this is the other
//   incident (late success of the only attempt), which is not recorded here.
// - Exactly once: the run and batch are locked first (same order as every
//   payout step) and the item is read FOR UPDATE; a replay or a concurrent
//   call finds an item that is no longer `failed` and is refused. The journal
//   key and the unique `journal_key` of the posting are the second and third
//   guard. The database allows `failed -> overpaid` only while this code has
//   set `app.payout_overpaid` for its transaction (migration 0543).

import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import { journalEntries } from "../db/schema/index.ts";
import {
  payrollDisbursementItems,
  payrollPayoutConfigs,
  payrollPayoutGlPostings,
} from "../db/schema/payroll-payout.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import type { Tx } from "./hris-access.ts";
import { payrollEntryDateOf, payrollGlKeys } from "./payroll-gl-consumer.ts";
import { assertEvidenceKeyForBatch } from "./payroll-payout-evidence.ts";
import { settledSourceAccount } from "./payroll-payout-setup.ts";
import {
  loadBatchRunFirst,
  openItemAmount,
  payoutRefuse,
  payoutScope,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const overpaidJournalKey = (itemId: string) =>
  `payroll-payout-overpaid:${itemId}`;

export type OverpaidInput = { evidenceKey: string; note: string };

/**
 * Records a late transfer of a `failed` item whose payslip was paid by another
 * attempt. `batchId` is the batch of the failed item. Throws 4xx and changes
 * nothing when the item is not `failed` or its payslip has no other paid
 * attempt.
 */
export async function recordOverpaidItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: OverpaidInput,
  now = new Date(),
): Promise<{ postingId: string; journalKey: string }> {
  const tenantId = actor.tenantId as TenantId;
  if (!UUID.test(itemId))
    throw payoutRefuse(422, "PAYOUT_ITEMS_INVALID", "ID item tidak valid.");
  const [peek] = await tx
    .select({ batchId: payrollDisbursementItems.batchId })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.id, itemId),
      ),
    )
    .limit(1);
  if (!peek)
    throw payoutRefuse(404, "PAYOUT_ITEM_NOT_FOUND", "Item tidak ditemukan.");
  const batch = await loadBatchRunFirst(tx, actor.tenantId, peek.batchId);
  const note = input.note.trim();
  if (note === "" || note.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_NOTE_REQUIRED",
      "Catatan wajib diisi (maks 500 karakter).",
    );
  const evidence = assertEvidenceKeyForBatch(
    { tenantId: actor.tenantId, batchId: batch.id },
    input.evidenceKey,
  );
  if (batch.channel !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Pembayaran ganda hanya bisa dicatat untuk transfer bank manual.",
    );

  const [item] = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        eq(payrollDisbursementItems.id, itemId),
      ),
    )
    .for("update");
  if (!item)
    throw payoutRefuse(404, "PAYOUT_ITEM_NOT_FOUND", "Item tidak ditemukan.");
  if (item.status !== "failed")
    throw payoutRefuse(
      409,
      "PAYOUT_ITEM_NOT_OVERPAYABLE",
      "Hanya item gagal yang bisa dicatat sebagai pembayaran ganda.",
    );
  const [paid] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.payslipId, item.payslipId),
        ne(payrollDisbursementItems.id, item.id),
        eq(payrollDisbursementItems.status, "succeeded"),
      ),
    )
    .limit(1);
  if (!paid)
    throw payoutRefuse(
      409,
      "PAYOUT_ITEM_NOT_OVERPAYABLE",
      "Slip ini belum punya pembayaran lain yang berhasil, jadi bukan pembayaran ganda.",
    );

  const netIdr = Number(openItemAmount(item));
  if (!Number.isSafeInteger(netIdr) || netIdr <= 0)
    throw payoutRefuse(
      422,
      "PAYROLL_BANK_ACCOUNT_UNREADABLE",
      "Data pembayaran tidak bisa dibaca, jurnal tidak diposting.",
    );
  const journalKey = overpaidJournalKey(item.id);

  // Like the settle: a run without a locked journal has no ledger side, the
  // item is still recorded.
  const [locked] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(
          journalEntries.idempotencyKey,
          payrollGlKeys.locked(item.payrollRunId),
        ),
      ),
    )
    .limit(1);
  if (locked) {
    // Credit the account the settle journal of this batch used; the config is
    // only the fallback when the batch has no settle journal.
    const [settled] = await tx
      .select({ journalKey: payrollPayoutGlPostings.journalKey })
      .from(payrollPayoutGlPostings)
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          eq(payrollPayoutGlPostings.batchId, batch.id),
          eq(payrollPayoutGlPostings.kind, "settle"),
        ),
      )
      .orderBy(payrollPayoutGlPostings.postedAt)
      .limit(1);
    let sourceAccountId: string | undefined;
    if (settled) {
      sourceAccountId = await settledSourceAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        settled.journalKey,
      );
    } else {
      const [source] = await tx
        .select({ glAccountId: bankAccounts.glAccountId })
        .from(payrollPayoutConfigs)
        .innerJoin(
          bankAccounts,
          and(
            eq(bankAccounts.tenantId, payrollPayoutConfigs.tenantId),
            eq(bankAccounts.legalEntityId, payrollPayoutConfigs.legalEntityId),
            eq(bankAccounts.id, payrollPayoutConfigs.manualSourceBankAccountId),
          ),
        )
        .where(
          and(
            eq(payrollPayoutConfigs.tenantId, tenantId),
            eq(payrollPayoutConfigs.legalEntityId, batch.legalEntityId),
          ),
        )
        .limit(1);
      if (!source)
        throw payoutRefuse(
          409,
          "PAYOUT_SOURCE_ACCOUNT_MISSING",
          "Rekening sumber pembayaran gaji PT ini tidak ditemukan, pembayaran ganda belum bisa dijurnal.",
        );
      sourceAccountId = source.glAccountId;
    }
    await postJournalFromRuleInTransaction(
      tx,
      payoutScope(actor.tenantId),
      {
        eventName: "payroll.paid",
        variant: "payout_overpaid",
        amounts: { netIdr },
        legalEntityId: batch.legalEntityId,
        outletId: null,
        entryDate: payrollEntryDateOf(now.toISOString()),
        sourceId: batch.payrollRunId,
        postedBy: null,
        idempotencyKey: journalKey,
        accountOverrides: { bank: sourceAccountId },
      },
      now,
    );
  }

  const postingId = randomUUID();
  await tx.insert(payrollPayoutGlPostings).values({
    id: postingId,
    tenantId,
    batchId: batch.id,
    kind: "overpaid",
    itemSetHash: createHash("sha256").update(item.id).digest("hex"),
    journalKey,
    totalEncrypted: sealPayrollValue(
      JSON.stringify({ netIdr, feeIdr: 0, itemCount: 1 }),
      {
        tenantId,
        table: "payroll_payout_gl_postings",
        rowId: postingId,
        field: "total",
      },
      PAYROLL_SEAL_KEY_VERSION,
    ),
    piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
    postedAt: now,
  });
  // The database allows failed -> overpaid only inside this transaction.
  await tx.execute(sql`SELECT set_config('app.payout_overpaid', 'on', true)`);
  const moved = await tx
    .update(payrollDisbursementItems)
    .set({ status: "overpaid", glPostingId: postingId, updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.id, item.id),
        eq(payrollDisbursementItems.status, "failed"),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  await tx.execute(sql`SELECT set_config('app.payout_overpaid', 'off', true)`);
  if (moved.length !== 1)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status item berubah saat diproses. Coba lagi.",
    );
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.item_overpaid",
    objectType: "payroll_disbursement_item",
    objectId: item.id,
    reason: note,
    before: { status: "failed" },
    after: { status: "overpaid", evidenceKey: evidence, netIdr },
  });
  return { postingId, journalKey };
}
