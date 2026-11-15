// Payroll disbursement, withdraw a step-one resolve proposal (bead
// legend-5rh26; design docs/design/payroll-disbursement.md 7.7).
//
// A first resolve proposal (`resolveManualItems`, step one) stores the
// proposer, outcome, proof key and note on an `exported` item. If the proof was
// wrong (for example a key that was never uploaded) the second person can
// never confirm it, and nobody could change it. This writer clears the
// proposal so a new one can be recorded.
//
// Money rules held here:
// - Only a step-one proposal is withdrawn: status `exported`, `resolved_by`
//   set, `resolved_by_2` NULL. A finished step two is refused.
// - Only the four proposal columns go back to NULL. The item stays `exported`
//   with its attempt number and idempotency key, so it remains the live
//   attempt of its payslip (`one_live_per_payslip`): withdrawing never frees
//   a slip for a second payment.
// - The stored proof object is never deleted, and its existence is not
//   checked (a never-uploaded key must be withdrawable).
// - The route holds `payroll.disburse.approve`: that covers both the proposer
//   and any other approver. Withdrawing only lowers what can be paid out.
// - The batch requester is refused (403 PAYOUT_REQUESTER_CANNOT_WITHDRAW).
//
// Trusted in-transaction writer: the caller wraps `withTenant`. Lock order:
// the run row, then the batch row (`loadBatchRunFirst`), then the items.

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { payrollDisbursementItems } from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  loadBatchRunFirst,
  payoutRefuse,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type WithdrawResolutionInput = {
  itemIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Clears the step-one resolve proposal of the given `exported` items. All or
 * nothing: any item without a withdrawable proposal refuses the whole call.
 */
export async function withdrawResolutionProposal(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: WithdrawResolutionInput,
  now = new Date(),
): Promise<{ withdrawn: number }> {
  const tenantId = actor.tenantId as TenantId;
  const itemIds = input.itemIds;
  if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length)
    throw payoutRefuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Daftar item kosong atau memuat item yang sama dua kali.",
    );
  if (itemIds.some((id) => !UUID.test(id)))
    throw payoutRefuse(422, "PAYOUT_ITEMS_INVALID", "ID item tidak valid.");

  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan transfer bank manual.",
    );
  if (batch.status !== "exported")
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_NOT_EXPORTED",
      "Berkas transfer batch ini belum diunduh atau sudah selesai, jadi tidak ada usulan yang bisa ditarik.",
    );
  // The requester never proposes or confirms a resolution (R5), so they must
  // not clear someone else's proposal either.
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_REQUESTER_CANNOT_WITHDRAW",
      "Pengaju batch tidak boleh menarik usulan penyelesaian orang lain.",
    );

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
    throw payoutRefuse(
      404,
      "PAYOUT_ITEM_NOT_FOUND",
      "Ada item yang bukan bagian dari batch ini.",
    );
  // Check every item first so a refusal leaves nothing half done.
  if (
    rows.some(
      (row) =>
        row.status !== "exported" ||
        row.resolvedBy === null ||
        row.resolvedBy2 !== null,
    )
  )
    throw payoutRefuse(
      409,
      "PAYOUT_PROPOSAL_NOT_WITHDRAWABLE",
      "Ada item yang tidak punya usulan penyelesaian langkah pertama, atau penyelesaiannya sudah selesai.",
    );

  const updated = await tx
    .update(payrollDisbursementItems)
    .set({
      resolvedBy: null,
      resolutionOutcome: null,
      resolutionEvidenceKey: null,
      resolutionNote: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(payrollDisbursementItems.id, [...itemIds]),
        eq(payrollDisbursementItems.status, "exported"),
        isNotNull(payrollDisbursementItems.resolvedBy),
        isNull(payrollDisbursementItems.resolvedBy2),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  // The guard repeats the checks above: a mismatch means the row moved under
  // us, so nothing is kept.
  if (updated.length !== itemIds.length)
    throw payoutRefuse(
      409,
      "PAYOUT_PROPOSAL_NOT_WITHDRAWABLE",
      "Ada item yang tidak punya usulan penyelesaian langkah pertama, atau penyelesaiannya sudah selesai.",
    );

  const proposers = new Set(rows.map((row) => row.resolvedBy));
  // The columns are NULL after the update, so the audit keeps what was taken
  // back (outcome and proof key, or "mixed" when the items differ).
  const uniform = (values: (string | null)[]): string | null => {
    const distinct = new Set(values);
    return distinct.size === 1 ? ([...distinct][0] ?? null) : "mixed";
  };
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.manual_resolve_withdrawn",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    before: {
      status: batch.status,
      outcome: uniform(rows.map((row) => row.resolutionOutcome)),
      evidenceKey: uniform(rows.map((row) => row.resolutionEvidenceKey)),
    },
    after: {
      status: batch.status,
      itemCount: rows.length,
      by: proposers.size === 1 ? [...proposers][0]! : null,
    },
  });
  return { withdrawn: updated.length };
}
