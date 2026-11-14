// Guest "kelola" link in the reservation confirmation and reminder messages
// (bead legend-lb3c; PRD v1.7 §3.22 "DP & Kebijakan" and "Pengingat", RSV-03).
// The signed link already exists (reservation-public.test.ts); this file covers
// the missing part: the message the guest receives carries the link, and the
// link is a per-reservation secret. Real app, real middleware, PostgreSQL.
//
// Design (after the review of beads 9txo + lb3c):
// - the guest message is a `notifications` row of the tenant. It exists only for
//   a reservation with a customerProfileId: the row's user_id is the user of
//   that customer profile. A guest without a profile (phone only) gets no message.
// - the row holds NO token and no link: nothing secret sits in `notifications`.
//   The kelola link `<origin>/reservasi/kelola#<token>` (43 character base64url
//   token, in the fragment) is minted when the email is SENT
//   (`prepareReservationEmail`, the `reservationLink` dependency of delivery).
// - the confirmation is written by the `reservation.confirmed` consumer
//   (`handleReservationConfirmed`) and only if the booking is still confirmed.
// - the reminder is `sweepReservationReminders(context, now)`: confirmed,
//   profiled reservations inside (now, now + 24h], once per booked time, not
//   right after a confirmation sent inside the last 24 hours.
// - an automatic link replaces an earlier automatic link (the newest message
//   works) but never a link staff issued by hand.
import { createHash, randomUUID } from "node:crypto";
import { FakeEmailProvider, FakePushProvider } from "@starter/shared/adapters";
import {
  cafeLegendNotificationFixtures,
  notificationPolicySchema,
} from "@starter/shared/notification";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  RESERVATION_LINK_TOKEN_HEADER,
  createReservationInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { db } from "../db/index.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import {
  handlePaymentPaid,
  handleReservationConfirmed,
} from "../services/reservation-consumers.ts";
import {
  notifyReservationConfirmed,
  prepareReservationEmail,
} from "../services/reservation-guest-notify.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { sweepReservationReminders } from "../services/reservation-sweeps.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { agent, originHeader } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const outletA = outletIdSchema.parse(seededOutletA);
const LINK_PATH = "/api/public/reservation-link";
const KELOLA_LINK =
  /https?:\/\/[^\s"'<>?#]+\/reservasi\/kelola#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Provider double: one code per idempotency key. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const created: GatewayIntent = {
      providerRef: `FAKE-GK-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEGK",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
    this.byKey.set(input.idempotencyKey, created);
    return created;
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

let app: ReturnType<typeof createApp>;
let staff: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const profileUsers: { userId: string; profileId: string }[] = [];
let dayCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Kelola" });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    const links = (
      await client.query<{ id: string }>(
        "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
        [seededTenantId, zoneIds],
      )
    ).rows.map((row) => row.id);
    for (const table of [
      "reservation_reschedule_requests",
      "reservation_guest_links",
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, links],
      );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
  });
  const userIds = profileUsers.map((entry) => entry.userId);
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]))",
      [seededTenantId, userIds],
    );
    await client.query(
      "DELETE FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])",
      [seededTenantId, userIds],
    );
    await client.query(
      "DELETE FROM customer_profiles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, profileUsers.map((entry) => entry.profileId)],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds]);
  await owner.query("DELETE FROM notification_policies WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

async function setPolicy(requirement: "none" | "required", amount = 0) {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        `kelola-test-${requirement}`,
        requirement,
        amount,
      ],
    );
  });
}

async function floorZone() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  return zone.id as string;
}

/** A distinct future day (March 2027) per reservation. */
function nextDate() {
  const day = 1 + (dayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

async function book(guestName: string): Promise<ReservationCreated> {
  const zoneId = await floorZone();
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(nextDate(), "19:00", WIB).toISOString(),
      pax: 2,
      zoneId,
      guestName,
      contactPhone: "081234567890",
    }),
    `rsv-kelola-${randomUUID()}`,
  );
}

/** Confirmed booking with no DP. */
async function freeBooking(guestName = "Tamu Kelola") {
  await setPolicy("none");
  const created = await book(guestName);
  return { created, id: created.reservation.id };
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function publicGet(token: string) {
  return agent(app)
    .get(LINK_PATH)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token);
}

function publicPost(
  action: "cancel" | "reschedule",
  token: string,
  body: Record<string, unknown>,
) {
  return agent(app)
    .post(`${LINK_PATH}/${action}`)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token)
    .set("Idempotency-Key", `rsv-kelola-${randomUUID()}`)
    .send(body);
}

type KelolaLink = { url: string; token: string };

/**
 * The kelola link of the NEWEST guest message of a reservation, minted the way
 * the email send does (a link exists only at send time, never in the table).
 * Minting replaces an earlier automatic link, like a real send. A reservation
 * without a message has no link. The link belongs to the reservation its token
 * opens (verified over the public route, the way the guest would).
 */
async function kelolaLinksFor(reservationId: string): Promise<KelolaLink[]> {
  const { rows } = await asOwner((client) =>
    client.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications
        WHERE tenant_id = $1 AND dedupe_key LIKE $2
          AND category IN ('reservation_confirmation', 'reservation_reminder')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [seededTenantId, `${reservationId}@%`],
    ),
  );
  if (!rows[0]) return [];
  const prepared = await prepareReservationEmail(tenantScope(), {
    dedupeKey: rows[0].dedupe_key,
  });
  const found: KelolaLink[] = [];
  for (const match of (prepared?.text ?? "").matchAll(KELOLA_LINK)) {
    const response = await publicGet(match[1]!);
    if (
      response.status === 200 &&
      response.body.data.reservationId === reservationId
    )
      found.push({ url: match[0], token: match[1]! });
  }
  return found;
}

async function linkRows(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ token_hash: string; revoked_at: Date | null }>(
      "SELECT token_hash, revoked_at FROM reservation_guest_links WHERE reservation_id = $1",
      [reservationId],
    ),
  );
  return rows;
}

async function status(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM reservations WHERE id = $1",
      [reservationId],
    ),
  );
  return rows[0]!.status;
}

// Profiles: a customer profile belongs to a user of the tenant.
async function seedProfile() {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan Kelola', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Pelanggan Kelola', 'active', now())`,
    [profileId, seededTenantId, userId],
  );
  profileUsers.push({ userId, profileId });
  return { userId, profileId };
}

async function attachProfile(reservationId: string, profileId: string) {
  await asOwner((client) =>
    client.query(
      "UPDATE reservations SET customer_profile_id = $2 WHERE id = $1",
      [reservationId, profileId],
    ),
  );
}

/** A booking that waited for its DP with a profile attached, then was paid. */
async function profiledConfirmed(
  guestName = "Tamu Profil Kelola",
  consume = true,
) {
  await setPolicy("required", 100_000);
  const created = await book(guestName);
  const id = created.reservation.id;
  const profile = await seedProfile();
  await attachProfile(id, profile.profileId);
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-kelola-pay-${id}`,
    }),
  );
  await confirmPayment(tenantScope(), intent.id, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: 100_000,
    providerRef: `PAID-${intent.id}`,
    at: new Date().toISOString(),
  });
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intent.id],
    ),
  );
  await handlePaymentPaid(
    tenantScope(),
    eventEnvelopeSchema.parse(rows[0]!.event),
  );
  expect(await status(id)).toBe("confirmed");
  const { rows: confirmed } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'reservation.confirmed'",
      [seededTenantId, id],
    ),
  );
  const confirmedEvent = eventEnvelopeSchema.parse(confirmed[0]!.event);
  if (consume) await handleReservationConfirmed(tenantScope(), confirmedEvent);
  return { id, ...profile, confirmedEvent };
}

/** Confirmed booking without DP (no profile at creation), profile attached after. */
async function profiledFree(guestName = "Tamu Pengingat") {
  const free = await freeBooking(guestName);
  const profile = await seedProfile();
  await attachProfile(free.id, profile.profileId);
  return { id: free.id, ...profile };
}

async function reservedForOf(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ reserved_for: Date }>(
      "SELECT reserved_for FROM reservations WHERE id = $1",
      [reservationId],
    ),
  );
  return rows[0]!.reserved_for;
}

const HOUR = 3_600_000;

/** Notifications of one user, any category. */
async function messagesOf(userId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ category: string; body: string; user_id: string }>(
      "SELECT category, body, user_id FROM notifications WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at",
      [seededTenantId, userId],
    ),
  );
  return rows;
}

const remindersOf = async (userId: string) =>
  (await messagesOf(userId)).filter(
    (row) => row.category === "reservation_reminder",
  );

async function runReminderSweep(now: Date) {
  await sweepReservationReminders(tenantScope(), now);
}

// --- tests ------------------------------------------------------------------

describe("RSV-03 kelola link in the confirmation message (legend-lb3c)", () => {
  it("RSV-03 a confirmed booking with a profile gets a confirmation carrying <origin>/reservasi/kelola#<token> for that profile's user", async () => {
    const { id, userId } = await profiledConfirmed("Tamu Satu Kelola");
    const links = await kelolaLinksFor(id);
    expect(links.length).toBeGreaterThanOrEqual(1);

    // The message sits in the inbox of the profile's user.
    const own = (await messagesOf(userId)).filter(
      (row) => row.category === "reservation_confirmation",
    );
    expect(own).toHaveLength(1);
    // The stored message carries no link and no token at all.
    expect(own[0]!.body).not.toContain("/reservasi/kelola");
    for (const link of links) expect(own[0]!.body).not.toContain(link.token);
    for (const link of links) {
      // Token in the fragment only: the path and query carry nothing secret.
      const url = new URL(link.url);
      expect(url.pathname).toBe("/reservasi/kelola");
      expect(url.search).toBe("");
      expect(url.hash).toBe(`#${link.token}`);
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    // The guest opens the link: they see their own booking.
    const view = await publicGet(links[0]!.token);
    expect(view.status).toBe(200);
    expect(view.body.data.reservationId).toBe(id);
    expect(view.body.data.guestName).toBe("Tamu Satu Kelola");
    expect(view.body.data.status).toBe("confirmed");
    expect(view.body.data.deposit.paidIdr).toBe(100_000);
  });

  it("RSV-03 a booking still waiting for its DP gets no kelola link, even with a profile", async () => {
    await setPolicy("required", 100_000);
    const created = await book("Tamu Menunggu DP");
    const profile = await seedProfile();
    await attachProfile(created.reservation.id, profile.profileId);
    expect(await status(created.reservation.id)).toBe("pending_deposit");
    expect(await kelolaLinksFor(created.reservation.id)).toHaveLength(0);
    expect(await messagesOf(profile.userId)).toHaveLength(0);
  });

  it("RSV-03 a guest without a profile (phone only) gets no message with a link, in no inbox, and staff can still issue one by hand", async () => {
    const { id } = await freeBooking("Tamu Tanpa Profil");
    // Confirmed at once, but no customer profile: nobody to message.
    expect(await status(id)).toBe("confirmed");
    expect(await kelolaLinksFor(id)).toHaveLength(0);
    // Not the staff inbox either, and no stored message of the tenant carries
    // a kelola link at all.
    const { rows: stored } = await asOwner((client) =>
      client.query<{ body: string }>(
        "SELECT body FROM notifications WHERE tenant_id = $1 AND body LIKE '%/reservasi/kelola%'",
        [seededTenantId],
      ),
    );
    expect(stored).toHaveLength(0);

    // The manual path keeps working: staff issue a link, the token opens it.
    const issued = await staff.client
      .post(`/api/outlets/${seededOutletA}/reservations/${id}/guest-link`)
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    const view = await publicGet(issued.body.data.token);
    expect(view.status).toBe(200);
    expect(view.body.data.reservationId).toBe(id);
  });

  it("RSV-03 the link in the message is the active link: only its hash is stored and the raw token is in no event", async () => {
    const { id } = await profiledConfirmed();
    const links = await kelolaLinksFor(id);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const token = links[0]!.token;

    const rows = await linkRows(id);
    const hashes = rows.map((row) => row.token_hash);
    expect(hashes).toContain(sha256(token));
    expect(hashes).not.toContain(token);
    // The token is a bearer secret: no domain event of the tenant may carry it.
    const { rows: events } = await asOwner((client) =>
      client.query(
        "SELECT 1 FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'",
        [seededTenantId, token],
      ),
    );
    expect(events).toHaveLength(0);
  });

  it("RSV-03 an expired link from the message is refused with the same 404 as any unknown link", async () => {
    const { id } = await profiledConfirmed();
    const [link] = await kelolaLinksFor(id);
    expect(link).toBeDefined();
    expect((await publicGet(link!.token)).status).toBe(200);

    await asOwner((client) =>
      client.query(
        "UPDATE reservation_guest_links SET expires_at = now() - interval '1 hour' WHERE reservation_id = $1",
        [id],
      ),
    );
    const expired = await publicGet(link!.token);
    expect(expired.status).toBe(404);
    expect(expired.body.error.code).toBe("RESERVATION_LINK_INVALID");
    expect(expired.body.data).toBeUndefined();
    // A cancel with the expired token changes nothing either.
    const cancel = await publicPost("cancel", link!.token, {});
    expect(cancel.status).toBe(404);
    expect(await status(id)).toBe("confirmed");
  });
});

describe("RSV-03 kelola links are per reservation", () => {
  it("RSV-03 two bookings get different links, and each token opens only its own booking", async () => {
    const a = await profiledConfirmed("Tamu Alfa Kelola");
    const b = await profiledConfirmed("Tamu Bravo Kelola");
    const [linkA] = await kelolaLinksFor(a.id);
    const [linkB] = await kelolaLinksFor(b.id);
    expect(linkA).toBeDefined();
    expect(linkB).toBeDefined();
    expect(linkA!.token).not.toBe(linkB!.token);

    const viewA = await publicGet(linkA!.token);
    expect(viewA.status).toBe(200);
    expect(viewA.body.data.reservationId).toBe(a.id);
    // Nothing of the other guest's booking leaks through A's link.
    const text = JSON.stringify(viewA.body);
    expect(text).not.toContain(b.id);
    expect(text).not.toContain("Tamu Bravo Kelola");
    expect(text).not.toContain(linkB!.token);
  });

  it("RSV-03 booking A's token cannot cancel or reschedule booking B", async () => {
    const a = await profiledConfirmed("Tamu Alfa Dua");
    const b = await profiledConfirmed("Tamu Bravo Dua");
    const [linkA] = await kelolaLinksFor(a.id);
    expect(linkA).toBeDefined();

    const reschedule = await publicPost("reschedule", linkA!.token, {
      requestedFor: new Date(Date.now() + 40 * 24 * HOUR).toISOString(),
    });
    expect([200, 201]).toContain(reschedule.status);
    const { rows } = await asOwner((client) =>
      client.query<{ reservation_id: string }>(
        "SELECT reservation_id FROM reservation_reschedule_requests WHERE reservation_id = ANY($1::uuid[])",
        [[a.id, b.id]],
      ),
    );
    expect(rows.map((row) => row.reservation_id)).toEqual([a.id]);

    const cancel = await publicPost("cancel", linkA!.token, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.view.reservationId).toBe(a.id);
    expect(await status(a.id)).toBe("cancelled");
    expect(await status(b.id)).toBe("confirmed");
  });

  it("RSV-03 a guessed token never answers with data", async () => {
    const a = await profiledConfirmed("Tamu Alfa Empat");
    const [linkA] = await kelolaLinksFor(a.id);
    expect(linkA).toBeDefined();
    // Flip the last character: a well-formed but unissued token.
    const last = linkA!.token.endsWith("A") ? "B" : "A";
    const guessed = `${linkA!.token.slice(0, -1)}${last}`;
    const response = await publicGet(guessed);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("RESERVATION_LINK_INVALID");
    expect(response.body.data).toBeUndefined();
  });
});

describe("RSV-03 kelola link in the reminder (legend-lb3c)", () => {
  it("RSV-03 the sweep writes one reservation_reminder with a working kelola link for a confirmed profiled booking inside the 24 hour window", async () => {
    const { id, userId } = await profiledFree("Tamu Pengingat Satu");
    const reservedFor = await reservedForOf(id);
    expect(await remindersOf(userId)).toHaveLength(0);

    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    const reminders = await remindersOf(userId);
    expect(reminders).toHaveLength(1);

    expect(reminders[0]!.body).not.toContain("/reservasi/kelola");
    const links = await kelolaLinksFor(id);
    expect(links).toHaveLength(1);
    const url = new URL(links[0]!.url);
    expect(url.pathname).toBe("/reservasi/kelola");
    expect(url.search).toBe("");
    // The link in the reminder opens exactly this booking.
    const view = await publicGet(links[0]!.token);
    expect(view.status).toBe(200);
    expect(view.body.data.reservationId).toBe(id);
    expect(view.body.data.guestName).toBe("Tamu Pengingat Satu");
  });

  it("RSV-03 running the sweep twice, or later in the window, still leaves one reminder", async () => {
    const { id, userId } = await profiledFree("Tamu Pengingat Dua");
    const reservedFor = await reservedForOf(id);
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    await runReminderSweep(new Date(reservedFor.getTime() - 2 * HOUR));
    expect(await remindersOf(userId)).toHaveLength(1);
  });

  it("RSV-03 no reminder before the window opens or after the booking time", async () => {
    const early = await profiledFree("Tamu Terlalu Awal");
    const earlyAt = await reservedForOf(early.id);
    await runReminderSweep(new Date(earlyAt.getTime() - 48 * HOUR));
    expect(await remindersOf(early.userId)).toHaveLength(0);

    const late = await profiledFree("Tamu Sudah Lewat");
    const lateAt = await reservedForOf(late.id);
    await runReminderSweep(new Date(lateAt.getTime() + HOUR));
    expect(await remindersOf(late.userId)).toHaveLength(0);
  });

  it("RSV-03 no reminder for a cancelled booking or a guest without a profile", async () => {
    const cancelled = await profiledFree("Tamu Batal Pengingat");
    const issued = await staff.client
      .post(
        `/api/outlets/${seededOutletA}/reservations/${cancelled.id}/guest-link`,
      )
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    expect(
      (await publicPost("cancel", issued.body.data.token, {})).status,
    ).toBe(200);

    const anonymous = await freeBooking("Tamu Anonim Pengingat");
    const now = new Date(
      (await reservedForOf(anonymous.id)).getTime() - 20 * HOUR,
    );
    await runReminderSweep(now);
    expect(await remindersOf(cancelled.userId)).toHaveLength(0);
    expect(await kelolaLinksFor(anonymous.id)).toHaveLength(0);
  });

  it("RSV-03 the sweep does not touch another booking's guest: each reminder opens its own booking", async () => {
    const a = await profiledFree("Tamu Pengingat Alfa");
    const b = await profiledFree("Tamu Pengingat Bravo");
    await runReminderSweep(
      new Date((await reservedForOf(a.id)).getTime() - 20 * HOUR),
    );
    // Only A was inside the window the sweep was given (B is on another day).
    expect(await remindersOf(a.userId)).toHaveLength(1);
    expect(await remindersOf(b.userId)).toHaveLength(0);
    const [link] = await kelolaLinksFor(a.id);
    expect(link).toBeDefined();
    expect((await publicGet(link!.token)).body.data.reservationId).toBe(a.id);
  });
});

async function staffLink(reservationId: string): Promise<string> {
  const issued = await staff.client
    .post(
      `/api/outlets/${seededOutletA}/reservations/${reservationId}/guest-link`,
    )
    .set(originHeader)
    .send({});
  expect(issued.status).toBe(201);
  return issued.body.data.token as string;
}

describe("RSV-03 confirmation: only for a booking that is still confirmed", () => {
  it("RSV-03 a booking cancelled before the confirmed event is consumed gets no confirmation", async () => {
    const booked = await profiledConfirmed(
      "Tamu Batal Sebelum Konfirmasi",
      false,
    );
    const token = await staffLink(booked.id);
    expect((await publicPost("cancel", token, {})).status).toBe(200);
    expect(await status(booked.id)).toBe("cancelled");

    expect(
      await handleReservationConfirmed(tenantScope(), booked.confirmedEvent),
    ).toBe(false);
    expect(await messagesOf(booked.userId)).toHaveLength(0);
  });

  it("RSV-03 consuming the confirmed event twice writes one confirmation", async () => {
    const booked = await profiledConfirmed("Tamu Dua Kali", false);
    expect(
      await handleReservationConfirmed(tenantScope(), booked.confirmedEvent),
    ).toBe(true);
    expect(
      await handleReservationConfirmed(tenantScope(), booked.confirmedEvent),
    ).toBe(false);
    expect(
      (await messagesOf(booked.userId)).filter(
        (row) => row.category === "reservation_confirmation",
      ),
    ).toHaveLength(1);
  });

  it("RSV-03 a confirmation yields to a reminder already sent for the same time", async () => {
    const booked = await profiledFree("Tamu Konfirmasi Terlambat");
    const reservedFor = await reservedForOf(booked.id);
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    expect(
      await notifyReservationConfirmed(
        tenantScope(),
        outletA,
        booked.id,
        new Date(reservedFor.getTime() - 19 * HOUR),
      ),
    ).toBe(false);
    expect(await messagesOf(booked.userId)).toHaveLength(1);
  });
});

describe("RSV-03 reminder timing and links (review)", () => {
  it("RSV-03 no reminder on the heels of a confirmation sent inside the last 24 hours; one when the confirmation was earlier", async () => {
    const close = await profiledFree("Tamu Pesan Mepet");
    const closeAt = await reservedForOf(close.id);
    expect(
      await notifyReservationConfirmed(
        tenantScope(),
        outletA,
        close.id,
        new Date(closeAt.getTime() - 10 * HOUR),
      ),
    ).toBe(true);
    await runReminderSweep(new Date(closeAt.getTime() - 5 * HOUR));
    expect(await remindersOf(close.userId)).toHaveLength(0);

    const early = await profiledFree("Tamu Pesan Jauh");
    const earlyAt = await reservedForOf(early.id);
    expect(
      await notifyReservationConfirmed(
        tenantScope(),
        outletA,
        early.id,
        new Date(earlyAt.getTime() - 72 * HOUR),
      ),
    ).toBe(true);
    await runReminderSweep(new Date(earlyAt.getTime() - 20 * HOUR));
    expect(await remindersOf(early.userId)).toHaveLength(1);
  });

  it("RSV-03 automatic messages never revoke a link staff issued by hand; the email then carries no new link", async () => {
    const booked = await profiledFree("Tamu Link Staf");
    const manual = await staffLink(booked.id);
    const reservedFor = await reservedForOf(booked.id);
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    expect(await remindersOf(booked.userId)).toHaveLength(1);

    expect(await kelolaLinksFor(booked.id)).toHaveLength(0);
    expect((await publicGet(manual)).status).toBe(200);
  });

  it("RSV-03 a later automatic message keeps the earlier automatic link valid (legend-wmfip): both work", async () => {
    const booked = await profiledConfirmed("Tamu Link Baru");
    const [first] = await kelolaLinksFor(booked.id);
    expect(first).toBeDefined();
    const reservedFor = await reservedForOf(booked.id);
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    const [second] = await kelolaLinksFor(booked.id);
    expect(second).toBeDefined();
    expect(second!.token).not.toBe(first!.token);
    expect((await publicGet(first!.token)).status).toBe(200);
    expect((await publicGet(second!.token)).status).toBe(200);
  });

  it("RSV-03 the guest requesting a reschedule keeps the link in use (confirming the DP revokes nothing)", async () => {
    const booked = await profiledConfirmed("Tamu Pakai Link", false);
    const token = await staffLink(booked.id);
    const request = await publicPost("reschedule", token, {
      requestedFor: new Date(Date.now() + 40 * 24 * HOUR).toISOString(),
    });
    expect([200, 201]).toContain(request.status);
    expect((await publicGet(token)).status).toBe(200);
  });

  it("RSV-03 no email link is minted for a cancelled booking or one moved to another time", async () => {
    const cancelled = await profiledConfirmed("Tamu Batal Kirim");
    const token = await staffLink(cancelled.id);
    expect((await publicPost("cancel", token, {})).status).toBe(200);
    expect(await kelolaLinksFor(cancelled.id)).toHaveLength(0);

    const moved = await profiledConfirmed("Tamu Pindah Kirim");
    await asOwner((client) =>
      client.query(
        "UPDATE reservations SET reserved_for = reserved_for + interval '1 hour' WHERE id = $1",
        [moved.id],
      ),
    );
    expect(await kelolaLinksFor(moved.id)).toHaveLength(0);
  });

  it("RSV-03 a profile without a user is passed over and does not hold back another guest's reminder", async () => {
    const orphan = await freeBooking("Tamu Profil Yatim");
    const profileId = randomUUID();
    await owner.query(
      `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
       VALUES ($1, $2, NULL, 'Profil Yatim', 'active', now())`,
      [profileId, seededTenantId],
    );
    profileUsers.push({ userId: randomUUID(), profileId });
    await attachProfile(orphan.id, profileId);
    const real = await profiledFree("Tamu Setelah Yatim");
    const at = new Date((await reservedForOf(orphan.id)).getTime() - 20 * HOUR);
    await runReminderSweep(at);
    await runReminderSweep(
      new Date((await reservedForOf(real.id)).getTime() - 20 * HOUR),
    );
    expect(await remindersOf(real.userId)).toHaveLength(1);
  });
});

describe("RSV-03 the email is built at send time", () => {
  it("RSV-03 the sent email carries the kelola link, the stored message and the delivery table do not", async () => {
    const booked = await profiledFree("Tamu Kirim Email");
    const reservedFor = await reservedForOf(booked.id);
    // A tenant sends email only when its policy turns the channel on.
    await asOwner((client) =>
      client.query(
        `INSERT INTO notification_policies (tenant_id, web_push_enabled, email_enabled, whatsapp, max_attempts, retry_backoff_seconds)
         VALUES ($1, true, true, '{"enabled":false,"allowedCategories":[],"monthlyCap":0,"costPerMessageIdr":0}', 3, '[30,120]')
         ON CONFLICT (tenant_id) DO UPDATE SET email_enabled = true`,
        [seededTenantId],
      ),
    );
    await runReminderSweep(new Date(reservedFor.getTime() - 20 * HOUR));
    const { rows } = await asOwner((client) =>
      client.query<{ id: string }>(
        `SELECT a.id FROM delivery_attempts a JOIN notifications n
           ON n.tenant_id = a.tenant_id AND n.id = a.notification_id
          WHERE n.tenant_id = $1 AND n.user_id = $2 AND a.channel = 'email'`,
        [seededTenantId, booked.userId],
      ),
    );
    expect(rows).toHaveLength(1);
    const mail = new FakeEmailProvider();
    const policy = notificationPolicySchema.parse({
      ...cafeLegendNotificationFixtures.policy,
      tenantId: seededTenantId,
      webPushEnabled: true,
      emailEnabled: true,
    });
    const result = await deliverNotificationAttempt(
      db,
      tenantScope(),
      uuidToUlid(rows[0]!.id),
      {
        resolve: async () => ({
          policy,
          preference: null,
          reachability: {
            hasPushSubscription: false,
            hasVerifiedEmail: true,
            whatsappOptIn: false,
          },
          defaultTimeZone: WIB,
          email: "tamu@example.test",
          pushEndpoint: null,
          whatsappNumber: null,
        }),
        email: mail,
        push: new FakePushProvider(),
        reservationLink: (context, notification) =>
          prepareReservationEmail(context, notification),
      },
      new Date(reservedFor.getTime() - 8 * HOUR),
    );
    expect(result).toBe("sent");
    expect(mail.sent).toHaveLength(1);
    const links = [...mail.sent[0]!.body.matchAll(KELOLA_LINK)];
    expect(links).toHaveLength(1);
    const view = await publicGet(links[0]![1]!);
    expect(view.body.data.reservationId).toBe(booked.id);

    // The token reached the mail only: no stored message holds it.
    const none = await asOwner((client) =>
      client.query(
        "SELECT 1 FROM notifications WHERE tenant_id = $1 AND body LIKE '%' || $2 || '%'",
        [seededTenantId, links[0]![1]!],
      ),
    );
    expect(none.rows).toHaveLength(0);
  });
});
