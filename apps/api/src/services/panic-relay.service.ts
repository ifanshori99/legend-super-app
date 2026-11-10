// Panic alert relay (bead legend-bod; PRD v1.7 §3 F25 "Keselamatan", FAC-08).
// A registered panic button posts a press to the edge node. This module
//
// - stores one `panic_alerts` row per (device, eventId): a replayed press is the
//   same row, and while the alert is unacknowledged it is shown again to the
//   staff on duty (a button press whose answer was lost must not go silent);
// - raises the `panic` incident of the button's unit (reusing the incident
//   writer of facility-incidents.service.ts) when the button is mapped to one;
// - finds the staff on duty in the outlet (latest attendance log of the last
//   18 h is not a clock-out) and hands the frame, after commit, to the
//   in-process hub, which reaches their sockets without the internet;
//   `recipient_count` is the number of sockets that really got it;
// - records the first acknowledgement; response time is
//   `acknowledged_at - received_at`, both on the server clock.
//
// Everything runs inside `withTenant` (RLS scopes rows to the tenant and the
// outlet of the node). The external alert id is the UUID form of the ULID key.
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  userIdSchema,
  ulidToUuid,
  uuidToUlid,
  createUlid,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  panicAlertIdSchema,
  panicAlertSchema,
  type PanicAlert,
  type PanicRealtimeFrame,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { facilityIncidents, facilityUnits } from "../db/schema/facility.ts";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { employees } from "../db/schema/hris.ts";
import { panicAlerts } from "../db/schema/panic-alert.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { raisePanicIncident } from "./facility-incidents.service.ts";
import {
  assertFacilityPermission,
  auditFacility,
  notFound,
  OPERATE_PERMISSION,
  type Tx,
} from "./facility-shared.ts";
import { publish } from "./panic-relay-hub.ts";

type AlertRow = typeof panicAlerts.$inferSelect;

const alertNotFound = () => notFound("Peringatan darurat");

export function toPanicAlert(row: AlertRow): PanicAlert {
  return panicAlertSchema.parse({
    id: ulidToUuid(row.id),
    outletId: row.outletId,
    deviceId: row.deviceId,
    eventId: row.eventId,
    unitId: row.unitId,
    facilityIncidentId: row.facilityIncidentId,
    triggeredAt: row.triggeredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    fannedOutAt: row.fannedOutAt?.toISOString() ?? null,
    recipientCount: row.recipientCount,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    offline: row.offline,
  });
}

/** The one outlet a node-minted context covers; anything else is refused. */
function singleOutlet(context: ScopedTenantContext): OutletId {
  const scope = context.outletScope;
  if (scope.kind !== "outlets" || scope.outletIds.length !== 1)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Tombol darurat hanya berlaku untuk satu outlet.",
    );
  return outletIdSchema.parse(scope.outletIds[0]);
}

/**
 * How far back a clock-in still counts as a shift in progress. No business
 * date match: a night shift that started yesterday is still on duty after
 * midnight.
 */
export const ON_DUTY_LOOKBACK_MS = 18 * 60 * 60 * 1000;

/**
 * User ids of the staff on duty in an outlet: employees whose latest valid
 * attendance log in this outlet within the last 18 hours is not a clock-out
 * (a clock-in with no later clock-out; a break counts as on duty).
 */
export async function listOnDutyUserIds(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const logs = await tx
    .select({
      employeeId: attendanceLogs.employeeId,
      type: attendanceLogs.type,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        eq(attendanceLogs.outletId, outletId),
        gte(
          attendanceLogs.occurredAt,
          new Date(now.getTime() - ON_DUTY_LOOKBACK_MS),
        ),
        ne(attendanceLogs.validity, "rejected"),
      ),
    )
    .orderBy(attendanceLogs.occurredAt, attendanceLogs.id);
  // Ascending order: the last log seen per employee is the latest.
  const latest = new Map<string, string>();
  for (const log of logs) latest.set(log.employeeId, log.type);
  const onDuty = [...latest]
    .filter(([, type]) => type !== "out")
    .map(([employeeId]) => employeeId);
  if (onDuty.length === 0) return [];
  const rows = await tx
    .select({ userId: employees.userId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenantId),
        inArray(employees.id, onDuty),
        eq(employees.status, "active"),
        isNotNull(employees.userId),
      ),
    );
  return [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
}

/**
 * A button press. `context` is the node's own outlet scope (server minted); the
 * token check that proves who is calling is the route's job. The device must be
 * an active `panic_button` of this outlet. A replay (same device and eventId)
 * returns the stored alert and raises nothing new; while the alert is still
 * unacknowledged the frame is published again to the staff on duty now.
 */
export async function ingestPanicEvent(
  context: ScopedTenantContext,
  input: { deviceId: string; eventId: string; triggeredAt: string },
  now = new Date(),
): Promise<{ alert: PanicAlert; replayed: boolean }> {
  const outletId = singleOutlet(context);
  const tenantId = context.tenant.tenantId;
  const result = await withTenant(db, context, async (tx) => {
    const [device] = await tx
      .select()
      .from(devices)
      .where(
        and(eq(devices.tenantId, tenantId), eq(devices.id, input.deviceId)),
      )
      .limit(1);
    if (!device) throw notFound("Perangkat");
    if (device.outletId !== outletId)
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Perangkat ini bukan milik outlet ini.",
      );
    if (device.status !== "active" || device.revokedAt !== null)
      throw new HttpError(403, "FORBIDDEN", "Perangkat tidak aktif.");
    if (device.type !== "panic_button")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Perangkat ini bukan tombol darurat.",
      );

    const [unit] = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.outletId, outletId),
          eq(facilityUnits.panicDeviceId, device.id),
        ),
      )
      .limit(1);
    const runtime = getEdgeRuntimeState();
    const offline = runtime.edgeMode && runtime.link.cloudLink !== "connected";

    const [inserted] = await tx
      .insert(panicAlerts)
      .values({
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        deviceId: device.id,
        eventId: input.eventId,
        unitId: unit?.id ?? null,
        triggeredAt: new Date(input.triggeredAt),
        offline,
      })
      .onConflictDoNothing({
        target: [
          panicAlerts.tenantId,
          panicAlerts.deviceId,
          panicAlerts.eventId,
        ],
      })
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(panicAlerts)
        .where(
          and(
            eq(panicAlerts.tenantId, tenantId),
            eq(panicAlerts.deviceId, device.id),
            eq(panicAlerts.eventId, input.eventId),
          ),
        )
        .limit(1);
      if (!existing) throw alertNotFound();
      // Someone already took it: nothing more to show.
      const userIds = existing.acknowledgedAt
        ? null
        : await listOnDutyUserIds(tx, context, outletId, now);
      return { row: existing, replayed: true, userIds };
    }

    const incident = unit
      ? await raisePanicIncident(
          tx,
          context,
          { unit, deviceId: device.id, offline },
          now,
        )
      : null;
    const [row] = incident
      ? await tx
          .update(panicAlerts)
          .set({ facilityIncidentId: incident.id })
          .where(
            and(
              eq(panicAlerts.tenantId, tenantId),
              eq(panicAlerts.id, inserted.id),
            ),
          )
          .returning()
      : [inserted];
    const userIds = await listOnDutyUserIds(tx, context, outletId, now);
    return { row, replayed: false, userIds };
  });

  let alert = toPanicAlert(result.row);
  if (result.userIds === null) return { alert, replayed: true };
  // After commit: a rolled back press never reaches a screen. Only the sockets
  // of staff on duty get it; the count is what was really delivered.
  const frame: PanicRealtimeFrame = {
    type: "panic",
    alertId: alert.id,
    outletId: alert.outletId,
    unitId: alert.unitId,
    receivedAt: alert.receivedAt,
  };
  const delivered = publish({ tenantId, outletId }, frame, {
    userIds: result.userIds,
  });
  if (!result.replayed) {
    const row = await withTenant(db, context, async (tx) => {
      const [updated] = await tx
        .update(panicAlerts)
        .set({
          recipientCount: delivered,
          // Database clock, like received_at, so the measured fan-out time
          // never goes negative through clock skew with the database.
          fannedOutAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(panicAlerts.tenantId, tenantId),
            eq(panicAlerts.id, result.row.id),
          ),
        )
        .returning();
      return updated;
    });
    alert = toPanicAlert(row);
  }
  return { alert, replayed: result.replayed };
}

/**
 * First acknowledgement wins. The row is locked, so two staff cannot both win:
 * the second gets 409. The same staff member repeating returns the stored
 * alert. The linked incident is marked as responded by the same person.
 */
export async function acknowledgePanicAlert(
  context: ScopedTenantContext,
  actorUserId: string,
  alertId: string,
  now = new Date(),
): Promise<PanicAlert> {
  const actor = userIdSchema.parse(actorUserId);
  const id = uuidToUlid(panicAlertIdSchema.parse(alertId));
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [locked] = await tx
      .select()
      .from(panicAlerts)
      .where(and(eq(panicAlerts.tenantId, tenantId), eq(panicAlerts.id, id)))
      .limit(1)
      .for("update");
    if (!locked) throw alertNotFound();
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      locked.outletId,
    );
    if (locked.acknowledgedAt) {
      if (locked.acknowledgedBy === actor) return toPanicAlert(locked);
      throw new HttpError(
        409,
        "PANIC_ALREADY_ACKNOWLEDGED",
        "Peringatan ini sudah ditangani rekan lain.",
      );
    }
    const [row] = await tx
      .update(panicAlerts)
      .set({ acknowledgedBy: actor, acknowledgedAt: now })
      .where(and(eq(panicAlerts.tenantId, tenantId), eq(panicAlerts.id, id)))
      .returning();
    if (row.facilityIncidentId)
      await tx
        .update(facilityIncidents)
        .set({ respondedBy: actor, respondedAt: now })
        .where(
          and(
            eq(facilityIncidents.tenantId, tenantId),
            eq(facilityIncidents.id, row.facilityIncidentId),
            sql`${facilityIncidents.respondedAt} IS NULL`,
          ),
        );
    await auditFacility(tx, context, actor, now, {
      action: "panic_alert.acknowledge",
      objectType: "panic_alert",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: row.id, status: "open" },
      after: { id: row.id, status: "acknowledged" },
    });
    return toPanicAlert(row);
  });
}

const CURSOR_TAG = "pa1";
const RECEIVED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
// Microsecond text of received_at: a JS Date would cut it to milliseconds and
// skip or repeat rows at a page border.
const receivedOf = sql<string>`to_char(${panicAlerts.receivedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function decodePanicCursor(cursor: string): { at: string; id: string } {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  }
  const [tag, at, id, extra] = keys;
  if (
    tag !== CURSOR_TAG ||
    typeof at !== "string" ||
    !RECEIVED_PATTERN.test(at) ||
    typeof id !== "string" ||
    !panicAlertIdSchema.safeParse(id).success ||
    extra !== undefined
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  return { at, id };
}

/** Alerts of an outlet, newest first. Authorization is the caller's (route). */
export async function listPanicAlerts(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: { limit: number; cursor?: string },
): Promise<CursorPage<PanicAlert>> {
  const after = query.cursor ? decodePanicCursor(query.cursor) : null;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ row: panicAlerts, received: receivedOf })
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, context.tenant.tenantId),
          eq(panicAlerts.outletId, outletId),
          after === null
            ? undefined
            : sql`(${panicAlerts.receivedAt}, ${panicAlerts.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(panicAlerts.receivedAt), desc(panicAlerts.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ row }) => toPanicAlert(row)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([CURSOR_TAG, last.received, ulidToUuid(last.row.id)])
            : null,
      },
    };
  });
}
