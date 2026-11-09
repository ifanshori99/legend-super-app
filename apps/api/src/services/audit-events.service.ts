// Audit log viewer reads (PRD v1.7 §3 F36 "Audit Log Viewer"; bead legend-zbzr).
// `GET /api/audit/events`: newest first, cursor-paged, from `audit_logs`.
//
// Runs inside `withTenant`, so RLS scopes rows to the caller's tenant only. The
// route requires `audit.log.view` at tenant scope (`requireTenantPermission`),
// which is what keeps an outlet-scoped caller out. Rows are append-only and
// already masked at write time (`recordAudit`); this service validates each row
// against the event schema again. A stored row that fails (an unmasked
// sensitive field) is masked default-deny before it leaves the server; one that
// still fails is skipped and logged by id only, so one bad row never fails the
// whole page.
//
// Blind stock counts (legend-j5x): the count's totalVarianceIdr and
// grossVarianceIdr are replaced by the redaction marker for a reader who
// entered a quantity in that count or lacks `inventory.adjustment.approve` at
// its outlet, so the audit trail never leaks what the blind count hides.
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AUDIT_REDACTED,
  auditEventSchema,
  listAuditEventsEndpoint,
  maskAuditChanges,
  type AuditEvent,
  type AuditEventView,
} from "@starter/shared/audit";
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { auditLogs } from "../db/schema/core-audit.ts";
import { stockCountLines, stockCounts } from "../db/schema/inventory-count.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { outletTarget } from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

export type ListAuditEventsQuery = z.output<
  typeof listAuditEventsEndpoint.query
>;

// A tenant-wide event (no outlet) uses the tenant default zone and cutoff,
// like every other report period (D-CORE time rules).
const DEFAULT_TIME_ZONE = "Asia/Jakarta";
const DEFAULT_CUTOFF = "04:00";

function invalidCursor(): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
}

// A ULID stored as uuid has no RFC version/variant bits, so z.uuid() rejects it.
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The row id is a ULID stored as uuid, so byte order is time order. */
function cursorId(cursor: string): string {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  const [id] = keys;
  if (keys.length !== 1 || typeof id !== "string" || !ROW_ID.test(id))
    throw invalidCursor();
  return id;
}

/** The event, masked if needed; `null` when the stored row is unusable. */
function toEvent(raw: unknown): AuditEvent | null {
  const parsed = auditEventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Stored row that skipped the masker: redact every scalar, keep structure.
  // maskAuditChanges throws on a value that is not JSON.
  try {
    const record = (raw ?? {}) as { maskedChanges?: Record<string, unknown> };
    const remasked = auditEventSchema.safeParse({
      ...record,
      maskedChanges: {
        before: maskAuditChanges(record.maskedChanges?.before ?? null),
        after: maskAuditChanges(record.maskedChanges?.after ?? null),
      },
    });
    return remasked.success ? remasked.data : null;
  } catch {
    return null;
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const BLIND_COUNT_VARIANCE_FIELDS = [
  "totalVarianceIdr",
  "grossVarianceIdr",
] as const;

function isBlindCountEvent(event: AuditEvent): boolean {
  if (event.objectType !== "stock_count" || event.objectId === null)
    return false;
  return [event.maskedChanges.before, event.maskedChanges.after].some(
    (side) =>
      side !== null &&
      typeof side === "object" &&
      !Array.isArray(side) &&
      side.blind === true,
  );
}

function redactVariance(side: AuditEvent["maskedChanges"]["before"]) {
  if (side === null || typeof side !== "object" || Array.isArray(side))
    return side;
  const copy = { ...side };
  for (const field of BLIND_COUNT_VARIANCE_FIELDS)
    if (field in copy) copy[field] = AUDIT_REDACTED;
  return copy;
}

/**
 * Ids of the blind stock counts whose variance the reader may NOT see: the
 * reader entered a quantity (creator, counter history, line counter), lacks
 * `inventory.adjustment.approve` at the count's outlet, or the count row is
 * gone (fail closed).
 */
async function hiddenBlindCountIds(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  countIds: readonly string[],
): Promise<Set<string>> {
  const hidden = new Set(countIds);
  if (countIds.length === 0) return hidden;
  const counts = await tx
    .select({
      id: stockCounts.id,
      outletId: stockCounts.outletId,
      countedBy: stockCounts.countedBy,
      counterIds: stockCounts.counterIds,
    })
    .from(stockCounts)
    .where(
      and(
        eq(stockCounts.tenantId, context.tenant.tenantId),
        inArray(stockCounts.id, [...countIds]),
      ),
    );
  const lineCounters = await tx
    .selectDistinct({
      stockCountId: stockCountLines.stockCountId,
      countedBy: stockCountLines.countedBy,
    })
    .from(stockCountLines)
    .where(
      and(
        eq(stockCountLines.tenantId, context.tenant.tenantId),
        inArray(stockCountLines.stockCountId, [...countIds]),
        isNotNull(stockCountLines.countedBy),
      ),
    );
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  const reader = actorUserId.toLowerCase();
  for (const count of counts) {
    const counters = new Set(
      [count.countedBy, ...count.counterIds].map((id) => id.toLowerCase()),
    );
    for (const line of lineCounters)
      if (line.stockCountId === count.id && line.countedBy !== null)
        counters.add(line.countedBy.toLowerCase());
    const canApprove = snapshot.allows(
      "inventory.adjustment.approve",
      outletTarget(count.outletId),
    );
    if (canApprove && !counters.has(reader)) hidden.delete(count.id);
  }
  return hidden;
}

export async function listAuditEvents(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListAuditEventsQuery,
): Promise<CursorPage<AuditEventView>> {
  return withTenant(db, context, async (tx) => {
    const eventField = (key: string) =>
      sql<string | null>`${auditLogs.event}->>${key}`;
    const filters: SQL[] = [eq(auditLogs.tenantId, context.tenant.tenantId)];
    if (query.actorType)
      filters.push(sql`${eventField("actorType")} = ${query.actorType}`);
    if (query.actorId)
      filters.push(sql`${eventField("actorId")} = ${query.actorId}`);
    if (query.objectType)
      filters.push(sql`${eventField("objectType")} = ${query.objectType}`);
    if (query.action)
      filters.push(sql`${eventField("action")} = ${query.action}`);
    if (query.outletId) filters.push(eq(auditLogs.outletId, query.outletId));
    // Business date = local time of the outlet minus its day cutoff.
    const businessDate = sql`((${auditLogs.createdAt} AT TIME ZONE coalesce(${outlets.timezone}, ${DEFAULT_TIME_ZONE})) - coalesce(${outlets.businessDayCutoff}, ${DEFAULT_CUTOFF})::interval)::date`;
    if (query.from) filters.push(sql`${businessDate} >= ${query.from}::date`);
    if (query.to) filters.push(sql`${businessDate} <= ${query.to}::date`);
    if (query.cursor) filters.push(lt(auditLogs.id, cursorId(query.cursor)));

    const rows = await tx
      .select({
        id: auditLogs.id,
        event: auditLogs.event,
        outletName: outlets.name,
        outletTimeZone: outlets.timezone,
        actorName: sql<string | null>`CASE ${eventField("actorType")}
          WHEN 'user' THEN (SELECT u.name FROM "user" u WHERE u.id = ${eventField("actorId")})
          WHEN 'device' THEN (SELECT d.label FROM devices d WHERE d.tenant_id = ${auditLogs.tenantId} AND d.id::text = ${eventField("actorId")})
        END`,
        deviceName: sql<
          string | null
        >`(SELECT d.label FROM devices d WHERE d.tenant_id = ${auditLogs.tenantId} AND d.id::text = ${eventField("deviceId")})`,
      })
      .from(auditLogs)
      .leftJoin(
        outlets,
        and(
          eq(outlets.tenantId, auditLogs.tenantId),
          eq(outlets.id, auditLogs.outletId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(auditLogs.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const events: Array<{ row: (typeof page)[number]; event: AuditEvent }> = [];
    for (const row of page) {
      const event = toEvent(row.event);
      if (event === null) {
        // Row id only: the event body may hold what the masker would remove.
        logger.warn({ auditLogId: row.id }, "Skipped an unreadable audit row");
        continue;
      }
      events.push({ row, event });
    }
    const blindIds = new Set(
      events
        .map(({ event }) => event)
        .filter(isBlindCountEvent)
        .map((event) => String(event.objectId)),
    );
    const hidden = await hiddenBlindCountIds(tx, context, actorUserId, [
      ...blindIds,
    ]);
    const data: AuditEventView[] = [];
    for (const { row, event: stored } of events) {
      const event =
        isBlindCountEvent(stored) && hidden.has(String(stored.objectId))
          ? {
              ...stored,
              maskedChanges: {
                before: redactVariance(stored.maskedChanges.before),
                after: redactVariance(stored.maskedChanges.after),
              },
            }
          : stored;
      data.push({
        event,
        actorName: row.actorName,
        outletName: row.outletName,
        outletTimeZone: row.outletTimeZone,
        deviceName: row.deviceName,
      });
    }
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.id]) : null,
      },
    };
  });
}
