// legend-bz9h Area A (F39/F25, FAC-14): WFC seats, seat reservations and day
// pass against PostgreSQL with the restricted app role (RLS enforced).
// Written from the bz9h spec, never from the implementation.
//
// Money rules covered (jangan sampai rugi):
//   M1 price is read server-side (client price/amount never trusted)
//   M2 refund <= amount actually paid, never pays twice
//   M4 entitlement only after paid, revoked on refund, idempotent per purchase
//   M5 a seat cannot be double-booked (exclusion constraint)
// plus tenant and outlet isolation (TEN-01..03).
//
// Assumptions (the spec leaves them open):
// - Service inputs carry ISO-8601 strings for instants (`startsAt`, `endsAt`).
// - `createWfcSeat` input is `{ outletId, zoneId, code }`; results expose `.id`.
//   `listWfcSeats` resolves to an array (or an object with `items`).
// - Failures are `HttpError`s: 409 for a conflict (wrong paid amount, refund
//   over the paid amount, double booking, duplicate seat code), 403 without the
//   facility permission, 400/404/409/422 for other invalid input.
// - A second refund / confirm of the same reservation either resolves as a
//   no-op or is rejected with 409. Both are fine; paying twice is not.
// - The day pass refund entry point is `refundDayPass({ paymentRef,
//   refundIdr })` (the spec names no function for it).
// - "end of the outlet-local business day" is somewhere after NOW and no later
//   than the next 04:00 cutoff (Jakarta), i.e. <= 2026-11-08T21:00:00Z.
// - Seeding uses raw SQL as the owner; the column names of wfc_seats and
//   wfc_seat_reservations are the ones the spec lists.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  cancelWfcReservation,
  confirmWfcReservationPaid,
  createWfcSeat,
  listWfcSeats,
  purchaseDayPass,
  refundDayPass,
  refundWfcReservation,
  reserveWfcSeat,
} from "../services/wfc-seat.service.ts";
import {
  NOW,
  asTenant,
  createWorld,
  owner,
  seedProfile,
  short,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  HOUR,
  entitlementsOf,
  inHours,
  ledgerRows,
  outletContext,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const PRICE = 50_000;
const DAY_PASS_PRICE = 75_000;

type Failure = { status?: number; code?: string; message: string };

/** What a promise rejects with; throws when it resolves. */
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return { status: e.status, code: e.code, message: String(e.message) };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

/** Rejected or resolved; never throws. Returns the rejection or null. */
async function settle(promise: Promise<unknown>): Promise<Failure | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return { status: e.status, code: e.code, message: String(e.message) };
  }
}

const idOf = (value: unknown): string => {
  const id = (value as { id?: string } | null)?.id;
  if (!id) throw new Error("expected a result with an id");
  return id;
};
const listOf = (value: unknown): { id: string }[] =>
  Array.isArray(value)
    ? value
    : ((value as { items?: { id: string }[] }).items ?? []);

/** Business instants are relative to NOW (2026-11-08 10:00 Jakarta). */
const at = (hours: number) => inHours(hours, NOW).toISOString();

async function seedActor(
  tenantId: string,
  permissions: string[] = ["facility.config.manage", "facility.booth.operate"],
): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC seat test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC seat test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return userId;
}

async function seedZone(world: Pick<World, "tenantId">, outletId: string) {
  const zoneId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, world.tenantId, outletId, `Zona WFC ${short()}`],
    ),
  );
  return zoneId;
}

async function seedCoworking(world: Pick<World, "tenantId">, outletId: string) {
  const facilityId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'coworking', 60, 0, 10, $5, $6, $7)`,
      [
        facilityId,
        world.tenantId,
        outletId,
        `Coworking ${short()}`,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    ),
  );
  return facilityId;
}

async function seedProduct(
  world: Pick<World, "tenantId">,
  input: {
    outletId: string;
    facilityId: string;
    wfcKind: "day_pass" | "seat_reservation" | null;
    price: number;
    type?: "single" | "package";
  },
) {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, wfc_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true, $8)`,
      [
        id,
        world.tenantId,
        input.outletId,
        input.facilityId,
        `Produk WFC ${short()}`,
        input.type ?? "single",
        input.price,
        input.wfcKind,
      ],
    ),
  );
  return id;
}

/** One tenant: coworking facility + zone + seat/day-pass products + actor. */
async function setup() {
  const world = await createWorld();
  const facilityId = await seedCoworking(world, world.outletA);
  const zoneId = await seedZone(world, world.outletA);
  const reservationProductId = await seedProduct(world, {
    outletId: world.outletA,
    facilityId,
    wfcKind: "seat_reservation",
    price: PRICE,
  });
  const dayPassProductId = await seedProduct(world, {
    outletId: world.outletA,
    facilityId,
    wfcKind: "day_pass",
    price: DAY_PASS_PRICE,
  });
  const actor = await seedActor(world.tenantId);
  const customer = await seedProfile(world.tenantId);
  const ctx = world.context;

  const makeSeat = async (code = `S-${short()}`, zone = zoneId) =>
    idOf(
      await createWfcSeat(
        ctx,
        actor,
        { outletId: world.outletA, zoneId: zone, code },
        NOW,
      ),
    );
  const reserve = (
    seatId: string,
    over: Partial<{
      productId: string;
      customerProfileId: string;
      startsAt: string;
      endsAt: string;
      idempotencyKey: string;
    }> = {},
  ) =>
    reserveWfcSeat(
      ctx,
      actor,
      {
        seatId,
        productId: reservationProductId,
        customerProfileId: customer.id,
        startsAt: at(2),
        endsAt: at(4),
        idempotencyKey: `idem-${randomUUID()}`,
        ...over,
      },
      NOW,
    );
  const reserved = async (seatId?: string) =>
    idOf(await reserve(seatId ?? (await makeSeat())));
  const confirm = (reservationId: string, paidIdr = PRICE) =>
    confirmWfcReservationPaid(ctx, actor, { reservationId, paidIdr }, NOW);
  const paid = async () => {
    const reservationId = await reserved();
    await confirm(reservationId);
    return reservationId;
  };
  const refund = (reservationId: string, refundIdr: number) =>
    refundWfcReservation(ctx, actor, { reservationId, refundIdr }, NOW);
  const buyDayPass = (
    over: Partial<{
      productId: string;
      paidIdr: number;
      paymentRef: string;
    }> = {},
  ) =>
    purchaseDayPass(
      ctx,
      actor,
      {
        productId: dayPassProductId,
        customerProfileId: customer.id,
        paidIdr: DAY_PASS_PRICE,
        paymentRef: `pay-${randomUUID()}`,
        ...over,
      },
      NOW,
    );

  return {
    world,
    ctx,
    actor,
    facilityId,
    zoneId,
    reservationProductId,
    dayPassProductId,
    customer,
    makeSeat,
    reserve,
    reserved,
    confirm,
    paid,
    refund,
    buyDayPass,
  };
}

type ReservationRow = {
  status: string;
  price_idr: number;
  paid_idr: number;
  refunded_idr: number;
};

async function reservationRow(
  tenantId: string,
  reservationId: string,
): Promise<ReservationRow> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT status, price_idr::text, paid_idr::text, refunded_idr::text
         FROM wfc_seat_reservations WHERE id = $1`,
      [reservationId],
    );
    if (!rows[0]) throw new Error("reservation row not found");
    return {
      status: rows[0].status,
      price_idr: Number(rows[0].price_idr),
      paid_idr: Number(rows[0].paid_idr),
      refunded_idr: Number(rows[0].refunded_idr),
    };
  });
}

const countRows = (tenantId: string, table: string) =>
  asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  });

describe("F39 seats", () => {
  it("F39 an authorised actor creates a seat and lists it, filtered by zone", async () => {
    const s = await setup();
    const otherZone = await seedZone(s.world, s.world.outletA);
    const seatA = await s.makeSeat("A1");
    const seatB = await s.makeSeat("B1", otherZone);

    const all = listOf(await listWfcSeats(s.ctx, s.actor, {}, NOW)).map(
      (x) => x.id,
    );
    expect(all).toEqual(expect.arrayContaining([seatA, seatB]));

    const inZone = listOf(
      await listWfcSeats(s.ctx, s.actor, { zoneId: s.zoneId }, NOW),
    ).map((x) => x.id);
    expect(inZone).toEqual([seatA]);
  });

  it("F39 a new seat is active", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const status = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT status FROM wfc_seats WHERE id = $1",
        [seatId],
      );
      return rows[0].status;
    });
    expect(status).toBe("active");
  });

  it("F39 a duplicate seat code in the same zone is a 409; another zone may reuse it", async () => {
    const s = await setup();
    await s.makeSeat("DUP");
    expect((await failure(s.makeSeat("DUP"))).status).toBe(409);
    const otherZone = await seedZone(s.world, s.world.outletA);
    await expect(s.makeSeat("DUP", otherZone)).resolves.toEqual(
      expect.any(String),
    );
  });

  it("F39 a zone of another outlet is rejected and no seat is written", async () => {
    const s = await setup();
    const zoneB = await seedZone(s.world, s.world.outletB);
    const rejected = await failure(
      createWfcSeat(
        s.ctx,
        s.actor,
        { outletId: s.world.outletA, zoneId: zoneB, code: "X1" },
        NOW,
      ),
    );
    expect([400, 404, 409, 422]).toContain(rejected.status);
    expect(await countRows(s.world.tenantId, "wfc_seats")).toBe(0);
  });

  it("F39 an actor without the facility permission cannot create a seat", async () => {
    const s = await setup();
    const nobody = await seedActor(s.world.tenantId, []);
    const rejected = await failure(
      createWfcSeat(
        s.ctx,
        nobody,
        { outletId: s.world.outletA, zoneId: s.zoneId, code: "NOPE" },
        NOW,
      ),
    );
    expect(rejected.status).toBe(403);
    expect(await countRows(s.world.tenantId, "wfc_seats")).toBe(0);
  });

  it("F39 an actor without the facility permission cannot reserve", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const nobody = await seedActor(s.world.tenantId, []);
    const rejected = await failure(
      reserveWfcSeat(
        s.ctx,
        nobody,
        {
          seatId,
          productId: s.reservationProductId,
          customerProfileId: s.customer.id,
          startsAt: at(2),
          endsAt: at(3),
          idempotencyKey: `idem-${randomUUID()}`,
        },
        NOW,
      ),
    );
    expect(rejected.status).toBe(403);
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(0);
  });

  it("F39 empty state: a tenant without seats lists none", async () => {
    const s = await setup();
    expect(listOf(await listWfcSeats(s.ctx, s.actor, {}, NOW))).toEqual([]);
  });
});

describe("F39 seat reservation", () => {
  it("F39 reserving creates a pending_payment reservation priced from the product (M1)", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const reservationId = idOf(await s.reserve(seatId));
    expect(await reservationRow(s.world.tenantId, reservationId)).toEqual({
      status: "pending_payment",
      price_idr: PRICE,
      paid_idr: 0,
      refunded_idr: 0,
    });
  });

  it("M1 a client supplied price is ignored or rejected, never used", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const key = `idem-${randomUUID()}`;
    let reservationId: string | null = null;
    const rejected = await settle(
      (async () => {
        const result = await reserveWfcSeat(
          s.ctx,
          s.actor,
          {
            seatId,
            productId: s.reservationProductId,
            customerProfileId: s.customer.id,
            startsAt: at(2),
            endsAt: at(3),
            idempotencyKey: key,
            priceIdr: 1,
            amount: 1,
            paidIdr: 1,
          } as never,
          NOW,
        );
        reservationId = idOf(result);
      })(),
    );
    if (rejected) expect([400, 422]).toContain(rejected.status);
    else
      expect(
        (await reservationRow(s.world.tenantId, reservationId!)).price_idr,
      ).toBe(PRICE);
  });

  it("M1 the price is a snapshot: a later product price change does not alter the reservation", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE facility_products SET price_idr = 999999 WHERE id = $1",
        [s.reservationProductId],
      ),
    );
    await s.confirm(reservationId, PRICE);
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).price_idr,
    ).toBe(PRICE);
  });

  it("F39 the same idempotency key returns the same reservation, written once", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const idempotencyKey = `idem-${randomUUID()}`;
    const first = idOf(await s.reserve(seatId, { idempotencyKey }));
    const second = idOf(await s.reserve(seatId, { idempotencyKey }));
    expect(second).toBe(first);
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(1);
  });

  it("F39 a product that is not a seat reservation product is rejected", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    for (const productId of [s.dayPassProductId, randomUUID()]) {
      const rejected = await failure(s.reserve(seatId, { productId }));
      expect([400, 404, 409, 422]).toContain(rejected.status);
    }
    const plain = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 10_000,
    });
    expect([400, 404, 409, 422]).toContain(
      (await failure(s.reserve(seatId, { productId: plain }))).status,
    );
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(0);
  });

  it("F39 an inactive seat cannot be reserved", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    await asTenant(s.world.tenantId, (client) =>
      client.query("UPDATE wfc_seats SET status = 'inactive' WHERE id = $1", [
        seatId,
      ]),
    );
    const rejected = await failure(s.reserve(seatId));
    expect([400, 404, 409, 422]).toContain(rejected.status);
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(0);
  });

  it("F39 an unknown seat is rejected", async () => {
    const s = await setup();
    const rejected = await failure(s.reserve(randomUUID()));
    expect([400, 404, 422]).toContain(rejected.status);
  });

  it("F39 a slot that ends before or at its start is rejected", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    for (const [startsAt, endsAt] of [
      [at(3), at(2)],
      [at(2), at(2)],
    ] as const) {
      const rejected = await failure(s.reserve(seatId, { startsAt, endsAt }));
      expect([400, 409, 422]).toContain(rejected.status);
    }
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(0);
  });
});

describe("M5 a seat cannot be double-booked", () => {
  it("M5 an overlapping slot on the same seat is a 409", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    await s.reserve(seatId, { startsAt: at(2), endsAt: at(4) });
    for (const [startsAt, endsAt] of [
      [at(2), at(4)],
      [at(3), at(5)],
      [at(1), at(3)],
      [at(2.5), at(3)],
    ] as const) {
      const rejected = await failure(s.reserve(seatId, { startsAt, endsAt }));
      expect(rejected.status).toBe(409);
    }
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(1);
  });

  it("M5 back-to-back slots on the same seat are allowed", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    await s.reserve(seatId, { startsAt: at(2), endsAt: at(4) });
    await expect(
      s.reserve(seatId, { startsAt: at(4), endsAt: at(6) }),
    ).resolves.toBeTruthy();
    await expect(
      s.reserve(seatId, { startsAt: at(0.5), endsAt: at(2) }),
    ).resolves.toBeTruthy();
  });

  it("M5 the same time on another seat is allowed", async () => {
    const s = await setup();
    await s.reserve(await s.makeSeat());
    await expect(s.reserve(await s.makeSeat())).resolves.toBeTruthy();
  });

  it("M5 two concurrent bookings of one seat: exactly one wins", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const results = await Promise.allSettled([
      s.reserve(seatId),
      s.reserve(seatId),
      s.reserve(seatId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect(
        ((r as PromiseRejectedResult).reason as { status?: number }).status,
      ).toBe(409);
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(1);
  });

  it("M5 a cancelled reservation frees the seat for the same slot", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const first = idOf(await s.reserve(seatId));
    await cancelWfcReservation(s.ctx, s.actor, { reservationId: first }, NOW);
    expect((await reservationRow(s.world.tenantId, first)).status).toBe(
      "cancelled",
    );
    await expect(s.reserve(seatId)).resolves.toBeTruthy();
  });

  it("M5 the database itself refuses an overlapping active row (exclusion constraint)", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    const first = idOf(
      await s.reserve(seatId, { startsAt: at(2), endsAt: at(4) }),
    );
    const insert = (status: string, from: string, to: string) =>
      asTenant(s.world.tenantId, (client) =>
        client.query(
          `INSERT INTO wfc_seat_reservations
             (id, tenant_id, outlet_id, seat_id, product_id, customer_profile_id, slot, status, price_idr, paid_idr, refunded_idr)
           VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7::timestamptz, $8::timestamptz), $9, $10, 0, 0)`,
          [
            randomUUID(),
            s.world.tenantId,
            s.world.outletA,
            seatId,
            s.reservationProductId,
            s.customer.id,
            from,
            to,
            status,
            PRICE,
          ],
        ),
      );
    // 23P01 = exclusion_violation
    await expect(insert("confirmed", at(3), at(5))).rejects.toMatchObject({
      code: "23P01",
    });
    // Inactive statuses do not hold the seat.
    await expect(insert("cancelled", at(3), at(5))).resolves.toBeTruthy();
    expect(first).toBeTruthy();
  });
});

describe("M1 M2 paying and refunding a reservation", () => {
  it("M1 confirming needs the exact price: less or more is a 409 and nothing is recorded", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    for (const paidIdr of [PRICE - 1, PRICE + 1, 0, 1]) {
      expect((await failure(s.confirm(reservationId, paidIdr))).status).toBe(
        409,
      );
    }
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "pending_payment",
        paid_idr: 0,
      },
    );
  });

  it("F39 confirming with the exact price confirms the reservation and records the paid amount", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    await s.confirm(reservationId);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        paid_idr: PRICE,
        refunded_idr: 0,
      },
    );
  });

  it("M2 confirming twice never records the payment twice", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    await s.confirm(reservationId);
    await settle(s.confirm(reservationId));
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        paid_idr: PRICE,
      },
    );
  });

  it("M2 refunding an unpaid reservation is a 409 (nothing was paid)", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    expect((await failure(s.refund(reservationId, 1))).status).toBe(409);
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).refunded_idr,
    ).toBe(0);
  });

  it("M2 a refund above what was paid is a 409 and refunds nothing", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    expect((await failure(s.refund(reservationId, PRICE + 1))).status).toBe(
      409,
    );
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        refunded_idr: 0,
      },
    );
  });

  it("M2 a non-positive refund amount refunds nothing", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    for (const refundIdr of [0, -1000]) {
      const rejected = await failure(s.refund(reservationId, refundIdr));
      expect([400, 409, 422]).toContain(rejected.status);
    }
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).refunded_idr,
    ).toBe(0);
  });

  it("M2 partial refunds add up but can never exceed the paid amount", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    await s.refund(reservationId, 20_000);
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).refunded_idr,
    ).toBe(20_000);
    // 30.000 remains refundable; 30.001 is over the paid amount.
    expect((await failure(s.refund(reservationId, 30_001))).status).toBe(409);
    await s.refund(reservationId, 30_000);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "refunded",
        paid_idr: PRICE,
        refunded_idr: PRICE,
      },
    );
  });

  it("M2 a second full refund is a no-op or a 409 and never pays twice", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    await s.refund(reservationId, PRICE);
    const second = await settle(s.refund(reservationId, PRICE));
    if (second) expect(second.status).toBe(409);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "refunded",
        refunded_idr: PRICE,
      },
    );
  });

  it("M2 concurrent full refunds pay out once", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    await Promise.allSettled([
      s.refund(reservationId, PRICE),
      s.refund(reservationId, PRICE),
      s.refund(reservationId, PRICE),
    ]);
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).refunded_idr,
    ).toBe(PRICE);
  });

  it("F39 cancelling a pending reservation twice is safe", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    await cancelWfcReservation(s.ctx, s.actor, { reservationId }, NOW);
    await settle(cancelWfcReservation(s.ctx, s.actor, { reservationId }, NOW));
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "cancelled",
        paid_idr: 0,
      },
    );
  });
});

describe("M2 slot timing and refund permission of a reservation", () => {
  // The reservation of `setup()` runs at(2)..at(4).
  const started = inHours(2, NOW);

  it("M2 a reservation cannot be cancelled once its slot has started", async () => {
    const s = await setup();
    for (const now of [started, inHours(3, NOW), inHours(5, NOW)]) {
      const reservationId = await s.paid();
      const rejected = await failure(
        cancelWfcReservation(s.ctx, s.actor, { reservationId }, now),
      );
      expect(rejected.status).toBe(409);
      expect(
        (await reservationRow(s.world.tenantId, reservationId)).status,
      ).toBe("confirmed");
    }
    // Before the start it still works.
    const reservationId = await s.paid();
    await cancelWfcReservation(
      s.ctx,
      s.actor,
      { reservationId },
      new Date(started.getTime() - 1),
    );
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "cancelled",
    );
  });

  it("M2 a reservation cannot be refunded once its slot has started", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    for (const now of [started, inHours(3, NOW), inHours(5, NOW)]) {
      const rejected = await failure(
        refundWfcReservation(
          s.ctx,
          s.actor,
          { reservationId, refundIdr: PRICE },
          now,
        ),
      );
      expect(rejected.status).toBe(409);
    }
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        refunded_idr: 0,
      },
    );
  });

  it("M2 a no_show reservation is not refundable", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE wfc_seat_reservations SET status = 'no_show' WHERE id = $1",
        [reservationId],
      ),
    );
    const rejected = await failure(s.refund(reservationId, PRICE));
    expect(rejected.status).toBe(409);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "no_show",
        refunded_idr: 0,
      },
    );
  });

  it("M2 refunding a reservation needs the config permission, operate alone is a 403", async () => {
    const s = await setup();
    const reservationId = await s.paid();
    const operator = await seedActor(s.world.tenantId, [
      "facility.booth.operate",
    ]);
    const rejected = await failure(
      refundWfcReservation(
        s.ctx,
        operator,
        { reservationId, refundIdr: PRICE },
        NOW,
      ),
    );
    expect(rejected.status).toBe(403);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        refunded_idr: 0,
      },
    );
    // The operator still runs the booth: confirm and cancel stay allowed.
    const pending = await s.reserved();
    await confirmWfcReservationPaid(
      s.ctx,
      operator,
      { reservationId: pending, paidIdr: PRICE },
      NOW,
    );
    await cancelWfcReservation(
      s.ctx,
      operator,
      { reservationId: pending },
      NOW,
    );
    expect((await reservationRow(s.world.tenantId, pending)).status).toBe(
      "cancelled",
    );
  });
});

describe("F39 M1 M4 day pass", () => {
  it("F39 paying the exact price issues one 1-session entitlement expiring within the business day (M4)", async () => {
    const s = await setup();
    const purchase = await s.buyDayPass();
    const rows = await ledgerRows(s.world.tenantId, {
      customerProfileId: s.customer.id,
      facilityId: s.facilityId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "grant",
      sessions: 1,
      source_type: "purchase",
      // The purchase id, never the typed payment reference.
      source_ref: purchase.id,
      facility_id: s.facilityId,
      outlet_id: s.world.outletA,
    });
    const expiresAt = rows[0]!.expires_at!.getTime();
    expect(expiresAt).toBeGreaterThan(NOW.getTime());
    // NOW is 2026-11-08 10:00 Jakarta; the business day ends 04:00 next day.
    expect(expiresAt).toBeLessThanOrEqual(Date.parse("2026-11-08T21:00:00Z"));
    expect(expiresAt).toBeLessThanOrEqual(NOW.getTime() + 24 * HOUR);
  });

  it("M1 M4 a wrong paid amount is a 409 and issues nothing", async () => {
    const s = await setup();
    for (const paidIdr of [0, 1, DAY_PASS_PRICE - 1, DAY_PASS_PRICE + 1]) {
      expect((await failure(s.buyDayPass({ paidIdr }))).status).toBe(409);
    }
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("M1 a client supplied price in the purchase is not trusted", async () => {
    const s = await setup();
    const rejected = await settle(
      purchaseDayPass(
        s.ctx,
        s.actor,
        {
          productId: s.dayPassProductId,
          customerProfileId: s.customer.id,
          paidIdr: 1,
          priceIdr: 1,
          paymentRef: `pay-${randomUUID()}`,
        } as never,
        NOW,
      ),
    );
    expect(rejected).not.toBeNull();
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("F39 only a day_pass product can be bought as a day pass", async () => {
    const s = await setup();
    const rejected = await failure(
      s.buyDayPass({ productId: s.reservationProductId, paidIdr: PRICE }),
    );
    expect([400, 404, 409, 422]).toContain(rejected.status);
    const unknown = await failure(s.buyDayPass({ productId: randomUUID() }));
    expect([400, 404, 422]).toContain(unknown.status);
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("M4 buying again with the same paymentRef issues only one entitlement", async () => {
    const s = await setup();
    const paymentRef = `pay-${randomUUID()}`;
    await s.buyDayPass({ paymentRef });
    await settle(s.buyDayPass({ paymentRef }));
    const grants = (await ledgerRows(s.world.tenantId)).filter(
      (r) => r.type === "grant",
    );
    expect(grants).toHaveLength(1);
  });

  it("M2 M4 a refund revokes the unredeemed entitlement; refunding again changes nothing", async () => {
    const s = await setup();
    const paymentRef = `pay-${randomUUID()}`;
    await s.buyDayPass({ paymentRef });
    await refundDayPass(
      s.ctx,
      s.actor,
      { paymentRef, refundIdr: DAY_PASS_PRICE },
      NOW,
    );
    const afterFirst = await ledgerRows(s.world.tenantId);
    const sessionsNet = (rows: typeof afterFirst) =>
      rows.reduce(
        (sum, r) =>
          sum +
          (r.type === "grant"
            ? r.sessions
            : r.type === "cancel"
              ? -r.sessions
              : 0),
        0,
      );
    expect(afterFirst.some((r) => r.type === "cancel")).toBe(true);
    expect(sessionsNet(afterFirst)).toBe(0);

    const second = await settle(
      refundDayPass(
        s.ctx,
        s.actor,
        { paymentRef, refundIdr: DAY_PASS_PRICE },
        NOW,
      ),
    );
    if (second) expect(second.status).toBe(409);
    expect(sessionsNet(await ledgerRows(s.world.tenantId))).toBe(0);
  });

  it("M2 a day pass refund above the price paid is a 409 and keeps the entitlement", async () => {
    const s = await setup();
    const paymentRef = `pay-${randomUUID()}`;
    await s.buyDayPass({ paymentRef });
    const rejected = await failure(
      refundDayPass(
        s.ctx,
        s.actor,
        { paymentRef, refundIdr: DAY_PASS_PRICE + 1 },
        NOW,
      ),
    );
    expect(rejected.status).toBe(409);
    expect(
      (await ledgerRows(s.world.tenantId)).some((r) => r.type === "cancel"),
    ).toBe(false);
  });

  it("M2 refunding a payment that never happened is rejected", async () => {
    const s = await setup();
    const rejected = await failure(
      refundDayPass(
        s.ctx,
        s.actor,
        { paymentRef: `pay-${randomUUID()}`, refundIdr: DAY_PASS_PRICE },
        NOW,
      ),
    );
    expect([404, 409]).toContain(rejected.status);
  });
});

describe("M2 M4 day pass refund rules", () => {
  const dayPassRow = (tenantId: string, id: string) =>
    asTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT status, refunded_idr::text FROM wfc_day_pass_purchases WHERE id = $1",
        [id],
      );
      return {
        status: rows[0].status as string,
        refunded: Number(rows[0].refunded_idr),
      };
    });

  it("M4 a partial refund also revokes the pass", async () => {
    const s = await setup();
    const purchase = await s.buyDayPass();
    await refundDayPass(
      s.ctx,
      s.actor,
      { paymentRef: purchase.paymentRef, refundIdr: 10_000 },
      NOW,
    );
    const rows = await ledgerRows(s.world.tenantId);
    expect(rows.filter((r) => r.type === "cancel")).toHaveLength(1);
    expect(rows.find((r) => r.type === "cancel")!.source_ref).toBe(purchase.id);
    expect(await dayPassRow(s.world.tenantId, purchase.id)).toEqual({
      status: "paid",
      refunded: 10_000,
    });
  });

  it("M2 M4 a redeemed pass can never be refunded, not even partially", async () => {
    const s = await setup();
    const purchase = await s.buyDayPass();
    await entitlementsOf(s.world).redeem({
      facilityId: s.facilityId,
      customerProfileId: s.customer.id,
    });
    for (const refundIdr of [10_000, DAY_PASS_PRICE]) {
      const rejected = await failure(
        refundDayPass(
          s.ctx,
          s.actor,
          { paymentRef: purchase.paymentRef, refundIdr },
          NOW,
        ),
      );
      expect(rejected).toMatchObject({
        status: 409,
        code: "PASS_ALREADY_USED",
      });
    }
    expect(await dayPassRow(s.world.tenantId, purchase.id)).toEqual({
      status: "paid",
      refunded: 0,
    });
    expect(
      (await ledgerRows(s.world.tenantId)).some((r) => r.type === "cancel"),
    ).toBe(false);
  });

  it("M2 refunding a day pass needs the config permission, operate alone is a 403", async () => {
    const s = await setup();
    const purchase = await s.buyDayPass();
    const operator = await seedActor(s.world.tenantId, [
      "facility.booth.operate",
    ]);
    const rejected = await failure(
      refundDayPass(
        s.ctx,
        operator,
        { paymentRef: purchase.paymentRef, refundIdr: DAY_PASS_PRICE },
        NOW,
      ),
    );
    expect(rejected.status).toBe(403);
    expect(await dayPassRow(s.world.tenantId, purchase.id)).toEqual({
      status: "paid",
      refunded: 0,
    });
    expect(
      (await ledgerRows(s.world.tenantId)).some((r) => r.type === "cancel"),
    ).toBe(false);
  });
});

describe("TEN-01..03 tenant and outlet isolation", () => {
  it("TEN-01 another tenant sees no seats and cannot reserve, confirm or refund our rows", async () => {
    const a = await setup();
    const b = await setup();
    const seatId = await a.makeSeat();
    const reservationId = await a.paid();

    expect(listOf(await listWfcSeats(b.ctx, b.actor, {}, NOW))).toEqual([]);

    // B tries to use A's seat with B's own product and customer.
    expect(
      (await failure(b.reserve(seatId, { startsAt: at(10), endsAt: at(11) })))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(await countRows(b.world.tenantId, "wfc_seat_reservations")).toBe(0);
    expect(await countRows(a.world.tenantId, "wfc_seat_reservations")).toBe(1);

    // B cannot touch A's reservation.
    expect(
      (await failure(b.confirm(reservationId))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await failure(b.refund(reservationId, 1))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await failure(
          cancelWfcReservation(b.ctx, b.actor, { reservationId }, NOW),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await reservationRow(a.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        paid_idr: PRICE,
        refunded_idr: 0,
      },
    );
  });

  it("TEN-01 another tenant cannot buy a day pass with our product", async () => {
    const a = await setup();
    const b = await setup();
    const rejected = await failure(
      b.buyDayPass({ productId: a.dayPassProductId }),
    );
    expect([400, 404, 422]).toContain(rejected.status);
    expect(await ledgerRows(a.world.tenantId)).toHaveLength(0);
    expect(await ledgerRows(b.world.tenantId)).toHaveLength(0);
  });

  it("TEN-01 RLS hides wfc_seats and wfc_seat_reservations rows from another tenant", async () => {
    const a = await setup();
    const b = await setup();
    await a.paid();
    const count = (table: string, context: typeof b.ctx) =>
      withTenant(db, context, async (tx) => {
        const result = await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`,
        );
        return (result.rows[0] as { n: number }).n;
      });
    expect(await count("wfc_seats", a.ctx)).toBe(1);
    expect(await count("wfc_seat_reservations", a.ctx)).toBe(1);
    expect(await count("wfc_seats", b.ctx)).toBe(0);
    expect(await count("wfc_seat_reservations", b.ctx)).toBe(0);
  });

  it("TEN-03 a context limited to another outlet sees none of outlet A's seats or reservations", async () => {
    const a = await setup();
    await a.paid();
    const outletB = outletContext(a.world.tenantId, a.world.outletB);
    const outletA = outletContext(a.world.tenantId, a.world.outletA);
    const count = (table: string, context: typeof outletA) =>
      withTenant(db, context, async (tx) => {
        const result = await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`,
        );
        return (result.rows[0] as { n: number }).n;
      });
    expect(await count("wfc_seats", outletA)).toBe(1);
    expect(await count("wfc_seats", outletB)).toBe(0);
    expect(await count("wfc_seat_reservations", outletB)).toBe(0);
    expect(listOf(await listWfcSeats(outletB, a.actor, {}, NOW)).length).toBe(
      0,
    );
  });
});
