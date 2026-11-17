// WFC minimum spend per hour reminder (PRD v1.7 §3 F39 "Wi-Fi Berbasis
// Belanja"; bead legend-e24cz).
//
// A WFC zone may ask for `wifi_policies.min_spend_per_hour_idr`. During the
// policy's peak window (jam ramai; off-peak is relaxed) every open table
// session of the zone that has completed `h >= 1` full hours is checked:
// required = h x minimum; spend = net order total of the session (completed
// orders only, tax and service charge left out). A session below the
// requirement gets ONE polite reminder per completed hour. No charge, refund
// or session change happens: the reminder is a message, nothing else.
//
// Recipients (CTO decision, no migration): `notifications.user_id` is NOT
// NULL, so each DISTINCT signed-in participant of the session is reminded;
// an anonymous participant (user_id null) gets nothing (known limitation) and
// no staff user is notified. The reminder is delivered like the reservation
// guest messages (see `deliverReminders`). Dedupe key
// `wfc_min_spend:<sessionId>:<h>:<userId>` (unique per tenant) makes a repeat
// run in the same hour a no-op.
//
// Net spend of an order: price-exclusive = subtotal - discount; tax-inclusive
// (harga nett) = total - tax - service charge.

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  createUlid,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { isPeakAt } from "@starter/shared/facility";
import {
  notificationCreated,
  planDelivery,
} from "@starter/shared/notification";
import { wifiPolicies } from "../db/schema/facility.ts";
import { deliveryAttempts, notifications } from "../db/schema/notification.ts";
import { user } from "../db/schema/user.ts";
import {
  orders,
  sessionParticipants,
  tableSessions,
  tables,
} from "../db/schema/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { appendNotificationEvent } from "./notification-events.ts";
import { buildRecipients } from "./service-request.service.ts";
import type { Tx } from "./table-session.service.ts";

const HOUR_MS = 3_600_000;
const DEFAULT_TIME_ZONE = "Asia/Jakarta";
export const WFC_MIN_SPEND_CATEGORY = "wfc_min_spend" as const;

export type MinSpendEvaluation = {
  /** Open WFC sessions that were below the requirement. */
  sessionsBelow: number;
  /** New reminder rows written by this run. */
  reminders: number;
};

const wfcMinSpendDedupeKey = (
  sessionId: string,
  hours: number,
  userId: string,
) => `${WFC_MIN_SPEND_CATEGORY}:${sessionId}:${hours}:${userId}`;

const formatIdr = (amount: number) =>
  new Intl.NumberFormat("id-ID").format(amount);

/**
 * Writes the reminders through the same path as the reservation guest
 * messages: recipient policy and preference (`buildRecipients`), the
 * notification row, the `notification.created` event and one delivery attempt
 * per channel, all in the caller's transaction. A user whose account is gone
 * is skipped. Each user is written in a savepoint, so one failure leaves the
 * others (and the sweep) intact. Returns the number of new rows; a row that
 * already exists (same dedupe key) writes nothing.
 */
async function deliverReminders(
  tx: Tx,
  context: ScopedTenantContext,
  reminder: {
    outletId: OutletId;
    sessionId: string;
    hours: number;
    userIds: string[];
    content: { title: string; body: string };
  },
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const accounts = await tx
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(inArray(user.id, reminder.userIds));
  const verified = new Map(
    accounts.map((account) => [account.id, account.emailVerified === true]),
  );
  const recipients = await buildRecipients(
    tx,
    tenantId,
    reminder.userIds.filter((userId) => verified.has(userId)),
    reminder.content,
    now,
    WFC_MIN_SPEND_CATEGORY,
  );
  let written = 0;
  for (const recipient of recipients) {
    const dedupeKey = wfcMinSpendDedupeKey(
      reminder.sessionId,
      reminder.hours,
      recipient.userId,
    );
    try {
      const created = await tx.transaction(async (savepoint) => {
        const plan = planDelivery({
          category: WFC_MIN_SPEND_CATEGORY,
          policy: recipient.policy,
          preference: recipient.preference,
          reachability: {
            ...recipient.reachability,
            hasVerifiedEmail: verified.get(recipient.userId) === true,
          },
          whatsappSentThisMonth: recipient.whatsappSentThisMonth,
          now,
          defaultTimeZone: recipient.defaultTimeZone,
        });
        const notificationUlid = createUlid(now.getTime());
        const notificationId = ulidToUuid(notificationUlid);
        const inserted = await savepoint
          .insert(notifications)
          .values({
            tenantId,
            id: notificationId,
            outletId: reminder.outletId,
            userId: recipient.userId,
            category: WFC_MIN_SPEND_CATEGORY,
            title: recipient.title,
            body: recipient.body,
            link: null,
            readAt: null,
            createdAt: now,
            sourceEventId: null,
            dedupeKey,
          })
          .onConflictDoNothing()
          .returning({ id: notifications.id });
        if (!inserted.length) return false;
        await appendNotificationEvent(savepoint, context, notificationCreated, {
          aggregateId: notificationUlid,
          outletId: reminder.outletId,
          actorUserId: null,
          payload: {
            notificationId: notificationUlid,
            userId: recipient.userId,
            category: WFC_MIN_SPEND_CATEGORY,
            realtime: plan.realtime,
          },
          now,
        });
        for (const channel of plan.channels)
          await savepoint.insert(deliveryAttempts).values({
            tenantId,
            id: ulidToUuid(createUlid()),
            outletId: reminder.outletId,
            notificationId,
            channel: channel.channel,
            status: channel.decision === "skip" ? "skipped" : "queued",
            nextAttemptAt:
              channel.decision === "defer"
                ? new Date(channel.notBefore)
                : channel.decision === "send"
                  ? now
                  : null,
            idempotencyKey: `${dedupeKey}:${channel.channel}`,
            skipReason: channel.decision === "skip" ? channel.reason : null,
          });
        return true;
      });
      if (created) written += 1;
    } catch {
      console.error("WFC minimum spend reminder failed for a guest");
    }
  }
  return written;
}

export async function evaluateMinSpend(
  tx: Tx,
  input: {
    context: ScopedTenantContext;
    tenantId: TenantId;
    outletId: OutletId;
    now: Date;
  },
): Promise<MinSpendEvaluation> {
  const { tenantId, outletId, now } = input;
  const result: MinSpendEvaluation = { sessionsBelow: 0, reminders: 0 };
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return result;
  const timeZone = outlet.timezone || DEFAULT_TIME_ZONE;

  const policies = await tx
    .select({
      zoneId: wifiPolicies.zoneId,
      minSpendPerHourIdr: wifiPolicies.minSpendPerHourIdr,
      peakSchedule: wifiPolicies.peakSchedule,
    })
    .from(wifiPolicies)
    .where(
      and(
        eq(wifiPolicies.tenantId, tenantId),
        eq(wifiPolicies.outletId, outletId),
        isNotNull(wifiPolicies.minSpendPerHourIdr),
      ),
    );

  for (const policy of policies) {
    const minimum = policy.minSpendPerHourIdr;
    if (minimum === null || minimum <= 0) continue;
    if (!isPeakAt(policy, now, timeZone)) continue;

    const sessions = await tx
      .select({
        id: tableSessions.id,
        openedAt: tableSessions.openedAt,
      })
      .from(tableSessions)
      .innerJoin(
        tables,
        and(
          eq(tables.tenantId, tableSessions.tenantId),
          eq(tables.id, tableSessions.tableId),
        ),
      )
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.outletId, outletId),
          isNull(tableSessions.closedAt),
          eq(tables.tenantId, tenantId),
          eq(tables.zoneId, policy.zoneId),
        ),
      );
    const due = sessions
      .map((session) => ({
        id: session.id,
        hours: Math.floor(
          (now.getTime() - session.openedAt.getTime()) / HOUR_MS,
        ),
      }))
      .filter((session) => session.hours >= 1);
    if (due.length === 0) continue;

    const sessionIds = due.map((session) => session.id);
    const spendRows = await tx
      .select({
        sessionId: orders.tableSessionId,
        spend: sql<string>`COALESCE(SUM(CASE WHEN ${orders.pricesIncludeTax}
          THEN ${orders.totalIdr} - ${orders.taxIdr} - ${orders.serviceChargeIdr}
          ELSE ${orders.subtotalIdr} - ${orders.discountIdr} END), 0)::text`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.tableSessionId, sessionIds),
          eq(orders.status, "completed"),
        ),
      )
      .groupBy(orders.tableSessionId);
    const spendBySession = new Map<string, number>();
    for (const row of spendRows)
      if (row.sessionId !== null)
        spendBySession.set(row.sessionId, Number(row.spend));

    const below = due.filter(
      (session) =>
        (spendBySession.get(session.id) ?? 0) < session.hours * minimum,
    );
    if (below.length === 0) continue;
    result.sessionsBelow += below.length;

    const participants = await tx
      .selectDistinct({
        sessionId: sessionParticipants.tableSessionId,
        userId: sessionParticipants.userId,
      })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.tenantId, tenantId),
          inArray(
            sessionParticipants.tableSessionId,
            below.map((session) => session.id),
          ),
          isNotNull(sessionParticipants.userId),
        ),
      );

    for (const session of below) {
      const userIds = [
        ...new Set(
          participants.flatMap((participant) =>
            participant.sessionId === session.id && participant.userId !== null
              ? [participant.userId]
              : [],
          ),
        ),
      ];
      if (userIds.length === 0) continue;
      const required = session.hours * minimum;
      const spend = spendBySession.get(session.id) ?? 0;
      const content = {
        title: "Pengingat belanja minimum",
        body: `Anda sudah ${session.hours} jam di zona kerja. Minimum belanja sampai sekarang Rp${formatIdr(required)}, belanja Anda baru Rp${formatIdr(spend)}. Silakan pesan kapan saja, terima kasih.`,
      };
      result.reminders += await deliverReminders(
        tx,
        input.context,
        {
          outletId,
          sessionId: session.id,
          hours: session.hours,
          userIds,
          content,
        },
        now,
      );
    }
  }
  return result;
}
