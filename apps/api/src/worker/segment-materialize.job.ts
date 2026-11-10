// Daily segment materialization (legend-ts50, docs/briefs/290d). Saving a
// segment materializes it at once; this job refreshes every saved segment of a
// tenant so `segment_members`, `size` and `refreshedAt` follow new visits. The
// sweep runs from the worker tick after 02:00 Asia/Jakarta, once per tenant per
// day. A refresh replaces the members of one segment inside one transaction, so
// a rerun or a second worker writes the same rows and a failure keeps the old
// members of that segment.

import { asc } from "drizzle-orm";
import { businessDateOf, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { segments } from "../db/schema/crm-segments.ts";
import { withTenant } from "../db/tenant.ts";
import { refreshSegmentMembers } from "../services/segments.service.ts";

type Database = Parameters<typeof withTenant>[0];

const TIME_ZONE = "Asia/Jakarta";
/** Calendar day in Asia/Jakarta (cutoff 00:00). */
const DAY_CLOCK = { timeZone: TIME_ZONE, cutoff: "00:00" } as const;
/** The same clock with the 02:00 start: a different day means "before 02:00". */
const START_CLOCK = { timeZone: TIME_ZONE, cutoff: "02:00" } as const;

export type SegmentMaterializeResult = {
  businessDate: string;
  segments: number;
  refreshed: number;
  /** Segments with no usable definition (or deleted mid-sweep): nothing to retry. */
  skipped: number;
  /** Segments whose refresh threw: the sweep retries on the next tick. */
  failed: number;
};

/** Asia/Jakarta calendar day, or null before 02:00 that day. */
export function segmentMaterializeDay(now: Date): string | null {
  const day = businessDateOf(now, DAY_CLOCK);
  return businessDateOf(now, START_CLOCK) === day ? day : null;
}

export async function runSegmentMaterialize(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
): Promise<SegmentMaterializeResult> {
  const tenantId = context.tenant.tenantId;
  const ids = await withTenant(database, context, (tx) =>
    tx
      .select({ id: segments.id })
      .from(segments)
      .orderBy(asc(segments.createdAt), asc(segments.id)),
  );
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { id } of ids) {
    try {
      const row = await withTenant(database, context, (tx) =>
        refreshSegmentMembers(tx, tenantId, id, now),
      );
      // The service answers null for a broken definition or a vanished row.
      // That is permanent, so it must not keep the day open for a rerun.
      if (row) refreshed += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    businessDate: businessDateOf(now, DAY_CLOCK),
    segments: ids.length,
    refreshed,
    skipped,
    failed,
  };
}

const lastDayByTenant = new Map<string, string>();

/**
 * Worker sweep: runs `runSegmentMaterialize` once per tenant per Asia/Jakarta
 * day, after 02:00. A run with a failed (threw) segment is retried on the next
 * tick; a skipped segment (broken definition) does not hold the day open.
 */
export async function runSegmentMaterializeSweep(
  context: ScopedTenantContext,
  now: Date,
): Promise<SegmentMaterializeResult | null> {
  const day = segmentMaterializeDay(now);
  if (day === null) return null;
  const tenantId = context.tenant.tenantId;
  if (lastDayByTenant.get(tenantId) === day) return null;
  const result = await runSegmentMaterialize(db, context, now);
  if (result.failed === 0) lastDayByTenant.set(tenantId, day);
  return result;
}
