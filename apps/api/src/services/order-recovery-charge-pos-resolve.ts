// A cash or card attempt of a dearer-swap charge whose answer never reached
// the till (legend-f1mmf (d), contract @starter/shared/pos
// `resolvePosIssueChargeAttempt`; the 1268 W2 pattern of
// pos-payment-intent-resolve.ts). A supervisor settles it with their own PIN
// and a reason. No money is invented:
//
// - The approver is never the caller (403), holds the override for the method
//   at the charge's outlet (`void` for cash, `edc_standalone` for a card) and
//   types their PIN (counted on its own). Stating a card `paid` from its slip
//   also needs `payment.reconcile`.
// - Under the charge chain lock (cash collect, card start) and, for a card,
//   the EDC agent's (tenant, outlet:charge) advisory lock:
//   - cash: the movement of that key paid the charge -> `recorded`; else the
//     attempt is closed (`closeAttempt`) and a late arrival is refused.
//   - card: no sale under that key -> closed, the terminal is never asked.
//     `pending` or still on the wire -> 409. `approved` -> recorded once on
//     the charge. `unknown` -> 409 without a statement; `failed` resolves the
//     sale declined (closed, QRIS may follow); `paid` needs the slip and goes
//     through `resolveEdcReconciliation` (late-answer window, wire, amount,
//     one approval, the charge still payable), then is recorded once. A sale
//     flagged for reconciliation otherwise (a late approval) stays locked:
//     409, finance resolves it.
// - 404 for a charge of another tenant, an outlet outside the caller's scope,
//   another outlet than the acting cashier's, or one the caller cannot pay at.

import { and, eq, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  isOutletInScope,
  type ScopedTenantContext,
  type UserId,
  type z,
} from "@starter/shared/core";
import {
  ISSUE_CHARGE_EDC_STATEMENT_REQUIRED,
  ISSUE_CHARGE_SLIP_REQUIRED,
  resolvePosIssueChargeAttempt as resolveContract,
  type PosIssueChargeAttemptOutcome,
  type PosIssueChargeDetail,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { cashMovements } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { outletContext, outletTarget } from "./device-pin-support.ts";
import { resolveEdcReconciliation } from "./edc-reconciliation.service.ts";
import type { Tx } from "./menu-internals.ts";
import { auditCharge, lockChargeChain } from "./order-recovery-charge.ts";
import {
  closeAttempt,
  isAttemptClosed,
} from "./order-recovery-charge-attempt-key.ts";
import {
  assertCollectable,
  assertNoPaidIntentOnLink,
  recordEdcSaleOnCharge,
} from "./order-recovery-charge-pos-nontunai.ts";
import { readPosIssueCharge } from "./order-recovery-charge-pos-read.ts";
import {
  accessSnapshotInTransaction,
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";
import { holdsOverridePermission } from "./staff-override.service.ts";
import { attemptApproverPin } from "./staff-pin-proof.service.ts";

type Input = z.infer<typeof resolveContract.body>;

const PAY = "pos.payment.accept";
const RECONCILE = "payment.reconcile";
const AUDIT_ATTEMPT_RESOLVED = "order_issue.charge_attempt_resolved";

export type ChargeAttemptCaller = {
  readonly userId: UserId;
  readonly deviceId: string | null;
  /** The acting cashier's outlet on a shared device, else null. */
  readonly actingOutletId: string | null;
};

const notFound = () =>
  new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");

const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

/** The charge's outlet when the caller may take its money; 404 otherwise. */
async function outletInReach(
  tx: Tx,
  context: ScopedTenantContext,
  caller: ChargeAttemptCaller,
  charge: { outletId: string } | undefined,
  now: Date,
): Promise<string> {
  if (!charge) throw notFound();
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    caller.userId,
    now,
  );
  if (
    !isOutletInScope(context.outletScope, charge.outletId) ||
    (caller.actingOutletId !== null &&
      caller.actingOutletId.toLowerCase() !== charge.outletId.toLowerCase()) ||
    !snapshot.allows(PAY, { type: "outlet", id: charge.outletId })
  )
    throw notFound();
  return charge.outletId;
}

type Settled = {
  outcome: PosIssueChargeAttemptOutcome;
  edcTransactionId: string | null;
};

async function settleCash(
  tx: Tx,
  context: ScopedTenantContext,
  locked: NonNullable<Awaited<ReturnType<typeof lockChargeChain>>>,
  input: Input,
): Promise<Settled> {
  const tenantId = context.tenant.tenantId;
  const { charge } = locked;
  if (charge.status === "paid" && charge.cashMovementId !== null) {
    const [movement] = await tx
      .select({ key: cashMovements.idempotencyKey })
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, tenantId),
          eq(cashMovements.id, charge.cashMovementId),
        ),
      );
    if (movement?.key === input.idempotencyKey)
      return { outcome: "recorded", edcTransactionId: null };
  }
  await closeAttempt(
    tx,
    tenantId,
    charge.outletId,
    charge.id,
    "cash",
    input.idempotencyKey,
  );
  return { outcome: "closed", edcTransactionId: null };
}

async function settleEdc(
  tx: Tx,
  context: ScopedTenantContext,
  locked: NonNullable<Awaited<ReturnType<typeof lockChargeChain>>>,
  input: Input,
  now: Date,
): Promise<Settled> {
  const tenantId = context.tenant.tenantId;
  const { charge } = locked;
  // The EDC agent's write-ahead lock for this reference: a sale starting now
  // waits, and a sale already written is seen.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${charge.outletId}:${charge.id}`}))`,
  );
  const [sale] = await tx
    .select()
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.outletId, charge.outletId),
        eq(edcTransactions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!sale) {
    await closeAttempt(
      tx,
      tenantId,
      charge.outletId,
      charge.id,
      "edc",
      input.idempotencyKey,
    );
    return { outcome: "closed", edcTransactionId: null };
  }
  const settled = (outcome: PosIssueChargeAttemptOutcome): Settled => ({
    outcome,
    edcTransactionId: sale.id,
  });
  if (sale.type !== "sale" || sale.reference !== charge.id)
    throw conflict("Kunci ini bukan percobaan pembayaran tagihan ini.");
  // Paid by its own approved sale (one approval per reference).
  if (
    charge.status === "paid" &&
    charge.cashMovementId === null &&
    charge.paymentIntentId === null &&
    sale.status === "approved"
  )
    return settled("recorded");
  if (sale.status === "pending" || sale.saleWireOpenAt !== null)
    throw conflict(
      "Terminal masih memproses transaksi ini; tunggu sampai selesai, lalu ulangi.",
    );

  const record = async () => {
    await assertCollectable(tx, tenantId, locked);
    await assertNoPaidIntentOnLink(tx, context, charge.paymentLinkId, true);
    if (sale.mode !== "ecr" || sale.method !== "card")
      throw conflict(
        "Hanya penjualan kartu dari terminal yang bisa dipakai sebagai pembayaran.",
      );
    await recordEdcSaleOnCharge(
      tx,
      context,
      locked,
      input.approverUserId,
      "Selisih swap dibayar EDC, diselesaikan supervisor",
      now,
    );
    return settled("recorded");
  };

  if (sale.status === "unknown") {
    if (input.edc === undefined)
      throw new HttpError(
        409,
        ISSUE_CHARGE_EDC_STATEMENT_REQUIRED,
        "Cek terminal dulu: nyatakan kartu gagal, atau lunas dengan slip.",
      );
    if (input.edc === "failed") {
      await resolveEdcReconciliation(
        tx,
        context,
        {
          edcTransactionId: sale.id,
          outcome: "declined",
          evidence: { source: "inquiry", note: input.reason },
          actorUserId: input.approverUserId,
        },
        now,
      );
      return settled("closed");
    }
    if (input.slip === undefined)
      throw new HttpError(
        409,
        ISSUE_CHARGE_SLIP_REQUIRED,
        "Isi RRN, kode approval, dan nominal dari slip EDC.",
      );
    if (input.slip.chargedAmountIdr !== charge.amountIdr)
      throw conflict(
        "Nominal di slip tidak sama dengan tagihan selisih; transaksi tetap perlu dicek.",
      );
    await resolveEdcReconciliation(
      tx,
      context,
      {
        edcTransactionId: sale.id,
        outcome: "approved",
        evidence: {
          source: "terminal_receipt",
          note: input.reason,
          rrn: input.slip.rrn,
          approvalCode: input.slip.approvalCode,
          chargedAmountIdr: input.slip.chargedAmountIdr,
        },
        actorUserId: input.approverUserId,
      },
      now,
    );
    return record();
  }
  if (sale.needsReconciliation)
    throw conflict(
      "Transaksi EDC ini ditandai perlu dicek bagian keuangan; semua pembayaran tagihan ini terkunci sampai selesai.",
    );
  if (sale.status === "approved") return record();
  // declined, cancelled, failed: the card was not charged; the key replays it.
  return settled("closed");
}

/**
 * POST /api/order-issue-charges/:chargeId/attempts/resolve. Every settled
 * attempt is audited on the issue with the approver and the reason.
 */
export async function resolvePosIssueChargeAttempt(
  context: ScopedTenantContext,
  caller: ChargeAttemptCaller,
  chargeId: string,
  input: Input,
  now = new Date(),
): Promise<{
  outcome: PosIssueChargeAttemptOutcome;
  charge: PosIssueChargeDetail;
}> {
  const { tenant } = context;
  const tenantId = tenant.tenantId;
  const { approverUserId } = input;
  // AUTH-06: the approver is never the requester.
  if (approverUserId.toLowerCase() === caller.userId.toLowerCase())
    throw new AccessError("APPROVER_IS_REQUESTER");

  // 1. The charge in the caller's reach, before the PIN is touched.
  const outletId = await withTenant(db, context, async (tx) => {
    const [charge] = await tx
      .select({ outletId: orderIssueCharges.outletId })
      .from(orderIssueCharges)
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, chargeId),
        ),
      )
      .limit(1);
    return outletInReach(tx, context, caller, charge, now);
  });
  const approver = outletContext(tenant, outletId);
  const assertApprover = async (tx: Tx) => {
    const allowed = await holdsOverridePermission(
      tx,
      tenant,
      approver,
      approverUserId,
      input.method === "edc" ? "edc_standalone" : "void",
      outletId,
      now,
      true,
    );
    // A card stated paid from its slip is a reconciliation: finance's right.
    const reconciles =
      input.edc !== "paid" ||
      resolveAccessSnapshot({
        tenant,
        userId: approverUserId,
        ...(await loadTenantAccessInTransaction(tx, approver, approverUserId, {
          approver: true,
        })),
        mfaVerified: false,
        now,
      }).allows(RECONCILE, outletTarget(outletId));
    if (!allowed || !reconciles)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Penyetuju tidak memiliki izin untuk tindakan ini di outlet ini.",
      );
  };
  await withTenant(db, approver, assertApprover);
  // 2. The PIN: counted and committed on its own.
  await attemptApproverPin(tenant, {
    outletId,
    approverUserId,
    requesterUserId: caller.userId,
    pin: input.pin,
    deviceId: caller.deviceId,
    now,
  });
  // 3. Settle under the charge chain lock (the cash collect's and the card
  //    start's first lock), then the method's own.
  const outcome = await withTenant(db, context, async (tx) => {
    const locked = await lockChargeChain(tx, tenantId, { chargeId });
    await outletInReach(tx, context, caller, locked?.charge, now);
    if (!locked) throw notFound();
    // A role that ended while the PIN was checked fails closed.
    await assertApprover(tx);
    const { charge, issue } = locked;
    const settled: Settled = (await isAttemptClosed(
      tx,
      tenantId,
      charge.outletId,
      charge.id,
      input.method,
      input.idempotencyKey,
    ))
      ? { outcome: "closed", edcTransactionId: null }
      : input.method === "cash"
        ? await settleCash(tx, context, locked, input)
        : await settleEdc(tx, context, locked, input, now);
    await auditCharge(tx, context, {
      outletId: charge.outletId,
      issueId: issue.id,
      action: AUDIT_ATTEMPT_RESOLVED,
      actorUserId: caller.userId,
      reason: input.reason,
      after: {
        chargeId: charge.id,
        status: settled.outcome,
        approvedBy: approverUserId,
        attemptMethod: input.method,
        ...(input.edc ? { statement: input.edc } : {}),
        ...(settled.edcTransactionId
          ? { edcTransactionId: settled.edcTransactionId }
          : {}),
      },
      at: now,
    });
    return settled.outcome;
  });
  return {
    outcome,
    charge: await readPosIssueCharge(
      context,
      { userId: caller.userId, actingOutletId: caller.actingOutletId },
      chargeId,
      now,
    ),
  };
}
