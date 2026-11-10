// Member feedback and the staff feedback queue (legend-ts50, docs/briefs/290d,
// docs/design/ws08-member-loyalty.md §M4). Member functions take the profile
// only from `MemberScope`, never from the request. Staff functions run in the
// permission-minted `ScopedTenantContext`, so outlet RLS narrows an outlet
// manager to their own outlet.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  crmErrorMessages,
  feedbackSchema,
  transitionFeedback,
  type CrmErrorCode,
  type Feedback,
  type FeedbackAction,
  type FeedbackStatus,
  type submitFeedbackInputSchema,
} from "@starter/shared/crm";
import { db } from "../db";
import { withMemberScope, type MemberScope } from "../db/member-scope";
import { feedback } from "../db/schema/crm-feedback";
import { sessionParticipants, tableSessions } from "../db/schema/floor";
import { orders } from "../db/schema/qr-order";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import type { Tx } from "./permission-resolver";

type FeedbackRow = typeof feedback.$inferSelect;
export type SubmitFeedbackInput = z.output<typeof submitFeedbackInputSchema>;
export type FeedbackListQuery = {
  cursor?: string;
  limit: number;
  status?: FeedbackStatus;
  kind?: "rating" | "complaint";
  outletId?: string;
};

const crmError = (code: CrmErrorCode, status: number): HttpError =>
  new HttpError(status, code, crmErrorMessages[code]);

const notFound = (): HttpError =>
  new HttpError(404, "NOT_FOUND", "Data tidak ditemukan.");

const invalid = (message: string): HttpError =>
  new HttpError(422, "VALIDATION_ERROR", message);

export function toFeedback(row: FeedbackRow): Feedback {
  return feedbackSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableSessionId: row.tableSessionId,
    customerProfileId: row.customerProfileId,
    orderId: row.orderId,
    kind: row.kind,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    handledBy: row.handledBy,
    handledNote: row.handledNote,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  });
}

/** True when a Postgres unique violation (23505) sits anywhere in the cause chain. */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

/**
 * A member leaves a rating or complaint for an order they own, or a table
 * session they joined. Anything else is a generic 404 so existence of other
 * members' orders never leaks.
 */
export async function submitFeedback(
  scope: MemberScope,
  input: SubmitFeedbackInput,
  now = new Date(),
): Promise<Feedback> {
  const profileId = scope.customerProfileId;
  if (profileId === null) throw crmError("CUSTOMER_NOT_FOUND", 404);
  if (input.orderId === null && input.tableSessionId === null)
    throw invalid("Sebutkan pesanan atau sesi meja.");
  if (input.kind === "rating" && input.rating === null)
    throw invalid("Penilaian membutuhkan skor.");
  if (input.kind === "complaint" && input.comment === null)
    throw invalid("Keluhan membutuhkan deskripsi.");
  const tenantId = tenantIdSchema.parse(scope.tenantId);

  try {
    return await withMemberScope(db, scope, async (tx) => {
      let outletId: string | null = null;
      if (input.orderId !== null) {
        const [order] = await tx
          .select({ outletId: orders.outletId })
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.id, input.orderId),
              eq(orders.customerProfileId, profileId),
            ),
          )
          .limit(1);
        if (!order) throw notFound();
        outletId = order.outletId;
      }
      if (input.tableSessionId !== null) {
        const [session] = await tx
          .select({ outletId: tableSessions.outletId })
          .from(tableSessions)
          .innerJoin(
            sessionParticipants,
            and(
              eq(sessionParticipants.tenantId, tableSessions.tenantId),
              eq(sessionParticipants.tableSessionId, tableSessions.id),
            ),
          )
          .where(
            and(
              eq(tableSessions.tenantId, tenantId),
              eq(tableSessions.id, input.tableSessionId),
              eq(sessionParticipants.userId, scope.userId),
            ),
          )
          .limit(1);
        if (!session) throw notFound();
        if (outletId !== null && outletId !== session.outletId)
          throw notFound();
        outletId = session.outletId;
      }
      if (outletId === null) throw notFound();
      if (input.orderId === null)
        await assertNoSessionDuplicate(tx, scope, input);

      const [row] = await tx
        .insert(feedback)
        .values({
          id: randomUUID(),
          tenantId,
          outletId: outletIdSchema.parse(outletId),
          tableSessionId: input.tableSessionId,
          customerProfileId: profileId,
          orderId: input.orderId,
          kind: input.kind,
          rating: input.rating,
          comment: input.comment,
          status: "open",
          createdAt: now,
        })
        .returning();
      return toFeedback(row!);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw crmError("FEEDBACK_DUPLICATE", 409);
    throw error;
  }
}

/**
 * The order unique key skips NULL orders, so a session-only duplicate is
 * checked here; the partial index `feedback_session_profile_kind_key` is the
 * backstop for parallel posts (23505, mapped in the caller).
 */
async function assertNoSessionDuplicate(
  tx: Tx,
  scope: MemberScope,
  input: SubmitFeedbackInput,
): Promise<void> {
  const [existing] = await tx
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        eq(feedback.tenantId, tenantIdSchema.parse(scope.tenantId)),
        eq(feedback.customerProfileId, scope.customerProfileId!),
        eq(feedback.kind, input.kind),
        eq(feedback.tableSessionId, input.tableSessionId!),
        sql`${feedback.orderId} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) throw crmError("FEEDBACK_DUPLICATE", 409);
}

const CURSOR_PATTERN =
  /^(\d{1,15})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Staff queue, newest first; the cursor is `createdAtMs|id`. */
export async function listFeedback(
  context: ScopedTenantContext,
  query: FeedbackListQuery,
): Promise<{
  data: Feedback[];
  meta: { limit: number; nextCursor: string | null };
}> {
  let after: { at: Date; id: string } | null = null;
  if (query.cursor !== undefined) {
    const match = CURSOR_PATTERN.exec(query.cursor);
    if (!match)
      throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
    after = { at: new Date(Number(match[1])), id: match[2] as string };
  }
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.tenantId, context.tenant.tenantId),
          query.status ? eq(feedback.status, query.status) : undefined,
          query.kind ? eq(feedback.kind, query.kind) : undefined,
          query.outletId
            ? eq(feedback.outletId, outletIdSchema.parse(query.outletId))
            : undefined,
          after === null
            ? undefined
            : sql`(${feedback.createdAt}, ${feedback.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toFeedback),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? `${last.createdAt.getTime()}|${last.id}`
            : null,
      },
    };
  });
}

/**
 * Moves one item through `transitionFeedback`. The row is locked first, so two
 * staff acting at once serialise and the loser gets 409. An item outside the
 * caller's outlet reach is invisible (RLS) and answers 404.
 */
export async function updateFeedback(
  context: ScopedTenantContext,
  actorUserId: string,
  feedbackId: string,
  action: FeedbackAction,
  handledNote: string | undefined,
  now = new Date(),
): Promise<Feedback> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.tenantId, context.tenant.tenantId),
          eq(feedback.id, feedbackId),
        ),
      )
      .for("update");
    if (!row) throw notFound();
    let next: FeedbackStatus;
    try {
      next = transitionFeedback(row.status, action);
    } catch {
      throw crmError("FEEDBACK_TRANSITION_INVALID", 409);
    }
    const resolved = next === "resolved" || next === "closed";
    const [updated] = await tx
      .update(feedback)
      .set({
        status: next,
        handledBy: row.handledBy ?? actorUserId,
        handledNote: handledNote ?? row.handledNote,
        resolvedAt: resolved ? (row.resolvedAt ?? now) : null,
      })
      .where(
        and(
          eq(feedback.tenantId, context.tenant.tenantId),
          eq(feedback.id, feedbackId),
        ),
      )
      .returning();
    return toFeedback(updated!);
  });
}
