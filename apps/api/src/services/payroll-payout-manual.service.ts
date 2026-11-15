// Payroll disbursement, manual bank channel and cash handover (bead
// legend-wnkep.1; design docs/design/payroll-disbursement.md 5.2, 6 R5, R10,
// R14, R15, 7.7, 7.9; founder Q15-Q17).
//
// Trusted in-transaction writers: the caller wraps `withTenant`, a throw rolls
// back everything. Money rules held here (the database triggers of migration
// 0344 are the net):
// - The bank file comes out ONCE (R14). The compare-and-set `approved ->
//   exported` of the batch and its items commits in the same transaction that
//   returns the content, so a second caller, or a lost response, never gets a
//   second copy. Only the SHA-256 checksum is kept, never the file.
// - Rows of the file come only from `payslip_bank_snapshots` (frozen at lock),
//   never from the employee's current account. Amounts are the sealed net pay
//   of the item, paid in full; the bank fee is borne by the company (Q15).
// - Export re-checks the per-PT `enabled` switch (R15), the 24 hour approval
//   window and the content hash the approver saw.
// - The requester of a batch never confirms a result (R5, also a trigger).
// - One non-requester may only confirm `succeeded` (with a bank reference). An
//   exported item moves to `failed` or `not_sent` (which frees its slip for a
//   new batch) only when TWO different non-requesters give the same outcome and
//   evidence (`resolveManualItems`, also a database trigger): one person alone
//   can never make a paid slip payable again.
// - A run turns `paid` only when every payslip with net pay above zero has a
//   succeeded item (R10). The transition sets `app.payout_settle` for its own
//   statement only. `paid_by` is the last approver of the batch (CTO 14 Nov);
//   the person who confirmed stays on the item (`confirmed_by`).
// - Every confirmed item is journaled exactly once by `settleBatchPayouts` in
//   the same transaction (payroll-payout-gl.service.ts), and a run that turned
//   paid emits `payroll.paid` with `settledPerItem: true` (legend-658).
// - A paid item whose funds come back moves `succeeded -> returned` only after
//   two different non-requesters agree (`returnManualItems`); the return is
//   journaled once.
// - A payment-proof key must name an object of this tenant's batch folder
//   (`assertEvidenceKeyForBatchStored`) and must exist in the storage, checked
//   before any row is written. The second resolve step must carry the same key
//   as the first.
//
// Lock order: the run row, then the batch row (`loadBatchRunFirst`), same as
// create, submit and approve. Account numbers are never
// logged and never put in an error.

import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import type { PayrollRunId } from "@starter/shared/hris/payroll";
import {
  payrollRuns,
  payslipBankSnapshots,
  payslips,
} from "../db/schema/payroll.ts";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
  payrollPayoutConfigs,
  payrollPayoutReturnClaims,
} from "../db/schema/payroll-payout.ts";
import {
  getBankFormatter,
  type BankFileRow,
} from "../lib/payroll-export/bank-formats.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import type { Tx } from "./hris-access.ts";
import { openPayeeBankSnapshot } from "./payroll-bank-snapshot.service.ts";
import {
  emitPayoutRunPaid,
  postPayoutReturn,
  settleBatchPayouts,
} from "./payroll-payout-gl.service.ts";
import {
  assertEvidenceKeyForBatchStored,
  assertOptionalEvidenceKeyForBatchStored,
  type PayoutEvidenceStore,
} from "./payroll-payout-evidence.ts";
import {
  accountingEnabled,
  assertManualPayoutSetup,
  configuredSourceBankAccountId,
  frozenSourceGlAccount,
} from "./payroll-payout-setup.ts";
import {
  computeBatchContentHash,
  loadBatchRunFirst,
  openItemAmount,
  payoutRefuse,
  recordPayoutAudit,
  type BatchRow,
  type ItemRow,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type ManualExportFile = {
  filename: string;
  contentType: string;
  content: string;
  checksumSha256: string;
};

export type ManualConfirmInput = {
  results: {
    itemId: string;
    result: "succeeded";
    bankRef?: string | null;
    evidenceKey?: string | null;
  }[];
};

export type ManualResolveInput = {
  itemIds: string[];
  outcome: "failed" | "not_sent";
  evidenceKey: string;
  note: string;
};

export type ManualReturnInput = {
  itemIds: string[];
  evidenceKey: string;
  note: string;
};

export type CashHandoverInput = {
  itemIds: string[];
  evidenceKey?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = payoutRefuse;

// ------------------------------------------------------------------- helpers

async function auditBatch(
  tx: Tx,
  actor: Actor,
  action: string,
  batch: Pick<BatchRow, "id">,
  before: Record<string, string | number | null>,
  after: Record<string, string | number | null>,
): Promise<void> {
  await recordPayoutAudit(tx, actor, {
    action,
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    before,
    after,
  });
}

// ---------------------------------------------------------------- bank export

/**
 * The one and only bank file of an approved manual batch. Moves the batch and
 * its approved items to `exported` BEFORE returning the content, in the same
 * transaction; a second call is 409 PAYOUT_EXPORT_ALREADY_DOWNLOADED.
 */
export async function exportManualBatch(
  tx: Tx,
  actor: Actor,
  batchId: string,
  now = new Date(),
): Promise<ManualExportFile> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan transfer bank manual.",
    );
  if (batch.exportedAt !== null || batch.status === "exported")
    throw refuse(
      409,
      "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
      "Berkas transfer bank batch ini sudah pernah diunduh dan tidak bisa diunduh lagi.",
    );
  if (batch.status !== "approved")
    throw refuse(
      409,
      "PAYOUT_BATCH_NOT_APPROVED",
      "Batch belum disetujui, jadi berkas transfer belum bisa dibuat.",
    );
  if (
    batch.approvalExpiresAt === null ||
    batch.approvalExpiresAt.getTime() <= now.getTime()
  )
    throw refuse(
      409,
      "PAYOUT_APPROVAL_EXPIRED",
      "Persetujuan batch sudah lewat 24 jam. Batalkan batch dan buat yang baru.",
    );

  // R15: the PT switch is read now, not at approval.
  const [config] = await tx
    .select()
    .from(payrollPayoutConfigs)
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, tenantId),
        eq(payrollPayoutConfigs.legalEntityId, batch.legalEntityId),
      ),
    );
  if (!config || !config.enabled || config.method !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CONFIG_DISABLED",
      "Pembayaran gaji manual untuk PT ini sedang dimatikan.",
    );
  // Fail closed (legend-8codi): the one download is not spent while the fee or
  // the source account cannot be journaled.
  await assertManualPayoutSetup(tx, tenantId, batch.legalEntityId);
  // The account frozen at approve must still be usable (legend-hkh57); a batch
  // approved before the freeze existed is frozen now, with the config account.
  let sourceBankAccountId = batch.sourceBankAccountId;
  if (sourceBankAccountId === null)
    sourceBankAccountId = await configuredSourceBankAccountId(
      tx,
      tenantId,
      batch.legalEntityId,
    );
  else if (await accountingEnabled(tx, tenantId))
    await frozenSourceGlAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      sourceBankAccountId,
    );

  const [run] = await tx
    .select({
      id: payrollRuns.id,
      periodEnd: payrollRuns.periodEnd,
      payDate: payrollRuns.payDate,
      legalEntityId: payrollRuns.legalEntityId,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, batch.payrollRunId),
      ),
    );
  if (!run || run.legalEntityId !== batch.legalEntityId)
    throw refuse(
      409,
      "PAYOUT_RUN_MISMATCH",
      "Payroll batch ini tidak cocok dengan data batch.",
    );

  const items = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        eq(payrollDisbursementItems.status, "approved"),
      ),
    )
    .orderBy(
      asc(payrollDisbursementItems.createdAt),
      asc(payrollDisbursementItems.id),
    );
  if (items.length === 0 || items.length !== batch.itemCount)
    throw refuse(
      409,
      "PAYOUT_HASH_MISMATCH",
      "Isi batch berubah sejak disetujui. Batalkan batch dan buat yang baru.",
    );

  // Frozen payee data, one snapshot per item.
  const snapshotIds = items.map((item) => item.bankSnapshotId);
  const snapshots = await tx
    .select({
      id: payslipBankSnapshots.id,
      tenantId: payslipBankSnapshots.tenantId,
      payslipId: payslipBankSnapshots.payslipId,
      snapshotEncrypted: payslipBankSnapshots.snapshotEncrypted,
      piiKeyVersion: payslipBankSnapshots.piiKeyVersion,
    })
    .from(payslipBankSnapshots)
    .where(
      and(
        eq(payslipBankSnapshots.tenantId, tenantId),
        inArray(
          payslipBankSnapshots.id,
          snapshotIds.filter((id): id is string => id !== null),
        ),
      ),
    );
  const snapshotById = new Map(snapshots.map((row) => [row.id, row]));

  const amounts = new Map<string, number>();
  const rows: BankFileRow[] = [];
  for (const item of items) {
    const snapshot = item.bankSnapshotId
      ? snapshotById.get(item.bankSnapshotId)
      : undefined;
    if (!snapshot || snapshot.payslipId !== item.payslipId)
      throw refuse(
        422,
        "PAYROLL_BANK_SNAPSHOT_MISSING",
        "Rekening tujuan gaji belum dibekukan saat payroll dikunci, sehingga berkas transfer tidak bisa dibuat.",
      );
    let amountIdr: number;
    let payee: ReturnType<typeof openPayeeBankSnapshot>;
    try {
      amountIdr = openItemAmount(item);
      payee = openPayeeBankSnapshot(snapshot);
    } catch {
      // The error may carry a number or an account: say nothing about it.
      throw refuse(
        422,
        "PAYROLL_BANK_ACCOUNT_UNREADABLE",
        "Data pembayaran tidak bisa dibaca, berkas tidak bisa dibuat.",
      );
    }
    amounts.set(item.id, amountIdr);
    rows.push({
      employeeId: item.employeeId,
      employeeCode: payee.employeeCode,
      employeeName: payee.employeeName,
      bankName: payee.bankName,
      accountNumber: payee.accountNumber,
      accountHolder: payee.accountHolder,
      amountIdr,
      bankCode: item.bankCode,
    });
  }

  // The hash the approver saw must still describe exactly these items.
  const hash = computeBatchContentHash(
    items.map((item) => ({
      payslipId: item.payslipId,
      amountIdr: amounts.get(item.id)!,
      bankSnapshotId: item.bankSnapshotId,
      bankCode: item.bankCode,
    })),
  );
  if (batch.contentHash === null || hash !== batch.contentHash)
    throw refuse(
      409,
      "PAYOUT_HASH_MISMATCH",
      "Isi batch berubah sejak disetujui. Batalkan batch dan buat yang baru.",
    );

  rows.sort(
    (a, b) =>
      a.employeeCode.localeCompare(b.employeeCode) ||
      a.employeeId.localeCompare(b.employeeId),
  );
  const formatter = getBankFormatter(
    (batch.bankFormat ?? config.manualBankFormat) as Parameters<
      typeof getBankFormatter
    >[0],
  );
  const periodLabel = run.periodEnd.slice(0, 7);
  const content = formatter.render(rows, {
    payrollRunId: run.id,
    periodLabel,
    payDate: run.payDate,
  });
  const checksumSha256 = createHash("sha256").update(content).digest("hex");

  // Compare-and-set BEFORE the content leaves this function. A parallel call
  // already waited on the row lock above and saw `exported`; the WHERE is the
  // second guard.
  const moved = await tx
    .update(payrollDisbursementBatches)
    .set({
      status: "exported",
      exportedBy: actor.userId as UserId,
      exportedAt: now,
      exportChecksumSha256: checksumSha256,
      sourceBankAccountId,
      updatedAt: now,
    })
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenantId),
        eq(payrollDisbursementBatches.id, batch.id),
        eq(payrollDisbursementBatches.status, "approved"),
      ),
    )
    .returning({ id: payrollDisbursementBatches.id });
  if (moved.length !== 1)
    throw refuse(
      409,
      "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
      "Berkas transfer bank batch ini sudah pernah diunduh dan tidak bisa diunduh lagi.",
    );
  const movedItems = await tx
    .update(payrollDisbursementItems)
    .set({ status: "exported", updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(
          payrollDisbursementItems.id,
          items.map((item) => item.id),
        ),
        eq(payrollDisbursementItems.status, "approved"),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  if (movedItems.length !== items.length)
    throw refuse(
      409,
      "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
      "Berkas transfer bank batch ini sudah pernah diunduh dan tidak bisa diunduh lagi.",
    );
  await auditBatch(
    tx,
    actor,
    "payroll.disbursement.exported",
    batch,
    { status: "approved" },
    { status: "exported", itemCount: items.length },
  );
  return {
    filename: `payroll-bank-${periodLabel}-${batch.id.slice(0, 8)}.${formatter.extension}`,
    contentType: formatter.contentType,
    content,
    checksumSha256,
  };
}

// ----------------------------------------------------------- result handling

/** Whole-rupiah net of a payslip when its sealed body can be read, else null. */
function readSlipNet(row: {
  id: string;
  tenantId: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}): number | null {
  try {
    const body: unknown = JSON.parse(
      openPayrollValue(
        row.calculationEncrypted,
        {
          tenantId: row.tenantId,
          table: "payslips",
          rowId: row.id,
          field: "calculation",
        },
        row.piiKeyVersion,
      ),
    );
    if (typeof body !== "object" || body === null) return null;
    const net = (body as { netIdr?: unknown }).netIdr;
    return typeof net === "number" && Number.isSafeInteger(net) ? net : null;
  } catch {
    return null;
  }
}

/**
 * R10: the run becomes `paid` only when every payslip with net pay above zero
 * has a succeeded item. A payslip that cannot be read counts as unpaid (fail
 * closed: it blocks `paid`, it never pays anyone). Returns true when the run
 * turned paid in this call. The caller holds the batch lock. `paidBy` is the
 * last approver of the batch, not the person who confirmed.
 */
async function settleRunWhenAllPaid(
  tx: Tx,
  actor: Actor,
  runId: PayrollRunId,
  now: Date,
  paidBy: string,
): Promise<boolean> {
  const tenantId = actor.tenantId as TenantId;
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .for("update");
  if (!run || run.status !== "locked") return false;

  const slips = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
    })
    .from(payslips)
    .where(
      and(eq(payslips.tenantId, tenantId), eq(payslips.payrollRunId, runId)),
    );
  if (slips.length === 0) return false;
  const paid = new Set(
    (
      await tx
        .select({ payslipId: payrollDisbursementItems.payslipId })
        .from(payrollDisbursementItems)
        .where(
          and(
            eq(payrollDisbursementItems.tenantId, tenantId),
            eq(payrollDisbursementItems.payrollRunId, runId),
            eq(payrollDisbursementItems.status, "succeeded"),
          ),
        )
    ).map((row) => row.payslipId as string),
  );
  for (const slip of slips) {
    if (paid.has(slip.id)) continue;
    const net = readSlipNet(slip);
    if (net === null || net > 0) return false;
  }
  // Only this statement may turn the run paid (trigger PAYOUT-22).
  await tx.execute(sql`SELECT set_config('app.payout_settle', 'on', true)`);
  try {
    const updated = await tx
      .update(payrollRuns)
      .set({
        status: "paid",
        paidAt: now,
        paidBy: paidBy as UserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(payrollRuns.tenantId, tenantId),
          eq(payrollRuns.id, runId),
          eq(payrollRuns.status, "locked"),
        ),
      )
      .returning({ id: payrollRuns.id });
    return updated.length === 1;
  } finally {
    await tx.execute(sql`SELECT set_config('app.payout_settle', 'off', true)`);
  }
}

/** When no item of the batch is still waiting, the batch closes. */
async function closeBatchWhenDone(
  tx: Tx,
  tenantId: TenantId,
  batch: BatchRow,
  waitingStatus: "exported" | "approved",
  now: Date,
): Promise<BatchRow["status"] | null> {
  const items = await tx
    .select({ status: payrollDisbursementItems.status })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
      ),
    );
  const live = items.filter((item) => item.status !== "cancelled");
  if (live.length === 0 || live.some((item) => item.status === waitingStatus))
    return null;
  const next = live.every((item) => item.status === "succeeded")
    ? "completed"
    : "partially_failed";
  const closed = await tx
    .update(payrollDisbursementBatches)
    .set({ status: next, updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenantId),
        eq(payrollDisbursementBatches.id, batch.id),
        eq(payrollDisbursementBatches.status, waitingStatus),
      ),
    )
    .returning({ id: payrollDisbursementBatches.id });
  if (closed.length !== 1)
    throw refuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status batch berubah saat diproses. Coba lagi.",
    );
  return next;
}

/**
 * After items became `succeeded`: journal them (once), then turn the run paid
 * when every payslip is paid and announce it. Same transaction as the caller.
 */
async function settleAndMaybePay(
  tx: Tx,
  actor: Actor,
  batch: BatchRow,
  now: Date,
): Promise<boolean> {
  await settleBatchPayouts(tx, actor, batch.id, now);
  const runPaid = await settleRunWhenAllPaid(
    tx,
    actor,
    batch.payrollRunId,
    now,
    batch.approvedBy ?? actor.userId,
  );
  if (runPaid) await emitPayoutRunPaid(tx, actor, batch, now);
  return runPaid;
}

function assertNotRequester(batch: BatchRow, actor: Actor): void {
  if (batch.requestedBy === actor.userId)
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pengaju batch tidak boleh mengonfirmasi pembayarannya sendiri.",
    );
}

async function loadItemsForConfirm(
  tx: Tx,
  tenantId: TenantId,
  batch: BatchRow,
  itemIds: readonly string[],
  expected: ItemRow["status"],
): Promise<ItemRow[]> {
  if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length)
    throw refuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Daftar item kosong atau memuat item yang sama dua kali.",
    );
  if (itemIds.some((id) => !UUID.test(id)))
    throw refuse(422, "PAYOUT_ITEMS_INVALID", "ID item tidak valid.");
  const rows = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(payrollDisbursementItems.id, [...itemIds]),
      ),
    )
    .for("update");
  if (rows.length !== itemIds.length)
    throw refuse(
      404,
      "PAYOUT_ITEM_NOT_FOUND",
      "Ada item yang bukan bagian dari batch ini.",
    );
  if (rows.some((row) => row.status !== expected))
    throw refuse(
      409,
      "PAYOUT_ITEM_NOT_CONFIRMABLE",
      expected === "exported"
        ? "Ada item yang belum diunduh atau sudah dikonfirmasi."
        : expected === "succeeded"
          ? "Ada item yang belum dibayar atau sudah dikembalikan."
          : "Ada item yang belum disetujui atau sudah diserahkan.",
    );
  return rows;
}

/**
 * Per-item `succeeded` result of a manual bank file, entered by someone other
 * than the requester. The bank reference is required; the evidence key is
 * kept. Items must be `exported` (compare-and-set), so one item is confirmed
 * once. A failed or unsent item goes through `resolveManualItems` instead.
 */
export async function confirmManualItems(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: ManualConfirmInput,
  proofs: PayoutEvidenceStore,
  now = new Date(),
): Promise<{
  batchStatus: BatchRow["status"];
  runPaid: boolean;
  confirmed: number;
}> {
  const tenantId = actor.tenantId as TenantId;
  // Proof checks run BEFORE the run and batch rows are locked: a storage read
  // must not hold them. Safe because the key is bound to this batch id and no
  // path deletes a stored proof; nothing is written before the check passes.
  for (const result of input.results)
    if ((result.evidenceKey ?? "").length > 500)
      throw refuse(422, "PAYOUT_ITEMS_INVALID", "Kunci bukti terlalu panjang.");
  // Each proof key must lie in this tenant's folder of this batch (L5) and name
  // an object really stored for it (01gg8). One storage read per distinct key.
  const storedKeys = new Map<string, string | null>();
  for (const result of input.results) {
    const raw = result.evidenceKey ?? "";
    if (!storedKeys.has(raw))
      storedKeys.set(
        raw,
        await assertOptionalEvidenceKeyForBatchStored(
          proofs,
          { tenantId: actor.tenantId, batchId },
          raw,
        ),
      );
  }
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan transfer bank manual.",
    );
  assertNotRequester(batch, actor);
  if (batch.status !== "exported")
    throw refuse(
      409,
      "PAYOUT_BATCH_NOT_EXPORTED",
      "Berkas transfer batch ini belum diunduh, jadi hasilnya belum bisa dikonfirmasi.",
    );
  for (const result of input.results) {
    // H2: a failed result is not accepted here, even if a caller sends one.
    if ((result.result as string) !== "succeeded")
      throw refuse(
        422,
        "PAYOUT_RESULT_NOT_ALLOWED",
        "Hanya hasil berhasil yang bisa dikonfirmasi di sini. Item gagal atau tidak terkirim diselesaikan oleh dua orang lewat langkah penyelesaian.",
      );
    const ref = result.bankRef?.trim() ?? "";
    if (ref === "" || ref.length > 100)
      throw refuse(
        422,
        "PAYOUT_BANK_REF_REQUIRED",
        "Pembayaran berhasil wajib memakai nomor referensi bank (maks 100 karakter).",
      );
  }
  const evidenceByItem = new Map(
    input.results.map((result) => [
      result.itemId,
      storedKeys.get(result.evidenceKey ?? "") ?? null,
    ]),
  );
  await loadItemsForConfirm(
    tx,
    tenantId,
    batch,
    input.results.map((result) => result.itemId),
    "exported",
  );
  for (const key of new Set(evidenceByItem.values()))
    if (key !== null) await assertProofNotUsedForReturn(tx, tenantId, key);

  let confirmed = 0;
  for (const result of input.results) {
    const updated = await tx
      .update(payrollDisbursementItems)
      .set({
        status: "succeeded",
        settledAt: now,
        confirmedBy: actor.userId as UserId,
        confirmationRef: result.bankRef?.trim() || null,
        confirmationEvidenceKey: evidenceByItem.get(result.itemId) ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          eq(payrollDisbursementItems.batchId, batch.id),
          eq(payrollDisbursementItems.id, result.itemId),
          eq(payrollDisbursementItems.status, "exported"),
        ),
      )
      .returning({ id: payrollDisbursementItems.id });
    if (updated.length !== 1)
      throw refuse(
        409,
        "PAYOUT_ITEM_NOT_CONFIRMABLE",
        "Ada item yang belum diunduh atau sudah dikonfirmasi.",
      );
    confirmed += 1;
  }

  const closed = await closeBatchWhenDone(tx, tenantId, batch, "exported", now);
  const runPaid = await settleAndMaybePay(tx, actor, batch, now);
  await auditBatch(
    tx,
    actor,
    "payroll.disbursement.manual_confirmed",
    batch,
    { status: batch.status },
    {
      status: closed ?? batch.status,
      confirmed,
    },
  );
  return {
    batchStatus: closed ?? batch.status,
    runPaid,
    confirmed,
  };
}

/**
 * H2: moves `exported` items to `failed` or `not_sent` (their slips become
 * payable again, so this must never rest on one person). Step one, by a
 * non-requester, records the proposed outcome, evidence and note; the item
 * stays `exported`. Step two, by a DIFFERENT non-requester with the SAME
 * outcome, moves the item. "The file was never uploaded" is `not_sent` for all
 * items (R14). The database trigger repeats the two-person rule.
 */
export async function resolveManualItems(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: ManualResolveInput,
  proofs: PayoutEvidenceStore,
  now = new Date(),
): Promise<{
  batchStatus: BatchRow["status"];
  /** Items moved out of `exported` by this call (second step). */
  resolved: number;
  /** Items that only got a first proposal in this call. */
  proposed: number;
}> {
  const tenantId = actor.tenantId as TenantId;
  const evidenceInput = input.evidenceKey.trim();
  const note = input.note.trim();
  if (evidenceInput === "" || evidenceInput.length > 500)
    throw refuse(
      422,
      "PAYOUT_EVIDENCE_REQUIRED",
      "Bukti wajib diisi (maks 500 karakter).",
    );
  if (note === "" || note.length > 500)
    throw refuse(
      422,
      "PAYOUT_NOTE_REQUIRED",
      "Catatan wajib diisi (maks 500 karakter).",
    );
  // Both steps: the proof lies in this tenant's folder of this batch (L5) and
  // the object really is in the storage (01gg8). Checked BEFORE the run and
  // batch rows are locked, so a storage read never holds them (the key is
  // bound to this batch id and no path deletes a stored proof; nothing is
  // written before the check passes).
  const evidence = await assertEvidenceKeyForBatchStored(
    proofs,
    { tenantId: actor.tenantId, batchId },
    evidenceInput,
  );
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan transfer bank manual.",
    );
  assertNotRequester(batch, actor);
  if (batch.status !== "exported")
    throw refuse(
      409,
      "PAYOUT_BATCH_NOT_EXPORTED",
      "Berkas transfer batch ini belum diunduh, jadi hasilnya belum bisa diselesaikan.",
    );
  if (input.outcome !== "failed" && input.outcome !== "not_sent")
    throw refuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Hasil penyelesaian tidak dikenal.",
    );
  const rows = await loadItemsForConfirm(
    tx,
    tenantId,
    batch,
    input.itemIds,
    "exported",
  );

  // Check every item first so a refusal leaves nothing half done.
  for (const row of rows) {
    if (row.resolvedBy === null) continue;
    if (row.resolvedBy === actor.userId)
      throw refuse(
        403,
        "PAYOUT_RESOLVE_SAME_PERSON",
        "Penyelesaian kedua harus dilakukan orang lain, bukan orang yang mengajukan penyelesaian pertama.",
      );
    if (row.resolutionOutcome !== input.outcome)
      throw refuse(
        409,
        "PAYOUT_RESOLVE_OUTCOME_MISMATCH",
        "Hasil yang diajukan berbeda dari penyelesaian pertama.",
      );
    // The second person confirms the same proof the first one recorded (bmlwf).
    if (row.resolutionEvidenceKey !== evidence)
      throw refuse(
        409,
        "PAYOUT_RESOLVE_EVIDENCE_MISMATCH",
        "Bukti penyelesaian harus sama dengan bukti yang dicatat orang pertama.",
      );
  }

  // A proof that frees items as failed must not already be a return proof or a
  // return claim (review F3). It MAY equal a payment-confirmation proof: one
  // bank result report legitimately covers paid and failed lines of a batch.
  await assertProofNotUsedForReturn(tx, tenantId, evidence);

  let resolved = 0;
  let proposed = 0;
  for (const row of rows) {
    const where = (secondStep: boolean) =>
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        eq(payrollDisbursementItems.id, row.id),
        eq(payrollDisbursementItems.status, "exported"),
        secondStep
          ? and(
              eq(payrollDisbursementItems.resolvedBy, row.resolvedBy!),
              isNull(payrollDisbursementItems.resolvedBy2),
            )
          : isNull(payrollDisbursementItems.resolvedBy),
      );
    const updated =
      row.resolvedBy === null
        ? await tx
            .update(payrollDisbursementItems)
            .set({
              resolvedBy: actor.userId as UserId,
              resolutionOutcome: input.outcome,
              resolutionEvidenceKey: evidence,
              resolutionNote: note,
              updatedAt: now,
            })
            .where(where(false))
            .returning({ id: payrollDisbursementItems.id })
        : await tx
            .update(payrollDisbursementItems)
            .set({
              resolvedBy2: actor.userId as UserId,
              status: input.outcome,
              failureClass: input.outcome === "failed" ? "definitive" : null,
              updatedAt: now,
            })
            .where(where(true))
            .returning({ id: payrollDisbursementItems.id });
    if (updated.length !== 1)
      throw refuse(
        409,
        "PAYOUT_ITEM_NOT_CONFIRMABLE",
        "Ada item yang belum diunduh atau sudah diselesaikan.",
      );
    if (row.resolvedBy === null) proposed += 1;
    else resolved += 1;
  }

  const closed =
    resolved > 0
      ? await closeBatchWhenDone(tx, tenantId, batch, "exported", now)
      : null;
  await auditBatch(
    tx,
    actor,
    "payroll.disbursement.manual_resolved",
    batch,
    { status: batch.status },
    {
      status: closed ?? batch.status,
      outcome: input.outcome,
      itemCount: rows.length,
      resolved,
      evidenceKey: evidence,
    },
  );
  return { batchStatus: closed ?? batch.status, resolved, proposed };
}

/**
 * A proof already used for a return (as a return proof or a return claim) can
 * neither free items as failed nor confirm a payment (review F3/F6): the
 * return's second step would then be refused for good, leaving money back in
 * the bank with no return journal.
 */
async function assertProofNotUsedForReturn(
  tx: Tx,
  tenantId: TenantId,
  evidence: string,
): Promise<void> {
  const [proofUsed] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.returnEvidenceKey, evidence),
      ),
    )
    .limit(1);
  const [claimUsed] = await tx
    .select({ id: payrollPayoutReturnClaims.id })
    .from(payrollPayoutReturnClaims)
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        eq(payrollPayoutReturnClaims.evidenceKey, evidence),
      ),
    )
    .limit(1);
  if (proofUsed || claimUsed) throw refuseReusedReturnProof();
}

const refuseReusedReturnProof = () =>
  refuse(
    409,
    "PAYOUT_RETURN_PROOF_REUSED",
    "Bukti pengembalian ini sudah dipakai untuk pengembalian lain. Unggah bukti dana kembali yang sesuai dengan item ini.",
  );

/**
 * Binds the return proof to ONE return operation (legend-w3691). The claim of
 * a proof key records the item set of the request that first used it; only an
 * identical item set can continue it, and step two consumes it atomically
 * (conditional UPDATE) before the items move. Returns the claim id.
 */
async function bindReturnClaim(
  tx: Tx,
  actor: Actor,
  batch: BatchRow,
  evidence: string,
  rows: readonly ItemRow[],
  secondStep: boolean,
  now: Date,
): Promise<string> {
  const tenantId = actor.tenantId as TenantId;
  const hash = createHash("sha256")
    .update(
      rows
        .map((row) => row.id)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  // The proof must not already free or confirm any item (review F3): a proof
  // that resolved a payslip as failed cannot also return another one.
  const [otherFlow] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        or(
          eq(payrollDisbursementItems.resolutionEvidenceKey, evidence),
          eq(payrollDisbursementItems.confirmationEvidenceKey, evidence),
        ),
      ),
    )
    .limit(1);
  if (otherFlow) throw refuseReusedReturnProof();
  const [existing] = await tx
    .select()
    .from(payrollPayoutReturnClaims)
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        eq(payrollPayoutReturnClaims.evidenceKey, evidence),
      ),
    )
    .for("update");
  let claim = existing;
  if (claim) {
    // Step two continues the claim its own step one created, nothing else.
    if (secondStep && rows.some((row) => row.returnClaimId !== claim!.id))
      throw refuseReusedReturnProof();
  } else {
    // A return proposal from before claims existed has no claim row. Its key
    // may already have released other items, so it is trusted only when no item
    // outside this request holds the same key.
    const [foreign] = await tx
      .select({ id: payrollDisbursementItems.id })
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          eq(payrollDisbursementItems.returnEvidenceKey, evidence),
          notInArray(
            payrollDisbursementItems.id,
            rows.map((row) => row.id),
          ),
        ),
      )
      .limit(1);
    if (foreign) throw refuseReusedReturnProof();
    if (secondStep && rows.some((row) => row.returnClaimId !== null))
      throw refuseReusedReturnProof();
    [claim] = await tx
      .insert(payrollPayoutReturnClaims)
      .values({
        tenantId,
        batchId: batch.id,
        evidenceKey: evidence,
        itemSetHash: hash,
        status: "open",
        createdBy: actor.userId as UserId,
        createdAt: now,
      })
      .returning();
  }
  if (
    !claim ||
    claim.batchId !== batch.id ||
    claim.itemSetHash !== hash ||
    claim.status !== "open"
  )
    throw refuseReusedReturnProof();
  if (secondStep) {
    const consumed = await tx
      .update(payrollPayoutReturnClaims)
      .set({ status: "consumed", consumedAt: now })
      .where(
        and(
          eq(payrollPayoutReturnClaims.tenantId, tenantId),
          eq(payrollPayoutReturnClaims.id, claim.id),
          eq(payrollPayoutReturnClaims.status, "open"),
        ),
      )
      .returning({ id: payrollPayoutReturnClaims.id });
    if (consumed.length !== 1) throw refuseReusedReturnProof();
  }
  return claim.id;
}

/**
 * Funds came back after a paid transfer (design 7.8): moves `succeeded` items
 * to `returned` and reverses their net in the ledger, once. Same two-person
 * rule as `resolveManualItems`: step one, by a non-requester, records the
 * evidence and note and the item stays `succeeded` (no journal); step two, by
 * a DIFFERENT non-requester, moves the item and posts the return journal
 * (`payroll-payout-return:<itemId>`). The database trigger repeats the rule.
 * A returned item frees its payslip for a new payment (R7), the run stays
 * `paid`, and the bank fee is not refunded.
 */
export async function returnManualItems(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: ManualReturnInput,
  proofs: PayoutEvidenceStore,
  now = new Date(),
): Promise<{
  batchStatus: BatchRow["status"];
  /** Items returned by this call (second step). */
  returned: number;
  /** Items that only got a first proposal in this call. */
  proposed: number;
}> {
  const tenantId = actor.tenantId as TenantId;
  const note = input.note.trim();
  if (note === "" || note.length > 500)
    throw refuse(
      422,
      "PAYOUT_NOTE_REQUIRED",
      "Catatan wajib diisi (maks 500 karakter).",
    );
  // Stored-proof check before the run and batch rows are locked (see resolve).
  const evidence = await assertEvidenceKeyForBatchStored(
    proofs,
    { tenantId: actor.tenantId, batchId },
    input.evidenceKey,
  );
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Pengembalian dana hanya untuk transfer bank manual.",
    );
  assertNotRequester(batch, actor);
  // Every succeeded item has its posting before it can come back.
  await settleBatchPayouts(tx, actor, batch.id, now);
  const rows = await loadItemsForConfirm(
    tx,
    tenantId,
    batch,
    input.itemIds,
    "succeeded",
  );
  for (const row of rows) {
    if (row.returnedBy === null) continue;
    if (row.returnedBy === actor.userId)
      throw refuse(
        403,
        "PAYOUT_RETURN_SAME_PERSON",
        "Pengembalian kedua harus dilakukan orang lain, bukan orang yang mengajukan pengembalian pertama.",
      );
  }

  // The second person confirms the same evidence the first one recorded.
  for (const row of rows) {
    if (row.returnedBy !== null && row.returnEvidenceKey !== evidence)
      throw refuse(
        409,
        "PAYOUT_RETURN_EVIDENCE_MISMATCH",
        "Bukti pengembalian harus sama dengan bukti yang dicatat orang pertama.",
      );
  }
  // One request is one operation: every item in the same step (w3691).
  const secondSteps = rows.filter((row) => row.returnedBy !== null).length;
  if (secondSteps !== 0 && secondSteps !== rows.length)
    throw refuse(
      409,
      "PAYOUT_ITEM_NOT_CONFIRMABLE",
      "Semua item dalam satu pengembalian harus berada pada langkah yang sama.",
    );
  const claimId = await bindReturnClaim(
    tx,
    actor,
    batch,
    evidence,
    rows,
    secondSteps > 0,
    now,
  );

  let returned = 0;
  let proposed = 0;
  for (const row of rows) {
    const secondStep = row.returnedBy !== null;
    const updated = secondStep
      ? await tx
          .update(payrollDisbursementItems)
          .set({
            returnedBy2: actor.userId as UserId,
            status: "returned",
            returnedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(payrollDisbursementItems.tenantId, tenantId),
              eq(payrollDisbursementItems.batchId, batch.id),
              eq(payrollDisbursementItems.id, row.id),
              eq(payrollDisbursementItems.status, "succeeded"),
              eq(payrollDisbursementItems.returnedBy, row.returnedBy!),
              isNull(payrollDisbursementItems.returnedBy2),
            ),
          )
          .returning({ id: payrollDisbursementItems.id })
      : await tx
          .update(payrollDisbursementItems)
          .set({
            returnedBy: actor.userId as UserId,
            returnEvidenceKey: evidence,
            returnNote: note,
            returnClaimId: claimId,
            updatedAt: now,
          })
          .where(
            and(
              eq(payrollDisbursementItems.tenantId, tenantId),
              eq(payrollDisbursementItems.batchId, batch.id),
              eq(payrollDisbursementItems.id, row.id),
              eq(payrollDisbursementItems.status, "succeeded"),
              isNull(payrollDisbursementItems.returnedBy),
            ),
          )
          .returning({ id: payrollDisbursementItems.id });
    if (updated.length !== 1)
      throw refuse(
        409,
        "PAYOUT_ITEM_NOT_CONFIRMABLE",
        "Ada item yang belum dibayar atau sudah dikembalikan.",
      );
    if (secondStep) {
      await postPayoutReturn(tx, actor, batch, row, now);
      returned += 1;
    } else proposed += 1;
  }
  await auditBatch(
    tx,
    actor,
    "payroll.disbursement.manual_returned",
    batch,
    { status: batch.status },
    {
      status: batch.status,
      itemCount: rows.length,
      resolved: returned,
      evidenceKey: evidence,
    },
  );
  return { batchStatus: batch.status, returned, proposed };
}

/**
 * Cash handover: approved cash items become `succeeded` once a person other
 * than the requester confirms the money was handed over. The batch closes when
 * every item is handed over.
 */
export async function confirmCashHandover(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: CashHandoverInput,
  now = new Date(),
): Promise<{ batchStatus: BatchRow["status"]; runPaid: boolean }> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "cash")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan pembayaran tunai.",
    );
  assertNotRequester(batch, actor);
  if (batch.status !== "approved")
    throw refuse(
      409,
      "PAYOUT_BATCH_NOT_APPROVED",
      "Batch tunai belum disetujui atau sudah selesai.",
    );
  if (
    batch.approvalExpiresAt === null ||
    batch.approvalExpiresAt.getTime() <= now.getTime()
  )
    throw refuse(
      409,
      "PAYOUT_APPROVAL_EXPIRED",
      "Persetujuan batch sudah lewat 24 jam. Batalkan batch dan buat yang baru.",
    );
  // Cash handover carries no evidence object: any non-null key is refused and
  // the stored confirmation evidence stays NULL.
  if (input.evidenceKey !== undefined && input.evidenceKey !== null)
    throw refuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Serah terima tunai tidak memakai kunci bukti.",
    );
  await loadItemsForConfirm(tx, tenantId, batch, input.itemIds, "approved");

  const updated = await tx
    .update(payrollDisbursementItems)
    .set({
      status: "succeeded",
      settledAt: now,
      confirmedBy: actor.userId as UserId,
      confirmationEvidenceKey: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(payrollDisbursementItems.id, [...input.itemIds]),
        eq(payrollDisbursementItems.status, "approved"),
        eq(payrollDisbursementItems.channel, "cash"),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  if (updated.length !== input.itemIds.length)
    throw refuse(
      409,
      "PAYOUT_ITEM_NOT_CONFIRMABLE",
      "Ada item yang belum disetujui atau sudah diserahkan.",
    );
  const closed = await closeBatchWhenDone(tx, tenantId, batch, "approved", now);
  const runPaid = await settleAndMaybePay(tx, actor, batch, now);
  await auditBatch(
    tx,
    actor,
    "payroll.disbursement.cash_handed_over",
    batch,
    { status: batch.status },
    {
      status: closed ?? batch.status,
      confirmed: updated.length,
    },
  );
  return { batchStatus: closed ?? batch.status, runPaid };
}
