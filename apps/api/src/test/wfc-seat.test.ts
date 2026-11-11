// legend-bz9h Area A (F39/F25, FAC-14): WFC seats, seat reservations and day
// pass against PostgreSQL with the restricted app role (RLS enforced).
// Written from the bz9h spec, never from the implementation.
//
// Money rules covered (jangan sampai rugi):
//   M1 price is read server-side (client price/amount never trusted); a sale
//      needs a real captured POS tender (round 3: payment_intents prove nothing)
//      on an order with a live line for the product's menu item, and one
//      capture funds ONE sale across reservations, day passes and bundles
//   M2 refund <= amount actually paid, never pays twice
//   M4 entitlement only after paid, revoked on refund, idempotent per purchase
//   M5 a seat cannot be double-booked (exclusion constraint)
// plus tenant and outlet isolation (TEN-01..03).
//
// Assumptions (the spec leaves them open):
// - Service inputs carry ISO-8601 strings for instants (`startsAt`, `endsAt`).
// - `createWfcSeat` input is `{ outletId, zoneId, code }`; results expose `.id`.
//   `listWfcSeats` resolves to an array (or an object with `items`).
// - Round 2 (CTO decisions): `confirmWfcReservationPaid({ reservationId,
//   paymentRef })`, `purchaseDayPass({ productId, customerProfileId,
//   paymentRef })`; no `paidIdr` (strict schema rejects it). Round 3 (spec3):
//   the payment is a seeded `pos_order_tenders` row (status 'captured') of the
//   sale's tenant and outlet on a POS order (orders + pos_orders, not training)
//   with a non-voided order item for the product's `menu_item_id`, referenced
//   by tender id or reference (case-insensitive). A paid `payment_intents` row
//   is never accepted. paid_idr stores the product price, never the (possibly
//   larger) captured amount.
// - Ledger `wfc_payment_captures` (capture_key = lowercase tender id, sale_kind,
//   sale_id) gets one row per sale. One order line funds at most `quantity`
//   sales (H1): a further sale is 409 PAYMENT_ALREADY_USED.
// - A product without `menu_item_id` can never be sold: 409 PAYMENT_NOT_CAPTURED
//   at confirm / purchase (a reservation of it may already be refused when it is
//   reserved; both are accepted).
// - Failures are `HttpError`s: 409 for a conflict (uncaptured payment, refund
//   over the paid amount, double booking, duplicate seat code), 403 without the
//   facility permission, 400/404/409/422 for other invalid input.
// - A second refund / confirm of the same reservation either resolves as a
//   no-op or is rejected with 409. Both are fine; paying twice is not.
// - A repeated day pass purchase with the same paymentRef (same product and
//   customer) resolves with the FIRST sale (same id), not a 409.
// - `reserveWfcSeat` rejects a slot longer than `facility_products
//   .duration_minutes` with 409 DURATION_EXCEEDS_PRODUCT; a product without a
//   duration cannot be reserved (status 400/404/409/422, code not asserted).
//   `setWfcProductKind({ productId, wfcKind, durationMinutes })` rejects a
//   seat_reservation without a duration in 1..1440 (400/409/422).
// - The day pass refund entry point is `refundDayPass({ paymentRef,
//   refundIdr })` (the spec names no function for it).
// - "end of the outlet-local business day" is somewhere after NOW and no later
//   than the next 04:00 cutoff (Jakarta), i.e. <= 2026-11-08T21:00:00Z.
// - Seeding uses raw SQL as the owner; the column names of wfc_seats and
//   wfc_seat_reservations are the ones the spec lists.
import { randomBytes, randomUUID } from "node:crypto";
import { ulidToUuid } from "@starter/shared/core";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createWfcBundle,
  purchaseWfcBundle,
} from "../services/wfc-bundle.service.ts";
import {
  cancelWfcReservation,
  confirmWfcReservationPaid,
  createWfcSeat,
  listWfcSeats,
  purchaseDayPass,
  refundDayPass,
  refundWfcReservation,
  reserveWfcSeat,
  setWfcProductKind,
} from "../services/wfc-seat.service.ts";
import {
  DATE,
  NOW,
  asTenant,
  createWorld,
  markTraining,
  owner,
  seedOrder,
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
  seedMenuItems,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

/** Fixture order-line unit price: above every WFC price, so a line never undercuts the sale. */
const LINE_UNIT_IDR = 1_000_000;

const PRICE = 50_000;
const DAY_PASS_PRICE = 75_000;
/** Default longest reservation of the seat product (the setup slots are <= 2h). */
const SEAT_DURATION = 120;

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

type CaptureSeed = {
  tenantId: string;
  outletId: string;
  amountIdr: number;
  status?: "captured" | "authorized";
  /** Menu items on the order; default: every menu item of the tenant's facility products. */
  menuItemIds?: string[];
  /** Quantity of each order line (default 1). */
  quantity?: number;
  /** Put the tender on this existing order (split tender): no new lines are seeded. */
  orderUlid?: string;
  /** Void every seeded line. */
  voidItems?: boolean;
  /** Stamp the POS order as a training sale. */
  training?: boolean;
};

/** A captured POS tender on a POS order with lines for the products' menu items. */
async function seedCapture(seed: CaptureSeed) {
  let orderUlid = seed.orderUlid;
  if (!orderUlid) {
    orderUlid = await seedOrder(seed.tenantId, {
      outletId: seed.outletId,
      profileId: null,
    });
    const menuItemIds =
      seed.menuItemIds ??
      (await asTenant(seed.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT DISTINCT menu_item_id FROM facility_products
            WHERE tenant_id = $1 AND menu_item_id IS NOT NULL`,
          [seed.tenantId],
        );
        return rows.map((row) => row.menu_item_id as string);
      }));
    const quantity = seed.quantity ?? 1;
    await asTenant(seed.tenantId, async (client) => {
      for (const menuItemId of menuItemIds) {
        const itemId = randomUUID();
        // A voided line is inserted as voided: the POS-04 trigger forbids
        // changing the lines of a final (completed) order afterwards.
        await client.query(
          `INSERT INTO order_items
             (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
              unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
              reserved_business_date)
           VALUES ($1, $2, $3, $4, $5, 'Menu uji', $6, 1000000, 0, $7, 'fired', $9, $8)`,
          [
            itemId,
            seed.tenantId,
            seed.outletId,
            ulidToUuid(orderUlid!),
            menuItemId,
            quantity,
            LINE_UNIT_IDR * quantity,
            DATE,
            seed.voidItems ? "voided" : "served",
          ],
        );
      }
    });
  }
  const reference = `tnd-${randomUUID().slice(0, 30)}`;
  const id = await asTenant(seed.tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, reference)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, $5::text, now(), CASE WHEN $5::text = 'authorized' THEN NULL ELSE now() END, $6)
       RETURNING id`,
      [
        seed.tenantId,
        seed.outletId,
        ulidToUuid(orderUlid!),
        seed.amountIdr,
        seed.status ?? "captured",
        reference,
      ],
    );
    return rows[0].id as string;
  });
  if (seed.training) await markTraining(seed.tenantId, orderUlid);
  return { id, ref: reference, orderUlid };
}

/**
 * A paid gateway intent with no link column set. Round 3: it proves nothing, a
 * sale funded by it is always 409 PAYMENT_NOT_CAPTURED.
 */
async function seedIntent(seed: {
  tenantId: string;
  outletId: string;
  amountIdr: number;
}) {
  const id = randomUUID();
  const linkId = randomUUID();
  const ref = `cap-${randomUUID().slice(0, 30)}`;
  await asTenant(seed.tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'wfc-seat-test')`,
      [
        linkId,
        seed.tenantId,
        seed.outletId,
        randomBytes(32).toString("hex"),
        `WS-${linkId.slice(0, 8)}`,
        seed.amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, paid_at, instructions, expires_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
               '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour', $7)`,
      [
        id,
        seed.tenantId,
        seed.outletId,
        linkId,
        seed.amountIdr,
        `ws-${id}`,
        ref,
      ],
    );
  });
  return { id, ref };
}

async function seedProduct(
  world: Pick<World, "tenantId" | "brandId">,
  input: {
    outletId: string;
    facilityId: string;
    wfcKind: "day_pass" | "seat_reservation" | null;
    price: number;
    type?: "single" | "package";
    /** Longest reservation in minutes; defaults to 120 for seat products. */
    durationMinutes?: number | null;
    /**
     * The menu item that sells the product at the POS. Default: a new one for
     * a wfc product (day pass / seat reservation); `null`: none.
     */
    menuItemId?: string | null;
  },
) {
  const id = randomUUID();
  const menuItemId =
    input.menuItemId !== undefined
      ? input.menuItemId
      : input.wfcKind
        ? (await seedMenuItems(world, 1))[0]!
        : null;
  const durationMinutes =
    input.durationMinutes !== undefined
      ? input.durationMinutes
      : input.wfcKind === "seat_reservation"
        ? SEAT_DURATION
        : null;
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, wfc_kind, duration_minutes, menu_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true, $8, $9, $10)`,
      [
        id,
        world.tenantId,
        input.outletId,
        input.facilityId,
        `Produk WFC ${short()}`,
        input.type ?? "single",
        input.price,
        input.wfcKind,
        durationMinutes,
        menuItemId,
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
  /** Seeds a captured POS tender of this tenant (outlet A); returns it. */
  const tender = (
    amountIdr: number,
    over: Partial<Omit<CaptureSeed, "tenantId" | "amountIdr">> = {},
  ) =>
    seedCapture({
      tenantId: world.tenantId,
      outletId: world.outletA,
      amountIdr,
      ...over,
    });
  /** Same, returning the tender reference to use as `paymentRef`. */
  const capture = async (
    amountIdr: number,
    over: Partial<Omit<CaptureSeed, "tenantId" | "amountIdr">> = {},
  ) => (await tender(amountIdr, over)).ref;
  /** Confirms with `paymentRef`, or with a fresh capture of exactly the price. */
  const confirm = async (reservationId: string, paymentRef?: string) =>
    confirmWfcReservationPaid(
      ctx,
      actor,
      { reservationId, paymentRef: paymentRef ?? (await capture(PRICE)) },
      NOW,
    );
  const paid = async () => {
    const reservationId = await reserved();
    await confirm(reservationId);
    return reservationId;
  };
  const refund = (reservationId: string, refundIdr: number) =>
    refundWfcReservation(ctx, actor, { reservationId, refundIdr }, NOW);
  /**
   * Buys a day pass. Without `paymentRef` a fresh capture of exactly the price
   * is seeded; a given `paymentRef` is used as is (seed it with `capture`).
   */
  const buyDayPass = async (
    over: Partial<{
      productId: string;
      customerProfileId: string;
      paymentRef: string;
    }> = {},
  ) =>
    purchaseDayPass(
      ctx,
      actor,
      {
        productId: dayPassProductId,
        customerProfileId: customer.id,
        ...over,
        paymentRef: over.paymentRef ?? (await capture(DAY_PASS_PRICE)),
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
    tender,
    capture,
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

  it("F39 the database ties a seat's zone to the seat's outlet (composite FK on tenant, outlet, zone)", async () => {
    const s = await setup();
    // Item 5 of round 2: the FK is added only when floor_zones already has a
    // unique (tenant_id, outlet_id, id); otherwise the service check above is
    // the guard and this test has nothing to assert.
    const hasUnique = await owner.query(
      `SELECT 1 FROM pg_indexes
        WHERE tablename = 'floor_zones' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
          AND indexdef LIKE '%(tenant_id, outlet_id, id)%'`,
    );
    if (hasUnique.rowCount === 0) return;
    const zoneB = await seedZone(s.world, s.world.outletB);
    // 23503 = foreign_key_violation
    await expect(
      asTenant(s.world.tenantId, (client) =>
        client.query(
          `INSERT INTO wfc_seats (id, tenant_id, outlet_id, zone_id, code, status)
           VALUES ($1, $2, $3, $4, 'FK1', 'active')`,
          [randomUUID(), s.world.tenantId, s.world.outletA, zoneB],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
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
    await s.confirm(reservationId);
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

describe("F39 reservation duration (facility_products.duration_minutes)", () => {
  /** A slot of `minutes` starting at 2 hours from NOW. */
  const slot = (minutes: number) => ({
    startsAt: at(2),
    endsAt: at(2 + minutes / 60),
  });

  it("F39 a slot up to the product duration is accepted, one minute more is 409 DURATION_EXCEEDS_PRODUCT", async () => {
    const s = await setup();
    const seatId = await s.makeSeat();
    expect(
      await failure(s.reserve(seatId, slot(SEAT_DURATION + 1))),
    ).toMatchObject({ status: 409, code: "DURATION_EXCEEDS_PRODUCT" });
    expect(await countRows(s.world.tenantId, "wfc_seat_reservations")).toBe(0);
    await expect(s.reserve(seatId, slot(SEAT_DURATION))).resolves.toBeTruthy();
    await expect(s.reserve(await s.makeSeat(), slot(30))).resolves.toBeTruthy();
  });

  it("F39 the limit is the duration of the chosen product, not a global one", async () => {
    const s = await setup();
    const short60 = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: "seat_reservation",
      price: 20_000,
      durationMinutes: 60,
    });
    const seatId = await s.makeSeat();
    expect(
      (await failure(s.reserve(seatId, { productId: short60, ...slot(61) })))
        .code,
    ).toBe("DURATION_EXCEEDS_PRODUCT");
    await expect(
      s.reserve(seatId, { productId: short60, ...slot(60) }),
    ).resolves.toBeTruthy();
  });

  it("F39 the database refuses a seat_reservation product without a duration (check constraint)", async () => {
    const s = await setup();
    // 23514 = check_violation
    await expect(
      seedProduct(s.world, {
        outletId: s.world.outletA,
        facilityId: s.facilityId,
        wfcKind: "seat_reservation",
        price: 20_000,
        durationMinutes: null,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE facility_products SET duration_minutes = NULL WHERE id = $1",
          [s.reservationProductId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const plain = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 20_000,
    });
    await expect(
      asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE facility_products SET wfc_kind = 'seat_reservation' WHERE id = $1",
          [plain],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Only the seat kind needs a duration: a day pass or plain product without one is fine.
    await expect(
      seedProduct(s.world, {
        outletId: s.world.outletA,
        facilityId: s.facilityId,
        wfcKind: "day_pass",
        price: 20_000,
        durationMinutes: null,
      }),
    ).resolves.toEqual(expect.any(String));
    // The stored duration is untouched by the refused statements.
    const kept = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT duration_minutes FROM facility_products WHERE id = $1",
        [s.reservationProductId],
      );
      return rows[0].duration_minutes as number;
    });
    expect(kept).toBe(SEAT_DURATION);
  });

  it("F39 setWfcProductKind stores the duration of a seat_reservation product", async () => {
    const s = await setup();
    const plain = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 30_000,
    });
    await setWfcProductKind(
      s.ctx,
      s.actor,
      { productId: plain, wfcKind: "seat_reservation", durationMinutes: 90 },
      NOW,
    );
    const row = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT wfc_kind, duration_minutes FROM facility_products WHERE id = $1",
        [plain],
      );
      return rows[0] as { wfc_kind: string; duration_minutes: number };
    });
    expect(row).toEqual({ wfc_kind: "seat_reservation", duration_minutes: 90 });
    // The new product can be reserved up to its duration and not beyond.
    const seatId = await s.makeSeat();
    expect(
      (await failure(s.reserve(seatId, { productId: plain, ...slot(91) })))
        .code,
    ).toBe("DURATION_EXCEEDS_PRODUCT");
    await expect(
      s.reserve(seatId, { productId: plain, ...slot(90) }),
    ).resolves.toBeTruthy();
  });

  it("F39 setWfcProductKind rejects a seat_reservation without a duration in 1..1440 and changes nothing", async () => {
    const s = await setup();
    const plain = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 30_000,
    });
    for (const durationMinutes of [undefined, 0, -30, 1441]) {
      const rejected = await failure(
        setWfcProductKind(
          s.ctx,
          s.actor,
          {
            productId: plain,
            wfcKind: "seat_reservation",
            durationMinutes,
          } as never,
          NOW,
        ),
      );
      expect([400, 409, 422], String(durationMinutes)).toContain(
        rejected.status,
      );
    }
    const kind = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT wfc_kind FROM facility_products WHERE id = $1",
        [plain],
      );
      return rows[0].wfc_kind as string | null;
    });
    expect(kind).toBeNull();
  });

  it("F39 the database refuses a duration outside 1..1440 minutes (check constraint)", async () => {
    const s = await setup();
    const setDuration = (minutes: number) =>
      asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE facility_products SET duration_minutes = $2 WHERE id = $1",
          [s.reservationProductId, minutes],
        ),
      );
    // 23514 = check_violation
    for (const minutes of [0, -1, 1441])
      await expect(setDuration(minutes)).rejects.toMatchObject({
        code: "23514",
      });
    await expect(setDuration(1440)).resolves.toBeTruthy();
    await expect(setDuration(1)).resolves.toBeTruthy();
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
  it("M1 confirming needs a real captured payment: anything else is 409 PAYMENT_NOT_CAPTURED and nothing is recorded", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const other = await setup();
    const refs = [
      `pay-${randomUUID()}`, // no such payment
      "not-a-uuid",
      await s.capture(PRICE, { status: "authorized" }), // not captured yet
      await s.capture(PRICE - 1), // below the price
      (
        await seedCapture({
          tenantId: s.world.tenantId,
          outletId: s.world.outletB, // another outlet
          amountIdr: PRICE,
        })
      ).ref,
      await other.capture(PRICE), // another tenant's capture
    ];
    for (const paymentRef of refs) {
      expect(
        await failure(s.confirm(reservationId, paymentRef)),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    }
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "pending_payment",
        paid_idr: 0,
      },
    );
  });

  it("M1 a paid payment_intents row, even an unlinked one, never confirms a reservation", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const intent = await seedIntent({
      tenantId: s.world.tenantId,
      outletId: s.world.outletA,
      amountIdr: PRICE * 3,
    });
    for (const paymentRef of [intent.ref, intent.id])
      expect(
        await failure(s.confirm(reservationId, paymentRef)),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "pending_payment",
    );
    expect(await countRows(s.world.tenantId, "wfc_payment_captures")).toBe(0);
  });

  it("M1 a tender of a food order (no line for the product's menu item) cannot confirm a reservation", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const [foodItem] = await seedMenuItems(s.world, 1);
    const food = await s.tender(PRICE, { menuItemIds: [foodItem!] });
    expect(await failure(s.confirm(reservationId, food.ref))).toMatchObject({
      status: 409,
      code: "PAYMENT_NOT_CAPTURED",
    });
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "pending_payment",
    );
  });

  it("M1 a tender whose line is voided, or whose order is a training sale, cannot confirm a reservation", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const voided = await s.capture(PRICE, { voidItems: true });
    const training = await s.capture(PRICE, { training: true });
    for (const paymentRef of [voided, training])
      expect(
        await failure(s.confirm(reservationId, paymentRef)),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "pending_payment",
    );
    expect(await countRows(s.world.tenantId, "wfc_payment_captures")).toBe(0);
  });

  it("M1 a seat product without a menu_item_id can never be sold: 409 PAYMENT_NOT_CAPTURED", async () => {
    const s = await setup();
    const noMenu = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: "seat_reservation",
      price: PRICE,
      menuItemId: null,
    });
    let reservationId: string | null = null;
    const early = await settle(
      (async () => {
        reservationId = idOf(
          await s.reserve(await s.makeSeat(), { productId: noMenu }),
        );
      })(),
    );
    if (early) {
      // Refusing the reservation up front is as good as refusing the sale.
      expect([400, 404, 409, 422]).toContain(early.status);
    } else {
      expect(
        await failure(s.confirm(reservationId!, await s.capture(PRICE * 2))),
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
      expect(
        (await reservationRow(s.world.tenantId, reservationId!)).status,
      ).toBe("pending_payment");
    }
    expect(await countRows(s.world.tenantId, "wfc_payment_captures")).toBe(0);
  });

  it("M1 the client never types the paid amount: paidIdr is rejected and a missing paymentRef too", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const paymentRef = await s.capture(PRICE);
    const withAmount = await failure(
      confirmWfcReservationPaid(
        s.ctx,
        s.actor,
        { reservationId, paymentRef, paidIdr: PRICE } as never,
        NOW,
      ),
    );
    expect([400, 422]).toContain(withAmount.status);
    const withoutRef = await failure(
      confirmWfcReservationPaid(
        s.ctx,
        s.actor,
        { reservationId } as never,
        NOW,
      ),
    );
    expect([400, 422]).toContain(withoutRef.status);
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "pending_payment",
    );
  });

  it("F39 confirming with a captured payment confirms the reservation and records the price as paid", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const paymentRef = await s.capture(PRICE);
    await s.confirm(reservationId, paymentRef);
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        paid_idr: PRICE,
        refunded_idr: 0,
      },
    );
    // The capture is remembered on the reservation (one capture funds one sale).
    const stored = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT payment_ref FROM wfc_seat_reservations WHERE id = $1",
        [reservationId],
      );
      return rows[0].payment_ref as string | null;
    });
    expect(stored).toBe(paymentRef);
  });

  it("F39 the tender id (uuid) also works as the payment reference", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const tender = await s.tender(PRICE);
    await s.confirm(reservationId, tender.id);
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "confirmed",
    );
  });

  it("M1 M2 an overpaying capture confirms for the price only; WFC refunds never exceed the price", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    await s.confirm(reservationId, await s.capture(PRICE * 3));
    expect(await reservationRow(s.world.tenantId, reservationId)).toMatchObject(
      {
        status: "confirmed",
        price_idr: PRICE,
        paid_idr: PRICE,
      },
    );
    expect((await failure(s.refund(reservationId, PRICE + 1))).status).toBe(
      409,
    );
    await s.refund(reservationId, PRICE);
    expect(
      (await reservationRow(s.world.tenantId, reservationId)).refunded_idr,
    ).toBe(PRICE);
  });

  it("M1 one capture funds one sale: a second reservation with the same payment is 409 PAYMENT_ALREADY_USED", async () => {
    const s = await setup();
    const first = await s.reserved();
    const second = await s.reserved();
    // A big capture must not be split over several sales either.
    const paymentRef = await s.capture(PRICE * 5);
    await s.confirm(first, paymentRef);
    expect(await failure(s.confirm(second, paymentRef))).toMatchObject({
      status: 409,
      code: "PAYMENT_ALREADY_USED",
    });
    expect((await reservationRow(s.world.tenantId, first)).status).toBe(
      "confirmed",
    );
    expect(await reservationRow(s.world.tenantId, second)).toMatchObject({
      status: "pending_payment",
      paid_idr: 0,
    });
  });

  it("M1 two concurrent confirms of different reservations with one capture: exactly one wins", async () => {
    const s = await setup();
    const ids = [await s.reserved(), await s.reserved(), await s.reserved()];
    const paymentRef = await s.capture(PRICE * 5);
    const results = await Promise.allSettled(
      ids.map((id) => s.confirm(id, paymentRef)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect(
        ((r as PromiseRejectedResult).reason as { status?: number }).status,
      ).toBe(409);
    const rows = await Promise.all(
      ids.map((id) => reservationRow(s.world.tenantId, id)),
    );
    expect(rows.filter((r) => r.status === "confirmed")).toHaveLength(1);
  });

  it("M1 a capture used by a day pass cannot confirm a reservation, and the other way round (PAYMENT_ALREADY_USED)", async () => {
    const s = await setup();
    // Both captures are big enough for either sale, so only the reuse can stop it.
    const passRef = await s.capture(DAY_PASS_PRICE + PRICE);
    await s.buyDayPass({ paymentRef: passRef });
    const reservationId = await s.reserved();
    expect(await failure(s.confirm(reservationId, passRef))).toMatchObject({
      status: 409,
      code: "PAYMENT_ALREADY_USED",
    });

    const seatRef = await s.capture(DAY_PASS_PRICE + PRICE);
    await s.confirm(reservationId, seatRef);
    expect(await failure(s.buyDayPass({ paymentRef: seatRef }))).toMatchObject({
      status: 409,
      code: "PAYMENT_ALREADY_USED",
    });
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
  });

  it("M2 confirming twice never records the payment twice", async () => {
    const s = await setup();
    const reservationId = await s.reserved();
    const paymentRef = await s.capture(PRICE);
    await s.confirm(reservationId, paymentRef);
    await settle(s.confirm(reservationId, paymentRef));
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

describe("M1 one capture, one sale (wfc_payment_captures ledger)", () => {
  const captureRows = (tenantId: string) =>
    asTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT capture_key, sale_kind FROM wfc_payment_captures WHERE tenant_id = $1",
        [tenantId],
      );
      return rows as { capture_key: string; sale_kind: string }[];
    });

  it("M1 every sale writes one capture row keyed by the lowercase tender id", async () => {
    const s = await setup();
    const seat = await s.tender(PRICE);
    await s.confirm(await s.reserved(), seat.ref);
    const pass = await s.tender(DAY_PASS_PRICE);
    await s.buyDayPass({ paymentRef: pass.id });
    const rows = await captureRows(s.world.tenantId);
    expect(rows.map((r) => r.capture_key).sort()).toEqual(
      [seat.id.toLowerCase(), pass.id.toLowerCase()].sort(),
    );
    expect(rows.map((r) => r.sale_kind).sort()).toEqual([
      "day_pass",
      "seat_reservation",
    ]);
  });

  it("M1 upper and lower case spellings of one reference are ONE capture: a day pass replays, never a second sale", async () => {
    const s = await setup();
    const t = await s.tender(DAY_PASS_PRICE * 5);
    const first = await s.buyDayPass({ paymentRef: t.ref });
    // Same product and customer: the replay returns the first sale.
    const again = await s.buyDayPass({ paymentRef: t.ref.toUpperCase() });
    expect(again.id).toBe(first.id);
    const byId = await s.buyDayPass({ paymentRef: t.id.toUpperCase() });
    expect(byId.id).toBe(first.id);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("M1 case or spelling (tender id, reference, UPPERCASE) never lets one tender fund a second sale of another kind", async () => {
    const s = await setup();
    const t = await s.tender(DAY_PASS_PRICE + PRICE);
    await s.buyDayPass({ paymentRef: t.ref });
    for (const alias of [t.ref.toUpperCase(), t.id, t.id.toUpperCase(), t.ref])
      expect(
        await failure(s.confirm(await s.reserved(), alias)),
        alias,
      ).toMatchObject({ status: 409, code: "PAYMENT_ALREADY_USED" });
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("M1 a reservation confirmed with the lowercase reference cannot be funded again with the uppercase one", async () => {
    const s = await setup();
    const t = await s.tender(PRICE * 5);
    await s.confirm(await s.reserved(), t.ref);
    const second = await s.reserved();
    expect(await failure(s.confirm(second, t.ref.toUpperCase()))).toMatchObject(
      { status: 409, code: "PAYMENT_ALREADY_USED" },
    );
    expect((await reservationRow(s.world.tenantId, second)).status).toBe(
      "pending_payment",
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("M1 a tender that funded a reservation cannot also fund a bundle (PAYMENT_ALREADY_USED)", async () => {
    const s = await setup();
    const [bundleItem] = await seedMenuItems(s.world, 1);
    const partA = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 20_000,
    });
    const partB = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: null,
      price: 30_000,
    });
    // list total 50.000, floor 25.000: 40.000 is a valid bundle price.
    const bundle = await createWfcBundle(
      s.ctx,
      s.actor,
      {
        name: "Paket uji",
        priceIdr: 40_000 as never,
        items: [
          { facilityId: s.facilityId, productId: partA, quantity: 1 },
          { facilityId: s.facilityId, productId: partB, quantity: 1 },
        ],
        idempotencyKey: `idem-${randomUUID()}`,
        menuItemId: bundleItem!,
      } as never,
      NOW,
    );
    // The order sells both the seat and the bundle, and the tender covers either.
    const t = await s.tender(PRICE + 40_000, {
      menuItemIds: [
        await asTenant(s.world.tenantId, async (client) => {
          const { rows } = await client.query(
            "SELECT menu_item_id FROM facility_products WHERE id = $1",
            [s.reservationProductId],
          );
          return rows[0].menu_item_id as string;
        }),
        bundleItem!,
      ],
    });
    const reservationId = await s.reserved();
    await s.confirm(reservationId, t.ref);
    expect(
      await failure(
        purchaseWfcBundle(
          s.ctx,
          s.actor,
          {
            bundleId: bundle.id,
            customerProfileId: s.customer.id,
            paymentRef: t.id.toUpperCase(),
          },
          NOW,
        ),
      ),
    ).toMatchObject({ status: 409, code: "PAYMENT_ALREADY_USED" });
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
    expect((await reservationRow(s.world.tenantId, reservationId)).status).toBe(
      "confirmed",
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("M1 H1 two split tenders on one quantity-1 line fund ONE sale: the second is 409 PAYMENT_ALREADY_USED", async () => {
    const s = await setup();
    const first = await s.tender(PRICE);
    // A second tender (e.g. a split bill) on the SAME order and line.
    const second = await s.tender(PRICE, { orderUlid: first.orderUlid });
    const r1 = await s.reserved();
    const r2 = await s.reserved();
    await s.confirm(r1, first.ref);
    expect(await failure(s.confirm(r2, second.ref))).toMatchObject({
      status: 409,
      code: "PAYMENT_ALREADY_USED",
    });
    expect((await reservationRow(s.world.tenantId, r1)).status).toBe(
      "confirmed",
    );
    expect(await reservationRow(s.world.tenantId, r2)).toMatchObject({
      status: "pending_payment",
      paid_idr: 0,
    });
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("M1 H1 an order line of quantity 2 funds two sales, never a third", async () => {
    const s = await setup();
    const first = await s.tender(PRICE, { quantity: 2 });
    const second = await s.tender(PRICE, { orderUlid: first.orderUlid });
    const third = await s.tender(PRICE, { orderUlid: first.orderUlid });
    const [r1, r2, r3] = [
      await s.reserved(),
      await s.reserved(),
      await s.reserved(),
    ];
    await s.confirm(r1, first.ref);
    await s.confirm(r2, second.ref);
    expect(await failure(s.confirm(r3, third.ref))).toMatchObject({
      status: 409,
      code: "PAYMENT_ALREADY_USED",
    });
    expect((await reservationRow(s.world.tenantId, r3)).status).toBe(
      "pending_payment",
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(2);
  });

  it("M1 H1 a quantity-1 line of the day pass menu item funds one pass, even over two tenders", async () => {
    const s = await setup();
    const first = await s.tender(DAY_PASS_PRICE);
    const second = await s.tender(DAY_PASS_PRICE, {
      orderUlid: first.orderUlid,
    });
    await s.buyDayPass({ paymentRef: first.ref });
    const otherCustomer = await seedProfile(s.world.tenantId);
    expect(
      await failure(
        s.buyDayPass({
          paymentRef: second.ref,
          customerProfileId: otherCustomer.id,
        }),
      ),
    ).toMatchObject({ status: 409, code: "PAYMENT_ALREADY_USED" });
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
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
      { reservationId: pending, paymentRef: await s.capture(PRICE) },
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

  it("M1 M4 a day pass needs a real captured payment: anything else is 409 PAYMENT_NOT_CAPTURED and issues nothing", async () => {
    const s = await setup();
    const other = await setup();
    const refs = [
      `pay-${randomUUID()}`,
      "not-a-uuid",
      await s.capture(DAY_PASS_PRICE, { status: "authorized" }),
      await s.capture(DAY_PASS_PRICE - 1),
      (
        await seedCapture({
          tenantId: s.world.tenantId,
          outletId: s.world.outletB,
          amountIdr: DAY_PASS_PRICE,
        })
      ).ref,
      await other.capture(DAY_PASS_PRICE),
    ];
    for (const paymentRef of refs)
      expect(
        await failure(s.buyDayPass({ paymentRef })),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(0);
  });

  it("M1 a paid payment_intents row, even an unlinked one, never buys a day pass", async () => {
    const s = await setup();
    const intent = await seedIntent({
      tenantId: s.world.tenantId,
      outletId: s.world.outletA,
      amountIdr: DAY_PASS_PRICE * 3,
    });
    for (const paymentRef of [intent.ref, intent.id])
      expect(
        await failure(s.buyDayPass({ paymentRef })),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(0);
    expect(await countRows(s.world.tenantId, "wfc_payment_captures")).toBe(0);
  });

  it("M1 a tender of a food order (no line for the day pass menu item) cannot buy a day pass", async () => {
    const s = await setup();
    const [foodItem] = await seedMenuItems(s.world, 1);
    const food = await s.tender(DAY_PASS_PRICE, { menuItemIds: [foodItem!] });
    expect(await failure(s.buyDayPass({ paymentRef: food.ref }))).toMatchObject(
      { status: 409, code: "PAYMENT_NOT_CAPTURED" },
    );
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("M1 a tender whose line is voided, or whose order is a training sale, cannot buy a day pass", async () => {
    const s = await setup();
    const voided = await s.capture(DAY_PASS_PRICE, { voidItems: true });
    const training = await s.capture(DAY_PASS_PRICE, { training: true });
    for (const paymentRef of [voided, training])
      expect(
        await failure(s.buyDayPass({ paymentRef })),
        paymentRef,
      ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(0);
  });

  it("M1 a day pass product without a menu_item_id can never be sold: 409 PAYMENT_NOT_CAPTURED", async () => {
    const s = await setup();
    const noMenu = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: "day_pass",
      price: 10_000,
      menuItemId: null,
    });
    expect(
      await failure(
        s.buyDayPass({
          productId: noMenu,
          paymentRef: await s.capture(DAY_PASS_PRICE),
        }),
      ),
    ).toMatchObject({ status: 409, code: "PAYMENT_NOT_CAPTURED" });
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
    expect(await countRows(s.world.tenantId, "wfc_payment_captures")).toBe(0);
  });

  it("M1 the client never types the paid amount or a price: paidIdr and priceIdr are rejected", async () => {
    const s = await setup();
    const paymentRef = await s.capture(DAY_PASS_PRICE);
    for (const extra of [
      { paidIdr: DAY_PASS_PRICE },
      { paidIdr: 1 },
      { priceIdr: 1 },
    ]) {
      const rejected = await failure(
        purchaseDayPass(
          s.ctx,
          s.actor,
          {
            productId: s.dayPassProductId,
            customerProfileId: s.customer.id,
            paymentRef,
            ...extra,
          } as never,
          NOW,
        ),
      );
      expect([400, 422]).toContain(rejected.status);
    }
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("M1 an overpaying capture buys the pass for the price only; the refund cap stays the price", async () => {
    const s = await setup();
    const paymentRef = await s.capture(DAY_PASS_PRICE * 4);
    const purchase = await s.buyDayPass({ paymentRef });
    const paid = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT price_idr::text, paid_idr::text FROM wfc_day_pass_purchases WHERE id = $1",
        [purchase.id],
      );
      return {
        price: Number(rows[0].price_idr),
        paid: Number(rows[0].paid_idr),
      };
    });
    expect(paid).toEqual({ price: DAY_PASS_PRICE, paid: DAY_PASS_PRICE });
    expect(
      (
        await failure(
          refundDayPass(
            s.ctx,
            s.actor,
            { paymentRef, refundIdr: DAY_PASS_PRICE + 1 },
            NOW,
          ),
        )
      ).status,
    ).toBe(409);
  });

  it("F39 only a day_pass product can be bought as a day pass", async () => {
    const s = await setup();
    const rejected = await failure(
      s.buyDayPass({ productId: s.reservationProductId }),
    );
    expect([400, 404, 409, 422]).toContain(rejected.status);
    const unknown = await failure(s.buyDayPass({ productId: randomUUID() }));
    expect([400, 404, 422]).toContain(unknown.status);
    expect(await ledgerRows(s.world.tenantId)).toHaveLength(0);
  });

  it("M4 buying again with the same paymentRef returns the first sale: same id, 200, one entitlement", async () => {
    const s = await setup();
    const paymentRef = await s.capture(DAY_PASS_PRICE);
    const first = await s.buyDayPass({ paymentRef });
    const again = await s.buyDayPass({ paymentRef });
    expect(again.id).toBe(first.id);
    const grants = (await ledgerRows(s.world.tenantId)).filter(
      (r) => r.type === "grant",
    );
    expect(grants).toHaveLength(1);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
  });

  it("M4 concurrent purchases with the same paymentRef all return the one sale", async () => {
    const s = await setup();
    const paymentRef = await s.capture(DAY_PASS_PRICE);
    const results = await Promise.all([
      s.buyDayPass({ paymentRef }),
      s.buyDayPass({ paymentRef }),
      s.buyDayPass({ paymentRef }),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
  });

  it("M4 the same paymentRef for another customer or another product is 409 PAYMENT_ALREADY_USED", async () => {
    const s = await setup();
    // The other pass exists before the capture, so its menu item is on the
    // order too: only the reuse can stop the sales below.
    const otherPass = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: s.facilityId,
      wfcKind: "day_pass",
      price: 10_000,
    });
    const paymentRef = await s.capture(DAY_PASS_PRICE * 5);
    await s.buyDayPass({ paymentRef });
    const otherCustomer = await seedProfile(s.world.tenantId);
    expect(
      await failure(
        s.buyDayPass({ paymentRef, customerProfileId: otherCustomer.id }),
      ),
    ).toMatchObject({ status: 409, code: "PAYMENT_ALREADY_USED" });
    expect(
      await failure(s.buyDayPass({ paymentRef, productId: otherPass })),
    ).toMatchObject({ status: 409, code: "PAYMENT_ALREADY_USED" });
    expect(
      (await ledgerRows(s.world.tenantId)).filter((r) => r.type === "grant"),
    ).toHaveLength(1);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
  });

  it("M2 M4 a refund revokes the unredeemed entitlement; refunding again changes nothing", async () => {
    const s = await setup();
    const paymentRef = await s.capture(DAY_PASS_PRICE);
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
    const paymentRef = await s.capture(DAY_PASS_PRICE);
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
