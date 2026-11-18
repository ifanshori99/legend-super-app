// Append-only point ledger writer (legend-111j, design §M5/§M6). Callers hold
// `withProfileLock` for the profile. The database sets `point_value_idr` and
// `liability_idr` (BEFORE INSERT) and `points_balance` (AFTER INSERT trigger):
// never pass them.

import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  crmEvents,
  type PointLedgerEntry,
  type PointLedgerSourceType,
  type PointLedgerType,
} from "@starter/shared/crm";
import { customerProfiles } from "../db/schema/crm-member";
import { pointLedger } from "../db/schema/crm-ledger";
import { domainEventOutbox } from "../db/schema/core-events";
import { HttpError } from "../lib/http-error";
import { appendOutbox } from "./core-outbox";
import type { Tx } from "./permission-resolver";

const EVENT_DESTINATION = "cloud-sync";

export type PointLedgerRow = typeof pointLedger.$inferSelect;

export type LedgerPostInput = {
  tenantId: string;
  customerProfileId: string;
  outletId?: string | null;
  type: PointLedgerType;
  /** Signed per contract; 0 is forbidden (return null instead, never call). */
  points: number;
  sourceType: PointLedgerSourceType;
  sourceId: string | null;
  reversesEntryId?: string | null;
  expiresAt?: Date | null;
  businessDate?: string | null;
  reason?: string | null;
  createdBy?: string | null;
  /** Extra payload fields for the outbox event (e.g. rewardId). */
  event?: Record<string, unknown>;
};

export type LedgerPostResult = {
  entry: PointLedgerRow;
  balanceAfter: number;
  inserted: boolean;
};

async function readBalance(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<number> {
  const tenant = tenantIdSchema.parse(tenantId);
  const [row] = await tx
    .select({ balance: customerProfiles.pointsBalance })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenant),
        eq(customerProfiles.id, profileId),
      ),
    );
  return Number(row?.balance ?? 0);
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantIdSchema.parse(tenantId)),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "points"),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Payload per packages/shared/src/crm/events.ts; null = row emits no event. */
function eventFor(
  entry: PointLedgerRow,
  balanceAfter: number,
  extra: Record<string, unknown>,
): { name: keyof typeof crmEvents; payload: Record<string, unknown> } | null {
  const base = {
    customerProfileId: entry.customerProfileId,
    points: Math.abs(entry.points),
    liabilityIdr: Math.abs(entry.liabilityIdr),
    balanceAfter,
  };
  switch (entry.type) {
    case "earn":
    case "bonus":
      // The catalog has no `adjustment` earn source.
      if (entry.sourceType === "adjustment") return null;
      return {
        name: "points.earned",
        payload: {
          ...base,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          expiresAt: entry.expiresAt?.toISOString(),
          ...extra,
        },
      };
    case "reverse":
      return {
        name: "points.reversed",
        payload: {
          ...base,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          reversesLedgerId: entry.reversesEntryId,
          ...extra,
        },
      };
    case "redeem":
      // 936: a POS points tender has no reward; its liability move is booked
      // by order.paid (paidPointsIdr), so it emits no points.redeemed event.
      if (entry.sourceType === "pos_tender") return null;
      return {
        name: "points.redeemed",
        payload: { ...base, redemptionId: entry.sourceId, ...extra },
      };
    // legend-m4p5
    case "adjust":
      return {
        name: "points.adjusted",
        payload: {
          ...base,
          kind: entry.reversesEntryId ? "restore" : "manual",
          reversesEntryId: entry.reversesEntryId,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          reason: entry.reason,
          ...extra,
        },
      };
    case "expire":
      return { name: "points.expired", payload: { ...base, ...extra } };
    default:
      return null;
  }
}

async function appendPointsEvent(
  tx: Tx,
  context: ScopedTenantContext,
  entry: PointLedgerRow,
  balanceAfter: number,
  extra: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const built = eventFor(entry, balanceAfter, extra);
  if (!built) return;
  const definition = crmEvents[built.name];
  const sequence = await nextSequence(
    tx,
    entry.tenantId,
    entry.customerProfileId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: entry.tenantId,
    // Tenant-wide: the aggregate is the member profile, which earns at many
    // outlets, and the outbox requires one outlet per aggregate (0004).
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: entry.customerProfileId,
    sequence,
    occurredAt: now.toISOString(),
    actor:
      entry.createdBy === null
        ? { type: "system" }
        : { type: "user", id: entry.createdBy },
    deviceId: null,
    idempotencyKey: `${definition.name}:${entry.id}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: built.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/** Idempotent on `(tenant, type, sourceType, sourceId)`: a replay returns the
 * existing row with `inserted: false` and emits no event. */
export async function postLedgerEntry(
  tx: Tx,
  context: ScopedTenantContext,
  input: LedgerPostInput,
  now: Date,
): Promise<LedgerPostResult> {
  if (!Number.isSafeInteger(input.points) || input.points === 0)
    throw new Error("Ledger entries must change the balance");
  const tenant = tenantIdSchema.parse(input.tenantId);
  const [inserted] = await tx
    .insert(pointLedger)
    .values({
      id: createUlid(now.getTime()),
      tenantId: tenant,
      customerProfileId: input.customerProfileId,
      outletId: input.outletId ? outletIdSchema.parse(input.outletId) : null,
      type: input.type,
      points: input.points,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversesEntryId: input.reversesEntryId ?? null,
      expiresAt: input.expiresAt ?? null,
      businessDate: input.businessDate ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({
      target: [
        pointLedger.tenantId,
        pointLedger.type,
        pointLedger.sourceType,
        pointLedger.sourceId,
      ],
      where: sql`${pointLedger.sourceId} IS NOT NULL`,
    })
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenant),
          eq(pointLedger.type, input.type),
          eq(pointLedger.sourceType, input.sourceType),
          input.sourceId === null
            ? sql`${pointLedger.sourceId} IS NULL`
            : eq(pointLedger.sourceId, input.sourceId),
        ),
      );
    if (!existing) throw new Error("Ledger conflict without an existing row");
    if (
      existing.customerProfileId !== input.customerProfileId ||
      existing.points !== input.points
    )
      throw new Error("Ledger dedupe key collision");
    return {
      entry: existing,
      balanceAfter: await readBalance(
        tx,
        input.tenantId,
        input.customerProfileId,
      ),
      inserted: false,
    };
  }
  const balanceAfter = await readBalance(
    tx,
    input.tenantId,
    input.customerProfileId,
  );
  await appendPointsEvent(
    tx,
    context,
    inserted,
    balanceAfter,
    input.event ?? {},
    now,
  );
  return { entry: inserted, balanceAfter, inserted: true };
}

export function toLedgerEntryDto(row: PointLedgerRow): PointLedgerEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerProfileId: row.customerProfileId,
    type: row.type,
    points: row.points,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    liabilityIdr: row.liabilityIdr,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  } as PointLedgerEntry;
}

/** Newest first; the cursor is the last `posting_seq` of the previous page. */
export async function listLedgerForProfile(
  tx: Tx,
  tenantId: string,
  profileId: string,
  page: { cursor?: string; limit: number },
): Promise<{ items: PointLedgerEntry[]; nextCursor: string | null }> {
  let before: number | null = null;
  if (page.cursor !== undefined) {
    if (!/^\d{1,15}$/.test(page.cursor))
      throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
    before = Number(page.cursor);
  }
  const rows = await tx
    .select()
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantIdSchema.parse(tenantId)),
        eq(pointLedger.customerProfileId, profileId),
        before === null ? undefined : lt(pointLedger.postingSeq, before),
      ),
    )
    .orderBy(desc(pointLedger.postingSeq))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toLedgerEntryDto),
    nextCursor:
      rows.length > page.limit && last ? String(last.postingSeq) : null,
  };
}
