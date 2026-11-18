// Finance waives a `settle_skipped` cash handover (bead legend-5qqb9, P2).
//
// A cash payroll handover done while accounting was off ends as `settle_skipped`
// and keeps counting as a pending credit against GL 1102 (the cash left the
// till, nobody may spend it twice). Its catch-up journal is impossible without
// the run's payroll.locked journal, so finance may close it by hand: the kind
// flips `settle_skipped` -> `settle_waived` (terminal, migration 0690), with a
// reason and an audit row. No journal is written and the GL does not move; the
// net simply stops counting as a reserve, so the available cash rises by it.
// That is the intended, explicit effect of the decision.
//
// Only for a cash batch whose run has NO locked journal and NO queued
// `payroll.locked` event. Otherwise the resolver (legend-vvzij) catches the
// skipped posting up by itself, and a waive would drop a credit that must be
// journaled (a bank handover is never waivable). Migration 0690 mirrors the
// cash condition in the guard trigger.
//
// Lock order matches `recordPostingSource`: run row, batch row
// (`loadBatchRunFirst`), the legal entity's cash/bank lock and the batch
// advisory lock (`lockBatchPayoutGl`), then the posting row. The entity lock is
// the one every 1102 coverage check holds while it reads the reserve, so a
// waive never interleaves with a spend that counted the old reserve.

import { and, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { payrollPayoutGlPostings } from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  lockBatchPayoutGl,
  runHasLockedJournal,
  runLockPending,
} from "./payroll-payout-gl.service.ts";
import {
  loadBatchRunFirst,
  payoutGuardViolation,
  payoutRefuse,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type WaiveSkippedPostingResult = {
  postingId: string;
  kind: "settle_waived";
  /** True when the posting was already waived: nothing changed, no new audit row. */
  alreadyWaived: boolean;
};

/**
 * Waives one `settle_skipped` posting. Any other kind than `settle_skipped` /
 * `settle_waived` answers 409; a posting that is already `settle_waived`
 * answers success without a second flip or audit row. The accounting module
 * state is irrelevant (the point is the case where it was off).
 */
export async function waiveSkippedPosting(
  tx: Tx,
  actor: Actor,
  batchId: string,
  postingId: string,
  reason: string,
): Promise<WaiveSkippedPostingResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  await lockBatchPayoutGl(tx, tenantId, batch);
  const [posting] = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.batchId, batch.id),
        eq(payrollPayoutGlPostings.id, postingId),
      ),
    )
    .limit(1)
    .for("update");
  if (!posting)
    throw payoutRefuse(
      404,
      "PAYOUT_POSTING_NOT_FOUND",
      "Posting tidak ditemukan.",
    );
  if (posting.kind === "settle_waived")
    return {
      postingId: posting.id,
      kind: "settle_waived",
      alreadyWaived: true,
    };
  if (posting.kind !== "settle_skipped")
    throw payoutRefuse(
      409,
      "PAYOUT_POSTING_NOT_SKIPPED",
      "Hanya posting yang dilewati karena akuntansi mati yang bisa dibebaskan.",
    );
  if (
    batch.channel !== "cash" ||
    (await runHasLockedJournal(tx, tenantId, batch.payrollRunId)) ||
    (await runLockPending(tx, tenantId, batch.payrollRunId))
  )
    throw payoutRefuse(
      409,
      "PAYOUT_WAIVE_NOT_ALLOWED",
      "Posting ini tidak bisa dibebaskan. Hanya batch tunai yang run-nya belum punya jurnal kunci gaji dan tidak sedang menunggunya yang boleh; selain itu jurnalnya dibuat otomatis.",
    );
  try {
    await tx
      .update(payrollPayoutGlPostings)
      .set({ kind: "settle_waived" })
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          eq(payrollPayoutGlPostings.id, posting.id),
          eq(payrollPayoutGlPostings.kind, "settle_skipped"),
        ),
      );
  } catch (error) {
    if (payoutGuardViolation(error) !== null)
      throw payoutRefuse(
        409,
        "PAYOUT_BATCH_STATE_CHANGED",
        "Status batch berubah saat diproses. Coba lagi.",
      );
    throw error;
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.posting_waived",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    reason,
    before: { postingId: posting.id, kind: "settle_skipped" },
    after: {
      postingId: posting.id,
      kind: "settle_waived",
      settleNetIdr: posting.settleNetIdr,
    },
  });
  return { postingId: posting.id, kind: "settle_waived", alreadyWaived: false };
}
