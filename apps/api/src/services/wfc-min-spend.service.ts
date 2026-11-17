// WFC minimum spend per hour reminder (PRD v1.7 §3 F39 "Wi-Fi Berbasis
// Belanja"; bead legend-e24cz).
//
// A WFC zone may ask for `wifi_policies.min_spend_per_hour_idr`. During the
// policy's peak window (jam ramai; off-peak is relaxed) every open table
// active session of the zone (open or bill requested, not pending
// confirmation or voided) that has completed `h >= 1` full hours is checked:
// required = h x minimum; spend = net order total of the session ('sent' open
// bill and 'completed' orders, training orders excluded, tax and service
// charge left out). A session below the
// requirement gets ONE polite reminder per completed hour. No charge, refund
// or session change happens: the reminder is a message, nothing else.
//
// Recipients: `notifications.user_id` is NOT NULL, so each DISTINCT signed-in
// participant of the session is reminded through `notifications`; no staff
// user is notified. The reminder is delivered like the reservation guest
// messages (see `deliverReminders`). Dedupe key
// `wfc_min_spend:<sessionId>:<h>:<userId>` (unique per tenant) makes a repeat
// run in the same hour a no-op.
// An anonymous participant (user_id null) who left a WhatsApp number or email
// on the session (legend-qr3sd) gets ONE row in the `wfc_guest_reminders`
// outbox per distinct destination + session + hour (WhatsApp preferred over
// email); no contact = no reminder. Outbox rows only: no order, payment or
// session is touched.
//
// Net spend of an order: price-exclusive = subtotal - discount; tax-inclusive
// (harga nett) = total - tax - service charge.

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import { wfcGuestReminders } from "../db/schema/wfc-guest-reminder.ts";
import {
  orders,
  sessionParticipants,
  tableSessions,
  tables,
} from "../db/schema/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { NOT_TRAINING_SQL } from "./metric-sources/sales.ts";
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

// Same shapes the participant contact is validated with on entry.
const WHATSAPP_DIGITS = /^[1-9][0-9]{7,14}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type GuestContact = { channel: "whatsapp" | "email"; destination: string };

/** One contact per participant: WhatsApp preferred, blank or invalid = none. */
function pickGuestContact(participant: {
  contactWhatsapp: string | null;
  contactEmail: string | null;
}): GuestContact | null {
  const whatsapp = participant.contactWhatsapp?.trim() ?? "";
  if (WHATSAPP_DIGITS.test(whatsapp.replace(/^\+/, "")))
    return {
      channel: "whatsapp",
      destination: `+${whatsapp.replace(/^\+/, "")}`,
    };
  const email = participant.contactEmail?.trim().toLowerCase() ?? "";
  if (email.length <= 254 && EMAIL_SHAPE.test(email))
    return { channel: "email", destination: email };
  return null;
}

/**
 * Outbox rows for guests without an account: one per distinct destination of
 * the session and hour; an existing row (same dedupe key) writes nothing.
 */
async function writeGuestReminders(
  tx: Tx,
  reminder: {
    tenantId: TenantId;
    outletId: OutletId;
    sessionId: string;
    hours: number;
    contacts: Array<GuestContact & { participantId: string }>;
  },
  now: Date,
): Promise<number> {
  const seen = new Set<string>();
  let written = 0;
  for (const contact of reminder.contacts) {
    if (seen.has(contact.destination)) continue;
    seen.add(contact.destination);
    const inserted = await tx
      .insert(wfcGuestReminders)
      .values({
        tenantId: reminder.tenantId,
        outletId: reminder.outletId,
        tableSessionId: reminder.sessionId,
        participantId: contact.participantId,
        hours: reminder.hours,
        channel: contact.channel,
        destination: contact.destination,
        dedupeKey: `${WFC_MIN_SPEND_CATEGORY}:${reminder.sessionId}:${reminder.hours}:${contact.destination}`,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: wfcGuestReminders.id });
    written += inserted.length;
  }
  return written;
}

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
          // Same filter as the WFC seat metrics: an unconfirmed or voided
          // session is not a seated guest.
          notInArray(tableSessions.status, ["voided", "pending_confirmation"]),
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
    // Alias `o`: NOT_TRAINING_SQL refers to the orders row as `o`.
    const o = alias(orders, "o");
    const spendRows = await tx
      .select({
        sessionId: o.tableSessionId,
        spend: sql<string>`COALESCE(SUM(CASE WHEN ${o.pricesIncludeTax}
          THEN ${o.totalIdr} - ${o.taxIdr} - ${o.serviceChargeIdr}
          ELSE ${o.subtotalIdr} - ${o.discountIdr} END), 0)::text`,
      })
      .from(o)
      .where(
        and(
          eq(o.tenantId, tenantId),
          inArray(o.tableSessionId, sessionIds),
          inArray(o.status, ["sent", "completed"]),
          NOT_TRAINING_SQL,
        ),
      )
      .groupBy(o.tableSessionId);
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
      .select({
        id: sessionParticipants.id,
        sessionId: sessionParticipants.tableSessionId,
        userId: sessionParticipants.userId,
        contactWhatsapp: sessionParticipants.contactWhatsapp,
        contactEmail: sessionParticipants.contactEmail,
      })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.tenantId, tenantId),
          inArray(
            sessionParticipants.tableSessionId,
            below.map((session) => session.id),
          ),
        ),
      )
      .orderBy(asc(sessionParticipants.joinedAt), asc(sessionParticipants.id));

    for (const session of below) {
      const inSession = participants.filter(
        (participant) => participant.sessionId === session.id,
      );
      const userIds = [
        ...new Set(
          inSession.flatMap((participant) =>
            participant.userId !== null ? [participant.userId] : [],
          ),
        ),
      ];
      // A signed-in participant is reminded through `notifications` only.
      const contacts = inSession.flatMap((participant) => {
        if (participant.userId !== null) return [];
        const contact = pickGuestContact(participant);
        return contact ? [{ ...contact, participantId: participant.id }] : [];
      });
      if (userIds.length === 0 && contacts.length === 0) continue;
      const required = session.hours * minimum;
      const spend = spendBySession.get(session.id) ?? 0;
      const content = {
        title: "Pengingat belanja minimum",
        body: `Anda sudah ${session.hours} jam di zona kerja. Minimum belanja sampai sekarang Rp${formatIdr(required)}, belanja Anda baru Rp${formatIdr(spend)}. Silakan pesan kapan saja, terima kasih.`,
      };
      if (userIds.length > 0)
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
      if (contacts.length > 0)
        result.reminders += await writeGuestReminders(
          tx,
          {
            tenantId,
            outletId,
            sessionId: session.id,
            hours: session.hours,
            contacts,
          },
          now,
        );
    }
  }
  return result;
}
