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
import { POS_SHIFT_BLIND_FIELDS } from "@starter/shared/pos";
import {
  businessDateSchema,
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
import { posShiftCounts, posShifts } from "../db/schema/pos-shift.ts";
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

const BLIND_COUNT_QUANTITY_FIELDS = new Set([
  "quantity",
  "qty",
  "countedQty",
  "systemQty",
  "snapshotQty",
  "expectedQty",
  "deltaQty",
  "balanceBefore",
  "balanceAfter",
  "onHandQuantity",
]);

function isBlindCountQuantityField(key: string): boolean {
  return (
    (BLIND_COUNT_VARIANCE_FIELDS as readonly string[]).includes(key) ||
    BLIND_COUNT_QUANTITY_FIELDS.has(key) ||
    /(qty|quantity)$/i.test(key)
  );
}

function redactBlindCountValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBlindCountValue);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    copy[key] = isBlindCountQuantityField(key)
      ? AUDIT_REDACTED
      : redactBlindCountValue(child);
  return copy;
}

function redactVariance(
  side: AuditEvent["maskedChanges"]["before"],
): AuditEvent["maskedChanges"]["before"] {
  if (side === null || typeof side !== "object" || Array.isArray(side))
    return side;
  return redactBlindCountValue(side) as typeof side;
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

// ---- Own drawer figures (legend-mxxev, POS-03 blind rule) -------------------

const SHIFT_DRAWER_FIELDS: readonly string[] = [
  ...POS_SHIFT_BLIND_FIELDS,
  "differenceIdr",
  "heldCashOutIdr",
  "expiredCashOutIdr",
];
// A cash_shift_close override is worth the server's |variance| (valueIdr).
const OVERRIDE_DRAWER_FIELDS: readonly string[] = [
  ...SHIFT_DRAWER_FIELDS,
  "valueIdr",
];
const DAY_CLOSE_DRAWER_FIELDS: readonly string[] = ["totalVarianceIdr"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuditSide = AuditEvent["maskedChanges"]["before"];
type DrawerRef =
  | { kind: "day"; outletId: AuditEvent["outletId"]; date: string | null }
  | {
      kind: "shift";
      outletId: AuditEvent["outletId"];
      shiftId: string | null;
      countId: string | null;
      requestedBy: string | null;
      fields: readonly string[];
    };

function sideRecord(side: AuditSide): Record<string, unknown> | null {
  return side !== null && typeof side === "object" && !Array.isArray(side)
    ? side
    : null;
}

function redactFields(side: AuditSide, fields: readonly string[]) {
  if (side === null || typeof side !== "object" || Array.isArray(side))
    return side;
  const copy = { ...side };
  for (const field of fields) if (field in copy) copy[field] = AUDIT_REDACTED;
  return copy;
}

/**
 * The drawer an audit row speaks about, when it carries drawer figures: a
 * business day (`pos_daily_close`: totalVarianceIdr) or one shift
 * (`pos_shift`, `pos_shift_count`, and a `pos_override` that recorded the
 * shift close figures).
 */
function drawerRef(event: AuditEvent): DrawerRef | null {
  const after = sideRecord(event.maskedChanges.after);
  const before = sideRecord(event.maskedChanges.before);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  switch (event.objectType) {
    case "pos_daily_close": {
      const date = businessDateSchema.safeParse(after?.businessDate);
      return {
        kind: "day",
        outletId: event.outletId,
        date: date.success ? date.data : null,
      };
    }
    case "pos_shift":
      return {
        kind: "shift",
        outletId: event.outletId,
        shiftId: event.objectId === null ? null : String(event.objectId),
        countId: null,
        requestedBy: null,
        fields: SHIFT_DRAWER_FIELDS,
      };
    case "pos_shift_count":
      return {
        kind: "shift",
        outletId: event.outletId,
        shiftId: text(after?.shiftId) ?? text(before?.shiftId),
        countId: event.objectId === null ? null : String(event.objectId),
        requestedBy: null,
        fields: SHIFT_DRAWER_FIELDS,
      };
    case "pos_override": {
      // A shift-close approval (recorded, or requested on the phone chain):
      // it names the blind count (objectType pos_shift_count, objectId = the
      // count id) or, for a forced close, the shift.
      const action = text(after?.action) ?? text(before?.action);
      const carriesFigures = [after, before].some(
        (side) =>
          side !== null && ("expectedIdr" in side || "varianceIdr" in side),
      );
      if (action !== "cash_shift_close" && !carriesFigures) return null;
      const objectType = text(after?.objectType) ?? text(before?.objectType);
      const objectId = text(after?.objectId) ?? text(before?.objectId);
      return {
        kind: "shift",
        outletId: event.outletId,
        shiftId: objectType === "pos_shift" ? objectId : null,
        countId: objectType === "pos_shift_count" ? objectId : null,
        // The requested row records the requester only as its actor.
        requestedBy:
          text(after?.requestedBy) ??
          text(before?.requestedBy) ??
          (event.action === "pos_override.requested" ? event.actorId : null),
        fields: OVERRIDE_DRAWER_FIELDS,
      };
    }
    default:
      return null;
  }
}

/**
 * Audit ids whose drawer figures the reader may NOT see, with the fields to
 * redact (legend-mxxev). Same rule as the day report (legend-awg5p): a reader
 * without `pos.day.close` at the outlet does not read the drawer figures of
 * their own shift (they ran it) nor the day close total of a day they held a
 * shift on. A row whose outlet, date or shift cannot be resolved is hidden
 * from a reader without `pos.day.close` (fail closed).
 */
async function hiddenDrawerFields(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  events: readonly AuditEvent[],
): Promise<Map<string, readonly string[]>> {
  const hidden = new Map<string, readonly string[]>();
  const refs = events.flatMap((event) => {
    const ref = drawerRef(event);
    return ref === null ? [] : [{ event, ref }];
  });
  if (refs.length === 0) return hidden;
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  const closes = (outletId: AuditEvent["outletId"]) =>
    outletId !== null &&
    snapshot.allows("pos.day.close", outletTarget(outletId));
  const reader = actorUserId.toLowerCase();

  const days: Array<{
    id: string;
    outletId: NonNullable<AuditEvent["outletId"]>;
    date: string;
  }> = [];
  type Pending = {
    id: string;
    outletId: AuditEvent["outletId"];
    fields: readonly string[];
  };
  const shiftRefs: Array<Pending & { shiftId: string }> = [];
  const countRefs: Array<Pending & { countId: string }> = [];
  const uuid = (value: string | null) =>
    value !== null && UUID.test(value) ? value.toLowerCase() : null;
  for (const { event, ref } of refs) {
    if (ref.kind === "day") {
      if (closes(ref.outletId)) continue;
      if (ref.outletId === null || ref.date === null)
        hidden.set(event.id, DAY_CLOSE_DRAWER_FIELDS);
      else days.push({ id: event.id, outletId: ref.outletId, date: ref.date });
      continue;
    }
    const pending = {
      id: event.id,
      outletId: ref.outletId,
      fields: ref.fields,
    };
    const shiftId = uuid(ref.shiftId);
    const countId = uuid(ref.countId);
    // Shift rows decide on the shift's own outlet (below); the event outlet
    // only decides a row whose requester is the reader or whose shift is gone.
    if (
      ref.requestedBy !== null &&
      ref.requestedBy.toLowerCase() === reader &&
      !closes(ref.outletId)
    )
      hidden.set(event.id, ref.fields);
    else if (shiftId !== null) shiftRefs.push({ ...pending, shiftId });
    else if (countId !== null) countRefs.push({ ...pending, countId });
    else if (!closes(ref.outletId)) hidden.set(event.id, ref.fields);
  }

  if (countRefs.length > 0) {
    const counts = await tx
      .select({ id: posShiftCounts.id, shiftId: posShiftCounts.shiftId })
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, context.tenant.tenantId),
          inArray(posShiftCounts.id, [
            ...new Set(countRefs.map((row) => row.countId)),
          ]),
        ),
      );
    const shiftOf = new Map(
      counts.map((row) => [row.id.toLowerCase(), row.shiftId.toLowerCase()]),
    );
    for (const ref of countRefs) {
      const shiftId = shiftOf.get(ref.countId);
      if (shiftId === undefined) {
        if (!closes(ref.outletId)) hidden.set(ref.id, ref.fields);
      } else shiftRefs.push({ ...ref, shiftId });
    }
  }

  if (days.length > 0) {
    const shifts = await tx
      .selectDistinct({
        outletId: posShifts.outletId,
        businessDate: posShifts.businessDate,
      })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, context.tenant.tenantId),
          inArray(posShifts.outletId, [
            ...new Set(days.map((row) => row.outletId)),
          ]),
          inArray(posShifts.businessDate, [
            ...new Set(days.map((row) => row.date)),
          ]),
          // Ids compare case-insensitively, as sameUser does in pos-shift.
          eq(sql`lower(${posShifts.cashierId})`, reader),
        ),
      );
    const own = new Set(
      shifts.map((row) => `${row.outletId.toLowerCase()}|${row.businessDate}`),
    );
    for (const row of days)
      if (own.has(`${row.outletId.toLowerCase()}|${row.date}`))
        hidden.set(row.id, DAY_CLOSE_DRAWER_FIELDS);
  }

  if (shiftRefs.length > 0) {
    const shifts = await tx
      .select({
        id: posShifts.id,
        outletId: posShifts.outletId,
        cashierId: posShifts.cashierId,
      })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, context.tenant.tenantId),
          inArray(posShifts.id, [
            ...new Set(shiftRefs.map((row) => row.shiftId)),
          ]),
        ),
      );
    const byId = new Map(shifts.map((row) => [row.id.toLowerCase(), row]));
    for (const ref of shiftRefs) {
      const shift = byId.get(ref.shiftId);
      if (shift === undefined) {
        if (!closes(ref.outletId)) hidden.set(ref.id, ref.fields);
      } else if (
        !closes(shift.outletId) &&
        shift.cashierId.toLowerCase() === reader
      )
        hidden.set(ref.id, ref.fields);
    }
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
    const hiddenDrawers = await hiddenDrawerFields(
      tx,
      context,
      actorUserId,
      events.map(({ event }) => event),
    );
    const data: AuditEventView[] = [];
    for (const { row, event: stored } of events) {
      const drawerFields = hiddenDrawers.get(stored.id);
      const event =
        isBlindCountEvent(stored) && hidden.has(String(stored.objectId))
          ? {
              ...stored,
              maskedChanges: {
                before: redactVariance(stored.maskedChanges.before),
                after: redactVariance(stored.maskedChanges.after),
              },
            }
          : drawerFields !== undefined
            ? {
                ...stored,
                maskedChanges: {
                  before: redactFields(
                    stored.maskedChanges.before,
                    drawerFields,
                  ),
                  after: redactFields(stored.maskedChanges.after, drawerFields),
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
