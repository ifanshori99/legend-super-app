// Unallocated funds: money that arrived without a bill remainder (bead
// legend-gz3; PRD v1.7 §3.13, PAY-04).
//
// Two cases create a row: a second payment for an intent that is already
// settled, and a payment above the amount due. The money is never deleted or
// silently absorbed; a resolution is either a refund or a credit, and it needs
// an approval reference (PRD: "diselesaikan melalui refund atau kredit dengan
// approval"). Resolution goes only through the HTTP payment admin endpoint
// (payment-admin-funds.service.ts), which opens a pending refund for approval;
// the former in-process resolver accepted any approval reference and was
// removed in the Opus review of legend-2lq0 (fail closed).

import {
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { asc, and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { paymentUnallocatedFunds } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { assertPaymentPermission } from "./payment-support";

export const listUnallocatedFundsQuerySchema = cursorPageQuerySchema
  .extend({
    outletId: outletIdSchema.optional(),
    resolved: z.enum(["true", "false"]).optional(),
  })
  .strict();
export type ListUnallocatedFundsQuery = z.infer<
  typeof listUnallocatedFundsQuerySchema
>;

/** Wire shape for the payment admin screens (contract endpoint pending). */
export type UnallocatedFund = {
  readonly id: string;
  readonly tenantId: string;
  readonly outletId: string;
  readonly paymentIntentId: string;
  readonly amountIdr: number;
  readonly reason: "overpayment" | "double_payment";
  readonly resolution: "refund" | "credit" | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly approvalRef: string | null;
  readonly createdAt: string;
};

type UnallocatedRow = typeof paymentUnallocatedFunds.$inferSelect;

function toFund(row: UnallocatedRow): UnallocatedFund {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    paymentIntentId: row.paymentIntentId,
    amountIdr: row.amountIdr,
    reason: row.reason,
    resolution:
      row.resolution === "refund" || row.resolution === "credit"
        ? row.resolution
        : null,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    approvalRef: row.approvalRef,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listUnallocatedFunds(
  context: ScopedTenantContext,
  query: ListUnallocatedFundsQuery,
  actorUserId: string,
  now = new Date(),
): Promise<{
  data: UnallocatedFund[];
  meta: { limit: number; nextCursor: string | null };
}> {
  const parsed = listUnallocatedFundsQuerySchema.parse(query);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "payment.reconcile",
      parsed.outletId
        ? { type: "outlet", id: parsed.outletId }
        : { type: "tenant" },
      now,
    );
    let cursorFilter = sql`TRUE`;
    if (parsed.cursor) {
      const keys = decodeCursor(parsed.cursor);
      const [createdAt, id] = keys;
      if (typeof createdAt !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
      cursorFilter = sql`(${paymentUnallocatedFunds.createdAt}, ${paymentUnallocatedFunds.id}) < (${createdAt}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select()
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          parsed.outletId
            ? eq(paymentUnallocatedFunds.outletId, parsed.outletId)
            : sql`TRUE`,
          parsed.resolved === "true"
            ? sql`${paymentUnallocatedFunds.resolvedAt} IS NOT NULL`
            : parsed.resolved === "false"
              ? isNull(paymentUnallocatedFunds.resolvedAt)
              : sql`TRUE`,
          cursorFilter,
        ),
      )
      .orderBy(
        desc(paymentUnallocatedFunds.createdAt),
        desc(paymentUnallocatedFunds.id),
      )
      .limit(parsed.limit + 1);
    const page = rows.slice(0, parsed.limit);
    const last = page.at(-1);
    return {
      data: page.map(toFund),
      meta: {
        limit: parsed.limit,
        nextCursor:
          rows.length > parsed.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** Opening rows for one intent, oldest first; used by tests and the admin list. */
export async function unallocatedFundsOfIntent(
  context: ScopedTenantContext,
  intentId: string,
): Promise<UnallocatedFund[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          eq(paymentUnallocatedFunds.paymentIntentId, intentId),
        ),
      )
      .orderBy(asc(paymentUnallocatedFunds.createdAt));
    return rows.map(toFund);
  });
}
