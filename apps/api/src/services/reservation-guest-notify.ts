// Guest messages of a reservation: the confirmation and the H-24 reminder, both
// carrying the guest "kelola" link (PRD v1.7 §3.22 "DP & Kebijakan" and
// "Pengingat"; RSV-03; bead legend-lb3c).
//
// Who is messaged: only a reservation with a `customerProfileId`, and the row
// goes to the user of that profile. A reservation holds no email or phone
// number of the guest (only a contact hash), so a guest without a profile gets
// no message; staff can still issue a link by hand. No guest contact column is
// added (personal data decision).
//
// The `notifications` row (and its delivery attempts) carries NO token: its
// body is the plain message, so nothing secret sits in the notification table
// or its in-app view. The kelola link `<WEB_URL>/reservasi/kelola#<token>` is
// minted at SEND time for the email channel (`prepareReservationEmail`, wired
// as the `reservationLink` dependency of notification delivery, like the
// tenant invitation link). The raw token exists only in that email, is never
// logged and never enters a domain event.
//
// Automatic links never revoke a link a staff member issued by hand (see
// `issueAutomaticReservationGuestLink`); then the email goes out without a new
// link. A message for a booking that is no longer confirmed, moved to another
// time or past is not sent.
//
// The confirmation is written by the `reservation.confirmed` consumer, in its
// own transaction and only when the booking is STILL confirmed there, so a
// booking cancelled in the same commit that confirmed it gets no message.
//
// Best effort: the message is written inside a savepoint, so a failure here
// can never undo anything else.
import { and, asc, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  createUlid,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  notificationCreated,
  notificationDedupeKey,
  planDelivery,
  type NotificationCategory,
} from "@starter/shared/notification";
import { env } from "../config/env";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/index.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import { deliveryAttempts, notifications } from "../db/schema/notification.ts";
import { reservations } from "../db/schema/reservation.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { appendNotificationEvent } from "./notification-events.ts";
import { buildRecipients } from "./service-request.service.ts";
import { issueAutomaticReservationGuestLink } from "./reservation-public.ts";
import {
  lockReservation,
  type ReservationRow,
  type Tx,
} from "./reservation-core.ts";

const HOUR_MS = 3_600_000;
/** The reminder goes out once a confirmed booking is this close. */
export const RESERVATION_REMINDER_LEAD_HOURS = 24;
/** Rows per page and pages per sweep call; the next tick starts over. */
const REMINDER_BATCH = 100;
const REMINDER_MAX_PAGES = 5;
const DEFAULT_TIME_ZONE = "Asia/Jakarta";

type GuestMessageCategory = Extract<
  NotificationCategory,
  "reservation_confirmation" | "reservation_reminder"
>;

/** Reservation id and booked time inside a message's dedupe key. */
const DEDUPE_SOURCE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@(\d+):/;

/** `<WEB_URL>/reservasi/kelola#<token>`: the token stays in the fragment. */
export function reservationKelolaUrl(token: string): string {
  return `${env.WEB_URL.replace(/\/+$/, "")}/reservasi/kelola#${token}`;
}

/**
 * Dedupe source of one message: the reservation and its booked time, so a
 * moved booking is reminded again for its new time but never twice for one.
 * Mirrored in SQL by `sweepReservationReminders`.
 */
const sourceKeyOf = (row: Pick<ReservationRow, "id" | "reservedFor">) =>
  `${row.id}@${row.reservedFor.getTime()}`;

function whenLabel(reservedFor: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reservedFor);
}

/** The user a profile belongs to; null for a merged-away profile. */
async function profileUserId(
  tx: Tx,
  tenantId: TenantId,
  profileId: string,
): Promise<string | null> {
  const [profile] = await tx
    .select({ userId: customerProfiles.userId })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId),
        eq(customerProfiles.id, profileId),
      ),
    );
  return profile?.userId ?? null;
}

/**
 * Writes the message for the profile's user. Returns false (writing nothing)
 * when there is nobody to message, the booking time has passed, or this
 * message was already written (a confirmation also yields to a reminder of the
 * same booked time).
 */
async function writeGuestMessage(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  category: GuestMessageCategory,
  now: Date,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  if (row.customerProfileId === null || row.reservedFor <= now) return false;
  const userId = await profileUserId(tx, tenantId, row.customerProfileId);
  if (userId === null) return false;
  const dedupeKey = notificationDedupeKey(sourceKeyOf(row), userId, category);
  const [existing] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.dedupeKey, dedupeKey),
      ),
    );
  if (existing) return false;
  if (category === "reservation_confirmation") {
    const [reminded] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(
            notifications.dedupeKey,
            notificationDedupeKey(
              sourceKeyOf(row),
              userId,
              "reservation_reminder",
            ),
          ),
        ),
      );
    if (reminded) return false;
  }
  const [account] = await tx
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  if (!account) return false;
  const [outlet] = await tx
    .select({ name: outlets.name, timezone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, row.outletId)));

  const when = whenLabel(
    row.reservedFor,
    outlet?.timezone ?? DEFAULT_TIME_ZONE,
  );
  const place = outlet?.name ? ` di ${outlet.name}` : "";
  const content =
    category === "reservation_confirmation"
      ? {
          title: "Reservasi terkonfirmasi",
          body: `Reservasi untuk ${row.pax} orang${place} pada ${when} sudah terkonfirmasi.`,
        }
      : {
          title: "Pengingat reservasi",
          body: `Reservasi Anda untuk ${row.pax} orang${place} pada ${when} segera tiba.`,
        };

  const [recipient] = await buildRecipients(
    tx,
    tenantId,
    [userId],
    content,
    now,
    category,
  );
  if (!recipient) return false;
  // buildRecipients is push only; add the verified email of the account.
  recipient.reachability = {
    ...recipient.reachability,
    hasVerifiedEmail: account.emailVerified === true,
  };
  const plan = planDelivery({
    category,
    policy: recipient.policy,
    preference: recipient.preference,
    reachability: recipient.reachability,
    whatsappSentThisMonth: recipient.whatsappSentThisMonth,
    now,
    defaultTimeZone: recipient.defaultTimeZone,
  });

  const notificationUlid = createUlid(now.getTime());
  const notificationId = ulidToUuid(notificationUlid);
  const inserted = await tx
    .insert(notifications)
    .values({
      tenantId,
      id: notificationId,
      outletId: row.outletId,
      userId,
      category,
      title: content.title,
      body: content.body,
      link: null,
      readAt: null,
      createdAt: now,
      sourceEventId: null,
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!inserted.length) return false;
  await appendNotificationEvent(tx, context, notificationCreated, {
    aggregateId: notificationUlid,
    outletId: row.outletId,
    actorUserId: null,
    payload: {
      notificationId: notificationUlid,
      userId,
      category,
      realtime: plan.realtime,
    },
    now,
  });
  for (const channel of plan.channels) {
    await tx.insert(deliveryAttempts).values({
      tenantId,
      id: ulidToUuid(createUlid()),
      outletId: row.outletId,
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
  }
  return true;
}

/** Runs the write in a savepoint: a failure logs a code, never the cause. */
async function bestEffort(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  category: GuestMessageCategory,
  now: Date,
): Promise<boolean> {
  try {
    return await tx.transaction((savepoint) =>
      writeGuestMessage(savepoint, context, row, category, now),
    );
  } catch {
    console.error(`Reservation ${category} message failed`);
    return false;
  }
}

/**
 * `reservation.confirmed` consumer. Opens its own transaction, locks the
 * reservation and writes the confirmation only when it is STILL confirmed (a
 * booking cancelled right after, or in the same commit, gets nothing) and has
 * a customer profile. Replay safe (the message is keyed per booking time).
 */
export async function notifyReservationConfirmed(
  context: ScopedTenantContext,
  outletId: OutletId,
  reservationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(db, context, async (tx) => {
    const row = await lockReservation(tx, context, outletId, reservationId);
    if (row.status !== "confirmed" || row.customerProfileId === null)
      return false;
    return bestEffort(tx, context, row, "reservation_confirmation", now);
  });
}

/**
 * Send-time part of a guest email: the text appended to the message body,
 * with a freshly minted kelola link. Null means do NOT send: the booking is
 * not confirmed any more, was moved to another time (the message is for the
 * old one) or has passed. An empty text means send as is (a link the staff
 * issued stays valid and is not replaced).
 */
export async function prepareReservationEmail(
  context: ScopedTenantContext,
  notification: { readonly dedupeKey: string },
  now: Date = new Date(),
): Promise<{ readonly text: string } | null> {
  const source = DEDUPE_SOURCE.exec(notification.dedupeKey);
  if (!source) return null;
  const [, reservationId, bookedFor] = source;
  if (!reservationId) return null;
  return withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select({ outletId: reservations.outletId })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, reservationId),
        ),
      );
    if (!found) return null;
    const row = await lockReservation(
      tx,
      context,
      found.outletId,
      reservationId,
    );
    if (
      row.status !== "confirmed" ||
      row.reservedFor <= now ||
      String(row.reservedFor.getTime()) !== bookedFor
    )
      return null;
    const issued = await issueAutomaticReservationGuestLink(tx, context, {
      outletId: row.outletId as OutletId,
      reservationId: row.id,
      now,
    });
    return {
      text:
        issued === null
          ? ""
          : `\n\nLihat, ubah jadwal, atau batalkan: ${reservationKelolaUrl(issued.token)}`,
    };
  });
}

export type ReminderSweepResult = {
  /** Reservations a reminder was written for in this call. */
  readonly reminded: string[];
};

/**
 * Writes one `reservation_reminder` for every confirmed, profiled reservation
 * whose time lies inside (now, now + 24h] and that was not confirmed by a
 * message inside the last 24 hours. Idempotent: the message is keyed per
 * reservation and booked time, and already-reminded rows are filtered in SQL
 * so they never crowd the batch. Rows locked by another writer are skipped and retried on
 * the next call.
 */
export async function runReservationReminderSweep(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
): Promise<ReminderSweepResult> {
  const tenantId = context.tenant.tenantId;
  const horizon = new Date(
    now.getTime() + RESERVATION_REMINDER_LEAD_HOURS * HOUR_MS,
  );
  const reminded: string[] = [];
  // Keyset pages: a row that writes nothing (a failure) is passed over, so it
  // can never hold back the rows behind it. Rows nobody can be messaged for
  // (no profile user, no account) are left out by the joins.
  let cursor: { reservedFor: Date; id: string } | null = null;
  for (let page = 0; page < REMINDER_MAX_PAGES; page += 1) {
    const due: { reservation: ReservationRow }[] = await tx
      .select({ reservation: reservations })
      .from(reservations)
      .innerJoin(
        customerProfiles,
        and(
          eq(customerProfiles.tenantId, reservations.tenantId),
          eq(customerProfiles.id, reservations.customerProfileId),
          isNotNull(customerProfiles.userId),
        ),
      )
      .innerJoin(user, eq(user.id, customerProfiles.userId))
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.status, "confirmed"),
          gt(reservations.reservedFor, now),
          lte(reservations.reservedFor, horizon),
          cursor === null
            ? undefined
            : or(
                gt(reservations.reservedFor, cursor.reservedFor),
                and(
                  eq(reservations.reservedFor, cursor.reservedFor),
                  gt(reservations.id, cursor.id),
                ),
              ),
          sql`NOT EXISTS (
            SELECT 1 FROM ${notifications} n
            WHERE n.tenant_id = ${reservations.tenantId}
              AND n.category = 'reservation_reminder'
              AND n.dedupe_key LIKE ${reservations.id}::text || '@' || (extract(epoch FROM ${reservations.reservedFor}) * 1000)::bigint::text || ':%'
          )`,
          // A confirmation sent inside the last 24 hours already carries the
          // link and the time: no reminder on its heels.
          sql`NOT EXISTS (
            SELECT 1 FROM ${notifications} c
            WHERE c.tenant_id = ${reservations.tenantId}
              AND c.category = 'reservation_confirmation'
              AND c.dedupe_key LIKE ${reservations.id}::text || '@' || (extract(epoch FROM ${reservations.reservedFor}) * 1000)::bigint::text || ':%'
              AND c.created_at > ${reservations.reservedFor} - interval '24 hours'
          )`,
        ),
      )
      .orderBy(asc(reservations.reservedFor), asc(reservations.id))
      .limit(REMINDER_BATCH)
      .for("update", { skipLocked: true, of: reservations });
    for (const { reservation } of due)
      if (
        await bestEffort(tx, context, reservation, "reservation_reminder", now)
      )
        reminded.push(reservation.id);
    const last = due.at(-1);
    if (due.length < REMINDER_BATCH || !last) break;
    cursor = {
      reservedFor: last.reservation.reservedFor,
      id: last.reservation.id,
    };
  }
  return { reminded };
}

/** Opens its own tenant transaction; for the worker tick and tests. */
export async function sweepReservationReminders(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<ReminderSweepResult> {
  return withTenant(db, context, (tx) =>
    runReservationReminderSweep(tx, context, now),
  );
}
