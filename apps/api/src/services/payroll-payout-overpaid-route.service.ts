// Payroll payout: the HTTP path to record a transfer that turned out paid twice
// (bead legend-v6gtp; design docs/design/payroll-disbursement.md 5.2, 7.9).
// The money rules live in `recordOverpaidItem` (payroll-payout-overpaid
// .service.ts); this file only adds who may call it and in what order:
// - Same two-person rule as resolve and return. Step one, by a non-requester,
//   writes a proposal (proof + note) and the item stays `failed`: no journal.
//   Step two, by a DIFFERENT non-requester with the SAME proof, calls
//   `recordOverpaidItem` for each item and records the proposal (migration
//   0391). The trusted function
//   `app.payout_overpaid_record` marks the proposal `recorded`. The database
//   repeats the rule (migrations 0391, 0410, 0411): the proposal step is the
//   trusted `app.payout_overpaid_propose`, `legend_app` has no DML here.
// - Exactly once: the run and batch are locked first (same order as every
//   payout step), so two callers are serialized; a replay finds an item that is
//   no longer `failed` and is refused (409) with nothing changed. The journal
//   key and the unique posting of `recordOverpaidItem` are the next guards.
// - Nothing is paid by this call. A payslip whose other attempt is still open
//   (not `succeeded`) is refused: record it once that attempt is paid.
// - One request is one operation: every item is in the same step.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import type { RecordOverpaidItemsInput } from "@starter/shared/validators/payroll-payout";
import {
  payrollDisbursementItems,
  payrollPayoutOverpaidProposals,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  assertEvidenceKeyForBatchStored,
  type PayoutEvidenceStore,
} from "./payroll-payout-evidence.ts";
import { recordOverpaidItem } from "./payroll-payout-overpaid.service.ts";
import { bindProofToOperation } from "./payroll-payout-proof-binding.service.ts";
import { proofSpentByWithdrawn } from "./payroll-payout-proposal-withdraw.service.ts";
import {
  isPayoutUuid,
  isProposalReplaceViolation,
  loadBatchRunFirst,
  payoutRefuse,
  payoutStateChanged,
  payoutTrustedGrant,
  readBatch,
  recordPayoutAudit,
  type BatchRow,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

const proposalReplaceRefused = () =>
  payoutRefuse(
    409,
    "PAYOUT_PROPOSAL_REPLACE_REFUSED",
    "Bukti pengajuan yang masih terbuka tidak bisa diganti. Tarik pengajuan itu, lalu ajukan lagi dengan bukti yang benar.",
  );

export type OverpaidRouteResult = {
  batchStatus: BatchRow["status"];
  /** The step this call completed: a first proposal or the final record. */
  stage: "proposed" | "recorded";
  /** Items recorded as overpaid by this call (second step). */
  recorded: number;
  /** Items that only got a first proposal in this call. */
  proposed: number;
};

type ItemRow = typeof payrollDisbursementItems.$inferSelect;
type ProposalRow = typeof payrollPayoutOverpaidProposals.$inferSelect;

/** Items of the request, locked, all of this batch and all still `failed`. */
async function loadFailedItems(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  itemIds: readonly string[],
): Promise<ItemRow[]> {
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
    throw payoutRefuse(
      409,
      "PAYOUT_ITEM_NOT_OVERPAYABLE",
      "Hanya item gagal yang bisa dicatat sebagai pembayaran ganda.",
    );
  return rows;
}

/** A payslip is double paid only when another attempt of it was paid. */
async function assertOtherAttemptPaid(
  tx: Tx,
  tenantId: TenantId,
  rows: readonly ItemRow[],
): Promise<void> {
  for (const row of rows) {
    const [paid] = await tx
      .select({ id: payrollDisbursementItems.id })
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          eq(payrollDisbursementItems.payslipId, row.payslipId),
          ne(payrollDisbursementItems.id, row.id),
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
  }
}

/** The grants of this request, issued before the run and batch rows are locked. */
type OverpaidGrants =
  | { step: "propose"; grant: string }
  | {
      step: "record";
      /** One grant per item, each bound to the posting id its record uses. */
      records: Map<string, { postingId: string; grant: string }>;
    };

/**
 * The step is only known for certain under the lock, but a grant must exist
 * before it: the grantor connection inserts a grant row whose foreign key takes
 * `FOR KEY SHARE` on the batch, which would wait for our own `FOR UPDATE` and
 * deadlock the request against itself. The step is read unlocked here (step two
 * when another person's proposals of exactly this item set exist), the grants
 * are bound to it, and the locked read must agree (else 409, fail closed). The
 * trusted functions re-check everything again under the lock. Null when the
 * request is malformed: the locked path refuses it before any grant is used.
 */
async function issueOverpaidGrants(
  tx: Tx,
  actor: Actor,
  tenantId: TenantId,
  batchId: string,
  itemIds: readonly string[],
  evidence: string,
): Promise<OverpaidGrants | null> {
  if (
    itemIds.length === 0 ||
    new Set(itemIds).size !== itemIds.length ||
    !itemIds.every(isPayoutUuid)
  )
    return null;
  const proposals = await tx
    .select({ proposedBy: payrollPayoutOverpaidProposals.proposedBy })
    .from(payrollPayoutOverpaidProposals)
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        inArray(payrollPayoutOverpaidProposals.itemId, [...itemIds]),
        // A withdrawn proposal is over (legend-xatux): a new one starts anew.
        ne(payrollPayoutOverpaidProposals.status, "withdrawn"),
      ),
    );
  const stepTwo =
    proposals.length === itemIds.length &&
    proposals.every((p) => p.proposedBy !== actor.userId);
  if (!stepTwo)
    return {
      step: "propose",
      grant: await payoutTrustedGrant(actor, {
        kind: "overpaid",
        step: "propose",
        batchId,
        itemIds,
        evidenceKey: evidence,
        refId: null,
        targetId: null,
      }),
    };
  const records = new Map<string, { postingId: string; grant: string }>();
  for (const itemId of itemIds) {
    const postingId = randomUUID();
    records.set(itemId, {
      postingId,
      grant: await payoutTrustedGrant(actor, {
        kind: "overpaid",
        step: "record",
        batchId,
        itemIds: [itemId],
        evidenceKey: evidence,
        refId: postingId,
        targetId: null,
      }),
    });
  }
  return { step: "record", records };
}

/**
 * Step one or two of recording a double paid transfer (see the file header).
 * The step is decided by the proposals found under the lock, not by the caller.
 */
export async function recordOverpaidItems(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: Pick<RecordOverpaidItemsInput, "itemIds" | "evidenceKey" | "note">,
  proofs: PayoutEvidenceStore,
  now = new Date(),
): Promise<OverpaidRouteResult> {
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
  await readBatch(tx, actor.tenantId, batchId);
  const early = await issueOverpaidGrants(
    tx,
    actor,
    tenantId,
    batchId,
    input.itemIds,
    evidence,
  );
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Pembayaran ganda hanya bisa dicatat untuk transfer bank manual.",
    );
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_OVERPAID_REQUESTER",
      "Pengaju batch tidak boleh mencatat pembayaran ganda dari batchnya sendiri.",
    );

  const rows = await loadFailedItems(tx, tenantId, batch.id, input.itemIds);
  // One proof backs ONE operation (legend-so897): bound to this overpaid record
  // (batch and item set) at both steps, before anything is written, under its
  // hash locks (lock order: run row, batch row, item rows, proof advisory). A
  // proof of a return, a correction or another overpaid record is refused.
  const operationItemIds = rows.map((row) => row.id);
  await bindProofToOperation(tx, proofs, tenantId, {
    kind: "overpaid",
    batchId: batch.id,
    evidenceKey: evidence,
    itemIds: operationItemIds,
    actorId: userId,
    now,
  });
  const proposals: ProposalRow[] = await tx
    .select()
    .from(payrollPayoutOverpaidProposals)
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        inArray(
          payrollPayoutOverpaidProposals.itemId,
          rows.map((row) => row.id),
        ),
        ne(payrollPayoutOverpaidProposals.status, "withdrawn"),
      ),
    );
  // One request is one operation: all items without a proposal, or all with.
  if (proposals.length !== 0 && proposals.length !== rows.length)
    throw payoutRefuse(
      409,
      "PAYOUT_OVERPAID_STEP_MISMATCH",
      "Semua item dalam satu pencatatan harus berada pada langkah yang sama.",
    );
  const ownProposals = proposals.filter((p) => p.proposedBy === userId).length;
  if (ownProposals !== 0 && ownProposals !== proposals.length)
    throw payoutRefuse(
      409,
      "PAYOUT_OVERPAID_STEP_MISMATCH",
      "Semua item dalam satu pencatatan harus berada pada langkah yang sama.",
    );

  // Step two: a different person, the same proof, then the real record.
  if (proposals.length > 0 && ownProposals === 0) {
    for (const proposal of proposals) {
      if (proposal.status !== "proposed")
        throw payoutRefuse(
          409,
          "PAYOUT_ITEM_NOT_OVERPAYABLE",
          "Pembayaran ganda item ini sudah dicatat.",
        );
      if (proposal.evidenceKey !== evidence)
        throw payoutRefuse(
          409,
          "PAYOUT_OVERPAID_EVIDENCE_MISMATCH",
          "Bukti harus sama dengan bukti yang dicatat orang pertama.",
        );
    }
    if (early?.step !== "record") throw payoutStateChanged();
    let recorded = 0;
    for (const row of rows) {
      const recordGrant = early.records.get(row.id);
      if (!recordGrant) throw payoutStateChanged();
      await recordOverpaidItem(
        tx,
        actor,
        row.id,
        { evidenceKey: evidence, note, operationItemIds, recordGrant },
        proofs,
        now,
      );
      recorded += 1;
    }
    return {
      batchStatus: batch.status,
      stage: "recorded",
      recorded,
      proposed: 0,
    };
  }

  // Step one: only a proposal. The same person repeating the same proof is a
  // replay, not a second person: refused. Replacing the proof of an open
  // proposal is refused in SQL too (legend-911 P1-2): withdraw it and propose
  // anew. Answered here as a 409 before any SQL runs.
  if (proposals.some((p) => p.evidenceKey === evidence))
    throw payoutRefuse(
      403,
      "PAYOUT_OVERPAID_SAME_PERSON",
      "Anda sudah mengajukan pencatatan ini. Langkah kedua harus dilakukan orang lain.",
    );
  if (proposals.length > 0) throw proposalReplaceRefused();
  await assertOtherAttemptPaid(tx, tenantId, rows);
  // One trusted call writes the proposal of every item; no direct DML on the
  // proposals (migration 0411).
  if (early?.step !== "propose") throw payoutStateChanged();
  try {
    await tx.execute(
      sql`SELECT app.payout_overpaid_propose(${batch.id}::uuid, ${`{${operationItemIds.join(",")}}`}::uuid[], ${evidence}::varchar, ${note}, ${early.grant})`,
    );
  } catch (error) {
    if (isProposalReplaceViolation(error)) throw proposalReplaceRefused();
    throw proofSpentByWithdrawn(error) ?? error;
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.overpaid_proposed",
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
    recorded: 0,
    proposed: rows.length,
  };
}
