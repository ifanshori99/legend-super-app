// Late funds after a write-off (legend-oan3p). A "missing" reconciliation case
// closed as `resolved` through the approval chain is a write-off. When a LATER
// settlement import matches that sale the funds did arrive: nothing is undone
// automatically (the case stays `resolved`, no journal, no money event). The
// import only queues ONE correction row per case for finance, who closes it
// through the same approval matrix as the case (Owner or Finance Manager, one
// level, approver != requester).
import { and, desc, eq, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import {
  listReconciliationCorrections as listEndpoint,
  resolveReconciliationCorrection as resolveEndpoint,
  reconciliationCorrectionViewSchema,
} from "@starter/shared/payment/admin";
import { db } from "../db/index.ts";
import {
  paymentReconciliationCases as cases,
  paymentReconciliationCorrections as corrections,
} from "../db/schema/payment-admin.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import {
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service.ts";
import type { Tx } from "./permission-resolver.ts";

/** Approval matrix identity of a correction (reuses the `reconciliation_case` policy). */
export const CORRECTION_SOURCE_MODULE = "payment";
export const CORRECTION_ACTION_TYPE = "reconciliation_case";
export const CORRECTION_OBJECT_TYPE = "payment_reconciliation_correction";
/** The approver may be off today, so the chain gets the longest window (7 days). */
const CORRECTION_DEADLINE_MINUTES = 10080;

type CorrectionRow = typeof corrections.$inferSelect;
type CaseRow = typeof cases.$inferSelect;

async function nameOf(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, id));
  return row?.name ?? null;
}

async function viewOf(tx: Tx, row: CorrectionRow) {
  const requestedByName = await nameOf(tx, row.requestedBy);
  return reconciliationCorrectionViewSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    caseId: row.caseId,
    settlementId: row.settlementId,
    settlementLineId: row.settlementLineId,
    mismatchCaseId: row.mismatchCaseId,
    source: row.source,
    reference: row.reference,
    writtenOffIdr: row.writtenOffIdr,
    receivedIdr: row.receivedIdr,
    status: row.status,
    decision: row.decision,
    requestedBy: row.requestedBy,
    requestedByName,
    approvalRequestId: row.approvalChainId,
    approvedBy: row.approvedBy,
    approvedByName: await nameOf(tx, row.approvedBy),
    // The requester is the closer of record.
    resolvedByName: requestedByName ?? (await nameOf(tx, row.resolvedBy)),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Queues the finance correction of a written-off case whose funds arrived
 * later. Idempotent: one row per case for life (`ON CONFLICT DO NOTHING`), and
 * the audit entry is written only by the call that inserted the row. No outbox
 * event, no journal.
 */
export async function openLateFundsCorrection(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    readonly caseRow: CaseRow;
    readonly line: {
      readonly id: string;
      readonly settlementId: string;
      readonly reference: string;
      readonly receivedIdr: number;
    };
    readonly now: Date;
  },
): Promise<CorrectionRow | null> {
  const { caseRow, line, now } = input;
  const [inserted] = await tx
    .insert(corrections)
    .values({
      tenantId: caseRow.tenantId,
      outletId: caseRow.outletId,
      caseId: caseRow.id,
      settlementId: line.settlementId,
      settlementLineId: line.id,
      source: caseRow.source,
      reference: line.reference,
      writtenOffIdr: idr(Math.abs(caseRow.varianceIdr)),
      receivedIdr: idr(line.receivedIdr),
      status: "open",
    })
    .onConflictDoNothing({
      target: [corrections.tenantId, corrections.caseId],
    })
    .returning();
  if (!inserted) return null;
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: caseRow.tenantId,
      outletId: caseRow.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "payment.reconciliation_correction_opened",
      objectType: CORRECTION_OBJECT_TYPE,
      objectId: inserted.id,
      reason: `Funds arrived after write-off: sale matched settlement line ${line.reference}`,
      maskedChanges: {
        before: { caseStatus: caseRow.status },
        after: { status: inserted.status },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["status", "caseStatus"],
  );
  return inserted;
}

export async function listReconciliationCorrections(
  context: ScopedTenantContext,
  actorId: string,
  input: unknown,
) {
  assertTrustedScopedContext(context);
  const query = listEndpoint.query.parse(input);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actorId,
      "payment.reconcile",
      query.outletId
        ? { type: "outlet", id: query.outletId }
        : { type: "tenant" },
      new Date(),
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor);
      if (
        typeof createdAt !== "string" ||
        !uuidSchema.safeParse(id).success ||
        !Number.isFinite(Date.parse(createdAt))
      )
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      cursor = sql`(${corrections.createdAt}, ${corrections.id}) < (${createdAt}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(corrections)
      .where(
        and(
          eq(corrections.tenantId, context.tenant.tenantId),
          query.outletId ? eq(corrections.outletId, query.outletId) : sql`TRUE`,
          query.status ? eq(corrections.status, query.status) : sql`TRUE`,
          cursor,
        ),
      )
      .orderBy(desc(corrections.createdAt), desc(corrections.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const data = [];
    for (const row of page) data.push(await viewOf(tx, row));
    const last = page.at(-1);
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function resolveReconciliationCorrection(
  context: ScopedTenantContext,
  actorId: string,
  params: unknown,
  body: unknown,
  key: string,
) {
  assertTrustedScopedContext(context);
  const { correctionId } = resolveEndpoint.params.parse(params);
  const input = resolveEndpoint.body.parse(body);
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(corrections)
      .where(
        and(
          eq(corrections.tenantId, context.tenant.tenantId),
          eq(corrections.id, correctionId),
        ),
      )
      .for("update");
    if (!existing)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Reconciliation correction not found.",
      );
    const now = new Date();
    await assertPaymentPermission(
      tx,
      context,
      actorId,
      "payment.reconcile",
      { type: "outlet", id: existing.outletId },
      now,
    );
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actorId,
      key,
      "reconciliation.correction_resolve",
      { correctionId, ...input },
      async () => {
        if (existing.status !== "open")
          throw new HttpError(
            409,
            "CONFLICT",
            existing.status === "pending_approval"
              ? "Reconciliation correction is already waiting for approval."
              : "Reconciliation correction is already resolved.",
          );
        // Never closed by its requester alone. A missing policy
        // (APPROVAL_POLICY_MISSING) propagates and rolls back (fail closed).
        const opened = await openApprovalRequest(tx, context, {
          sourceModule: CORRECTION_SOURCE_MODULE,
          actionType: CORRECTION_ACTION_TYPE,
          objectType: CORRECTION_OBJECT_TYPE,
          objectId: existing.id,
          amountIdr: existing.writtenOffIdr,
          outletId: existing.outletId,
          requestedBy: actorId,
          source: "user",
          requestReason: input.note,
          payload: {
            caseId: existing.caseId,
            settlementId: existing.settlementId,
            decision: input.decision,
          },
          deadlineMinutes: CORRECTION_DEADLINE_MINUTES,
          now,
        });
        if (!opened.required)
          throw new HttpError(
            409,
            "CONFLICT",
            "Reconciliation correction cannot be closed without an approval policy.",
          );
        const [updated] = await tx
          .update(corrections)
          .set({
            status: "pending_approval",
            approvalChainId: opened.chainId,
            requestedBy: actorId,
            decision: input.decision,
            note: input.note,
          })
          .where(
            and(
              eq(corrections.tenantId, context.tenant.tenantId),
              eq(corrections.id, correctionId),
              eq(corrections.status, "open"),
            ),
          )
          .returning();
        if (!updated) throw new Error("Correction update returned no row");
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId: context.tenant.tenantId,
            outletId: updated.outletId,
            actorType: "user",
            actorId,
            deviceId: null,
            action: "payment.reconciliation_correction_resolution_requested",
            objectType: CORRECTION_OBJECT_TYPE,
            objectId: updated.id,
            reason: input.note,
            maskedChanges: {
              before: { status: existing.status },
              after: { status: updated.status, decision: updated.decision },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          ["status", "decision"],
        );
        return viewOf(tx, updated);
      },
    );
  });
}

/**
 * Settles the correction a resolved approval chain belongs to (the
 * `approval.resolved` consumer). The chain outcome and final approver are
 * re-read from the database under the row lock: an event is only a trigger.
 * Idempotent: a correction no longer `pending_approval` is returned unchanged.
 *
 * - approved by someone other than the requester who still holds
 *   `payment.reconcile` at the outlet: `resolved` (decision kept);
 * - rejected, expired, or an approver failing those checks: back to `open`.
 *
 * No outbox event and no journal: finance acts on the decision elsewhere.
 */
export async function settleReconciliationCorrectionForApproval(
  tx: Tx,
  context: ScopedTenantContext,
  ref: { readonly correctionId: string } | { readonly chainId: string },
  now: Date = new Date(),
): Promise<CorrectionRow | null> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select()
    .from(corrections)
    .where(
      and(
        eq(corrections.tenantId, tenantId),
        "correctionId" in ref
          ? eq(corrections.id, ref.correctionId)
          : eq(corrections.approvalChainId, ref.chainId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) return null;
  if (row.status !== "pending_approval" || row.approvalChainId === null)
    return row;
  if ("chainId" in ref && row.approvalChainId !== ref.chainId) return row;
  const chainId = row.approvalChainId;
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: CORRECTION_SOURCE_MODULE,
    now,
  });
  if (outcome === "pending") return row;
  let approver: string | null = null;
  if (outcome === "approved") {
    const levels = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        objectType: approvalRequests.objectType,
        objectId: approvalRequests.objectId,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.chainId, chainId),
        ),
      )
      .orderBy(desc(approvalRequests.level));
    const last = levels[0];
    // The chain must be this correction's own, approved by someone other than
    // the requester; otherwise it stays open (never closed on doubt).
    if (
      last?.decidedBy &&
      levels.every(
        (level) =>
          level.objectType === CORRECTION_OBJECT_TYPE &&
          level.objectId === row.id &&
          level.decidedBy !== null &&
          level.decidedBy.toLowerCase() !== row.requestedBy?.toLowerCase(),
      )
    ) {
      try {
        await assertPaymentPermission(
          tx,
          context,
          last.decidedBy,
          "payment.reconcile",
          { type: "outlet", id: row.outletId },
          now,
        );
        approver = last.decidedBy;
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
      }
    }
  }
  const closed = approver !== null && row.requestedBy !== null;
  const [updated] = await tx
    .update(corrections)
    .set(
      closed
        ? {
            status: "resolved",
            resolvedBy: row.requestedBy,
            approvedBy: approver,
            resolvedAt: now,
          }
        : { status: "open", approvalChainId: null, decision: null },
    )
    .where(
      and(
        eq(corrections.tenantId, tenantId),
        eq(corrections.id, row.id),
        eq(corrections.status, "pending_approval"),
      ),
    )
    .returning();
  if (!updated) throw new Error("Correction update returned no row");
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: updated.outletId,
      actorType: closed ? "user" : "system",
      actorId: closed ? approver : null,
      deviceId: null,
      action: closed
        ? "payment.reconciliation_correction_resolved"
        : outcome === "expired"
          ? "payment.reconciliation_correction_resolution_expired"
          : "payment.reconciliation_correction_resolution_rejected",
      objectType: CORRECTION_OBJECT_TYPE,
      objectId: updated.id,
      reason: row.note,
      maskedChanges: {
        before: { status: row.status },
        after: { status: updated.status, decision: updated.decision },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["status", "decision"],
  );
  return updated;
}
