// EDC reconciliation (legend-x9zmq, EDC-01 follow-up). An ECR sale flagged
// `needs_reconciliation` locks its bill (assertNoOpenEdcRequest) and nothing
// else clears the flag. A person with `payment.reconcile` (Owner, Finance)
// resolves it here after checking the terminal (inquiry, receipt or bank
// statement). Founder rule "jangan sampai rugi": the customer is never charged
// twice and the outlet is never short, so every unclear case is rejected.
//
// - declined: the terminal did not charge. The bill stays unpaid and unlocks.
// - approved: the terminal charged. The row becomes `approved` only when it
//   can be booked exactly once: no other approved sale for the reference, the
//   bill is still open and its remaining balance equals the row amount
//   (assertEdcSaleBillPayable), and the amount printed on the terminal evidence
//   equals the row amount. The tender itself is booked by the normal ECR tender
//   path (edcTenderSettlement), and the bill stays locked to everything else
//   until then. An approved ECR row with no tender yet is only cleared while the
//   bill can still take exactly that tender.
// - Needs a second factor on the session (MFA_REQUIRED), as manual refund settle.
// - A final decline/cancel/fail never flips to approved (late approval): the
//   charge must be voided at the terminal and then resolved as declined.
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EdcError,
  edcTransactionSchema,
  resolveEdcReconciliationBodySchema,
  resolveEdcReconciliationParamsSchema,
  type EdcReconciliationEvidence,
  type EdcReconciliationOutcome,
  type EdcTransaction,
} from "@starter/shared/edc";
import type { EdcTransactionEventName } from "@starter/shared/edc/events";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { posOrderTenders } from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import { emitEdcTransactionEvent } from "../edge/edc/events.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { assertEdcSaleBillPayable } from "./pos-order-support.ts";

export type ResolveEdcReconciliationInput = {
  edcTransactionId: string;
  outcome: EdcReconciliationOutcome;
  evidence: EdcReconciliationEvidence;
  actorUserId: string;
};

/** Who is asking: set by the route from the session, never by the body. */
export type ResolveEdcReconciliationOptions = { readonly mfaVerified: boolean };

type EdcRow = typeof edcTransactions.$inferSelect;

function toDto(row: EdcRow): EdcTransaction {
  // Same projection as the agent's DTO; the strict schema re-applies the
  // card-data filters on read.
  return edcTransactionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    terminalId: row.terminalId,
    bank: row.bank,
    reference: row.reference,
    idempotencyKey: row.idempotencyKey,
    amountIdr: row.amountIdr,
    method: row.method,
    status: row.status,
    trace: row.trace,
    approvalCode: row.approvalCode,
    rrn: row.rrn,
    cardType: row.cardType,
    maskedPan: row.maskedPan,
    responseCode: row.responseCode,
    message: row.message,
    invoiceNo: row.invoiceNo,
    batchNo: row.batchNo,
    needsReconciliation: row.needsReconciliation,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    inquiryCount: row.inquiryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

const notFound = () =>
  new CoreError("NOT_FOUND", "Transaksi EDC tidak ditemukan.");

/** A tender that still counts: the row is booked on a bill (not voided/failed). */
async function hasLiveTender(
  tx: Tx,
  context: ScopedTenantContext,
  edcTransactionId: string,
): Promise<boolean> {
  const [live] = await tx
    .select({ id: posOrderTenders.id })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, context.tenant.tenantId),
        eq(posOrderTenders.edcTransactionId, edcTransactionId),
        notInArray(posOrderTenders.status, ["voided", "failed"]),
      ),
    )
    .limit(1);
  return live !== undefined;
}

/** The amount on the terminal/bank evidence must be exactly what the request
 * was for; otherwise the real charge is not what the books would record. */
function assertChargedAmount(
  row: EdcRow,
  evidence: EdcReconciliationEvidence,
): void {
  if (evidence.chargedAmountIdr !== row.amountIdr)
    throw new EdcError("EDC_AMOUNT_MISMATCH");
}

/**
 * Resolves one flagged ECR sale. Runs in the caller's tenant transaction and
 * does NOT check permission (see `resolveEdcReconciliationForActor`). Returns
 * the updated row as the POS/admin sees it.
 */
export async function resolveEdcReconciliation(
  tx: Tx,
  context: ScopedTenantContext,
  input: ResolveEdcReconciliationInput,
  now = new Date(),
): Promise<EdcTransaction> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const byId = and(
    eq(edcTransactions.tenantId, tenantId),
    eq(edcTransactions.id, input.edcTransactionId),
  );

  const [peek] = await tx
    .select({
      outletId: edcTransactions.outletId,
      reference: edcTransactions.reference,
    })
    .from(edcTransactions)
    .where(byId)
    .limit(1);
  if (!peek) throw notFound();
  try {
    assertOutletInScope(context.outletScope, peek.outletId);
  } catch {
    throw notFound();
  }

  // Same advisory lock as the EDC-01 guard and the agent's write-ahead, taken
  // BEFORE the row lock so the three never interleave or deadlock. The bill's
  // own row is deliberately not locked: a tender holding it waits on this
  // advisory lock and then fails the EDC-01 guard against the new state.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${peek.outletId}:${peek.reference}`}))`,
  );
  const [row] = await tx
    .select()
    .from(edcTransactions)
    .where(byId)
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  if (row.type !== "sale" || !row.needsReconciliation)
    throw new CoreError(
      "CONFLICT",
      "Transaksi ini tidak menunggu rekonsiliasi (sudah diselesaikan atau bukan penjualan).",
    );

  const evidence = input.evidence;
  let nextStatus = row.status;
  let completedAt = row.completedAt;
  let approvalCode = row.approvalCode;
  let rrn = row.rrn;

  if (input.outcome === "declined") {
    if (!["unknown", "declined", "cancelled", "failed"].includes(row.status))
      throw new CoreError(
        "CONFLICT",
        "Transaksi yang sudah disetujui terminal tidak dapat dinyatakan ditolak; void dulu di terminal dan catat lewat jalur void.",
      );
    if (await hasLiveTender(tx, context, row.id))
      throw new CoreError(
        "CONFLICT",
        "Transaksi ini sudah menjadi pembayaran di tagihan; batalkan pembayarannya lebih dulu.",
      );
    if (row.status === "unknown") {
      nextStatus = "declined";
      completedAt = now;
    }
  } else if (row.status === "approved") {
    assertChargedAmount(row, evidence);
    // Already booked as a tender (any mode): only the flag is cleared.
    if (!(await hasLiveTender(tx, context, row.id))) {
      // No tender yet: an ECR sale may be cleared only while the bill can still
      // take exactly this tender (the ECR path then books it once). A
      // hand-keyed entry can never be booked later, so it stays refused.
      if (row.mode !== "ecr")
        throw new CoreError(
          "CONFLICT",
          "Transaksi disetujui ini belum menjadi pembayaran di tagihan; tidak dapat dinyatakan selesai.",
        );
      await assertEdcSaleBillPayable(tx, context, {
        outletId: row.outletId,
        reference: row.reference,
        amountIdr: row.amountIdr,
      });
    }
  } else if (row.status === "unknown") {
    assertChargedAmount(row, evidence);
    const [other] = await tx
      .select({ id: edcTransactions.id })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.outletId, row.outletId),
          eq(edcTransactions.reference, row.reference),
          eq(edcTransactions.type, "sale"),
          eq(edcTransactions.status, "approved"),
          ne(edcTransactions.id, row.id),
        ),
      )
      .limit(1);
    if (other)
      throw new CoreError(
        "CONFLICT",
        "Tagihan ini sudah punya transaksi EDC yang disetujui; void salah satu muatan di terminal lalu nyatakan transaksi ini ditolak.",
      );
    await assertEdcSaleBillPayable(tx, context, {
      outletId: row.outletId,
      reference: row.reference,
      amountIdr: row.amountIdr,
    });
    nextStatus = "approved";
    completedAt = now;
    approvalCode = evidence.approvalCode ?? approvalCode;
    rrn = evidence.rrn ?? rrn;
  } else {
    // Late approval after a final decline/cancel/fail: the final status never
    // flips. The charge is voided at the terminal, then resolved as declined.
    throw new CoreError(
      "CONFLICT",
      "Transaksi ini sudah berstatus akhir tanpa persetujuan. Void muatan di terminal, lalu nyatakan ditolak.",
    );
  }

  const [updated] = await tx
    .update(edcTransactions)
    .set({
      status: nextStatus,
      completedAt,
      approvalCode,
      rrn,
      needsReconciliation: false,
      updatedAt: now,
    })
    .where(and(byId, eq(edcTransactions.needsReconciliation, true)))
    .returning();
  if (!updated) throw new Error("EDC reconciliation update returned no row");

  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: "edc_transaction.reconciliation_resolved",
      objectType: "edc_transaction",
      objectId: updated.id,
      reason: evidence.note,
      maskedChanges: {
        before: { status: row.status, needsReconciliation: true },
        after: {
          status: updated.status,
          needsReconciliation: false,
          outcome: input.outcome,
          evidenceSource: evidence.source,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["status", "needsReconciliation", "outcome", "evidenceSource"],
  );
  if (updated.status !== row.status) {
    const name: EdcTransactionEventName =
      updated.status === "approved"
        ? "edc_transaction.approved"
        : "edc_transaction.declined";
    await emitEdcTransactionEvent(tx, context, { name, row: updated, now });
  }
  return toDto(updated);
}

/**
 * HTTP entry: checks `payment.reconcile` at the row's outlet (Owner, Finance)
 * and the session's second factor, then resolves. The tenant and actor come from the verified session.
 */
export async function resolveEdcReconciliationForActor(
  context: ScopedTenantContext,
  actorUserId: string,
  params: unknown,
  body: unknown,
  options: ResolveEdcReconciliationOptions,
  now = new Date(),
): Promise<EdcTransaction> {
  assertTrustedScopedContext(context);
  const { id } = resolveEdcReconciliationParamsSchema.parse(params);
  const input = resolveEdcReconciliationBodySchema.parse(body);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: edcTransactions.outletId })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, context.tenant.tenantId),
          eq(edcTransactions.id, id),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "payment.reconcile",
      { type: "outlet", id: row.outletId },
      now,
    );
    // Money decision (books a charge or releases a locked bill): a second
    // factor always, whatever the role (precedent: manual refund settle).
    if (!options.mfaVerified) throw new AccessError("MFA_REQUIRED");
    return resolveEdcReconciliation(
      tx,
      context,
      {
        edcTransactionId: id,
        outcome: input.outcome,
        evidence: input.evidence,
        actorUserId,
      },
      now,
    );
  });
}
