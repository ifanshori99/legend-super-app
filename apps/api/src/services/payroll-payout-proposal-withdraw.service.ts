// Payroll payout: withdraw an open correction or overpaid proposal (bead
// legend-xatux; design docs/briefs/915/design-xatux.md, migration 0658).
//
// Step one of a correction or an overpaid record stores a proposal (proof and
// note) and the items stay `failed`. If the proof was wrong, nobody could take
// it back: the second person could only approve it. This writer marks the
// whole proposal `withdrawn`; the row is never deleted.
//
// Money rules held here (nobody is paid, nobody is paid twice):
// - Nothing is paid and no journal is made. The items are not touched at all:
//   they stay `failed`, are never a live attempt (`one_live_per_payslip`), and
//   the proof-closure hold of their key stays. A slip is never freed for a
//   second payment by a withdraw.
// - Only a step-one proposal: status `proposed`. A proposal already approved or
//   recorded, already withdrawn, or only part of the items of one operation, is
//   refused (409 PAYOUT_PROPOSAL_NOT_WITHDRAWABLE).
// - The proof of a withdrawn proposal can never back a new one (the database
//   refuses it, PAYOUT-75): a new proposal needs a new proof. That only limits.
// - Who: the proposer or another approver (the route holds
//   `payroll.disburse.approve`). The batch requester is refused (403
//   PAYOUT_REQUESTER_CANNOT_WITHDRAW; PAYOUT-64 in SQL).
// - The database writes it: only the trusted functions
//   `app.payout_correction_withdraw` / `app.payout_overpaid_withdraw` (owner
//   `legend_payout`) spend a one-time `withdraw` grant bound to the batch, the
//   item set, the proof key and the operation. `legend_app` has no DML here.
//
// Trusted in-transaction writer: the caller wraps `withTenant`. The grant is
// issued before any lock (its connection would wait on our own `FOR UPDATE`),
// then the run row and batch row are locked (`loadBatchRunFirst`); the trusted
// function locks the items and proposals after that, the order of every step.

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  payrollPayoutFailedCorrections,
  payrollPayoutOverpaidProposals,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  isPayoutUuid,
  loadBatchRunFirst,
  payoutRefuse,
  payoutStateChanged,
  payoutTrustedGrant,
  readBatch,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type WithdrawProposalInput = {
  itemIds: readonly string[];
};

export type WithdrawProposalResult = {
  withdrawn: number;
};

const notWithdrawable = () =>
  payoutRefuse(
    409,
    "PAYOUT_PROPOSAL_NOT_WITHDRAWABLE",
    "Usulan ini tidak bisa dibatalkan: sudah disetujui, sudah dibatalkan, atau item yang dipilih tidak sama dengan seluruh isi usulan.",
  );

const requesterRefused = () =>
  payoutRefuse(
    403,
    "PAYOUT_REQUESTER_CANNOT_WITHDRAW",
    "Pengaju batch tidak boleh membatalkan usulan dari batchnya sendiri.",
  );

/** A database message `PAYOUT-nn:` also behind a driver wrapper. */
function hasPayoutCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      candidate.message.includes(`PAYOUT-${code}:`)) ||
    hasPayoutCode(candidate.cause, code, depth + 1)
  );
}

/**
 * The proof of a withdrawn proposal cannot back a new proposal (PAYOUT-75).
 * Answered as a 409 by the propose paths; null for every other error.
 */
export function proofSpentByWithdrawn(error: unknown) {
  return hasPayoutCode(error, "75")
    ? payoutRefuse(
        409,
        "PAYOUT_PROOF_SPENT_BY_WITHDRAWN",
        "Bukti ini milik usulan yang sudah dibatalkan dan tidak bisa dipakai lagi. Unggah bukti baru.",
      )
    : null;
}

/** The database refusals of the two withdraw functions, as client errors. */
function withdrawError(error: unknown): unknown {
  if (hasPayoutCode(error, "63") || hasPayoutCode(error, "69"))
    return notWithdrawable();
  if (hasPayoutCode(error, "64")) return requesterRefused();
  return proofSpentByWithdrawn(error) ?? error;
}

function checkItemIds(itemIds: readonly string[]): void {
  if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length)
    throw payoutRefuse(
      422,
      "PAYOUT_ITEMS_INVALID",
      "Daftar item kosong atau memuat item yang sama dua kali.",
    );
  if (!itemIds.every(isPayoutUuid))
    throw payoutRefuse(422, "PAYOUT_ITEMS_INVALID", "ID item tidak valid.");
}

/** What the unlocked read found; the trusted function re-checks it all. */
type Plan = {
  evidenceKey: string;
  /** The first row of a correction (its `operation_id`); null for overpaid. */
  operationId: string | null;
};

async function planCorrection(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  itemIds: readonly string[],
): Promise<Plan> {
  const rows = await tx
    .select({
      batchId: payrollPayoutFailedCorrections.batchId,
      operationId: payrollPayoutFailedCorrections.operationId,
      evidenceKey: payrollPayoutFailedCorrections.evidenceKey,
      status: payrollPayoutFailedCorrections.status,
    })
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        inArray(payrollPayoutFailedCorrections.itemId, [...itemIds]),
        ne(payrollPayoutFailedCorrections.status, "withdrawn"),
      ),
    );
  const operations = new Set(rows.map((row) => row.operationId));
  const keys = new Set(rows.map((row) => row.evidenceKey));
  if (
    rows.length !== itemIds.length ||
    operations.size !== 1 ||
    keys.size !== 1 ||
    rows.some((row) => row.status !== "proposed" || row.batchId !== batchId)
  )
    throw notWithdrawable();
  const operationId = [...operations][0]!;
  // The request must name every item of the operation (all or nothing).
  const whole = await tx
    .select({ itemId: payrollPayoutFailedCorrections.itemId })
    .from(payrollPayoutFailedCorrections)
    .where(
      and(
        eq(payrollPayoutFailedCorrections.tenantId, tenantId),
        eq(payrollPayoutFailedCorrections.operationId, operationId),
        ne(payrollPayoutFailedCorrections.status, "withdrawn"),
      ),
    );
  if (whole.length !== itemIds.length) throw notWithdrawable();
  return { evidenceKey: [...keys][0]!, operationId };
}

async function planOverpaid(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  itemIds: readonly string[],
): Promise<Plan> {
  const rows = await tx
    .select({
      batchId: payrollPayoutOverpaidProposals.batchId,
      evidenceKey: payrollPayoutOverpaidProposals.evidenceKey,
      status: payrollPayoutOverpaidProposals.status,
    })
    .from(payrollPayoutOverpaidProposals)
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        inArray(payrollPayoutOverpaidProposals.itemId, [...itemIds]),
        ne(payrollPayoutOverpaidProposals.status, "withdrawn"),
      ),
    );
  const keys = new Set(rows.map((row) => row.evidenceKey));
  if (
    rows.length !== itemIds.length ||
    keys.size !== 1 ||
    rows.some((row) => row.status !== "proposed" || row.batchId !== batchId)
  )
    throw notWithdrawable();
  const evidenceKey = [...keys][0]!;
  // The request must name every item of the (batch, key) group.
  const whole = await tx
    .select({ itemId: payrollPayoutOverpaidProposals.itemId })
    .from(payrollPayoutOverpaidProposals)
    .where(
      and(
        eq(payrollPayoutOverpaidProposals.tenantId, tenantId),
        eq(payrollPayoutOverpaidProposals.batchId, batchId),
        eq(payrollPayoutOverpaidProposals.evidenceKey, evidenceKey),
        ne(payrollPayoutOverpaidProposals.status, "withdrawn"),
      ),
    );
  if (whole.length !== itemIds.length) throw notWithdrawable();
  return { evidenceKey, operationId: null };
}

/** Array literal for a `uuid[]` parameter (ids were checked as UUIDs). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

async function withdrawProposal(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: WithdrawProposalInput,
  kind: "correction" | "overpaid",
): Promise<WithdrawProposalResult> {
  const tenantId = actor.tenantId as TenantId;
  const itemIds = input.itemIds;
  checkItemIds(itemIds);
  // Unlocked reads first: the grant must exist before any lock is taken.
  const peek = await readBatch(tx, actor.tenantId, batchId);
  if (peek.requestedBy === actor.userId) throw requesterRefused();
  const plan =
    kind === "correction"
      ? await planCorrection(tx, tenantId, peek.id, itemIds)
      : await planOverpaid(tx, tenantId, peek.id, itemIds);
  const grant = await payoutTrustedGrant(actor, {
    kind,
    step: "withdraw",
    batchId: peek.id,
    itemIds,
    evidenceKey: plan.evidenceKey,
    refId: plan.operationId,
    targetId: null,
  });

  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  if (batch.channel !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Batch ini bukan transfer bank manual.",
    );
  if (batch.requestedBy === actor.userId) throw requesterRefused();

  let withdrawn: number;
  try {
    const result =
      kind === "correction"
        ? await tx.execute(
            sql`SELECT app.payout_correction_withdraw(${plan.operationId}::uuid, ${grant}) AS n`,
          )
        : await tx.execute(
            sql`SELECT app.payout_overpaid_withdraw(${batch.id}::uuid, ${uuidArray(itemIds)}::uuid[], ${plan.evidenceKey}::varchar, ${grant}) AS n`,
          );
    withdrawn = Number((result.rows[0] as { n: number }).n);
  } catch (error) {
    throw withdrawError(error);
  }
  // The function repeats every check under the lock; a count that differs
  // means the rows moved under us, so nothing is kept.
  if (withdrawn !== itemIds.length) throw payoutStateChanged();

  await recordPayoutAudit(tx, actor, {
    action:
      kind === "correction"
        ? "payroll.disbursement.correction_withdrawn"
        : "payroll.disbursement.overpaid_withdrawn",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    before: { status: batch.status },
    after: {
      status: batch.status,
      itemCount: withdrawn,
      evidenceKey: plan.evidenceKey,
    },
  });
  return { withdrawn };
}

/** Withdraws the open correction proposal that covers exactly these items. */
export function withdrawCorrectionProposal(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: WithdrawProposalInput,
): Promise<WithdrawProposalResult> {
  return withdrawProposal(tx, actor, batchId, input, "correction");
}

/** Withdraws the open overpaid proposal that covers exactly these items. */
export function withdrawOverpaidProposal(
  tx: Tx,
  actor: Actor,
  batchId: string,
  input: WithdrawProposalInput,
): Promise<WithdrawProposalResult> {
  return withdrawProposal(tx, actor, batchId, input, "overpaid");
}
