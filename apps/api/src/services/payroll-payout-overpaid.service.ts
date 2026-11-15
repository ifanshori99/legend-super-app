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
// - The transfer fee of the late transfer is borne by the PT (Q15): its own
//   journal Dr bank_charges / Cr the source account, key
//   `payroll-payout-overpaid-fee:<itemId>`, in the same transaction, from the
//   fee stored with the item. Net pay and the receivable stay whole. A
//   deactivated source account or an unmapped bank charges role refuses 409.
// - Without another paid attempt the item stays `failed`: this is the other
//   incident (late success of the only attempt), which is not recorded here.
// - Exactly once: the run and batch are locked first (same order as every
//   payout step) and the item is read FOR UPDATE; a replay or a concurrent
//   call finds an item that is no longer `failed` and is refused. The journal
//   key and the unique `journal_key` of the posting are the second and third
//   guard. The database allows `failed -> overpaid` only while this code has
//   set `app.payout_overpaid` for its transaction (migration 0351).

import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { journalEntries } from "../db/schema/index.ts";
import {
  payrollDisbursementItems,
  payrollPayoutGlPostings,
} from "../db/schema/payroll-payout.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import type { Tx } from "./hris-access.ts";
import { lockJournalPending } from "./payroll-payout-gl.service.ts";
import { payrollEntryDateOf, payrollGlKeys } from "./payroll-gl-consumer.ts";
import {
  assertEvidenceKeyForBatchStored,
  type PayoutEvidenceStore,
} from "./payroll-payout-evidence.ts";
import {
  PAYOUT_BANK_CHARGES_MAPPING_MISSING,
  PAYOUT_SOURCE_ACCOUNT_MISSING,
  accountingEnabled,
  activeSourceGlAccount,
  frozenSourceGlAccount,
  assertActiveBankGlAccount,
  bankChargesMapped,
  settledSourceAccount,
} from "./payroll-payout-setup.ts";
import {
  loadBatchRunFirst,
  openItemAmount,
  openItemFee,
  payoutRefuse,
  payoutScope,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const overpaidJournalKey = (itemId: string) =>
  `payroll-payout-overpaid:${itemId}`;

export const overpaidFeeJournalKey = (itemId: string) =>
  `payroll-payout-overpaid-fee:${itemId}`;

/** Whole-rupiah fee stored with the item at export; a tampered value throws. */
function safeFee(item: Parameters<typeof openItemFee>[0]): number {
  const fee = Number(openItemFee(item));
  if (!Number.isSafeInteger(fee) || fee < 0)
    throw payoutRefuse(
      422,
      "PAYROLL_BANK_ACCOUNT_UNREADABLE",
      "Data pembayaran tidak bisa dibaca, jurnal tidak diposting.",
    );
  return fee;
}

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
  proofs: PayoutEvidenceStore,
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
  const note = input.note.trim();
  if (note === "" || note.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_NOTE_REQUIRED",
      "Catatan wajib diisi (maks 500 karakter).",
    );
  // Stored-proof check before the run and batch rows are locked: a storage
  // read must not hold them. Nothing is written before it passes.
  const evidence = await assertEvidenceKeyForBatchStored(
    proofs,
    { tenantId: actor.tenantId, batchId: peek.batchId },
    input.evidenceKey,
  );
  const batch = await loadBatchRunFirst(tx, actor.tenantId, peek.batchId);
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
  // The fee actually journaled (0 when nothing is journaled).
  let feeIdr = 0;

  // The locked journal is queued, not posted yet: only the fee would post and
  // the second transfer's net would never reach the GL. Wait for the consumer.
  if (await lockJournalPending(tx, tenantId, item.payrollRunId))
    throw payoutRefuse(
      409,
      "PAYOUT_LOCK_JOURNAL_PENDING",
      "Jurnal kunci payroll belum diposting, coba lagi setelah diproses.",
    );

  // Like the settle: a run without a locked journal has no salary side, the
  // item is still recorded. The fee is journaled when the run has a locked
  // journal or accounting is on, exactly like the settle, so it never vanishes.
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
  const feeOnly =
    !locked && safeFee(item) > 0 && (await accountingEnabled(tx, tenantId));
  if (locked || feeOnly) {
    // Credit the account frozen on this batch (legend-hkh57), never the config
    // of today. A batch from before the freeze falls back to the account its
    // settle journal used; without one it is refused.
    let sourceAccountId: string;
    if (batch.sourceBankAccountId !== null) {
      sourceAccountId = (await frozenSourceGlAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        batch.sourceBankAccountId,
      ))!;
    } else {
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
      // No frozen account and no settle journal to copy it from: the batch is
      // from before the freeze and finished. Today's config is not its
      // account, so the most restrictive rule applies: refuse (409).
      if (!settled)
        throw payoutRefuse(
          409,
          PAYOUT_SOURCE_ACCOUNT_MISSING.code,
          PAYOUT_SOURCE_ACCOUNT_MISSING.message,
        );
      // The configured account must be active. A settled account is not the
      // config, so it is checked on its own: a batch settled from an account
      // since replaced and deactivated refuses the report (409).
      await activeSourceGlAccount(tx, tenantId, batch.legalEntityId);
      sourceAccountId = await settledSourceAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        settled.journalKey,
      );
    }
    await assertActiveBankGlAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      sourceAccountId,
    );
    // The transfer fee is real money the PT paid for the second transfer (Q15,
    // same stored value as the settle). Unmapped bank charges fail closed.
    feeIdr = safeFee(item);
    if (
      feeIdr > 0 &&
      !(await bankChargesMapped(tx, tenantId, batch.legalEntityId))
    )
      throw payoutRefuse(
        409,
        PAYOUT_BANK_CHARGES_MAPPING_MISSING.code,
        PAYOUT_BANK_CHARGES_MAPPING_MISSING.message,
      );
    const context = payoutScope(actor.tenantId);
    const entryDate = payrollEntryDateOf(now.toISOString());
    if (locked)
      await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "payroll.paid",
          variant: "payout_overpaid",
          amounts: { netIdr },
          legalEntityId: batch.legalEntityId,
          outletId: null,
          entryDate,
          sourceId: batch.payrollRunId,
          postedBy: null,
          idempotencyKey: journalKey,
          accountOverrides: { bank: sourceAccountId },
        },
        now,
      );
    if (feeIdr > 0)
      await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "payroll.paid",
          variant: "payout_fee",
          amounts: { feeIdr },
          legalEntityId: batch.legalEntityId,
          outletId: null,
          entryDate,
          sourceId: batch.payrollRunId,
          postedBy: null,
          idempotencyKey: overpaidFeeJournalKey(item.id),
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
      JSON.stringify({ netIdr, feeIdr, itemCount: 1 }),
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
