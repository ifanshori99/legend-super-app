// Automatic guest link: a retried email send must not kill the link of the
// first attempt (bead legend-wmfip; PRD v1.7 §3.22 "Pengingat", RSV-03).
//
// Why: every send of the guest email mints a link (`prepareReservationEmail`).
// If email A was delivered but the response was lost, the retry mints B while
// the provider dedupes the send by the OLD idempotency key, so B never reaches
// the guest. Minting B must therefore NOT revoke A: both stay valid until they
// expire. To bound the pile, at most AUTOMATIC_LINK_ACTIVE_CAP (5) automatic
// links stay active per reservation; older ones are revoked. A link staff issue
// by hand still revokes every active link, and a valid staff link is never
// replaced by an automatic one.
//
// Assumption: the cap is 5 and counts only automatic links (created_by NULL).
// Only the sha256 hash of a token is stored; the raw token is in no column.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  RESERVATION_LINK_TOKEN_HEADER,
  createReservationInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { issueAutomaticReservationGuestLink } from "../services/reservation-public.ts";
import { prepareReservationEmail } from "../services/reservation-guest-notify.ts";
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
const HOUR = 3_600_000;
const outletA = outletIdSchema.parse(seededOutletA);
const LINK_PATH = "/api/public/reservation-link";
const KELOLA_LINK =
  /https?:\/\/[^\s"'<>?#]+\/reservasi\/kelola#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;
/** Named in the brief; the test asserts the behavior, not the constant. */
const AUTOMATIC_LINK_ACTIVE_CAP = 5;

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

/** Provider double: the booking here needs no DP, so it is never called. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    return {
      providerRef: `FAKE-RETRY-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKERETRY",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
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
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Retry" });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
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
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
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
       VALUES ($1, $2, 'retry-test-none', 'none', 0, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
}

async function book(guestName: string): Promise<ReservationCreated> {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const day = 1 + (dayCounter++ % 28);
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(
        `2027-04-${String(day).padStart(2, "0")}`,
        "19:00",
        WIB,
      ).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName,
      contactPhone: "081234567890",
    }),
    `rsv-retry-${randomUUID()}`,
  );
}

async function seedProfile() {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan Retry', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Pelanggan Retry', 'active', now())`,
    [profileId, seededTenantId, userId],
  );
  profileUsers.push({ userId, profileId });
  return { userId, profileId };
}

/**
 * A confirmed, profiled booking with one reminder message written (the sweep
 * creates it). Returns the message's dedupe key: every send of that message
 * goes through `prepareReservationEmail` with it, like a delivery retry does.
 */
async function bookingWithReminder(guestName: string) {
  await setNoDepositPolicy();
  const created = await book(guestName);
  const id = created.reservation.id;
  const profile = await seedProfile();
  await asOwner((client) =>
    client.query(
      "UPDATE reservations SET customer_profile_id = $2 WHERE id = $1",
      [id, profile.profileId],
    ),
  );
  const { rows: times } = await asOwner((client) =>
    client.query<{ reserved_for: Date }>(
      "SELECT reserved_for FROM reservations WHERE id = $1",
      [id],
    ),
  );
  await sweepReservationReminders(
    tenantScope(),
    new Date(times[0]!.reserved_for.getTime() - 20 * HOUR),
  );
  const { rows } = await asOwner((client) =>
    client.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications
        WHERE tenant_id = $1 AND dedupe_key LIKE $2
          AND category IN ('reservation_confirmation', 'reservation_reminder')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [seededTenantId, `${id}@%`],
    ),
  );
  expect(rows).toHaveLength(1);
  return { id, dedupeKey: rows[0]!.dedupe_key };
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One email send: returns the kelola tokens in the email text (empty when the
 * email carries no new link). A short pause keeps created_at strictly ordered,
 * so "the 5 newest" is unambiguous.
 */
async function mint(dedupeKey: string): Promise<string[]> {
  await pause(5);
  const prepared = await prepareReservationEmail(tenantScope(), { dedupeKey });
  return [...(prepared?.text ?? "").matchAll(KELOLA_LINK)].map(
    (match) => match[1]!,
  );
}

function publicGet(token: string) {
  return agent(app)
    .get(LINK_PATH)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token);
}

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

async function linkRows(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      token_hash: string;
      revoked_at: Date | null;
      created_by: string | null;
    }>(
      "SELECT token_hash, revoked_at, created_by FROM reservation_guest_links WHERE reservation_id = $1",
      [reservationId],
    ),
  );
  return rows;
}

const activeRows = async (reservationId: string) =>
  (await linkRows(reservationId)).filter((row) => row.revoked_at === null);

// --- tests ------------------------------------------------------------------

describe("RSV-03 retry of the guest email keeps the earlier link alive (legend-wmfip)", () => {
  it("RSV-03 a retry mints a second link and the first one still opens the booking; only hashes are stored", async () => {
    const { id, dedupeKey } = await bookingWithReminder("Tamu Retry Satu");
    const [tokenA] = await mint(dedupeKey);
    // The retry: the first email was delivered, its response got lost.
    const [tokenB] = await mint(dedupeKey);
    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenB).not.toBe(tokenA);

    // Both links work: the guest holds A, and B is valid too.
    for (const token of [tokenA!, tokenB!]) {
      const view = await publicGet(token);
      expect(view.status).toBe(200);
      expect(view.body.data.reservationId).toBe(id);
    }

    // Storage: both hashes present and active, the raw token nowhere in the rows.
    const rows = await linkRows(id);
    const hashes = rows.map((row) => row.token_hash);
    expect(hashes).toEqual(
      expect.arrayContaining([sha256(tokenA!), sha256(tokenB!)]),
    );
    expect(hashes).not.toContain(tokenA);
    expect(hashes).not.toContain(tokenB);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(2);
    for (const token of [tokenA!, tokenB!]) {
      const leaked = await asOwner((client) =>
        client.query(
          "SELECT 1 FROM reservation_guest_links WHERE reservation_id = $1 AND reservation_guest_links::text LIKE '%' || $2 || '%'",
          [id, token],
        ),
      );
      expect(leaked.rows).toHaveLength(0);
    }
  });

  it("RSV-03 minting 7 times keeps only the 5 newest automatic links active", async () => {
    const { id, dedupeKey } = await bookingWithReminder("Tamu Retry Tujuh");
    const tokens: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const [token] = await mint(dedupeKey);
      expect(token).toBeDefined();
      tokens.push(token!);
    }
    expect(new Set(tokens).size).toBe(7);

    const newest = tokens.slice(-AUTOMATIC_LINK_ACTIVE_CAP);
    const oldest = tokens.slice(0, tokens.length - AUTOMATIC_LINK_ACTIVE_CAP);
    for (const token of newest)
      expect((await publicGet(token)).status).toBe(200);
    for (const token of oldest) {
      const gone = await publicGet(token);
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe("RESERVATION_LINK_INVALID");
    }
    expect(await activeRows(id)).toHaveLength(AUTOMATIC_LINK_ACTIVE_CAP);
  });

  it("RSV-03 the link just minted is never revoked by the cap, even with an identical clock and 5 active links", async () => {
    const { id } = await bookingWithReminder("Tamu Retry Jam Sama");
    const { rows: times } = await asOwner((client) =>
      client.query<{ reserved_for: Date }>(
        "SELECT reserved_for FROM reservations WHERE id = $1",
        [id],
      ),
    );
    // One fixed clock for every mint: created_at ties on every row, so only
    // the id of the new row can protect it.
    const now = new Date(times[0]!.reserved_for.getTime() - 30 * HOUR);
    const tokens: string[] = [];
    for (let i = 0; i < AUTOMATIC_LINK_ACTIVE_CAP + 2; i += 1) {
      const issued = await withTenant(db, tenantScope(), (tx) =>
        issueAutomaticReservationGuestLink(tx, tenantScope(), {
          outletId: outletA,
          reservationId: id,
          now,
        }),
      );
      expect(issued).not.toBeNull();
      tokens.push(issued!.token);
      // The newest link is active and opens the booking right after each mint.
      const view = await publicGet(issued!.token);
      expect(view.status).toBe(200);
      expect(view.body.data.reservationId).toBe(id);
    }
    expect(await activeRows(id)).toHaveLength(AUTOMATIC_LINK_ACTIVE_CAP);
  });

  it("RSV-03 a link issued by staff revokes every automatic link, and only the staff link stays", async () => {
    const { id, dedupeKey } = await bookingWithReminder("Tamu Retry Staf");
    const automatic = [
      ...(await mint(dedupeKey)),
      ...(await mint(dedupeKey)),
      ...(await mint(dedupeKey)),
    ];
    expect(automatic).toHaveLength(3);
    for (const token of automatic)
      expect((await publicGet(token)).status).toBe(200);

    const manual = await staffLink(id);
    for (const token of automatic)
      expect((await publicGet(token)).status).toBe(404);
    expect((await publicGet(manual)).status).toBe(200);

    const active = await activeRows(id);
    expect(active).toHaveLength(1);
    expect(active[0]!.token_hash).toBe(sha256(manual));
    expect(active[0]!.created_by).not.toBeNull();
  });

  it("RSV-03 a valid staff link is not replaced by a retry: the email carries no new link and no row is added", async () => {
    const { id, dedupeKey } = await bookingWithReminder("Tamu Retry Link Staf");
    const manual = await staffLink(id);
    const before = await linkRows(id);

    expect(await mint(dedupeKey)).toHaveLength(0);
    expect(await mint(dedupeKey)).toHaveLength(0);

    expect((await publicGet(manual)).status).toBe(200);
    const after = await linkRows(id);
    expect(after).toHaveLength(before.length);
    expect(await activeRows(id)).toHaveLength(1);
  });
});
