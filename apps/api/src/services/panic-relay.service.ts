// Emergency button relay (bead legend-bod.4; PRD v1.7 §3 F25 "Keselamatan",
// FAC-08; design docs/design/edge-emergency.md D-05, D-06, D-07, D-09).
// Runs on the outlet edge, and in the cloud API for a cloud-only outlet.
//
// - `ingestPanicPress`: a registered `panic_button` posts a press. One alert per
//   press burst (deterministic id, D-06): the same (device, eventId) returns the
//   stored alert, another press within 60 s of an open alert folds into it. The
//   alert, the press row and the `panic_alert.*` outbox event commit together.
// - Fan-out (D-05): after commit the frame goes to every socket of the outlet
//   whose receiver session still qualifies (re-checked at every send), is resent
//   every 3 s until the phone confirms (`received`), and is sent at once to a
//   socket that connects later.
// - Fallback (Q94): no human ack within 15 s -> the alert shows on every POS
//   screen of the outlet (room and time only, `GET /api/emergency/fallback`).
//   A phone's automatic receipt does not stop it.
// - `acknowledgePanicAlert`: first receiver wins under a row lock (D-07).
//
// Every query runs inside `withTenant` under the outlet of the device or the
// session; the tenant and the outlet never come from a request body.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  toIsoDateTime,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EMERGENCY_REVOKED_CLOSE_CODE,
  type PanicFallbackItem,
  type PanicPressBody,
  type PanicRealtimeFrame,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import {
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { employees } from "../db/schema/hris.ts";
import {
  panicAlertDeliveries,
  panicAlerts,
  panicPressEvents,
} from "../db/schema/panic-alert.ts";
import { withTenant } from "../db/tenant.ts";
import {
  allSubscribers,
  closeSessionSockets,
  hasSubscribers,
  subscribersOf,
  type HubSubscriber,
} from "../edge/panic-relay-hub.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import { logger } from "../lib/logger.ts";
import { toLoggableError } from "../lib/safe-error.ts";
import { outletContext } from "./device-pin-support.ts";
import type { EdgeTx } from "./edge-queue.service.ts";
import { panicAlertIdFor, queuePanicAlertEvent } from "./panic-alert-outbox.ts";
import { refuseWhenEdgeServesOutlet } from "./panic-edge-ownership.ts";
import {
  recheckReceiverSession,
  type ReceiverSession,
} from "./panic-receiver-session.ts";

/** A later press of the same button within this window folds into the open alert (D-06). */
export const PANIC_FOLD_WINDOW_MS = 60_000;
/** More presses than this per minute from one device answer 429 (D-06). */
export const PANIC_PRESS_RATE_LIMIT_PER_MIN = 30;
/** An unconfirmed frame is sent again this often (D-05). */
export const PANIC_RESEND_INTERVAL_MS = 3_000;
/** No receipt for this long: the POS fallback shows the alarm (Q94, D-05). */
export const PANIC_FALLBACK_AFTER_MS = 15_000;
/** Resending stops this long after the alert (D-05). */
export const PANIC_RESEND_UNTIL_MS = 10 * 60_000;
/** An open alert older than this is not sent to a socket that connects later. */
const CONNECT_LOOKBACK_MS = 24 * 60 * 60_000;

const pressLimiter = createFixedWindowCounter({
  limit: PANIC_PRESS_RATE_LIMIT_PER_MIN,
  windowMs: 60_000,
  capacity: 10_000,
});

/** Counts one request of a device; throws 429 past the limit (D-06). */
export function takePanicPressSlot(
  tenantId: string,
  deviceId: string,
  now = Date.now(),
): void {
  const retryAfter = pressLimiter.take(`${tenantId}:${deviceId}`, now);
  if (retryAfter !== null)
    throw new HttpError(
      429,
      "RATE_LIMITED",
      `Terlalu banyak penekanan. Coba lagi dalam ${retryAfter} detik.`,
    );
}

type AlertRow = typeof panicAlerts.$inferSelect;

// Location is optional: missing or removed unit/area never removes an alert.
// Keep qualified identifiers literal: Drizzle strips column qualifiers from
// single-table selections, including interpolated columns in subqueries.
const alertAreaName = sql<string | null>`(
  SELECT area.name FROM facility_units AS unit
  JOIN facility_areas AS area ON area.tenant_id = unit.tenant_id
    AND area.outlet_id = unit.outlet_id
    AND area.facility_id = unit.facility_id
    AND area.id = unit.area_id
  WHERE unit.tenant_id = panic_alerts.tenant_id
    AND unit.outlet_id = panic_alerts.outlet_id
    AND unit.id = panic_alerts.unit_id
  LIMIT 1
)`;

const logFailure = (message: string, error: unknown) =>
  logger.error({ err: toLoggableError(error) }, message);

const tenantWide = (tenant: TenantContext): ScopedTenantContext =>
  establishScopedTenantContext(tenant, { kind: "tenant" });

function frameOf(
  alert: Pick<
    AlertRow,
    "id" | "outletId" | "unitId" | "unitCodeSnapshot" | "receivedAt" | "kind"
  >,
  areaName: string | null = null,
): PanicRealtimeFrame {
  return {
    type: "panic",
    alertId: alert.id,
    outletId: outletIdSchema.parse(alert.outletId),
    unitId: alert.unitId,
    unitCode: alert.unitCodeSnapshot || null,
    areaName,
    receivedAt: toIsoDateTime(alert.receivedAt),
    kind: alert.kind === "test" ? "test" : "press",
  };
}

// ------------------------------------------------------------------- ingest

export type PressResult = {
  alertId: string;
  /** The same (device, eventId) was stored before. */
  replayed: boolean;
  /** A new press folded into the open alert of the device. */
  folded: boolean;
  pressCount: number;
  acknowledged: boolean;
};

type Outcome = {
  alert: AlertRow;
  areaName?: string | null;
  replayed: boolean;
  folded: boolean;
  created: boolean;
};

/**
 * One press of a panic button. `tenant` is the server-minted context of the
 * device token; the device must be an active `panic_button`. The outlet is the
 * device's own.
 */
export async function ingestPanicPress(
  tenant: TenantContext,
  input: { deviceId: string; body: PanicPressBody; now?: Date },
): Promise<PressResult> {
  const now = input.now ?? new Date();
  const tenantId = tenant.tenantId;
  const [device] = await withTenant(db, tenantWide(tenant), (tx) =>
    tx
      .select()
      .from(devices)
      .where(
        and(eq(devices.tenantId, tenantId), eq(devices.id, input.deviceId)),
      )
      .limit(1),
  );
  if (!device || device.status !== "active" || device.revokedAt !== null)
    throw new CoreError("UNAUTHORIZED", "Tombol darurat tidak terdaftar.");
  if (device.type !== "panic_button")
    throw new HttpError(
      403,
      "NOT_A_PANIC_BUTTON",
      "Perangkat ini bukan tombol darurat.",
    );
  const outletId = device.outletId as OutletId;
  await refuseWhenEdgeServesOutlet(tenant, outletId);
  const context = outletContext(tenant, outletId);
  const runtime = getEdgeRuntimeState();
  const linkOffline =
    runtime.edgeMode && runtime.link.cloudLink !== "connected";
  const originEdgeNodeId = runtime.edgeMode
    ? (runtime.identity?.scope.edgeNodeId ?? null)
    : null;
  const nobodyConnected = !hasSubscribers({ tenantId, outletId });
  const { body } = input;

  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<Outcome> => {
      // One press of a device at a time: replay, fold and create stay exact.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`panic:${tenantId}:${device.id}`}, 0))`,
      );
      const alertOf = async (id: string) => {
        const [row] = await tx
          .select({ ...getTableColumns(panicAlerts), areaName: alertAreaName })
          .from(panicAlerts)
          .where(
            and(eq(panicAlerts.tenantId, tenantId), eq(panicAlerts.id, id)),
          )
          .limit(1);
        if (!row) throw new CoreError("NOT_FOUND", "Panic alert not found");
        return row;
      };
      const [prior] = await tx
        .select({ alertId: panicPressEvents.alertId })
        .from(panicPressEvents)
        .where(
          and(
            eq(panicPressEvents.tenantId, tenantId),
            eq(panicPressEvents.deviceId, device.id),
            eq(panicPressEvents.deviceEventId, body.eventId),
          ),
        )
        .limit(1);
      if (prior) {
        const alert = await alertOf(prior.alertId);
        return {
          alert,
          areaName: alert.areaName,
          replayed: true,
          folded: false,
          created: false,
        };
      }

      const [open] = await tx
        .select({ ...getTableColumns(panicAlerts), areaName: alertAreaName })
        .from(panicAlerts)
        .where(
          and(
            eq(panicAlerts.tenantId, tenantId),
            eq(panicAlerts.deviceId, device.id),
            eq(panicAlerts.kind, body.kind),
            isNull(panicAlerts.acknowledgedAt),
            gt(
              panicAlerts.receivedAt,
              new Date(now.getTime() - PANIC_FOLD_WINDOW_MS),
            ),
          ),
        )
        .orderBy(desc(panicAlerts.receivedAt))
        .limit(1)
        .for("no key update");
      if (open) {
        await tx.insert(panicPressEvents).values({
          tenantId,
          outletId,
          deviceId: device.id,
          deviceEventId: body.eventId,
          alertId: open.id,
          receivedAt: now,
        });
        const [folded] = await tx
          .update(panicAlerts)
          .set({ pressCount: sql`${panicAlerts.pressCount} + 1` })
          .where(
            and(
              eq(panicAlerts.tenantId, tenantId),
              eq(panicAlerts.id, open.id),
            ),
          )
          .returning();
        if (!folded) throw new CoreError("NOT_FOUND", "Panic alert not found");
        await queuePanicAlertEvent(tx, context, {
          outletId,
          alertId: folded.id,
          now,
          event: {
            key: "pressed",
            payload: {
              alertId: folded.id,
              deviceId: device.id,
              deviceEventId: body.eventId,
              receivedAt: toIsoDateTime(now),
              pressCount: folded.pressCount,
            },
          },
        });
        return {
          alert: folded,
          areaName: open.areaName,
          replayed: false,
          folded: true,
          created: false,
        };
      }

      // The room of the button; a button without a room still raises an alert.
      const [unit] = await tx
        .select({
          id: facilityUnits.id,
          code: facilityUnits.code,
          facilityName: facilities.name,
          areaName: facilityAreas.name,
        })
        .from(facilityUnits)
        .innerJoin(
          facilities,
          and(
            eq(facilities.tenantId, facilityUnits.tenantId),
            eq(facilities.id, facilityUnits.facilityId),
          ),
        )
        .leftJoin(
          facilityAreas,
          and(
            eq(facilityAreas.tenantId, facilityUnits.tenantId),
            eq(facilityAreas.outletId, facilityUnits.outletId),
            eq(facilityAreas.facilityId, facilityUnits.facilityId),
            eq(facilityAreas.id, facilityUnits.areaId),
          ),
        )
        .where(
          and(
            eq(facilityUnits.tenantId, tenantId),
            eq(facilityUnits.outletId, outletId),
            eq(facilityUnits.panicDeviceId, device.id),
          ),
        )
        .limit(1);
      const alertId = panicAlertIdFor(tenantId, device.id, body.eventId);
      const triggeredAt = body.triggeredAt ? new Date(body.triggeredAt) : null;
      const [created] = await tx
        .insert(panicAlerts)
        .values({
          id: alertId,
          tenantId,
          outletId,
          deviceId: device.id,
          unitId: unit?.id ?? null,
          firstDeviceEventId: body.eventId,
          unitCodeSnapshot: unit?.code ?? "",
          facilityNameSnapshot: unit?.facilityName ?? "",
          deviceLabelSnapshot: device.label,
          kind: body.kind,
          triggeredAt,
          receivedAt: now,
          pressCount: 1,
          origin: runtime.edgeMode ? "edge" : "cloud",
          originEdgeNodeId,
          linkOffline,
          unroutedSince: nobodyConnected ? now : null,
        })
        .onConflictDoNothing()
        .returning();
      if (!created)
        return {
          alert: await alertOf(alertId),
          replayed: true,
          folded: false,
          created: false,
        };
      await tx
        .insert(panicPressEvents)
        .values({
          tenantId,
          outletId,
          deviceId: device.id,
          deviceEventId: body.eventId,
          alertId,
          receivedAt: now,
        })
        .onConflictDoNothing();
      await queuePanicAlertEvent(tx, context, {
        outletId,
        alertId,
        now,
        event: {
          key: "raised",
          payload: {
            alertId,
            outletId: outletIdSchema.parse(created.outletId),
            deviceId: device.id,
            unitId: created.unitId,
            firstDeviceEventId: body.eventId,
            kind: created.kind === "test" ? "test" : "press",
            triggeredAt: triggeredAt ? toIsoDateTime(triggeredAt) : null,
            receivedAt: toIsoDateTime(created.receivedAt),
            unitCodeSnapshot: created.unitCodeSnapshot,
            facilityNameSnapshot: created.facilityNameSnapshot,
            deviceLabelSnapshot: created.deviceLabelSnapshot,
            linkOffline,
          },
        },
      });
      return {
        alert: created,
        areaName: unit?.areaName ?? null,
        replayed: false,
        folded: false,
        created: true,
      };
    },
  );

  const { alert } = outcome;
  if (alert.acknowledgedAt === null) {
    // After commit: a rolled back press never reaches a screen. A replay or a
    // folded press shows the open alert again (a lost answer must not go silent).
    try {
      const sent = await fanOutAlert(alert, {
        force: !outcome.created,
        areaName: outcome.areaName ?? null,
      });
      if (outcome.created && sent === 0 && alert.unroutedSince === null)
        await markUnrouted(context, alert);
    } catch (error) {
      logFailure("panic alert fan-out failed", error);
    }
    if (outcome.created && alert.kind === "press")
      scheduleFallback(tenant, alert);
  }
  return {
    alertId: alert.id,
    replayed: outcome.replayed,
    folded: outcome.folded,
    pressCount: alert.pressCount,
    acknowledged: alert.acknowledgedAt !== null,
  };
}

async function markUnrouted(context: ScopedTenantContext, alert: AlertRow) {
  await withTenant(db, context, (tx) =>
    tx
      .update(panicAlerts)
      .set({ unroutedSince: new Date() })
      .where(
        and(
          eq(panicAlerts.tenantId, alert.tenantId),
          eq(panicAlerts.id, alert.id),
          isNull(panicAlerts.unroutedSince),
        ),
      ),
  );
}

// ------------------------------------------------------------------ fan-out

/** Re-checks the socket's session; a failed check closes it (4401). */
async function sessionStillLive(sub: HubSubscriber): Promise<boolean> {
  const check = await recheckReceiverSession(sub.session);
  if (check.ok) return true;
  closeSessionSockets(
    sub.session.tenantId,
    sub.session.id,
    EMERGENCY_REVOKED_CLOSE_CODE,
  );
  sub.close(EMERGENCY_REVOKED_CLOSE_CODE);
  return false;
}

// Alerts a socket is being sent right now (check, send). A second send
// of the same alert to the same socket awaits the running one and returns its
// result, instead of racing it or being counted as unsent.
const sendsInFlight = new WeakMap<
  HubSubscriber,
  Map<string, Promise<boolean>>
>();
// A snapshot read before an acknowledgement may finish afterwards. Remember
// closed IDs for the lifetime of each socket so that stale reads cannot revive
// an alert; the WeakMap is released when that socket is gone.
const closedAlerts = new WeakMap<HubSubscriber, Set<string>>();

function sendFrame(
  sub: HubSubscriber,
  frame: PanicRealtimeFrame,
  alertReceivedAt: number,
  options: { force: boolean },
): Promise<boolean> {
  if (closedAlerts.get(sub)?.has(frame.alertId)) return Promise.resolve(false);
  if (!options.force && sub.alerts.get(frame.alertId)?.received)
    return Promise.resolve(false);
  let inFlight = sendsInFlight.get(sub);
  if (!inFlight) {
    inFlight = new Map();
    sendsInFlight.set(sub, inFlight);
  }
  const running = inFlight.get(frame.alertId);
  if (running) return running;
  const release = () => {
    if (inFlight.get(frame.alertId) === attempt) {
      inFlight.delete(frame.alertId);
    }
  };
  const attempt = doSendFrame(sub, frame, alertReceivedAt, release).finally(
    release,
  );
  inFlight.set(frame.alertId, attempt);
  return attempt;
}

async function doSendFrame(
  sub: HubSubscriber,
  frame: PanicRealtimeFrame,
  alertReceivedAt: number,
  release: () => void,
): Promise<boolean> {
  if (!(await sessionStillLive(sub))) return false;
  if (closedAlerts.get(sub)?.has(frame.alertId)) return false;
  if (!sub.send(frame)) return false;
  // Read `received` again: a receipt can land while the check was running.
  sub.alerts.set(frame.alertId, {
    frame,
    alertReceivedAt,
    lastSentAt: Date.now(),
    received: sub.alerts.get(frame.alertId)?.received ?? false,
  });
  // The frame is out: free the slot before the (possibly slow) delivery write,
  // so a replay or a resend is not held behind it. `release` runs after the
  // first await, so `attempt` already exists.
  release();
  try {
    await recordSent(sub.session, frame);
  } catch (error) {
    logFailure("panic delivery record failed", error);
  }
  return true;
}

/**
 * Sends the alert to every socket of its outlet and returns how many sockets
 * got it. `force` also sends to sockets that already confirmed it (a replayed
 * press shows the alert again).
 */
export async function fanOutAlert(
  alert: AlertRow,
  options: { force: boolean; areaName?: string | null },
): Promise<number> {
  const frame = frameOf(alert, options.areaName);
  const subs = subscribersOf({
    tenantId: alert.tenantId,
    outletId: alert.outletId,
  });
  const results = await Promise.all(
    subs.map((sub) =>
      sendFrame(sub, frame, alert.receivedAt.getTime(), options).catch(
        (error: unknown) => {
          logFailure("panic frame send failed", error);
          return false;
        },
      ),
    ),
  );
  return results.filter(Boolean).length;
}

async function recordSent(session: ReceiverSession, frame: PanicRealtimeFrame) {
  const context = outletContext(tenantOf(session), session.outletId);
  await withTenant(db, context, (tx) =>
    tx
      .insert(panicAlertDeliveries)
      .values({
        tenantId: session.tenantId as TenantId,
        outletId: session.outletId as OutletId,
        alertId: frame.alertId,
        sessionId: session.id,
        userId: session.userId,
      })
      .onConflictDoUpdate({
        target: [
          panicAlertDeliveries.tenantId,
          panicAlertDeliveries.alertId,
          panicAlertDeliveries.sessionId,
        ],
        set: { sentCount: sql`${panicAlertDeliveries.sentCount} + 1` },
      }),
  );
}

function tenantOf(session: ReceiverSession): TenantContext {
  return establishTenantContext({
    tenantId: session.tenantId,
    brandId: null,
    source: "device",
  });
}

/** A socket that just connected: every open alert of its outlet at once (D-05). */
export async function sendOpenAlertsTo(sub: HubSubscriber): Promise<void> {
  const { session } = sub;
  const context = outletContext(tenantOf(session), session.outletId);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ ...getTableColumns(panicAlerts), areaName: alertAreaName })
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, session.tenantId as TenantId),
          eq(panicAlerts.outletId, session.outletId as OutletId),
          isNull(panicAlerts.acknowledgedAt),
          gt(
            panicAlerts.receivedAt,
            new Date(Date.now() - CONNECT_LOOKBACK_MS),
          ),
        ),
      )
      .orderBy(asc(panicAlerts.receivedAt)),
  );
  for (const row of rows)
    await sendFrame(sub, frameOf(row, row.areaName), row.receivedAt.getTime(), {
      force: false,
    });
}

/** Forgets an acknowledged alert on every socket of its outlet: no more resends. */
function dropAlert(tenantId: string, outletId: string, alertId: string) {
  for (const sub of subscribersOf({ tenantId, outletId })) {
    const closed = closedAlerts.get(sub) ?? new Set<string>();
    closed.add(alertId);
    closedAlerts.set(sub, closed);
    sub.alerts.delete(alertId);
  }
}

let lastRefreshAt = 0;

/**
 * One tick of the resend loop (the realtime module calls it every 500 ms):
 * every unconfirmed alert of a socket that was last sent 3 s ago is sent again,
 * until 10 minutes after the alert. Every 3 s the open alerts of the outlets
 * with sockets are re-read, so an acknowledgement made elsewhere (the cloud)
 * stops the resend, and an open alert a socket does not track (failed first
 * send, restart) is sent again.
 */
export async function resendDue(now = Date.now()): Promise<void> {
  const subs = allSubscribers();
  if (subs.length === 0) return;
  if (now - lastRefreshAt >= PANIC_RESEND_INTERVAL_MS) {
    lastRefreshAt = now;
    await forgetClosedAlerts(subs).catch((error: unknown) =>
      logFailure("panic open-alert refresh failed", error),
    );
  }
  await Promise.all(
    subs.flatMap((sub) =>
      [...sub.alerts.entries()].map(async ([alertId, state]) => {
        if (state.received) return;
        if (now - state.alertReceivedAt > PANIC_RESEND_UNTIL_MS) {
          sub.alerts.delete(alertId);
          return;
        }
        if (now - state.lastSentAt < PANIC_RESEND_INTERVAL_MS) return;
        // Claim the slot first: a slow check must not queue a second resend.
        state.lastSentAt = now;
        await sendFrame(sub, state.frame, state.alertReceivedAt, {
          force: false,
        }).catch((error: unknown) =>
          logFailure("panic frame resend failed", error),
        );
      }),
    ),
  );
}

/**
 * Reads the open alerts of every outlet that has sockets, from the database:
 * - an alert a socket tracks that is no longer open is forgotten (an ack or a
 *   resolve made elsewhere stops the resend);
 * - an open alert a socket does not track yet is sent to it, unless that
 *   session already confirmed it. This recovers an alert whose first send
 *   failed (the session re-check threw) and, after a restart, every open alert
 *   of a reconnected socket whose memory is empty (bead legend-w5u1a).
 */
async function forgetClosedAlerts(subs: readonly HubSubscriber[]) {
  const byTenant = new Map<string, Map<string, HubSubscriber>>();
  for (const sub of subs) {
    const { tenantId, outletId } = sub.session;
    let outlets = byTenant.get(tenantId);
    if (!outlets) {
      outlets = new Map();
      byTenant.set(tenantId, outlets);
    }
    outlets.set(outletId, sub);
  }
  // One read per tenant (all its outlets with sockets), tenants in parallel.
  await Promise.all(
    [...byTenant.entries()].map(([tenantId, outlets]) =>
      recoverTenantAlerts(tenantId, [...outlets.keys()], outlets),
    ),
  );
}

async function recoverTenantAlerts(
  tenantId: string,
  outletIds: string[],
  outlets: ReadonlyMap<string, HubSubscriber>,
) {
  const [first] = outlets.values();
  if (!first) return;
  const context = establishScopedTenantContext(tenantOf(first.session), {
    kind: "outlets",
    outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
  });
  // Snapshot before the database read: a later delivery may represent an
  // alert created after the query's snapshot and must not be discarded.
  const tracked = outletIds.flatMap((outletId) =>
    subscribersOf({ tenantId, outletId }).flatMap((sub) =>
      [...sub.alerts.entries()].map(([alertId, state]) => ({
        sub,
        alertId,
        state,
      })),
    ),
  );
  // Only alerts the resend window still covers: older ones are never sent again.
  const open = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: panicAlerts.id,
        outletId: panicAlerts.outletId,
        unitId: panicAlerts.unitId,
        unitCodeSnapshot: panicAlerts.unitCodeSnapshot,
        areaName: alertAreaName,
        kind: panicAlerts.kind,
        receivedAt: panicAlerts.receivedAt,
        unroutedSince: panicAlerts.unroutedSince,
      })
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, tenantId as TenantId),
          inArray(panicAlerts.outletId, outletIds as OutletId[]),
          isNull(panicAlerts.acknowledgedAt),
          isNull(panicAlerts.resolvedAt),
          gt(
            panicAlerts.receivedAt,
            new Date(Date.now() - PANIC_RESEND_UNTIL_MS),
          ),
        ),
      )
      .orderBy(asc(panicAlerts.receivedAt)),
  );
  const openIds = new Set(open.map((row) => row.id));
  for (const { sub, alertId, state } of tracked)
    if (!openIds.has(alertId) && sub.alerts.get(alertId) === state)
      sub.alerts.delete(alertId);
  if (open.length === 0) return;
  const confirmed = await withTenant(db, context, (tx) =>
    tx
      .select({
        alertId: panicAlertDeliveries.alertId,
        sessionId: panicAlertDeliveries.sessionId,
      })
      .from(panicAlertDeliveries)
      .where(
        and(
          eq(panicAlertDeliveries.tenantId, tenantId as TenantId),
          inArray(panicAlertDeliveries.outletId, outletIds as OutletId[]),
          inArray(panicAlertDeliveries.alertId, [...openIds]),
          isNotNull(panicAlertDeliveries.receivedAt),
        ),
      ),
  );
  const confirmedKeys = new Set(
    confirmed.map((row) => `${row.sessionId}:${row.alertId}`),
  );
  const now = Date.now();
  const recovered = new Set<string>();
  await Promise.all(
    open.flatMap((row) =>
      subscribersOf({ tenantId, outletId: row.outletId })
        .filter(
          (outletSub) =>
            !outletSub.alerts.has(row.id) &&
            now - row.receivedAt.getTime() <= PANIC_RESEND_UNTIL_MS &&
            !confirmedKeys.has(`${outletSub.session.id}:${row.id}`),
        )
        .map((outletSub) =>
          sendFrame(
            outletSub,
            frameOf(row, row.areaName),
            row.receivedAt.getTime(),
            {
              force: false,
            },
          )
            .then((sent) => {
              if (sent && row.unroutedSince !== null) recovered.add(row.id);
            })
            .catch((error: unknown) =>
              logFailure("panic frame recovery failed", error),
            ),
        ),
    ),
  );
  // A screen got an alert nobody could receive before: it is routed now.
  if (recovered.size > 0)
    await withTenant(db, context, (tx) =>
      tx
        .update(panicAlerts)
        .set({ unroutedSince: null })
        .where(
          and(
            eq(panicAlerts.tenantId, tenantId as TenantId),
            inArray(panicAlerts.id, [...recovered]),
            isNotNull(panicAlerts.unroutedSince),
          ),
        ),
    );
}

// ------------------------------------------------------------------ receipts

/**
 * The phone showed the alert (`received` frame): stored per recipient, and the
 * alert keeps the count and the first time (the FAC-08 proof, edge clock).
 */
export async function recordReceipt(
  sub: HubSubscriber,
  alertId: string,
  now = new Date(),
): Promise<void> {
  const { session } = sub;
  const context = outletContext(tenantOf(session), session.outletId);
  // Stored first, flagged after: a receipt that fails to commit must not stop
  // the resend and the recovery. One retry on a deadlock or serialization abort.
  try {
    await storeReceipt(session, context, alertId, now);
  } catch (error) {
    if (!isRetryableTxError(error)) throw error;
    await storeReceipt(session, context, alertId, now);
  }
  const state = sub.alerts.get(alertId);
  if (state) state.received = true;
}

function isRetryableTxError(error: unknown): boolean {
  for (let cause = error; cause && typeof cause === "object";) {
    const code = (cause as { code?: unknown }).code;
    if (code === "40P01" || code === "40001") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

async function storeReceipt(
  session: ReceiverSession,
  context: ScopedTenantContext,
  alertId: string,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [alert] = await tx
      .select({ id: panicAlerts.id })
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, session.tenantId as TenantId),
          eq(panicAlerts.outletId, session.outletId as OutletId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .limit(1)
      .for("no key update");
    if (!alert) return;
    const [delivery] = await tx
      .select({ receivedAt: panicAlertDeliveries.receivedAt })
      .from(panicAlertDeliveries)
      .where(
        and(
          eq(panicAlertDeliveries.tenantId, session.tenantId as TenantId),
          eq(panicAlertDeliveries.alertId, alertId),
          eq(panicAlertDeliveries.sessionId, session.id),
        ),
      )
      .limit(1);
    if (delivery?.receivedAt) return;
    if (delivery)
      await tx
        .update(panicAlertDeliveries)
        .set({ receivedAt: now })
        .where(
          and(
            eq(panicAlertDeliveries.tenantId, session.tenantId as TenantId),
            eq(panicAlertDeliveries.alertId, alertId),
            eq(panicAlertDeliveries.sessionId, session.id),
          ),
        );
    else
      // Upsert, not a plain insert: `sendFrame` sends the frame before it
      // records the send, so the receipt can race that insert. A plain insert
      // then hit the unique key, the receipt was lost and delivered_count
      // stayed one short (flake EM-01 Q95).
      await tx
        .insert(panicAlertDeliveries)
        .values({
          tenantId: session.tenantId as TenantId,
          outletId: session.outletId as OutletId,
          alertId,
          sessionId: session.id,
          userId: session.userId,
          receivedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            panicAlertDeliveries.tenantId,
            panicAlertDeliveries.alertId,
            panicAlertDeliveries.sessionId,
          ],
          set: {
            receivedAt: sql`COALESCE(${panicAlertDeliveries.receivedAt}, ${now.toISOString()}::timestamptz)`,
          },
        });
    const [updated] = await tx
      .update(panicAlerts)
      .set({
        // Counted from the receipt rows (same transaction, alert row locked):
        // a blind +1 could drift from the rows if a receipt were ever skipped.
        deliveredCount: sql`(SELECT count(*)::int FROM panic_alert_deliveries WHERE tenant_id = ${session.tenantId}::uuid AND alert_id = ${alertId}::uuid AND received_at IS NOT NULL)`,
        firstDeliveredAt: sql`COALESCE(${panicAlerts.firstDeliveredAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(panicAlerts.tenantId, session.tenantId as TenantId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .returning();
    // The `delivered` event is queued on this same transaction (D-09): no RAM
    // timer, so a restart cannot lose it. A receipt that was already stored
    // returned above, so one event is queued per new receipt, carrying the
    // running total.
    if (updated) await queueDelivered(tx, context, updated, now);
  });
}

function queueDelivered(
  tx: EdgeTx,
  context: ScopedTenantContext,
  alert: AlertRow,
  now?: Date,
) {
  return queuePanicAlertEvent(tx, context, {
    outletId: alert.outletId,
    alertId: alert.id,
    now,
    event: {
      key: "delivered",
      payload: {
        alertId: alert.id,
        deliveredCount: alert.deliveredCount,
        firstDeliveredAt: alert.firstDeliveredAt
          ? toIsoDateTime(alert.firstDeliveredAt)
          : null,
        fallbackShownAt: alert.fallbackShownAt
          ? toIsoDateTime(alert.fallbackShownAt)
          : null,
      },
    },
  });
}

// ----------------------------------------------------------------- fallback

/**
 * Stamps `fallback_shown_at` when nobody took the alert (Q94): the POS screens
 * of the outlet now show it. The automatic receipt of a phone does not stop it;
 * only a human acknowledgement (or a resolve) does. Set once; queues a
 * `delivered` event so the cloud learns it.
 */
async function markFallbackShown(
  context: ScopedTenantContext,
  tenantId: string,
  alertId: string,
  now = new Date(),
): Promise<boolean> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(panicAlerts)
      .set({ fallbackShownAt: now })
      .where(
        and(
          eq(panicAlerts.tenantId, tenantId as TenantId),
          eq(panicAlerts.id, alertId),
          eq(panicAlerts.kind, "press"),
          isNull(panicAlerts.fallbackShownAt),
          isNull(panicAlerts.acknowledgedAt),
        ),
      )
      .returning();
    if (!row) return false;
    await queueDelivered(tx, context, row);
    return true;
  });
}

/**
 * Clock of the server fallback timer (Q94). Tests replace it through
 * `setPanicClockForTest`; production keeps the real clock and `setTimeout`.
 */
export const panicClock = {
  now: (): Date => new Date(),
  setTimer: (fn: () => void, ms: number): { unref(): void } =>
    setTimeout(fn, ms),
};

/** Replaces parts of `panicClock`; returns a function that restores them. */
export function setPanicClockForTest(
  patch: Partial<typeof panicClock>,
): () => void {
  const previous = { ...panicClock };
  Object.assign(panicClock, patch);
  return () => {
    Object.assign(panicClock, previous);
  };
}

function scheduleFallback(tenant: TenantContext, alert: AlertRow) {
  const wait = Math.max(
    0,
    alert.receivedAt.getTime() +
      PANIC_FALLBACK_AFTER_MS -
      panicClock.now().getTime(),
  );
  const context = outletContext(tenant, alert.outletId);
  const timer = panicClock.setTimer(() => {
    void markFallbackShown(
      context,
      alert.tenantId,
      alert.id,
      panicClock.now(),
    ).catch((error: unknown) =>
      logFailure("panic fallback stamp failed", error),
    );
  }, wait);
  timer.unref();
}

/**
 * The alarms a POS screen of the outlet shows (Q94): open press alerts of the
 * last 24 hours (CONNECT_LOOKBACK_MS, as for a socket that connects later) that
 * no human acknowledged within 15 s (a phone's automatic receipt does not
 * count), or that the fallback already showed. Room name
 * and time only. The device is read from the token by the route; it must be a
 * `pos` (403 otherwise).
 */
export async function readPanicFallback(
  tenant: TenantContext,
  deviceId: string,
  now = new Date(),
): Promise<PanicFallbackItem[]> {
  const tenantId = tenant.tenantId;
  const [device] = await withTenant(db, tenantWide(tenant), (tx) =>
    tx
      .select({ outletId: devices.outletId, type: devices.type })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
      .limit(1),
  );
  if (!device)
    throw new CoreError("UNAUTHORIZED", "Perangkat tidak terdaftar.");
  // Only a POS screen shows the fallback (Q94); a phone or a button never does.
  if (device.type !== "pos")
    throw new HttpError(
      403,
      "NOT_A_POS_DEVICE",
      "Hanya layar POS yang menampilkan alarm cadangan.",
    );
  const outletId = device.outletId as OutletId;
  await refuseWhenEdgeServesOutlet(tenant, outletId);
  const context = outletContext(tenant, outletId);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, tenantId),
          eq(panicAlerts.outletId, outletId),
          eq(panicAlerts.kind, "press"),
          isNull(panicAlerts.acknowledgedAt),
          // Same window as a socket that connects later: older open alerts stay out.
          gt(
            panicAlerts.receivedAt,
            new Date(now.getTime() - CONNECT_LOOKBACK_MS),
          ),
          or(
            sql`${panicAlerts.fallbackShownAt} IS NOT NULL`,
            lte(
              panicAlerts.receivedAt,
              new Date(now.getTime() - PANIC_FALLBACK_AFTER_MS),
            ),
          ),
        ),
      )
      .orderBy(asc(panicAlerts.receivedAt)),
  );
  for (const row of rows)
    if (row.fallbackShownAt === null)
      await markFallbackShown(context, tenantId, row.id, now).catch(
        (error: unknown) => logFailure("panic fallback stamp failed", error),
      );
  return rows.map((row) => ({
    alertId: row.id,
    unitCode: row.unitCodeSnapshot === "" ? null : row.unitCodeSnapshot,
    receivedAt: toIsoDateTime(row.receivedAt),
  }));
}

// ---------------------------------------------------------------------- ack

export type AckResult = { alertId: string; acknowledgedAt: string };

/**
 * First acknowledgement wins (D-07). The row is locked, so two receivers cannot
 * both win: the second gets 409 naming who took it. The same staff member
 * repeating gets the stored result. The alert of another outlet is 404 (the
 * session is scoped to one outlet).
 */
export async function acknowledgePanicAlert(
  session: ReceiverSession,
  alertId: string,
  now = new Date(),
): Promise<AckResult> {
  const context = outletContext(tenantOf(session), session.outletId);
  const result = await withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(panicAlerts)
      .where(
        and(
          eq(panicAlerts.tenantId, session.tenantId as TenantId),
          eq(panicAlerts.outletId, session.outletId as OutletId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .limit(1)
      .for("no key update");
    if (!locked)
      throw new HttpError(404, "NOT_FOUND", "Peringatan tidak ditemukan.");
    if (locked.acknowledgedAt !== null) {
      if (locked.acknowledgedBy === session.userId)
        return { alert: locked, taken: false };
      const [who] = await tx
        .select({ fullName: employees.fullName })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, session.tenantId as TenantId),
            eq(employees.userId, (locked.acknowledgedBy ?? "") as UserId),
          ),
        )
        .limit(1);
      throw new HttpError(
        409,
        "PANIC_ALREADY_ACKNOWLEDGED",
        `Peringatan ini sudah ditangani oleh ${who?.fullName ?? "rekan lain"}.`,
        {
          acknowledgedBy: { displayName: who?.fullName ?? "rekan lain" },
          acknowledgedAt: toIsoDateTime(locked.acknowledgedAt),
        },
      );
    }
    const [row] = await tx
      .update(panicAlerts)
      .set({
        acknowledgedAt: now,
        acknowledgedBy: session.userId,
        ackDeviceId: session.deviceId,
      })
      .where(
        and(
          eq(panicAlerts.tenantId, session.tenantId as TenantId),
          eq(panicAlerts.id, alertId),
        ),
      )
      .returning();
    if (!row) throw new CoreError("NOT_FOUND", "Panic alert not found");
    await queuePanicAlertEvent(tx, context, {
      outletId: session.outletId,
      alertId,
      now,
      event: {
        key: "acknowledged",
        payload: {
          alertId,
          acknowledgedBy: userIdSchema.parse(session.userId),
          ackDeviceId: session.deviceId,
          acknowledgedAt: toIsoDateTime(now),
        },
      },
    });
    return { alert: row, taken: true };
  });
  dropAlert(session.tenantId, session.outletId, alertId);
  if (result.taken) {
    // This is best effort after commit: a lookup or socket failure must never
    // undo or delay the staff member's acknowledgement.
    void (async () => {
      const [who] = await withTenant(db, context, (tx) =>
        tx
          .select({ fullName: employees.fullName })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, session.tenantId as TenantId),
              eq(employees.userId, session.userId as UserId),
            ),
          )
          .limit(1),
      ).catch((error: unknown) => {
        logFailure("panic acknowledgement name lookup failed", error);
        return [];
      });
      const frame = {
        type: "acknowledged" as const,
        alertId,
        acknowledgedAt: toIsoDateTime(result.alert.acknowledgedAt ?? now),
        byName: who?.fullName ?? "rekan lain",
      };
      await Promise.all(
        subscribersOf(session).map(async (subscriber) => {
          try {
            if (await sessionStillLive(subscriber)) subscriber.send(frame);
          } catch (error) {
            logFailure("panic acknowledgement frame send failed", error);
          }
        }),
      );
    })();
  }
  return {
    alertId,
    acknowledgedAt: toIsoDateTime(result.alert.acknowledgedAt ?? now),
  };
}
