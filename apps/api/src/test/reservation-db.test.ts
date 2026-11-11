// Reservations against PostgreSQL (PRD v1.7 §3.22, Alur H; RSV-01 no table
// overlap under concurrency, RSV-02 paid DP is a deposit allocated on arrival,
// RSV-03 cancellation follows the snapshot taken at booking; TEN-01..03
// isolation; bead legend-t8bz). Runs the real services with the restricted app
// role (RLS enforced); the DP goes through the real WS-05 adapter (bill link,
// hosted-page intent, verified confirmation) with a gateway test double.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  assignReservationTablesInputSchema,
  cancelReservationInputSchema,
  createReservationInputSchema,
  markNoShowInputSchema,
  reservationAvailabilityQuerySchema,
  seatReservationInputSchema,
  type ReservationCreated,
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
  confirmReservationDeposit,
  getReservation,
  listReservations,
  markReservationNoShow,
  seatReservation,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
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
const linkIds: string[] = [];

/**
 * Gateway test double behind the real WS-05 path: like the provider, one
 * payable code per idempotency key (a retry returns the same code).
 */
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
      providerRef: `FAKE-RSV-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKERSV",
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

/**
 * The guest pays the DP the WS-05 way: opens the hosted page (token from the
 * returned path), creates a QRIS intent, and the verified webhook confirms it.
 */
async function payDeposit(created: ReservationCreated): Promise<string> {
  const deposit = created.deposit!;
  linkIds.push(deposit.paymentLinkId);
  const token = deposit.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-pay-${created.reservation.id}`,
    }),
  );
  await confirmPayment(tenantScope(), intent.id, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: deposit.amountIdr,
    providerRef: `PAID-${intent.id}`,
    at: new Date().toISOString(),
  });
  return intent.id;
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
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
  await setPolicy({ version: "base-1" });
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(seededTenantId, async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    const links = await client.query<{ id: string }>(
      "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
      [seededTenantId, zoneIds],
    );
    const allLinks = [...new Set([...linkIds, ...links.rows.map((r) => r.id)])];
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
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, allLinks],
      );
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE 'reservation-refund:%'",
      [seededTenantId],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, allLinks],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, allLinks],
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
    expect(created.deposit?.paymentPath.startsWith("/bayar/")).toBe(true);
    expect(created.reservation.depositPaymentId).toBeNull();
    expect(created.reservation.depositStatus).toBe("pending");
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

    await payDeposit(created);
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

describe("RSV-02 RSV-03 a DP WS-05 refunded is never treated as held", () => {
  /** WS-05 returned `amount` of the DP (a completed refund row + its status). */
  async function refundByWs05(intentId: string, amount: number, full: boolean) {
    await asOwner(seededTenantId, async (client) => {
      await client.query(
        `INSERT INTO payment_refunds
           (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, approved_by, decided_at)
         VALUES ($1, $2, $3, $4, 'Pengembalian WS-05', 'completed', 'finance-test', 'finance-approver', now())`,
        [seededTenantId, seededOutletA, intentId, amount],
      );
      await client.query(
        "UPDATE payment_intents SET status = $2 WHERE id = $1",
        [intentId, full ? "refunded" : "partially_refunded"],
      );
    });
  }

  async function allocations(reservationId: string) {
    const { rows } = await asOwner(seededTenantId, (client) =>
      client.query<{ amount_idr: string }>(
        "SELECT amount_idr::text FROM reservation_deposit_allocations WHERE reservation_id = $1",
        [reservationId],
      ),
    );
    return rows.map((row) => row.amount_idr);
  }

  async function bookWithDp(date: string) {
    await setPolicy({
      version: "dp-refunded",
      requirement: "required",
      amount: 100_000,
      freeHours: 24,
      lateBp: 0,
    });
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      bookingInput(f.zoneId, date),
      key(),
    );
    return { created, tableIds: f.tableIds };
  }

  const seat = (id: string, tableIds: string[]) =>
    seatReservation(
      tenantScope(),
      staff.userId,
      outletA,
      id,
      seatReservationInputSchema.parse({ tableIds }),
      key(),
    );

  it("RSV-02 a DP refunded in full before it was recorded never confirms the booking", async () => {
    const { created, tableIds } = await bookWithDp("2027-03-20");
    const intentId = await payDeposit(created);
    await refundByWs05(intentId, 100_000, true);
    // Seating reconciles the DP first: a refunded intent is not a deposit, so
    // the booking stays pending_deposit and seating is refused.
    await expect(seat(created.reservation.id, tableIds)).rejects.toMatchObject({
      code: "RESERVATION_DEPOSIT_UNPAID",
    });
    const [row] = await asOwner(seededTenantId, (client) =>
      client
        .query<{ status: string; deposit_payment_id: string | null }>(
          "SELECT status, deposit_payment_id FROM reservations WHERE id = $1",
          [created.reservation.id],
        )
        .then((result) => result.rows),
    );
    expect(row).toEqual({
      status: "pending_deposit",
      deposit_payment_id: null,
    });
    expect(await allocations(created.reservation.id)).toEqual([]);
    await setPolicy({ version: "base-1" });
  });

  it("RSV-02 a DP refunded in full after confirmation seats the guest with no bill credit", async () => {
    const { created, tableIds } = await bookWithDp("2027-03-21");
    const intentId = await payDeposit(created);
    // The payment.paid consumer records it as the DP first.
    const confirmed = await confirmReservationDeposit(
      tenantScope(),
      outletA,
      created.reservation.id,
    );
    expect(confirmed.status).toBe("confirmed");
    await refundByWs05(intentId, 100_000, true);
    const seated = await seat(created.reservation.id, tableIds);
    expect(seated.reservation).toMatchObject({
      status: "seated",
      depositStatus: "refunded",
    });
    expect(await allocations(created.reservation.id)).toEqual([]);
    await setPolicy({ version: "base-1" });
  });

  it("RSV-02 a partly refunded DP credits only what WS-05 still holds", async () => {
    const { created, tableIds } = await bookWithDp("2027-03-22");
    const intentId = await payDeposit(created);
    await refundByWs05(intentId, 40_000, false);
    const seated = await seat(created.reservation.id, tableIds);
    expect(seated.reservation.depositStatus).toBe("partially_refunded");
    expect(await allocations(created.reservation.id)).toEqual(["60000"]);
    await setPolicy({ version: "base-1" });
  });

  it("RSV-03 cancelling a partly refunded DP refunds only the remainder", async () => {
    const { created } = await bookWithDp("2027-03-23");
    const intentId = await payDeposit(created);
    await refundByWs05(intentId, 40_000, false);
    // Well before the free window closes: the snapshot refunds what is held.
    const closed = await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Ganti jadwal" }),
      key(),
      new Date(dayAt("2027-03-20", "12:00")),
    );
    expect(closed.depositOutcome).toMatchObject({
      refundIdr: 60_000,
      forfeitedIdr: 0,
    });
    const { rows } = await asOwner(seededTenantId, (client) =>
      client.query<{ amount_idr: string; status: string }>(
        "SELECT amount_idr::text, status FROM payment_refunds WHERE payment_intent_id = $1 ORDER BY amount_idr",
        [intentId],
      ),
    );
    expect(rows).toEqual([
      { amount_idr: "40000", status: "completed" },
      { amount_idr: "60000", status: "pending" },
    ]);
    await setPolicy({ version: "base-1" });
  });

  it("RSV-03 cancelling a DP refunded in full moves no money", async () => {
    const { created } = await bookWithDp("2027-03-24");
    const intentId = await payDeposit(created);
    await confirmReservationDeposit(
      tenantScope(),
      outletA,
      created.reservation.id,
    );
    await refundByWs05(intentId, 100_000, true);
    const closed = await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Ganti jadwal" }),
      key(),
      new Date(dayAt("2027-03-20", "12:00")),
    );
    expect(closed.depositOutcome).toMatchObject({
      resolution: "nothing_paid",
      refundIdr: 0,
      forfeitedIdr: 0,
    });
    const { rows } = await asOwner(seededTenantId, (client) =>
      client.query(
        "SELECT 1 FROM payment_refunds WHERE payment_intent_id = $1",
        [intentId],
      ),
    );
    expect(rows).toHaveLength(1);
    await setPolicy({ version: "base-1" });
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
    const paidIntentId = await payDeposit(created);

    // The outlet now refunds nothing and has no free window: must not matter.
    await setPolicy({
      version: "snap-2",
      requirement: "required",
      amount: 300_000,
      freeHours: 0,
      lateBp: 0,
      noShowBp: 0,
    });
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
    // The refund is a WS-05 refund request (approval stays with WS-05).
    const refundRows = await asOwner(seededTenantId, (client) =>
      client.query<{ amount_idr: string; status: string }>(
        "SELECT amount_idr::text, status FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
        [seededTenantId, paidIntentId],
      ),
    );
    expect(refundRows.rows).toEqual([
      { amount_idr: "50000", status: "pending" },
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
    await payDeposit(early);
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
    await payDeposit(late);
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
