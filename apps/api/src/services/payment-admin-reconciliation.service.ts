// WS-05 settlement exceptions (PRD §3 F13, EDC-06).
import { and, desc, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  uuidSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  listReconciliationCases as listEndpoint,
  getReconciliationSummary as summaryEndpoint,
  resolveReconciliationCase as resolveEndpoint,
  reconciliationCaseViewSchema,
  reconciliationSummarySchema,
} from "@starter/shared/payment/admin";
import { db } from "../db/index.ts";
import { paymentReconciliationCases as cases } from "../db/schema/payment-admin.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { paymentSettlementLines as lines } from "../db/schema/payment-settlement.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  assertPaymentPermission,
  EVENT_DESTINATION,
} from "./payment-support.ts";
import {
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service.ts";
import type { Tx } from "./permission-resolver.ts";

/** Approval matrix identity of a reconciliation case (one chain per resolve request). */
export const RECONCILIATION_SOURCE_MODULE = "payment";
export const RECONCILIATION_ACTION_TYPE = "reconciliation_case";
export const RECONCILIATION_OBJECT_TYPE = "payment_reconciliation_case";
/** The approver may be off today, so the chain gets the longest window (7 days). */
const RECONCILIATION_DEADLINE_MINUTES = 10080;

type CaseRow = typeof cases.$inferSelect;
async function viewOf(tx: Tx, row: CaseRow) {
  const requestedByName = await nameOf(tx, row.requestedBy);
  return view(
    row,
    requestedByName,
    await nameOf(tx, row.approvedBy),
    // The requester is the closer of record; legacy resolved rows have only resolved_by.
    requestedByName ?? (await nameOf(tx, row.resolvedBy)),
  );
}
function view(
  row: CaseRow,
  requestedByName: string | null,
  approvedByName: string | null,
  resolvedByName: string | null,
) {
  return reconciliationCaseViewSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    settlementId: row.settlementId,
    settlementLineId: row.settlementLineId,
    source: row.source,
    provider: row.provider,
    reference: row.reference,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    expectedIdr: row.expectedIdr,
    receivedIdr: row.receivedIdr,
    varianceIdr: row.varianceIdr,
    reason: row.reason,
    status: row.status,
    note: row.note,
    requestedByName,
    approvedByName,
    resolvedByName,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    approvalRequestId: row.approvalChainId,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
  });
}
async function nameOf(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, id));
  return row?.name ?? null;
}

export async function listReconciliationCases(
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
      cursor = sql`(${cases.createdAt}, ${cases.id}) < (${createdAt}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.tenantId, context.tenant.tenantId),
          query.outletId ? eq(cases.outletId, query.outletId) : sql`TRUE`,
          query.status ? eq(cases.status, query.status) : sql`TRUE`,
          query.source ? eq(cases.source, query.source) : sql`TRUE`,
          cursor,
        ),
      )
      .orderBy(desc(cases.createdAt), desc(cases.id))
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

export async function getReconciliationSummary(
  context: ScopedTenantContext,
  actorId: string,
  input: unknown,
) {
  assertTrustedScopedContext(context);
  const query = summaryEndpoint.query.parse(input);
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
    const outletOf = (column: AnyPgColumn) =>
      query.outletId ? eq(column, query.outletId) : sql`TRUE`;
    const tenantId = context.tenant.tenantId;
    const [lineCounts] = await tx
      .select({
        matched: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'matched')::int`,
        mismatch: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'mismatch')::int`,
        unmatched: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'unmatched')::int`,
      })
      .from(lines)
      .where(and(eq(lines.tenantId, tenantId), outletOf(lines.outletId)));
    const [caseCounts] = await tx
      .select({
        open: sql<number>`count(*) FILTER (WHERE ${cases.status} IN ('open','pending_approval'))::int`,
        resolvedThisMonth: sql<number>`count(*) FILTER (WHERE ${cases.status} = 'resolved' AND ${cases.resolvedAt} >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta')::int`,
        variance: sql<string>`COALESCE(sum(${cases.varianceIdr}) FILTER (WHERE ${cases.status} IN ('open','pending_approval')), 0)::text`,
      })
      .from(cases)
      .where(and(eq(cases.tenantId, tenantId), outletOf(cases.outletId)));
    return reconciliationSummarySchema.parse({
      matchedLines: lineCounts?.matched ?? 0,
      unmatchedLines: lineCounts?.unmatched ?? 0,
      mismatchLines: lineCounts?.mismatch ?? 0,
      openCases: caseCounts?.open ?? 0,
      resolvedThisMonth: caseCounts?.resolvedThisMonth ?? 0,
      varianceIdr: Number(caseCounts?.variance ?? "0"),
    });
  });
}

export async function resolveReconciliationCase(
  context: ScopedTenantContext,
  actorId: string,
  params: unknown,
  body: unknown,
  key: string,
) {
  assertTrustedScopedContext(context);
  const { caseId } = resolveEndpoint.params.parse(params);
  const input = resolveEndpoint.body.parse(body);
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(cases)
      .where(
        and(eq(cases.tenantId, context.tenant.tenantId), eq(cases.id, caseId)),
      )
      .for("update");
    if (!existing)
      throw new HttpError(404, "NOT_FOUND", "Reconciliation case not found.");
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
      "reconciliation.resolve",
      { caseId, ...input },
      async () => {
        if (existing.status === "matched")
          throw new HttpError(
            409,
            "CONFLICT",
            "Reconciliation case was closed automatically: its sale was matched in a settlement report.",
          );
        if (existing.status !== "open")
          throw new HttpError(
            409,
            "CONFLICT",
            existing.status === "pending_approval"
              ? "Reconciliation case is already waiting for approval."
              : "Reconciliation case is already resolved.",
          );
        // A case is never closed by its requester alone: it waits for a chain
        // approved by someone else. A missing policy (APPROVAL_POLICY_MISSING)
        // propagates and rolls back: the case stays open (fail closed).
        const opened = await openApprovalRequest(tx, context, {
          sourceModule: RECONCILIATION_SOURCE_MODULE,
          actionType: RECONCILIATION_ACTION_TYPE,
          objectType: RECONCILIATION_OBJECT_TYPE,
          objectId: existing.id,
          amountIdr: Math.abs(existing.varianceIdr),
          outletId: existing.outletId,
          requestedBy: actorId,
          source: "user",
          requestReason: input.note,
          payload: { settlementId: existing.settlementId },
          deadlineMinutes: RECONCILIATION_DEADLINE_MINUTES,
          now,
        });
        // The matrix needs no approval: still refuse (fail closed) so no case
        // closes without an approver.
        if (!opened.required)
          throw new HttpError(
            409,
            "CONFLICT",
            "Reconciliation case cannot be closed without an approval policy.",
          );
        const [updated] = await tx
          .update(cases)
          .set({
            status: "pending_approval",
            approvalChainId: opened.chainId,
            requestedBy: actorId,
            note: input.note,
          })
          .where(
            and(
              eq(cases.tenantId, context.tenant.tenantId),
              eq(cases.id, caseId),
              eq(cases.status, "open"),
            ),
          )
          .returning();
        if (!updated) throw new Error("Case update returned no row");
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
            action: "payment.reconciliation_case_resolution_requested",
            objectType: RECONCILIATION_OBJECT_TYPE,
            objectId: updated.id,
            reason: input.note,
            maskedChanges: {
              before: { status: existing.status },
              after: { status: updated.status },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          ["status"],
        );
        return viewOf(tx, updated);
      },
    );
  });
}

/** The settlement line that already carries this missing case's sale, if any. */
async function findLineOfSale(
  tx: Tx,
  tenantId: TenantId,
  row: CaseRow,
): Promise<{ reference: string; lineNo: number } | null> {
  if (row.sourceTransactionId === null) return null;
  const [line] = await tx
    .select({ reference: lines.reference, lineNo: lines.lineNo })
    .from(lines)
    .where(
      and(
        eq(lines.tenantId, tenantId),
        eq(lines.outletId, row.outletId),
        eq(
          row.source === "edc"
            ? lines.matchedEdcTransactionId
            : lines.matchedPaymentIntentId,
          row.sourceTransactionId,
        ),
      ),
    )
    .limit(1);
  return line ?? null;
}

/**
 * Settles the case a resolved approval chain belongs to (the `approval.resolved`
 * consumer, or a caller that already knows the case). The chain outcome and the
 * final approver are re-read from the database under the case row lock: an
 * event is only a trigger, never the authority. Idempotent: a case that is no
 * longer `pending_approval` is returned unchanged.
 *
 * - approved by someone other than the requester, who still holds
 *   `payment.reconcile` at the outlet: `resolved` (resolvedBy = requester,
 *   approvedBy = the final approver);
 * - rejected, expired, or an approver that fails those checks: back to `open`.
 */
export async function settleReconciliationCaseForApproval(
  tx: Tx,
  context: ScopedTenantContext,
  ref: { readonly caseId: string } | { readonly chainId: string },
  now: Date = new Date(),
): Promise<CaseRow | null> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, tenantId),
        "caseId" in ref
          ? eq(cases.id, ref.caseId)
          : eq(cases.approvalChainId, ref.chainId),
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
    sourceModule: RECONCILIATION_SOURCE_MODULE,
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
    // The chain must be this case's own, and approved by someone other than
    // the requester; otherwise the case stays open (never closed on doubt).
    if (
      last?.decidedBy &&
      levels.every(
        (level) =>
          level.objectType === RECONCILIATION_OBJECT_TYPE &&
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
  // The sale may have reached a settlement line after the close was requested
  // (e.g. a later report): the money did arrive, so never write it off. Close
  // as `matched`: no resolution event, no approver, no resolver.
  const matchedLine =
    outcome === "approved" &&
    row.settlementLineId === null &&
    row.sourceTransactionId !== null
      ? await findLineOfSale(tx, tenantId, row)
      : null;
  if (matchedLine) {
    const note = `Closed automatically: sale matched a settlement line (report ${matchedLine.reference}, line ${matchedLine.lineNo})`;
    const [matched] = await tx
      .update(cases)
      .set({ status: "matched", note })
      .where(
        and(
          eq(cases.tenantId, tenantId),
          eq(cases.id, row.id),
          eq(cases.status, "pending_approval"),
        ),
      )
      .returning();
    if (!matched) throw new Error("Case update returned no row");
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: matched.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.reconciliation_case_matched_closed",
        objectType: RECONCILIATION_OBJECT_TYPE,
        objectId: matched.id,
        reason: note,
        maskedChanges: {
          before: { status: row.status },
          after: { status: matched.status },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["status"],
    );
    return matched;
  }
  const closed = approver !== null && row.requestedBy !== null;
  const [updated] = await tx
    .update(cases)
    .set(
      closed
        ? {
            status: "resolved",
            resolvedBy: row.requestedBy,
            approvedBy: approver,
            resolvedAt: now,
          }
        : { status: "open", approvalChainId: null },
    )
    .where(
      and(
        eq(cases.tenantId, tenantId),
        eq(cases.id, row.id),
        eq(cases.status, "pending_approval"),
      ),
    )
    .returning();
  if (!updated) throw new Error("Case update returned no row");
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
        ? "payment.reconciliation_case_resolved"
        : outcome === "expired"
          ? "payment.reconciliation_case_resolution_expired"
          : "payment.reconciliation_case_resolution_rejected",
      objectType: RECONCILIATION_OBJECT_TYPE,
      objectId: updated.id,
      reason: row.note,
      maskedChanges: {
        before: { status: row.status },
        after: { status: updated.status },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["status"],
  );
  if (closed && approver !== null) {
    const event = eventEnvelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId: updated.outletId,
      name: "reconciliation_case.resolved",
      version: 1,
      aggregateType: "reconciliation_case",
      aggregateId: updated.id,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: approver },
      deviceId: null,
      idempotencyKey: `reconciliation_case.resolved:${updated.id}`,
      payloadSchemaRef: "reconciliation_case.resolved.v1",
      payload: { caseId: updated.id, settlementId: updated.settlementId },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
    });
  }
  return updated;
}
