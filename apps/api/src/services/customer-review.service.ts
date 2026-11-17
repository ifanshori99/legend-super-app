// Customer reviews (legend-vqicf, docs/briefs/981-reviews.md). Staff functions
// run in the permission-minted `ScopedTenantContext`: the tenant and outlet
// filters sit in the SQL and outlet RLS narrows an outlet manager to their own
// outlets. `body` is personal data: never log it and never copy it into a
// dashboard queue or AI output.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  outletIdSchema,
  outletIdsForQuery,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  customerReviewDtoSchema,
  type CreateCustomerReviewInput,
  type CustomerReviewDto,
  type ListCustomerReviewsQuery,
  type ModerateCustomerReviewInput,
} from "@starter/shared/crm";
import { db } from "../db";
import { customerReviews } from "../db/schema/customer-reviews";
import { orders } from "../db/schema/qr-order";
import { reservations } from "../db/schema/reservation";
import { outlets } from "../db/schema/platform-org";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";

type CustomerReviewRow = typeof customerReviews.$inferSelect;

const notFound = (): HttpError =>
  new HttpError(404, "NOT_FOUND", "Data tidak ditemukan.");

const statusConflict = (): HttpError =>
  new HttpError(
    409,
    "REVIEW_STATUS_CONFLICT",
    "Status ulasan sudah berubah. Muat ulang lalu coba lagi.",
  );

const CURSOR_PATTERN =
  /^(\d{1,15})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function toCustomerReview(row: CustomerReviewRow): CustomerReviewDto {
  return customerReviewDtoSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    reservationId: row.reservationId,
    customerProfileId: row.customerProfileId,
    rating: row.rating,
    body: row.body,
    source: row.source,
    moderationStatus: row.moderationStatus,
    moderatedBy: row.moderatedBy,
    moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    moderationNote: row.moderationNote,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Staff manual entry. The source is always `manual` (a staff member typing a
 * review in), whatever the body says. The review starts `pending`. An order or
 * reservation that is not in the tenant (or outside the caller's outlets, RLS)
 * answers 404.
 */
export async function createCustomerReview(
  context: ScopedTenantContext,
  input: CreateCustomerReviewInput,
): Promise<CustomerReviewDto> {
  assertOutletInScope(context.outletScope, input.outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // The outlet must belong to the caller's tenant (an `all`-scope staff
    // member passes the scope check with any outlet id).
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
      )
      .limit(1);
    if (!outlet) throw notFound();
    if (input.orderId !== undefined) {
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.id, input.orderId),
            eq(orders.outletId, input.outletId),
          ),
        )
        .limit(1);
      if (!order) throw notFound();
    }
    if (input.reservationId !== undefined) {
      const [reservation] = await tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.tenantId, tenantId),
            eq(reservations.id, input.reservationId),
            eq(reservations.outletId, input.outletId),
          ),
        )
        .limit(1);
      if (!reservation) throw notFound();
    }
    const [row] = await tx
      .insert(customerReviews)
      .values({
        id: randomUUID(),
        tenantId,
        outletId: outletIdSchema.parse(input.outletId),
        orderId: input.orderId ?? null,
        reservationId: input.reservationId ?? null,
        rating: input.rating,
        body: input.body ?? null,
        source: "manual",
      })
      .returning();
    return toCustomerReview(row!);
  });
}

/** Staff list, newest first; the cursor is `createdAtMs|id`. */
export async function listCustomerReviews(
  context: ScopedTenantContext,
  query: ListCustomerReviewsQuery,
): Promise<{
  data: CustomerReviewDto[];
  meta: { limit: number; nextCursor: string | null };
}> {
  let after: { at: Date; id: string } | null = null;
  if (query.cursor !== undefined) {
    const match = CURSOR_PATTERN.exec(query.cursor);
    if (!match)
      throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
    after = { at: new Date(Number(match[1])), id: match[2] as string };
  }
  const filter = outletIdsForQuery(
    context.outletScope,
    query.outletId ? [query.outletId] : undefined,
  );
  return withTenant(db, context, async (tx) => {
    // Milliseconds on both sides (filter and order): the cursor carries a JS
    // Date, so a row with microseconds must not compare greater than its own
    // cursor, and same-millisecond rows page by id.
    const createdMs = sql`date_trunc('milliseconds', ${customerReviews.createdAt})`;
    const rows = await tx
      .select()
      .from(customerReviews)
      .where(
        and(
          eq(customerReviews.tenantId, context.tenant.tenantId),
          filter.kind === "outlets"
            ? inArray(customerReviews.outletId, filter.outletIds)
            : undefined,
          query.moderationStatus
            ? eq(customerReviews.moderationStatus, query.moderationStatus)
            : undefined,
          after === null
            ? undefined
            : sql`(${createdMs}, ${customerReviews.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(createdMs), desc(customerReviews.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toCustomerReview),
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
 * Sets the moderation status. The row is locked first, so two moderators
 * acting at once serialise. A review outside the caller's outlet reach is
 * invisible (RLS) and answers 404. A row whose status is no longer the
 * caller's `expectedStatus` answers 409 REVIEW_STATUS_CONFLICT. Back to
 * `pending` clears the moderator.
 */
export async function moderateCustomerReview(
  context: ScopedTenantContext,
  actorUserId: string,
  reviewId: string,
  input: ModerateCustomerReviewInput,
  now = new Date(),
): Promise<CustomerReviewDto> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({
        id: customerReviews.id,
        moderationStatus: customerReviews.moderationStatus,
      })
      .from(customerReviews)
      .where(
        and(
          eq(customerReviews.tenantId, tenantId),
          eq(customerReviews.id, reviewId),
        ),
      )
      .for("update");
    if (!row) throw notFound();
    // Compare-and-set on the status the moderator saw: a second moderator
    // acting on stale data must not overwrite the first decision.
    if (row.moderationStatus !== input.expectedStatus) throw statusConflict();
    const pending = input.status === "pending";
    const [updated] = await tx
      .update(customerReviews)
      .set({
        moderationStatus: input.status,
        moderatedBy: pending ? null : actorUserId,
        moderatedAt: pending ? null : now,
        moderationNote: pending ? null : (input.note ?? null),
      })
      .where(
        and(
          eq(customerReviews.tenantId, tenantId),
          eq(customerReviews.id, reviewId),
        ),
      )
      .returning();
    return toCustomerReview(updated!);
  });
}
