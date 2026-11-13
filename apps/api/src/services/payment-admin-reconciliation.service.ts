// WS-05 settlement exceptions (PRD §3 F13, EDC-06).
import { and, desc, eq, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
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
import type { Tx } from "./permission-resolver.ts";

type CaseRow = typeof cases.$inferSelect;
function view(row: CaseRow, resolvedByName: string | null) {
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
    resolvedByName,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
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
    for (const row of page)
      data.push(view(row, await nameOf(tx, row.resolvedBy)));
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
    const outletOf = (column: typeof cases.outletId) =>
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
        open: sql<number>`count(*) FILTER (WHERE ${cases.status} = 'open')::int`,
        resolvedThisMonth: sql<number>`count(*) FILTER (WHERE ${cases.status} = 'resolved' AND ${cases.resolvedAt} >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta')::int`,
        variance: sql<string>`COALESCE(sum(${cases.varianceIdr}) FILTER (WHERE ${cases.status} = 'open'), 0)::text`,
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
        if (existing.status !== "open")
          throw new HttpError(
            409,
            "CONFLICT",
            "Reconciliation case is already resolved.",
          );
        const [updated] = await tx
          .update(cases)
          .set({
            status: "resolved",
            resolvedBy: actorId,
            resolvedAt: now,
            note: input.note,
          })
          .where(
            and(
              eq(cases.tenantId, context.tenant.tenantId),
              eq(cases.id, caseId),
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
            action: "payment.reconciliation_case_resolved",
            objectType: "payment_reconciliation_case",
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
        const event = eventEnvelopeSchema.parse({
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId: updated.outletId,
          name: "reconciliation_case.resolved",
          version: 1,
          aggregateType: "reconciliation_case",
          aggregateId: updated.id,
          sequence: 1,
          occurredAt: now.toISOString(),
          actor: { type: "user", id: actorId },
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
        return view(updated, await nameOf(tx, actorId));
      },
    );
  });
}
