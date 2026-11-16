// Payroll payout: correct a `failed` item that did reach the employee after all
// (bead legend-mejr2; design docs/design/payroll-disbursement.md 5.2, 7.9).
// Nothing is paid by this call: the money already left, the books are fixed.
//
// Money rules held here (nobody is paid twice, the PT does not lose):
// - Only a `failed` item whose resolution is final (two people) and whose
//   payslip has NO other attempt that is live, paid, paid back or overpaid.
//   Otherwise the payment would be a second one: refused 409, and the overpaid
//   path (payroll-payout-overpaid-route.service.ts) is the way.
// - Two different people, as with resolve and return. Step one writes a
//   proposal (proof + note) and the item stays `failed`: no journal. Step two,
//   by another person with the SAME proof, moves each item `failed ->
//   succeeded` and settles it. Neither person may be the batch requester or one
//   of the two who resolved the item as failed (403). The database repeats all
//   of it (migrations 0635, 0636, 0644, 0645): both steps are written only by
//   the trusted functions `app.payout_correction_propose` / `_approve` (owned
//   by `legend_payout`, which check actor and session); `legend_app` cannot
//   write the corrections or move `failed -> succeeded` itself.
// - The proof is bound to ONE operation: its key and both hashes (uploaded and
//   stored bytes) must not back a return claim, an overpaid proposal, another
//   correction, or any item's payment, resolution or return proof (409
//   PAYOUT_CORRECTION_PROOF_REUSED). Step two must name the same item set.
// - Exactly once: the run and batch are locked first (same order as every
//   payout step; a retry batch is created under the same run lock), status,
//   other attempts and proof are re-checked under the lock, and the items are
//   read FOR UPDATE. The journal is made by `settleBatchPayouts` (Dr the
//   salaries payable account frozen on the lock journal / Cr the source
//   account frozen on the batch; pending, skipped and fee rules as for any
//   confirmed payment); a replay finds nothing to do.
// - A corrected item is `succeeded`, so it holds the payslip's live slot: a
//   retry or a new batch for it is refused (409, no second transfer).
// - One request is one operation: every item is in the same step.

import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import {
  PAYOUT_LIVE_ITEM_STATUSES,
  payrollDisbursementItems,
  payrollPayoutFailedCorrections,
  payrollPayoutOverpaidProposals,
  payrollPayoutReturnClaims,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  assertEvidenceKeyForBatchStored,
  type PayoutEvidenceStore,
} from "./payroll-payout-evidence.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import { settleAndMaybePay } from "./payroll-payout-manual.service.ts";
import {
  claimHoldingFingerprint,
  twinEvidenceKeys,
} from "./payroll-payout-proof-fingerprint.service.ts";
import { bindProofToOperation } from "./payroll-payout-proof-binding.service.ts";
import {
  loadBatchRunFirst,
  payoutRefuse,
  payoutTrustedSessionId,
  recordPayoutAudit,
  type BatchRow,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type CorrectFailedInput = {
  itemIds: readonly string[];
  evidenceKey: string;
  note: string;
};

export type CorrectFailedResult = {
  batchStatus: BatchRow["status"];
  /** The step this call completed: a first proposal or the final correction. */
  stage: "proposed" | "corrected";
  /** Items moved to `succeeded` by this call (second step). */
  corrected: number;
  /** Items that only got a first proposal in this call. */
  proposed: number;
};

type ItemRow = typeof payrollDisbursementItems.$inferSelect;
type CorrectionRow = typeof payrollPayoutFailedCorrections.$inferSelect;

/** Another attempt in one of these states makes the transfer a second one. */
const BLOCKING_OTHER_ATTEMPT = [
  ...PAYOUT_LIVE_ITEM_STATUSES,
  "returned",
  "overpaid",
] as const;

const notCorrectable = (message: string) =>
  payoutRefuse(409, "PAYOUT_ITEM_NOT_CORRECTABLE", message);

const stepMismatch = () =>
  payoutRefuse(
    409,
    "PAYOUT_CORRECTION_STEP_MISMATCH",
    "Semua item dalam satu koreksi harus berada pada langkah yang sama dan memuat himpunan item yang sama.",
  );

const proofReused = () =>
  payoutRefuse(
    409,
    "PAYOUT_CORRECTION_PROOF_REUSED",
    "Bukti ini sudah dipakai untuk pencatatan lain. Unggah bukti transfer bank yang sesuai dengan item ini.",
  );

const SHA_CONSTRAINTS = new Set([
  "payroll_payout_failed_corrections_evidence_key",
  "payroll_payout_failed_corrections_content_sha_key",
  "payroll_payout_failed_corrections_stored_sha_key",
]);

function isProofUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      code === "23505" &&
      typeof constraint === "string" &&
      SHA_CONSTRAINTS.has(constraint)
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Array literal for a `uuid[]` parameter (ids come from locked rows). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

/** Step one in SQL: writes the proposals, returns the operation id. */
async function callCorrectionPropose(
  tx: Tx,
  actor: Actor,
  batchId: string,
  itemIds: readonly string[],
  evidence: string,
  note: string,
): Promise<string> {
  const result = await tx.execute(
    sql`SELECT app.payout_correction_propose(${batchId}::uuid, ${uuidArray(itemIds)}::uuid[], ${evidence}::varchar, ${note}, ${actor.userId}, ${payoutTrustedSessionId(actor)}) AS id`,
  );
  return (result.rows[0] as { id: string }).id;
}

/** Step two in SQL: corrects every item of the operation, returns how many. */
async function callCorrectionApprove(
  tx: Tx,
  actor: Actor,
  operationId: string,
  evidence: string,
): Promise<number> {
  const result = await tx.execute(
    sql`SELECT app.payout_correction_approve(${operationId}::uuid, ${evidence}::varchar, ${actor.userId}, ${payoutTrustedSessionId(actor)}) AS moved`,
  );
  return Number((result.rows[0] as { moved: number }).moved);
}

/** Items of the request, locked, all of this batch and all still `failed`. */
async function loadFailedItems(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  itemIds: readonly string[],
): Promise<ItemRow[]> {
  if (new Set(itemIds).size !== itemIds.length)
    throw payoutRefuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Daftar item memuat item yang sama dua kali.",
    );
  const rows = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batchId),
        inArray(payrollDisbursementItems.id, [...itemIds]),
      ),
    )
    .orderBy(payrollDisbursementItems.id)
    .for("update");
  if (rows.length !== itemIds.length)
    throw payoutRefuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Ada item yang bukan bagian dari batch ini.",
    );
  if (rows.some((row) => row.status !== "failed"))
    throw notCorrectable("Hanya item gagal yang bisa dikoreksi.");
  return rows;
}

/** The failure was resolved by two people, and the transfer is not a second one. */
async function assertCorrectable(
  tx: Tx,
  tenantId: TenantId,
  rows: readonly ItemRow[],
): Promise<void> {
  for (const row of rows)
    if (
      row.resolutionOutcome !== "failed" ||
      row.resolvedBy === null ||
      row.resolvedBy2 === null
    )
      throw notCorrectable(
        "Kegagalan item ini belum diselesaikan oleh dua orang, jadi belum bisa dikoreksi.",
      );
  const payslips = new Set(rows.map((row) => row.payslipId));
  if (payslips.size !== rows.length)
    throw notCorrectable(
      "Satu slip hanya boleh dikoreksi lewat satu item dalam satu permintaan.",
    );
  const [other] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        inArray(payrollDisbursementItems.payslipId, [...payslips]),
        notInArray(
          payrollDisbursementItems.id,
          rows.map((row) => row.id),
        ),
        inArray(payrollDisbursementItems.status, [...BLOCKING_OTHER_ATTEMPT]),
      ),
    )
    .limit(1);
  if (other)
    throw notCorrectable(
      "Slip ini sudah punya pembayaran susulan. Catat sebagai pembayaran ganda, bukan koreksi.",
    );
}

/**
 * The proof must not back anything else (under the fingerprint locks, which the
 * caller took): not a return claim, an overpaid proposal, another correction,
 * nor the payment, resolution or return proof of any item. The correction rows
 * of the request itself are the one thing it may already back.
 */
async function assertProofFree(
  tx: Tx,
  tenantId: TenantId,
  evidence: string,
  shas: readonly string[],
  ownItemIds: readonly string[],
): Promise<void> {
  const keys = [
    evidence,
    ...(await twinEvidenceKeys(tx, tenantId, shas, evidence)),
  ];
  const [itemUse] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        or(
          inArray(payrollDisbursementItems.resolutionEvidenceKey, keys),
          inArray(payrollDisbursementItems.confirmationEvidenceKey, keys),
          inArray(payrollDisbursementItems.returnEvidenceKey, keys),
        ),
      ),
    )
    .limit(1);
  if (itemUse) throw proofReused();
  const [claimUse] = await tx
    .select({ id: payrollPayoutReturnClaims.id })
    .from(payrollPayoutReturnClaims)
    .where(
      and(
        eq(payrollPayoutReturnClaims.tenantId, tenantId),
        inArray(payrollPayoutReturnClaims.evidenceKey, keys),
      ),
    )
    .limit(1);
  if (claimUse || (await claimHoldingFingerprint(tx, tenantId, shas, evidence)))
    throw proofReused();
  const [overpaidUse] = await tx
    .select({ id: payrollPayoutOverpaidProposals.id })
    .from(payrollPayoutOverpaidProposals)
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        inArray(payrollPayoutOverpaidProposals.evidenceKey, keys),
      ),
    )
    .limit(1);
  if (overpaidUse) throw proofReused();
  const [correctionUse] = await tx
    .select({ id: payrollPayoutFailedCorrections.id })
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        notInArray(payrollPayoutFailedCorrections.itemId, [...ownItemIds]),
        or(
          inArray(payrollPayoutFailedCorrections.evidenceKey, keys),
          shas.length > 0
            ? inArray(payrollPayoutFailedCorrections.contentSha256, [...shas])
            : undefined,
          shas.length > 0
            ? inArray(payrollPayoutFailedCorrections.storedSha256, [...shas])
            : undefined,
        ),
      ),
    )
    .limit(1);
  if (correctionUse) throw proofReused();
}

/**
 * Step one or two of correcting a failed item (see the file header). The step
 * is decided by the proposals found under the lock, not by the caller.
 */
export async function correctFailedItems(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: CorrectFailedInput,
  proofs: PayoutEvidenceStore,
  now = new Date(),
): Promise<CorrectFailedResult> {
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
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
    { tenantId: actor.tenantId, batchId },
    input.evidenceKey,
  );
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Koreksi hanya bisa dicatat untuk transfer bank manual.",
    );
  // A reversed run freed its period: a rerun may have paid the same people
  // again, so booking the old transfer as salary would count it twice.
  const [run] = await tx
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, batch.payrollRunId),
      ),
    );
  if (!run || (run.status !== "locked" && run.status !== "paid"))
    throw payoutRefuse(
      409,
      "PAYOUT_RUN_NOT_PAYABLE",
      "Payroll ini sudah dibatalkan atau belum dikunci, jadi koreksi tidak bisa dicatat.",
    );
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_CORRECTION_REQUESTER",
      "Pengaju batch tidak boleh mengoreksi item dari batchnya sendiri.",
    );

  // Status, resolution and other attempts are read again under the lock.
  const rows = await loadFailedItems(tx, tenantId, batch.id, input.itemIds);
  if (
    rows.some((row) => row.resolvedBy === userId || row.resolvedBy2 === userId)
  )
    throw payoutRefuse(
      403,
      "PAYOUT_CORRECTION_RESOLVER",
      "Orang yang menyelesaikan kegagalan item ini tidak boleh mengoreksinya.",
    );
  await assertCorrectable(tx, tenantId, rows);
  const itemIds = rows.map((row) => row.id);

  // One proof backs ONE operation (legend-so897): bound to this correction
  // (batch and item set) at both steps, before anything is written. Its hashes
  // are recorded first (fail closed when it cannot be read), then one lock per
  // hash, in order, is held while every reuse check runs (lock order: run row,
  // batch row, item rows, proof advisory).
  const record = await bindProofToOperation(tx, proofs, tenantId, {
    kind: "correction",
    batchId: batch.id,
    evidenceKey: evidence,
    itemIds,
    actorId: userId,
    now,
  });
  const shas = record.shas;
  await assertProofFree(tx, tenantId, evidence, shas, itemIds);

  const proposals: CorrectionRow[] = await tx
    .select()
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        inArray(payrollPayoutFailedCorrections.itemId, itemIds),
      ),
    )
    .orderBy(payrollPayoutFailedCorrections.itemId);
  // One request is one operation: all items without a proposal, or all with,
  // and then exactly the items of that one earlier operation.
  if (proposals.length !== 0) {
    const operations = new Set(proposals.map((p) => p.operationId));
    if (proposals.length !== rows.length || operations.size !== 1)
      throw stepMismatch();
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollPayoutFailedCorrections)
      .where(
        and(
          eq(payrollPayoutFailedCorrections.tenantId, tenantId),
          eq(payrollPayoutFailedCorrections.operationId, [...operations][0]!),
        ),
      );
    if (n !== rows.length) throw stepMismatch();
    const own = proposals.filter((p) => p.proposedBy === userId).length;
    if (own !== 0 && own !== proposals.length) throw stepMismatch();
    if (proposals.some((p) => p.status !== "proposed"))
      throw notCorrectable("Item ini sudah dikoreksi.");
  }
  const ownProposals = proposals.filter((p) => p.proposedBy === userId);

  // Step two: a different person, the same proof, then the real correction.
  if (proposals.length > 0 && ownProposals.length === 0) {
    for (const proposal of proposals) {
      if (proposal.evidenceKey !== evidence)
        throw payoutRefuse(
          409,
          "PAYOUT_CORRECTION_EVIDENCE_MISMATCH",
          "Bukti harus sama dengan bukti yang dicatat orang pertama.",
        );
      if (
        proposal.proposedBy === batch.requestedBy ||
        rows.some(
          (row) =>
            row.resolvedBy === proposal.proposedBy ||
            row.resolvedBy2 === proposal.proposedBy,
        )
      )
        throw payoutRefuse(
          403,
          "PAYOUT_CORRECTION_RESOLVER",
          "Pengusul koreksi tidak memenuhi syarat dua orang berbeda.",
        );
    }
    // The trusted function re-checks everything in SQL (two people, proof,
    // binding), marks the proposals corrected and moves `failed -> succeeded`
    // (migration 0645); no GUC is an authorisation any more.
    const moved = await callCorrectionApprove(
      tx,
      actor,
      proposals[0]!.operationId,
      evidence,
    );
    if (moved !== rows.length)
      throw payoutRefuse(
        409,
        "PAYOUT_BATCH_STATE_CHANGED",
        "Status item berubah saat diproses. Coba lagi.",
      );
    for (const row of rows)
      await recordPayoutAudit(tx, actor, {
        action: "payroll.disbursement.item_corrected",
        objectType: "payroll_disbursement_item",
        objectId: row.id,
        reason: note,
        before: { status: "failed" },
        after: { status: "succeeded", evidenceKey: evidence },
      });
    // The journal, once: Dr the frozen salaries payable / Cr the source account.
    await settleAndMaybePay(tx, actor, batch, now);
    return {
      batchStatus: batch.status,
      stage: "corrected",
      corrected: rows.length,
      proposed: 0,
    };
  }

  // Step one (or the same person replacing an open proposal): only a proposal.
  // The same person repeating the same proof is a replay, not a second person:
  // refused. Only a different proof replaces their own open proposal.
  if (ownProposals.some((p) => p.evidenceKey === evidence))
    throw payoutRefuse(
      403,
      "PAYOUT_CORRECTION_SAME_PERSON",
      "Anda sudah mengajukan koreksi ini. Langkah kedua harus dilakukan orang lain.",
    );
  try {
    // One call writes (or replaces, for the same person) the proposal of every
    // item; the proof hashes are read from the stored record in SQL.
    await callCorrectionPropose(tx, actor, batch.id, itemIds, evidence, note);
  } catch (error) {
    if (isProofUniqueViolation(error)) throw proofReused();
    throw error;
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.correction_proposed",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    reason: note,
    before: { status: batch.status },
    after: {
      status: batch.status,
      itemCount: rows.length,
      evidenceKey: evidence,
    },
  });
  return {
    batchStatus: batch.status,
    stage: "proposed",
    corrected: 0,
    proposed: rows.length,
  };
}
