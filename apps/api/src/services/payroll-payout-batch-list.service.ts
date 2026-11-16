// Payout batch list across runs (legend-396pf): newest first, keyset paged on
// (created_at, id). The tenant comes from the verified session, never from the
// query or the cursor: the cursor holds only a timestamp and a batch id, and
// every query also filters `tenant_id` (RLS from `withTenant` is the second
// lock). Items of the whole page load in ONE query, so no N+1.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  type TenantId,
} from "@starter/shared/core";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import type { ListPayoutBatchesQuery } from "@starter/shared/validators/payroll-payout";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  loadBatchFreezes,
  payoutRefuse,
  toBatchDto,
  type ItemRow,
} from "./payroll-payout.service.ts";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Emitted by `to_char(... AT TIME ZONE 'UTC', ...)` so DateStyle and TimeZone
 * of the session never matter; keeps the microseconds a JS Date would drop.
 */
const CURSOR_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;

/**
 * Rejects impossible dates (`2026-02-30`, hour 24, second 60) the regex lets
 * through, and year 0, which JS accepts but PostgreSQL refuses (22008).
 */
function isRealTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() >= 1 &&
    date.toISOString().slice(0, 19) === match[1]
  );
}

const invalidCursor = () =>
  payoutRefuse(422, "VALIDATION_ERROR", "Kursor tidak valid.");

function readCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  if (
    keys.length !== 2 ||
    typeof keys[0] !== "string" ||
    typeof keys[1] !== "string" ||
    !isRealTimestamp(keys[0]) ||
    !UUID_SHAPE.test(keys[1])
  )
    throw invalidCursor();
  return [keys[0], keys[1]];
}

export async function listPayoutBatches(
  tx: Tx,
  tenantId: string,
  query: ListPayoutBatchesQuery,
  viewerId?: string,
): Promise<{
  items: PayrollDisbursementBatchDto[];
  nextCursor: string | null;
}> {
  const after = readCursor(query.cursor);
  const tenant = tenantId as TenantId;
  const rows = await tx
    .select({
      batch: payrollDisbursementBatches,
      cursorAt: sql<string>`to_char(${payrollDisbursementBatches.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenant),
        query.legalEntityId
          ? eq(payrollDisbursementBatches.legalEntityId, query.legalEntityId)
          : undefined,
        query.status
          ? eq(payrollDisbursementBatches.status, query.status)
          : undefined,
        after
          ? sql`(${payrollDisbursementBatches.createdAt}, ${payrollDisbursementBatches.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(
      desc(payrollDisbursementBatches.createdAt),
      desc(payrollDisbursementBatches.id),
    )
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const itemsByBatch = new Map<string, ItemRow[]>();
  if (page.length > 0) {
    const items = await tx
      .select()
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenant),
          inArray(
            payrollDisbursementItems.batchId,
            page.map((entry) => entry.batch.id),
          ),
        ),
      )
      .orderBy(
        asc(payrollDisbursementItems.createdAt),
        asc(payrollDisbursementItems.id),
      );
    for (const item of items) {
      const bucket = itemsByBatch.get(item.batchId);
      if (bucket) bucket.push(item);
      else itemsByBatch.set(item.batchId, [item]);
    }
  }
  const freezes = await loadBatchFreezes(
    tx,
    tenantId,
    page.map((entry) => entry.batch.id),
    viewerId,
  );
  const last = page.at(-1);
  return {
    items: page.map((entry) =>
      toBatchDto(
        entry.batch,
        itemsByBatch.get(entry.batch.id) ?? [],
        freezes.get(entry.batch.id),
      ),
    ),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor([last.cursorAt, last.batch.id])
        : null,
  };
}
