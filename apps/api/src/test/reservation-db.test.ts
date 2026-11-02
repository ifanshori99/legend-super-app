// Reservations against PostgreSQL (PRD v1.7 §3.22, Alur H; RSV-01 no table
// overlap under concurrency, RSV-02 paid DP is a deposit allocated on arrival,
// RSV-03 cancellation follows the snapshot taken at booking; TEN-01..03
// isolation; bead legend-t8bz). Runs the real services with the restricted app
// role (RLS enforced); the payment side is a test double of the deposit port
// that writes real payment_links / payment_intents rows like WS-05 does.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  assignReservationTablesInputSchema,
  cancelReservationInputSchema,
  createReservationInputSchema,
  markNoShowInputSchema,
  reservationAvailabilityQuerySchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { db } from "../db";
import { reservations } from "../db/schema/reservation";
import { withTenant } from "../db/tenant";
import {
  assignReservationTables,
  createReservation,
  getAvailability,
} from "../services/reservation-booking.ts";
import {
  cancelReservation,
  getReservation,
  listReservations,
  markReservationNoShow,
  seatReservation,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const outletA = outletIdSchema.parse(seededOutletA);
const outletB = outletIdSchema.parse(seededOutletB);

const base = (tenant = seededTenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = () =>
  establishScopedTenantContext(base(), { kind: "tenant" });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

let app: ReturnType<typeof createApp>;
let staff: Staff;
let isolated: IsolatedTenant | undefined;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const refunds: { paymentIntentId: string; refundIdr: number }[] = [];
const openedByKey = new Map<string, { id: string; url: string; exp: string }>();

/** A deposit port that behaves like WS-05: one intent per idempotency key. */
const depositPort: ReservationDepositPort = {
  async openDeposit(input) {
    const cached = openedByKey.get(input.idempotencyKey);
    if (cached)
      return {
        paymentIntentId: cached.id,
        paymentUrl: cached.url,
        expiresAt: cached.exp,
      };
    const linkId = randomUUID();
    const intentId = randomUUID();
    const expiresAt = new Date(
      input.now.getTime() + input.expiresInMinutes * 60_000,
    );
    await asOwner(seededTenantId, async (client) => {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'reservation-test')`,
        [
          linkId,
          seededTenantId,
          input.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `RSV-${linkId.slice(0, 8)}`,
          input.amountIdr,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider, amount_idr,
            idempotency_key, status, instructions, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'pending',
                 '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', $8)`,
        [
          intentId,
          seededTenantId,
          input.outletId,
          linkId,
          input.reservationId,
          input.amountIdr,
          input.idempotencyKey,
          expiresAt,
        ],
      );
    });
    linkIds.push(linkId);
    intentIds.push(intentId);
    const opened = {
      id: intentId,
      url: `https://pay.example.test/${intentId}`,
      exp: expiresAt.toISOString(),
    };
    openedByKey.set(input.idempotencyKey, opened);
    return {
      paymentIntentId: opened.id,
      paymentUrl: opened.url,
      expiresAt: opened.exp,
    };
  },
  async requestRefund(input) {
    refunds.push({
      paymentIntentId: input.paymentIntentId,
      refundIdr: input.refundIdr,
    });
  },
};

async function payDeposit(intentId: string) {
  await asOwner(seededTenantId, (client) =>
    client.query(
      "UPDATE payment_intents SET status = 'paid', paid_at = now() WHERE id = $1",
      [intentId],
    ),
  );
}

type PolicySeed = {
  version: string;
  requirement?: "none" | "required";
  amount?: number;
  freeHours?: number;
  lateBp?: number;
  noShowBp?: number;
};

async function setPolicy(seed: PolicySeed) {
  await asOwner(seededTenantId, async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, 60, $6, $7, $8, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        seed.version,
        seed.requirement ?? "none",
        seed.amount ?? 0,
        seed.freeHours ?? 24,
        seed.lateBp ?? 0,
        seed.noShowBp ?? 0,
      ],
    );
  });
}

/** A zone with `count` 4-seat tables created through the floor API. */
async function floor(count: number) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    ids.push(table.id);
  }
  return { zoneId: zone.id as string, tableIds: ids };
}

const dayAt = (date: string, time: string) =>
  zonedInstant(date, time, WIB).toISOString();

function bookingInput(
  zoneId: string,
  date: string,
  overrides: Record<string, unknown> = {},
) {
  return createReservationInputSchema.parse({
    reservedFor: dayAt(date, "19:00"),
    pax: 2,
    zoneId,
    guestName: "Tamu Uji",
    contactPhone: "081234567890",
    ...overrides,
  });
}

const key = () => `rsv-${randomUUID()}`;

async function liveHolds(reservationId: string): Promise<string[]> {
  const { rows } = await asOwner(seededTenantId, (client) =>
    client.query<{ table_id: string }>(
      "SELECT table_id FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows.map((row) => row.table_id);
}

async function eventNames(reservationId: string): Promise<string[]> {
  const { rows } = await asOwner(seededTenantId, (client) =>
    client.query<{ name: string }>(
      "SELECT event->>'name' AS name FROM domain_event_outbox WHERE aggregate_id = $1 ORDER BY sequence",
      [reservationId],
    ),
  );
  return rows.map((row) => row.name);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Owner" });
  setReservationDepositPort(depositPort);
  await setPolicy({ version: "base-1" });
});

afterAll(async () => {
  setReservationDepositPort(null);
  await asOwner(seededTenantId, async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    await client.query(
      `DELETE FROM reservation_deposit_allocations WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      `DELETE FROM reservation_tables WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
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
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("RSV-01 table assignment never overlaps", () => {
  it("RSV-01 two simultaneous bookings for the last table: exactly one wins", async () => {
    const f = await floor(1);
    const results = await Promise.allSettled([
      createReservation(
        tenantScope(),
        outletA,
        bookingInput(f.zoneId, "2027-03-10"),
        key(),
      ),
      createReservation(
        tenantScope(),
        outletA,
        bookingInput(f.zoneId, "2027-03-10", { guestName: "Tamu Dua" }),
        key(),
      ),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "RESERVATION_SLOT_UNAVAILABLE",
    });
  });

  it("RSV-01 two simultaneous staff assignments of one table: exactly one wins with SLOT_TAKEN", async () => {
    const f = await floor(3);
    const [one, two] = await Promise.all([
      createReservation(
        tenantScope(),
        outletA,
        bookingInput(f.zoneId, "2027-03-11"),
        key(),
      ),
      createReservation(
        tenantScope(),
        outletA,
        bookingInput(f.zoneId, "2027-03-11", { guestName: "Tamu Dua" }),
        key(),
      ),
    ]);
    const target = assignReservationTablesInputSchema.parse({
      tableIds: [f.tableIds[2]],
    });
    const results = await Promise.allSettled([
      assignReservationTables(
        tenantScope(),
        staff.userId,
        outletA,
        one.reservation.id,
        target,
        key(),
      ),
      assignReservationTables(
        tenantScope(),
        staff.userId,
        outletA,
        two.reservation.id,
        target,
        key(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "RESERVATION_SLOT_TAKEN" });
    const holders = [
      ...(await liveHolds(one.reservation.id)),
      ...(await liveHolds(two.reservation.id)),
    ].filter((id) => id === f.tableIds[2]);
    expect(holders).toHaveLength(1);
  });

  it("RSV-01 the exclusion constraint itself rejects an overlapping hold, and allows back-to-back", async () => {
    const f = await floor(2);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-12"),
      key(),
    );
    const held = created.reservation.tableIds[0]!;
    const insert = (startsAt: string, endsAt: string) =>
      asOwner(seededTenantId, async (client) => {
        const other = await client.query<{ id: string }>(
          `INSERT INTO reservations
             (tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax, zone_id, deposit_idr,
              policy_snapshot, status, source)
           SELECT tenant_id, outlet_id, 'Raw', $2::timestamptz, 60, 2, zone_id, 0, policy_snapshot, 'confirmed', 'staff'
           FROM reservations WHERE id = $1 RETURNING id`,
          [created.reservation.id, startsAt],
        );
        await client.query(
          `INSERT INTO reservation_tables (tenant_id, outlet_id, reservation_id, table_id, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
          [
            seededTenantId,
            seededOutletA,
            other.rows[0]!.id,
            held,
            startsAt,
            endsAt,
          ],
        );
      });
    const startsAt = dayAt("2027-03-12", "19:00");
    await expect(
      insert(dayAt("2027-03-12", "20:00"), dayAt("2027-03-12", "21:00")),
    ).rejects.toMatchObject({
      code: "23P01",
    });
    // The booking holds [19:00, 20:30): a slot starting at 20:30 is free.
    await expect(
      insert(dayAt("2027-03-12", "20:30"), dayAt("2027-03-12", "21:30")),
    ).resolves.toBeUndefined();
    expect(startsAt).toBeTruthy();
  });

  it("RSV-01 availability shows free tables and drops a held one", async () => {
    const f = await floor(1);
    const query = reservationAvailabilityQuerySchema.parse({
      date: "2027-03-13",
      pax: 2,
      zoneId: f.zoneId,
    });
    const before = await getAvailability(tenantScope(), outletA, query);
    const slot = dayAt("2027-03-13", "19:00");
    expect(before.slots.find((s) => s.startsAt === slot)?.tableIds).toEqual(
      f.tableIds,
    );
    await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-13"),
      key(),
    );
    const after = await getAvailability(tenantScope(), outletA, query);
    expect(after.slots.find((s) => s.startsAt === slot)).toBeUndefined();
    // 20:30 starts exactly when the booking ends, so it is still offered.
    expect(
      after.slots.find((s) => s.startsAt === dayAt("2027-03-13", "20:30")),
    ).toBeDefined();
  });

  it("RSV-01 idempotent replay returns the same reservation; a different payload with the same key conflicts", async () => {
    const f = await floor(2);
    const idempotencyKey = key();
    const input = bookingInput(f.zoneId, "2027-03-14");
    const [a, b] = await Promise.all([
      createReservation(tenantScope(), outletA, input, idempotencyKey),
      createReservation(tenantScope(), outletA, input, idempotencyKey),
    ]);
    expect(b.reservation.id).toBe(a.reservation.id);
    const again = await createReservation(
      tenantScope(),
      outletA,
      input,
      idempotencyKey,
    );
    expect(again.reservation.id).toBe(a.reservation.id);
    const { rows } = await asOwner(seededTenantId, (client) =>
      client.query("SELECT 1 FROM reservations WHERE zone_id = $1", [f.zoneId]),
    );
    expect(rows).toHaveLength(1);
    await expect(
      createReservation(
        tenantScope(),
        outletA,
        bookingInput(f.zoneId, "2027-03-14", { pax: 3 }),
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

describe("RSV-02 the paid DP is a deposit allocated on arrival", () => {
  it("RSV-02 refuses to seat before the DP is paid, allows a tentative table assignment, then allocates the DP", async () => {
    await setPolicy({
      version: "dp-1",
      requirement: "required",
      amount: 100_000,
    });
    const f = await floor(2);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-15"),
      key(),
    );
    expect(created.reservation.status).toBe("pending_deposit");
    expect(created.deposit?.amountIdr).toBe(100_000);
    expect(created.deposit?.paymentUrl.startsWith("https://")).toBe(true);
    const id = created.reservation.id;

    // Tentative hold: staff may assign tables before the DP is paid.
    const assigned = await assignReservationTables(
      tenantScope(),
      staff.userId,
      outletA,
      id,
      assignReservationTablesInputSchema.parse({ tableIds: [f.tableIds[1]] }),
      key(),
    );
    expect(assigned.tableIds).toEqual([f.tableIds[1]]);
    expect(assigned.status).toBe("pending_deposit");

    // C11: seating needs the DP.
    const seatInput = seatReservationInputSchema.parse({
      tableIds: [f.tableIds[1]],
    });
    await expect(
      seatReservation(
        tenantScope(),
        staff.userId,
        outletA,
        id,
        seatInput,
        key(),
      ),
    ).rejects.toMatchObject({ code: "RESERVATION_DEPOSIT_UNPAID" });

    await payDeposit(created.deposit!.paymentIntentId);
    const seatKey = key();
    const seated = await seatReservation(
      tenantScope(),
      staff.userId,
      outletA,
      id,
      seatInput,
      seatKey,
    );
    expect(seated.reservation.status).toBe("seated");
    // Replay of the same seat request returns the stored result, not a second session.
    const replay = await seatReservation(
      tenantScope(),
      staff.userId,
      outletA,
      id,
      seatInput,
      seatKey,
    );
    expect(replay.tableSessionId).toBe(seated.tableSessionId);

    const { rows } = await asOwner(seededTenantId, (client) =>
      client.query<{ amount_idr: string; table_session_id: string }>(
        "SELECT amount_idr::text, table_session_id FROM reservation_deposit_allocations WHERE reservation_id = $1",
        [id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount_idr: "100000",
      table_session_id: seated.tableSessionId,
    });
    expect(await eventNames(id)).toEqual(
      expect.arrayContaining([
        "reservation.created",
        "reservation.confirmed",
        "reservation.seated",
      ]),
    );
    await setPolicy({ version: "base-1" });
  });

  it("RSV-02 a reservation without DP is confirmed at once and can be seated", async () => {
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-16"),
      key(),
    );
    expect(created.reservation.status).toBe("confirmed");
    expect(created.deposit).toBeNull();
    const seated = await seatReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      seatReservationInputSchema.parse({
        tableIds: created.reservation.tableIds,
      }),
      key(),
    );
    expect(seated.reservation.status).toBe("seated");
  });
});

describe("RSV-03 cancellation follows the policy snapshot", () => {
  it("RSV-03 a later policy change does not affect the refund of an earlier booking", async () => {
    await setPolicy({
      version: "snap-1",
      requirement: "required",
      amount: 100_000,
      freeHours: 24,
      lateBp: 5000,
      noShowBp: 0,
    });
    const f = await floor(1);
    const bookedAt = new Date(dayAt("2027-03-17", "09:00"));
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-17"),
      key(),
      bookedAt,
    );
    expect(created.reservation.policy.version).toBe("snap-1");
    await payDeposit(created.deposit!.paymentIntentId);

    // The outlet now refunds nothing and has no free window: must not matter.
    await setPolicy({
      version: "snap-2",
      requirement: "required",
      amount: 300_000,
      freeHours: 0,
      lateBp: 0,
      noShowBp: 0,
    });
    const refundsBefore = refunds.length;
    const closed = await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Tamu berhalangan" }),
      key(),
      new Date(dayAt("2027-03-17", "12:00")), // 7h before: inside the 24h window
    );
    expect(closed.reservation.status).toBe("cancelled");
    expect(closed.reservation.policy.version).toBe("snap-1");
    expect(closed.depositOutcome).toMatchObject({
      resolution: "refund_partial",
      refundIdr: 50_000,
      forfeitedIdr: 50_000,
      policyVersion: "snap-1",
    });
    expect(refunds.slice(refundsBefore)).toEqual([
      { paymentIntentId: created.deposit!.paymentIntentId, refundIdr: 50_000 },
    ]);
    expect(await liveHolds(created.reservation.id)).toEqual([]);
    expect(await eventNames(created.reservation.id)).toContain(
      "reservation.cancelled",
    );
    const audit = await asOwner(seededTenantId, (client) =>
      client.query(
        "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'reservation.cancelled'",
        [seededTenantId, created.reservation.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);

    // The snapshot is frozen at the database as well.
    await expect(
      asOwner(seededTenantId, (client) =>
        client.query(
          "UPDATE reservations SET policy_snapshot = jsonb_set(policy_snapshot, '{lateCancellationRefundBp}', '10000') WHERE id = $1",
          [created.reservation.id],
        ),
      ),
    ).rejects.toThrow(/immutable/);
    await setPolicy({ version: "base-1" });
  });

  it("RSV-03 cancelling outside the free window refunds the full DP; a no-show follows the snapshot's no-show rule", async () => {
    await setPolicy({
      version: "snap-3",
      requirement: "required",
      amount: 80_000,
      freeHours: 24,
      lateBp: 5000,
      noShowBp: 0,
    });
    const f = await floor(2);
    const early = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-18"),
      key(),
      new Date(dayAt("2027-03-10", "09:00")),
    );
    await payDeposit(early.deposit!.paymentIntentId);
    const full = await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      early.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Ganti jadwal" }),
      key(),
      new Date(dayAt("2027-03-15", "10:00")),
    );
    expect(full.depositOutcome).toMatchObject({
      resolution: "refund_full",
      refundIdr: 80_000,
      forfeitedIdr: 0,
    });

    const late = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-19"),
      key(),
      new Date(dayAt("2027-03-10", "09:00")),
    );
    await payDeposit(late.deposit!.paymentIntentId);
    await expect(
      markReservationNoShow(
        tenantScope(),
        staff.userId,
        outletA,
        late.reservation.id,
        markNoShowInputSchema.parse({}),
        key(),
        new Date(dayAt("2027-03-19", "18:00")),
      ),
    ).rejects.toMatchObject({ code: "RESERVATION_TRANSITION_INVALID" }); // not due yet
    const noShow = await markReservationNoShow(
      tenantScope(),
      staff.userId,
      outletA,
      late.reservation.id,
      markNoShowInputSchema.parse({}),
      key(),
      new Date(dayAt("2027-03-19", "20:00")),
    );
    expect(noShow.reservation.status).toBe("no_show");
    expect(noShow.depositOutcome).toMatchObject({
      resolution: "no_refund",
      refundIdr: 0,
      forfeitedIdr: 80_000,
    });
    await setPolicy({ version: "base-1" });
  });
});

describe("tenant and outlet isolation", () => {
  it("TEN-01 RSV-01 another tenant cannot read, book or list this outlet's reservations", async () => {
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-20"),
      key(),
    );
    isolated = await createIsolatedTenant(`rsv-${randomUUID().slice(0, 6)}`);
    const other = establishScopedTenantContext(base(isolated.tenantId), {
      kind: "tenant",
    });

    // RLS: the row does not exist for the other tenant.
    const visible = await withTenant(db, other, (tx) =>
      tx.select().from(reservations),
    );
    expect(visible.map((row) => row.id)).not.toContain(created.reservation.id);
    // Service paths refuse as well.
    await expect(
      createReservation(
        other,
        outletA,
        bookingInput(f.zoneId, "2027-03-20", { guestName: "Penyusup" }),
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getAvailability(
        other,
        outletA,
        reservationAvailabilityQuerySchema.parse({
          date: "2027-03-20",
          pax: 2,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getReservation(other, staff.userId, outletA, created.reservation.id),
    ).rejects.toBeDefined();
  });

  it("TEN-03 an outlet-scoped manager of outlet A cannot act on outlet B", async () => {
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, "2027-03-21"),
      key(),
    );
    const manager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Rsv Manager A",
    });
    const scopedToA = establishScopedTenantContext(base(), {
      kind: "outlets",
      outletIds: [outletA],
    });
    // Allowed in the own outlet.
    const own = await listReservations(scopedToA, manager.userId, outletA, {
      limit: 25,
      date: "2027-03-21",
    } as never);
    expect(own.data.map((row) => row.id)).toContain(created.reservation.id);
    // Denied on the other outlet, for every staff action.
    await expect(
      listReservations(scopedToA, manager.userId, outletB, {
        limit: 25,
      } as never),
    ).rejects.toBeDefined();
    await expect(
      cancelReservation(
        scopedToA,
        manager.userId,
        outletB,
        created.reservation.id,
        cancelReservationInputSchema.parse({ reason: "x" }),
        key(),
      ),
    ).rejects.toBeDefined();
    // A reservation of outlet A is not found under outlet B even for a tenant-wide caller.
    await expect(
      getReservation(
        tenantScope(),
        staff.userId,
        outletB,
        created.reservation.id,
      ),
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_FOUND" });
  });
});
