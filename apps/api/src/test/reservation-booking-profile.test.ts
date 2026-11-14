// A public booking links itself to the guest's member profile when one can be
// found by the WhatsApp number (bead legend-q4sv2; PRD v1.7 §3.22 "Pengingat",
// RSV-01/RSV-03). Real PostgreSQL; the booking runs through createReservation.
//
// Rule under test (engineer decision in the brief): the booking only LOOKS UP a
// profile, it never creates one. A profile is linkable when it is of the same
// tenant, holds the same WhatsApp digest, is not closed or suspended, is not
// merged into another profile and belongs to a user (only such a profile can be
// sent a message).
//
// Assumptions:
// - the digest of "contactPhone" is `whatsAppDigest` (same keyed digest every
//   module uses for the same number, "0812..." and "62812..." are equal).
// - a replay with the same Idempotency-Key answers with the same reservation id.
// - after the link, the confirmation message appears in `notifications` for the
//   profile's user (the table the guest message tests read).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createReservationInputSchema } from "@starter/shared/reservation";
import { createApp } from "../app";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { notifyReservationConfirmed } from "../services/reservation-guest-notify.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const HOUR = 3_600_000;
const outletA = outletIdSchema.parse(seededOutletA);

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

let staff: Staff;
let otherTenant: IsolatedTenant;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const profileIds: { tenantId: string; id: string }[] = [];
const userIds: string[] = [];
let dayCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Profile" });
  otherTenant = await createIsolatedTenant(`rsvprof${Date.now() % 100_000}`);
});

afterAll(async () => {
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
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
      [
        seededTenantId,
        profileIds
          .filter((entry) => entry.tenantId === seededTenantId)
          .map((entry) => entry.id),
      ],
    );
  });
  await owner.query(
    "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
    [
      profileIds
        .filter((entry) => entry.tenantId === otherTenant.tenantId)
        .map((entry) => entry.id),
    ],
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds]);
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await dropIsolatedTenant(otherTenant);
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

async function setNoDepositPolicy() {
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
       VALUES ($1, $2, 'profile-link-test', 'none', 0, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
}

/** A number no other test file uses: "0812" plus eight random digits. */
const freshPhone = () =>
  `0812${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

type ProfileOptions = {
  tenantId?: string;
  status?: "active" | "closed" | "suspended" | "pending_verification";
  withUser?: boolean;
};

/** Seeds a customer profile holding the digest of `phone`. */
async function seedProfile(phone: string, options: ProfileOptions = {}) {
  const tenantId = options.tenantId ?? seededTenantId;
  let userId: string | null = null;
  if (options.withUser ?? true) {
    userId = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan Profil', $2, true)`,
      [userId, `${userId}@example.test`],
    );
    userIds.push(userId);
  }
  const id = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, $4, 'Pelanggan Profil', $5, now())`,
    [
      id,
      tenantId,
      userId,
      await whatsAppDigest(phone),
      options.status ?? "active",
    ],
  );
  profileIds.push({ tenantId, id });
  return { id, userId };
}

function nextDate() {
  const day = 1 + (dayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

async function book(
  phone: string,
  idempotencyKey = `rsv-prof-${randomUUID()}`,
) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const created = await createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(nextDate(), "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName: "Tamu Profil",
      contactPhone: phone,
    }),
    idempotencyKey,
  );
  reservationIds.push(created.reservation.id);
  return Object.assign(created, { rawZoneId: zone.id as string });
}

async function profileIdOf(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ customer_profile_id: string | null }>(
      "SELECT customer_profile_id FROM reservations WHERE id = $1",
      [reservationId],
    ),
  );
  return rows[0]!.customer_profile_id;
}

/** Profiles of any tenant holding the digest of `phone`. */
async function profilesWithNumber(phone: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM customer_profiles WHERE whatsapp_hash = $1",
    [await whatsAppDigest(phone)],
  );
  return rows;
}

// --- tests ------------------------------------------------------------------

describe("RSV-01 RSV-03 legend-q4sv2 a booking links the member profile of its number", () => {
  it("RSV-01 a number that matches an active member profile of the tenant fills customer_profile_id", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const profile = await seedProfile(phone);
    const created = await book(phone);
    // Red on the old code: the insert always wrote NULL.
    expect(await profileIdOf(created.reservation.id)).toBe(profile.id);
  });

  it("RSV-01 the same number written as 62812... links the same profile", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const profile = await seedProfile(phone);
    const created = await book(`62${phone.slice(1)}`);
    expect(await profileIdOf(created.reservation.id)).toBe(profile.id);
  });

  it("RSV-01 a number without a profile leaves customer_profile_id empty and creates no profile", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const created = await book(phone);
    expect(await profileIdOf(created.reservation.id)).toBeNull();
    expect(await profilesWithNumber(phone)).toHaveLength(0);
  });

  it("RSV-01 a profile of ANOTHER tenant with the same number is not linked (tenant isolation)", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    await seedProfile(phone, { tenantId: otherTenant.tenantId });
    const created = await book(phone);
    expect(await profileIdOf(created.reservation.id)).toBeNull();
  });

  it("RSV-01 a closed profile is not linked", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    await seedProfile(phone, { status: "closed" });
    const created = await book(phone);
    expect(await profileIdOf(created.reservation.id)).toBeNull();
  });

  it("RSV-01 a suspended profile is not linked", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    await seedProfile(phone, { status: "suspended" });
    const created = await book(phone);
    expect(await profileIdOf(created.reservation.id)).toBeNull();
  });

  it("RSV-01 a profile without a user is not linked (nobody to message)", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    await seedProfile(phone, { withUser: false });
    const created = await book(phone);
    expect(await profileIdOf(created.reservation.id)).toBeNull();
  });

  it("RSV-01 booking again with the same idempotency key keeps one reservation and the link", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const profile = await seedProfile(phone);
    const idempotencyKey = `rsv-prof-same-${randomUUID()}`;
    const first = await book(phone, idempotencyKey);
    // Same key and same body: the stored zone is reused, so book() cannot be
    // called again (it builds a new zone). Replay with the first zone.
    const replay = await createReservation(
      tenantScope(),
      outletA,
      createReservationInputSchema.parse({
        reservedFor: first.reservation.reservedFor,
        pax: 2,
        zoneId: first.rawZoneId,
        guestName: "Tamu Profil",
        contactPhone: phone,
      }),
      idempotencyKey,
    );
    expect(replay.reservation.id).toBe(first.reservation.id);
    const { rows } = await asOwner((client) =>
      client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM reservations WHERE tenant_id = $1 AND zone_id = $2",
        [seededTenantId, first.rawZoneId],
      ),
    );
    expect(rows[0]!.count).toBe(1);
    expect(await profileIdOf(first.reservation.id)).toBe(profile.id);
  });

  it("RSV-01 the public response never reveals membership: member and non-member both get customerProfileId null", async () => {
    await setNoDepositPolicy();
    const memberPhone = freshPhone();
    const profile = await seedProfile(memberPhone);
    const member = await book(memberPhone);
    const stranger = await book(freshPhone());
    // Red on the old code: the member response carried the profile id.
    expect(member.reservation.customerProfileId).toBeNull();
    expect(stranger.reservation.customerProfileId).toBeNull();
    // The database keeps the link.
    expect(await profileIdOf(member.reservation.id)).toBe(profile.id);
    expect(await profileIdOf(stranger.reservation.id)).toBeNull();
  });

  it("RSV-01 an idempotent replay of a member booking also answers customerProfileId null", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const profile = await seedProfile(phone);
    const idempotencyKey = `rsv-prof-replay-${randomUUID()}`;
    const first = await book(phone, idempotencyKey);
    const replay = await createReservation(
      tenantScope(),
      outletA,
      createReservationInputSchema.parse({
        reservedFor: first.reservation.reservedFor,
        pax: 2,
        zoneId: first.rawZoneId,
        guestName: "Tamu Profil",
        contactPhone: phone,
      }),
      idempotencyKey,
    );
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.reservation.customerProfileId).toBeNull();
    expect(await profileIdOf(first.reservation.id)).toBe(profile.id);
  });

  it("RSV-03 once linked, the confirmation message reaches the profile's user", async () => {
    await setNoDepositPolicy();
    const phone = freshPhone();
    const profile = await seedProfile(phone);
    const created = await book(phone);
    const { rows: timing } = await asOwner((client) =>
      client.query<{ reserved_for: Date }>(
        "SELECT reserved_for FROM reservations WHERE id = $1",
        [created.reservation.id],
      ),
    );
    // Red on the old code: no profile on the reservation, so no message.
    expect(
      await notifyReservationConfirmed(
        tenantScope(),
        outletA,
        created.reservation.id,
        new Date(timing[0]!.reserved_for.getTime() - 72 * HOUR),
      ),
    ).toBe(true);
    const { rows } = await asOwner((client) =>
      client.query<{ category: string }>(
        "SELECT category FROM notifications WHERE tenant_id = $1 AND user_id = $2",
        [seededTenantId, profile.userId],
      ),
    );
    expect(rows.map((row) => row.category)).toContain(
      "reservation_confirmation",
    );
  });
});
