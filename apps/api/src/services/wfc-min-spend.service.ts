// WFC min-spend monitor (PRD v1.7 §3 F39 "Wi-Fi Berbasis Belanja", FAC-14;
// bead legend-bz9h). Run by a job per zone. For every open table session of
// the zone it reads what the table paid in the current one-hour window and,
// when that is under the zone's `min_spend_per_hour_idr`, sends a polite nudge.
//
// Money rules (jangan sampai rugi):
// - M6: the monitor only nudges. It never charges, blocks or ends a session and
//   never writes to orders, tenders or sessions; its only writes are the
//   `wfc_spend_windows` row and the notification events.
//   At most `maxNudgesPerWindow` nudges per window, the first only after 30
//   minutes of the window, two nudges at least 15 minutes apart. The conditional
//   UPDATE below enforces both limits even when two runs race.
// - M7: spend = captured tenders (not points) of completed orders of the
//   session, paid inside the window. A refund (POS refund or completed gateway
//   refund of the tender's intent) subtracts; an order never counts below 0.
//   When both refund records exist for one order the larger one is used, never
//   the sum, so one refund is not subtracted twice.
//
// The window: the hour that starts at the later of the session's opening and
// the start of the peak window that contains `now`, stepped in whole hours.
// Only a peak window of the zone's wifi policy is evaluated (outlet time zone).
// A zone without a policy, or with a null / 0 minimum, is skipped.
import { and, eq, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  minutesOfDay,
  wallClockAt,
  windowEndMinutes,
} from "@starter/shared/facility";
import {
  maxNudgesPerWindow,
  MIN_SPEND_FIRST_NUDGE_MINUTES,
  MIN_SPEND_NUDGE_GAP_MINUTES,
  MIN_SPEND_WINDOW_MINUTES,
  wfcMinSpendNudgedEvent,
  type MinSpendSessionResult,
  type MinSpendSummary,
} from "@starter/shared/wfc";
import { db } from "../db/index.ts";
import { wifiPolicies } from "../db/schema/facility.ts";
import { wfcSpendWindows } from "../db/schema/wfc-spend.ts";
import { withTenant } from "../db/tenant.ts";
import { createNotificationConsumer } from "./notification-consumer.ts";
import { appendNotificationEvent } from "./notification-events.ts";
import { buildRecipients } from "./service-request.service.ts";
import { outletTimeZone, type Tx } from "./facility-shared.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = MIN_SPEND_WINDOW_MINUTES * MINUTE_MS;

type Row = Record<string, unknown>;

export type EvaluateMinSpendInput = { zoneId: string; now: Date };

const rupiah = (value: number) => `Rp${value.toLocaleString("id-ID")}`;

/** Polite wording: invites, never demands, never mentions a limit on the stay. */
function nudgeContent(spentIdr: number, minSpendIdr: number) {
  return {
    title: "Terima kasih sudah bekerja bersama kami",
    body: `Belanja Anda jam ini baru ${rupiah(spentIdr)}. Kami berharap tiap tamu berbelanja sekitar ${rupiah(minSpendIdr)} per jam agar tempat ini tetap nyaman untuk semua. Silakan pesan lagi kapan pun Anda siap.`,
  };
}

/** Start of the peak window of the policy that covers `now`, or null. */
function peakStartAt(
  peakSchedule: readonly {
    daysOfWeek: number[];
    startsAt: string;
    endsAt: string;
  }[],
  now: Date,
  timeZone: string,
): Date | null {
  const clock = wallClockAt(now, timeZone);
  const peak = peakSchedule.find(
    (window) =>
      window.daysOfWeek.includes(clock.dayOfWeek) &&
      clock.minutesOfDay >= minutesOfDay(window.startsAt) &&
      clock.minutesOfDay < windowEndMinutes(window.endsAt),
  );
  if (!peak) return null;
  const minuteStart = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(
    minuteStart -
      (clock.minutesOfDay - minutesOfDay(peak.startsAt)) * MINUTE_MS,
  );
}

/**
 * M7: paid spend of one table session inside [from, now]. Per order the paid
 * tenders minus the refunds of the same span, floored at 0.
 */
async function spentInWindow(
  tx: Tx,
  tenantId: string,
  sessionId: string,
  from: Date,
  to: Date,
  now: Date,
): Promise<number> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const nowIso = now.toISOString();
  const result = await tx.execute(sql`
    WITH paid AS (
      SELECT o.id AS order_id, SUM(t.amount_idr) AS paid
        FROM orders o
        JOIN pos_order_tenders t
          ON t.tenant_id = o.tenant_id AND t.order_id = o.id
       WHERE o.tenant_id = ${tenantId} AND o.table_session_id = ${sessionId}
         AND o.status = 'completed'
         AND t.status = 'captured' AND t.method <> 'points'
         AND COALESCE(t.resolved_at, t.requested_at) >= ${fromIso}::timestamptz
         AND COALESCE(t.resolved_at, t.requested_at) < ${toIso}::timestamptz
         AND COALESCE(t.resolved_at, t.requested_at) <= ${nowIso}::timestamptz
       GROUP BY o.id)
    SELECT paid.paid,
           GREATEST(
             COALESCE((SELECT SUM(r.amount_idr) FROM pos_order_refunds r
                        WHERE r.tenant_id = ${tenantId} AND r.order_id = paid.order_id
                          AND r.refunded_at >= ${fromIso}::timestamptz
                          AND r.refunded_at <= ${nowIso}::timestamptz), 0),
             COALESCE((SELECT SUM(pr.amount_idr) FROM payment_refunds pr
                        WHERE pr.tenant_id = ${tenantId} AND pr.status = 'completed'
                          AND pr.completed_at >= ${fromIso}::timestamptz
                          AND pr.completed_at <= ${nowIso}::timestamptz
                          AND pr.payment_intent_id IN (
                            SELECT t2.payment_intent_id FROM pos_order_tenders t2
                             WHERE t2.tenant_id = ${tenantId}
                               AND t2.order_id = paid.order_id
                               AND t2.payment_intent_id IS NOT NULL)), 0)
           ) AS refunded
      FROM paid`);
  return (result.rows as Row[]).reduce(
    (sum, row) => sum + Math.max(0, Number(row.paid) - Number(row.refunded)),
    0,
  );
}

/** Signed-in guests of the table (the only people a notification can reach). */
async function participantUserIds(
  tx: Tx,
  tenantId: string,
  sessionId: string,
): Promise<string[]> {
  const result = await tx.execute(sql`
    SELECT DISTINCT user_id::text AS user_id FROM session_participants
     WHERE tenant_id = ${tenantId} AND table_session_id = ${sessionId}
       AND user_id IS NOT NULL`);
  return (result.rows as Row[]).map((row) => String(row.user_id)).sort();
}

async function customerProfileOf(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
): Promise<string | null> {
  const [userId] = userIds;
  if (!userId) return null;
  const result = await tx.execute(sql`
    SELECT id FROM customer_profiles
     WHERE tenant_id = ${tenantId} AND user_id = ${userId}
       AND merged_into_profile_id IS NULL
     ORDER BY created_at, id LIMIT 1`);
  const row = (result.rows as Row[])[0];
  return row ? String(row.id) : null;
}

/**
 * One monitor run for one zone at `now`. Idempotent: a second run at the same
 * instant changes nothing. Returns what it saw, per session.
 */
export async function evaluateMinSpend(
  context: ScopedTenantContext,
  input: EvaluateMinSpendInput,
): Promise<MinSpendSummary> {
  const { zoneId, now } = input;
  const tenantId = context.tenant.tenantId;
  const skipped: MinSpendSummary = {
    zoneId,
    evaluated: false,
    sessions: [],
    nudgesSent: 0,
  };
  return withTenant(db, context, async (tx) => {
    const [policy] = await tx
      .select()
      .from(wifiPolicies)
      .where(
        and(
          eq(wifiPolicies.tenantId, tenantId),
          eq(wifiPolicies.zoneId, zoneId),
        ),
      )
      .limit(1);
    const minSpend = policy?.minSpendPerHourIdr
      ? Number(policy.minSpendPerHourIdr)
      : 0;
    if (!policy || minSpend <= 0) return skipped;
    const timeZone = await outletTimeZone(tx, context, policy.outletId);
    const peakStart = peakStartAt(policy.peakSchedule, now, timeZone);
    if (!peakStart) return skipped;

    const sessions = (
      await tx.execute(sql`
        SELECT s.id, s.outlet_id, s.opened_at
          FROM table_sessions s
          JOIN tables t ON t.tenant_id = s.tenant_id AND t.id = s.table_id
         WHERE s.tenant_id = ${tenantId} AND t.zone_id = ${zoneId}
           AND s.status IN ('open', 'bill_requested')
         ORDER BY s.opened_at, s.id`)
    ).rows as Row[];

    const results: MinSpendSessionResult[] = [];
    let nudgesSent = 0;
    for (const session of sessions) {
      const sessionId = String(session.id);
      const anchorMs = Math.max(
        new Date(session.opened_at as string | Date).getTime(),
        peakStart.getTime(),
      );
      if (now.getTime() < anchorMs) continue;
      const windowStart = new Date(
        anchorMs + Math.floor((now.getTime() - anchorMs) / HOUR_MS) * HOUR_MS,
      );
      const windowEnd = new Date(windowStart.getTime() + HOUR_MS);
      const spent = await spentInWindow(
        tx,
        tenantId,
        sessionId,
        windowStart,
        windowEnd,
        now,
      );
      const users = await participantUserIds(tx, tenantId, sessionId);

      await tx
        .insert(wfcSpendWindows)
        .values({
          tenantId,
          outletId: policy.outletId,
          zoneId,
          tableSessionId: sessionId,
          customerProfileId: await customerProfileOf(tx, tenantId, users),
          windowStart,
          windowEnd,
          minSpendIdr: idr(minSpend),
          spentIdr: idr(spent),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      // Lock the row: a concurrent run waits and then sees our nudge.
      const [row] = (
        await tx.execute(sql`
          SELECT id, min_spend_idr, nudge_count, last_nudged_at
            FROM wfc_spend_windows
           WHERE tenant_id = ${tenantId} AND table_session_id = ${sessionId}
             AND window_start = ${windowStart.toISOString()}::timestamptz
             FOR UPDATE`)
      ).rows as Row[];
      if (!row) continue;
      const windowId = String(row.id);
      // The snapshot taken when the window opened is the figure that counts.
      const windowMin = Number(row.min_spend_idr);
      const below = spent < windowMin;
      const elapsedMs = now.getTime() - windowStart.getTime();
      let nudgeCount = Number(row.nudge_count);
      let nudged = false;
      if (below && elapsedMs >= MIN_SPEND_FIRST_NUDGE_MINUTES * MINUTE_MS) {
        const claimed = await tx.execute(sql`
          UPDATE wfc_spend_windows
             SET nudge_count = nudge_count + 1, last_nudged_at = ${now.toISOString()}::timestamptz
           WHERE tenant_id = ${tenantId} AND id = ${windowId}
             AND nudge_count < ${maxNudgesPerWindow}
             AND (last_nudged_at IS NULL
                  OR last_nudged_at <= ${new Date(
                    now.getTime() - MIN_SPEND_NUDGE_GAP_MINUTES * MINUTE_MS,
                  ).toISOString()}::timestamptz)
          RETURNING nudge_count`);
        const claimedRow = (claimed.rows as Row[])[0];
        if (claimedRow) {
          nudged = true;
          nudgeCount = Number(claimedRow.nudge_count);
          await emitNudge(tx, context, {
            windowId,
            sessionId,
            zoneId,
            outletId: policy.outletId,
            nudgeCount,
            minSpendIdr: windowMin,
            spentIdr: spent,
            users,
            now,
          });
          nudgesSent += 1;
        }
      }
      const status = !below ? "ok" : nudgeCount > 0 ? "nudged" : "below";
      await tx
        .update(wfcSpendWindows)
        .set({ spentIdr: idr(spent), status, updatedAt: now })
        .where(
          and(
            eq(wfcSpendWindows.tenantId, tenantId),
            eq(wfcSpendWindows.id, windowId),
          ),
        );
      results.push({
        tableSessionId: sessionId,
        windowStart: toIsoDateTime(windowStart),
        windowEnd: toIsoDateTime(windowEnd),
        minSpendIdr: idr(windowMin),
        spentIdr: idr(spent),
        status,
        nudged,
      });
    }
    return { zoneId, evaluated: true, sessions: results, nudgesSent };
  });
}

/**
 * One nudge: the catalogued event in the outbox (always), plus an in-app
 * notification for each signed-in guest of the table (same transaction). No
 * staff are alerted: the zone waiters are not recipients.
 */
async function emitNudge(
  tx: Tx,
  context: ScopedTenantContext,
  nudge: {
    windowId: string;
    sessionId: string;
    zoneId: string;
    outletId: string;
    nudgeCount: number;
    minSpendIdr: number;
    spentIdr: number;
    users: readonly string[];
    now: Date;
  },
): Promise<void> {
  const payload = {
    windowId: nudge.windowId,
    tableSessionId: nudge.sessionId,
    zoneId: nudge.zoneId,
    nudgeCount: nudge.nudgeCount,
    minSpendIdr: nudge.minSpendIdr,
    spentIdr: nudge.spentIdr,
  };
  await appendNotificationEvent(tx, context, wfcMinSpendNudgedEvent, {
    aggregateId: nudge.windowId,
    outletId: nudge.outletId,
    actorUserId: null,
    payload,
    now: nudge.now,
  });
  if (nudge.users.length === 0) return;
  const eventId = createUlid(nudge.now.getTime());
  const event = eventEnvelopeSchema.parse(
    wfcMinSpendNudgedEvent.envelopeSchema.parse({
      id: eventId,
      tenantId: context.tenant.tenantId,
      outletId: nudge.outletId,
      name: wfcMinSpendNudgedEvent.name,
      version: wfcMinSpendNudgedEvent.version,
      aggregateType: wfcMinSpendNudgedEvent.entry.aggregateType,
      aggregateId: nudge.windowId,
      sequence: nudge.nudgeCount,
      occurredAt: toIsoDateTime(nudge.now),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${wfcMinSpendNudgedEvent.name}:${nudge.windowId}:${nudge.nudgeCount}`,
      payloadSchemaRef: wfcMinSpendNudgedEvent.payloadSchemaRef,
      payload,
    }),
  );
  const recipients = await buildRecipients(
    tx,
    context.tenant.tenantId,
    [...nudge.users],
    nudgeContent(nudge.spentIdr, nudge.minSpendIdr),
    nudge.now,
    "facility_session",
  );
  if (recipients.length > 0)
    await createNotificationConsumer(context, async () => recipients)(
      event,
      event.idempotencyKey,
      tx,
    );
}
