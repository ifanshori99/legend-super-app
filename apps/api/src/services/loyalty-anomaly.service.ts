// Loyalty anti-fraud anomalies (legend-111j, docs/design/ws08-member-loyalty.md
// §M6, §3 "0193"). Written by the earn consumer, the phone-lookup attach and
// the nightly balance check; read by staff with `crm.loyalty.review`.
// `loyalty_anomalies` is tenant-scoped only (no outlet RLS).

import { and, count, desc, eq, sql } from "drizzle-orm";
import type { OutletId, TenantId } from "@starter/shared/core";
import type { LoyaltyAnomaly } from "@starter/shared/crm";
import { loyaltyAnomalies } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error";
import type { Tx } from "./inventory-ops.shared.ts";

export type LoyaltyAnomalyKind = LoyaltyAnomaly["kind"];

export type LoyaltyAnomalyInput = {
  tenantId: string;
  kind: LoyaltyAnomalyKind;
  outletId?: string | null;
  customerProfileId?: string | null;
  orderId?: string | null;
  actorUserId?: string | null;
  businessDate?: string | null;
  details?: Record<string, unknown>;
};

/** Details carry ids and counts only, never a phone number or a name. */
export async function recordLoyaltyAnomaly(
  tx: Tx,
  input: LoyaltyAnomalyInput,
): Promise<void> {
  await tx.insert(loyaltyAnomalies).values({
    tenantId: input.tenantId as TenantId,
    kind: input.kind,
    outletId: (input.outletId ?? null) as OutletId | null,
    customerProfileId: input.customerProfileId ?? null,
    orderId: input.orderId ?? null,
    actorUserId: input.actorUserId ?? null,
    businessDate: input.businessDate ?? null,
    details: input.details ?? {},
  });
}

/** Phone lookups (`phone_lookup_attach`) of one cashier on one business day. */
export async function countPhoneLookups(
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  businessDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(loyaltyAnomalies)
    .where(
      and(
        eq(loyaltyAnomalies.tenantId, tenantId as TenantId),
        eq(loyaltyAnomalies.kind, "phone_lookup_attach"),
        eq(loyaltyAnomalies.actorUserId, actorUserId),
        eq(loyaltyAnomalies.businessDate, businessDate),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * `ts` is the database's own `created_at::text` (microseconds): a JS Date keeps
 * only milliseconds, so rows sharing one `now()` would be skipped between pages.
 */
type Cursor = { ts: string; id: string };

// A ULID stored as uuid has no RFC version/variant bits, so z.uuid() rejects it.
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_TS =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.ts}|${cursor.id}`).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  const parts = Buffer.from(value, "base64url").toString().split("|");
  const [ts, id] = parts;
  if (
    parts.length !== 2 ||
    !ts ||
    !id ||
    !CURSOR_TS.test(ts) ||
    !ROW_ID.test(id)
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return { ts, id };
}

/** Newest first, keyset on `(created_at, id)`; `limit + 1` rows tell if more follow. */
export async function listLoyaltyAnomalies(
  tx: Tx,
  tenantId: string,
  page: { cursor?: string; limit: number; kind?: LoyaltyAnomalyKind },
): Promise<{ items: LoyaltyAnomaly[]; nextCursor: string | null }> {
  const cursor = page.cursor ? decodeCursor(page.cursor) : null;
  const found = await tx
    .select({
      row: loyaltyAnomalies,
      ts: sql<string>`${loyaltyAnomalies.createdAt}::text`,
    })
    .from(loyaltyAnomalies)
    .where(
      and(
        eq(loyaltyAnomalies.tenantId, tenantId as TenantId),
        page.kind ? eq(loyaltyAnomalies.kind, page.kind) : undefined,
        cursor
          ? sql`(${loyaltyAnomalies.createdAt}, ${loyaltyAnomalies.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(loyaltyAnomalies.createdAt), desc(loyaltyAnomalies.id))
    .limit(page.limit + 1);
  const rows = found.map((entry) => entry.row);
  const slice = rows.slice(0, page.limit);
  const last = slice.at(-1);
  return {
    items: slice.map(
      (row) =>
        ({
          id: row.id,
          kind: row.kind,
          outletId: row.outletId,
          customerProfileId: row.customerProfileId,
          orderId: row.orderId,
          actorUserId: row.actorUserId,
          businessDate: row.businessDate,
          details: row.details,
          createdAt: row.createdAt.toISOString(),
        }) as LoyaltyAnomaly,
    ),
    nextCursor:
      rows.length > page.limit && last
        ? encodeCursor({ ts: found[page.limit - 1]!.ts, id: last.id })
        : null,
  };
}
