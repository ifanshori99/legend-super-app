// Brief 1270 card W2: paid WFC sale (hold, QRIS link, settlement, sweep, late
// payment) against PostgreSQL with the restricted app role (RLS forced). Only
// the payment gateway is a double; links, codes, confirmations, parked money
// and refund requests are the real WS-05 rows.
//
// Money rules proved here ("jangan sampai rugi"): a seat is issued only for a
// full, on-time payment through its own link; nobody gets two passes or two
// refunds; a payment that cannot get a seat is refunded once and never more
// than was paid; a second payment is parked, not kept as a sale.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "../config/env.ts";
import type * as RefundService from "../services/payment-refund.service.ts";
import { memberTenantContext, type MemberScope } from "../db/member-scope.ts";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  handleWfcPaymentPaid,
  sweepWfcHolds,
  wfcLateRefundKey,
} from "../services/wfc-payment-consumer.ts";
import {
  getWfcClaim,
  holdWfcSeat,
  listMyWfcClaims,
  listWfcSaleProducts,
  refreshWfcPayment,
} from "../services/wfc-sale.service.ts";
import { createWfcSeat, setWfcProduct } from "../services/wfc-seat.service.ts";
import { seedFacility } from "./facility-entitlement-helpers.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedProfile,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

// A refund request the payment layer refuses (W2 review no. 1): the opening
// of the approval chain throws while `fail` is set.
const refundFault = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/payment-refund.service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof RefundService>();
  return {
    ...actual,
    openRefundChainSafely: (
      ...args: Parameters<typeof actual.openRefundChainSafely>
    ) => {
      if (refundFault.fail)
        throw Object.assign(new Error("refund refused"), { code: "23514" });
      return actual.openRefundChainSafely(...args);
    },
  };
});

const flag = env as unknown as { WFC_SALES_ENABLED?: boolean };
const was = flag.WFC_SALES_ENABLED;
const MINUTE = 60_000;
const WIB = "Asia/Jakarta";
const PRICE = 120_000;

/** Provider double: one QRIS code (with a provider reference) per key. */
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
      providerRef: `FAKE-WFC-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101WFC",
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setPaymentGateway(new FakeGateway());
});
beforeEach(() => {
  flag.WFC_SALES_ENABLED = true;
});
afterEach(() => {
  refundFault.fail = false;
  flag.WFC_SALES_ENABLED = was;
  delete process.env.EDGE_MODE;
});
afterAll(async () => {
  setPaymentGateway(null);
  await owner.end();
});

// ---- helpers ----------------------------------------------------------------

const q = async <T = Record<string, unknown>>(
  world: World,
  text: string,
  values: unknown[] = [],
) =>
  asTenant(
    world.tenantId,
    async (client) => (await client.query(text, values)).rows as T[],
  );

async function insertInto(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  table: string,
  row: Record<string, unknown>,
) {
  const names = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${names.join(", ")})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return { status: e.status, code: e.code };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

/** Local WIB date `days` ahead, and an instant at `hh:mm` on a date. */
function wibDate(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: WIB }).format(
    new Date(Date.now() + days * 24 * 60 * MINUTE),
  );
}
const wibAt = (date: string, time: string) =>
  new Date(`${date}T${time}:00+07:00`).toISOString();
const tomorrowAt = (time: string) => wibAt(wibDate(1), time);

// ---- seeding ----------------------------------------------------------------

async function seedActor(tenantId: string): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC sale test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.config.manage", "facility.booth.operate"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return userId;
}

const SETTINGS = {
  version: 1,
  effective_from: "2026-01-01",
  total_seats: 60,
  wfc_seats: 20,
  open_hours_per_month: 420,
  fixed_cost_idr: 100_000_000,
  target_revenue_idr: 300_000_000,
  target_profit_idr: 50_000_000,
  target_occupancy_bp: 5000,
  spend_per_person_idr: 60_000,
  cogs_bp: 3500,
  avg_stay_minutes: 60,
  no_show_minutes: 30,
  reason: "Uji",
};

/** A settings version in force, approved by a second person. */
async function seedSettings(world: World, proposer: string, approver: string) {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    tenant_id: world.tenantId,
    outlet_id: world.outletA,
    ...SETTINGS,
    proposed_by: proposer,
    approved_by: approver,
  };
  const approvalId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await insertInto(client, "approval_requests", {
      id: approvalId,
      tenant_id: world.tenantId,
      outlet_id: world.outletA,
      chain_id: approvalId,
      source_module: "wfc",
      action_type: "price_change",
      object_type: "wfc_business_settings",
      object_id: row.id,
      payload: JSON.stringify({
        version: row.version,
        effectiveFrom: row.effective_from,
        totalSeats: row.total_seats,
        wfcSeats: row.wfc_seats,
        openHoursPerMonth: row.open_hours_per_month,
        fixedCostIdr: row.fixed_cost_idr,
        targetRevenueIdr: row.target_revenue_idr,
        targetProfitIdr: row.target_profit_idr,
        targetOccupancyBp: row.target_occupancy_bp,
        spendPerPersonIdr: row.spend_per_person_idr,
        cogsBp: row.cogs_bp,
        avgStayMinutes: row.avg_stay_minutes,
        noShowMinutes: row.no_show_minutes,
      }),
      requested_by: proposer,
      source: "user",
      level: 1,
      required_levels: 1,
      required_steps: "[]",
      request_reason: "Uji",
      deadline_at: new Date(Date.now() + 3_600_000),
      status: "approved",
      decided_by: approver,
      decided_at: new Date(),
      reason: "Setuju",
    });
    await insertInto(client, "wfc_business_settings", {
      ...row,
      approval_request_id: approvalId,
    });
  });
}

type Split = {
  kind: "seat_reservation" | "day_pass";
  access?: "all_day" | "off_peak";
  seatFeeIdr: number;
  creditIdr: number;
};

/** A coworking product made WFC by the W1 editor and switched on. */
async function seedWfcProduct(
  world: World,
  actor: string,
  facilityId: string,
  split: Split,
) {
  const id = randomUUID();
  await q(
    world,
    `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
     VALUES ($1, $2, $3, $4, $5, 'single', 70000, 1)`,
    [id, world.tenantId, world.outletA, facilityId, `WFC ${short()}`],
  );
  const [stamp] = await q<{ updated_at: Date }>(
    world,
    "SELECT updated_at FROM facility_products WHERE id = $1",
    [id],
  );
  await setWfcProduct(world.context, actor, {
    productId: id,
    wfc: {
      kind: split.kind,
      access: split.access ?? "all_day",
      seatFeeIdr: split.seatFeeIdr,
      creditIdr: split.creditIdr,
      durationMinutes: split.kind === "seat_reservation" ? 60 : null,
    },
    expectedUpdatedAt: stamp!.updated_at.toISOString(),
  });
  await q(
    world,
    "UPDATE facility_products SET is_active = true WHERE id = $1",
    [id],
  );
  return id;
}

type Shop = Awaited<ReturnType<typeof shop>>;

/**
 * An outlet that may sell: a WFC zone with `seats` seats (facility open
 * 00:00-23:59), every quota cell at `quota` (null = no cells), the products
 * below (switched on before the settings version, as if it was raised later)
 * and a settings version in force. No wifi policy: every minute is peak.
 */
async function shop(options: { seats?: number; quota?: number | null } = {}) {
  const world = await createWorld();
  const actor = await seedActor(world.tenantId);
  const approver = await seedActor(world.tenantId);
  const zoneId = randomUUID();
  await q(
    world,
    `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours, is_wfc)
     VALUES ($1, $2, $3, $4, 'pay_first', '[]', true)`,
    [zoneId, world.tenantId, world.outletA, `Zona ${short()}`],
  );
  const facilityId = await seedFacility(world, world.outletA, "coworking");
  const seatIds: string[] = [];
  for (let i = 0; i < (options.seats ?? 2); i += 1) {
    const seat = await createWfcSeat(world.context, actor, {
      outletId: world.outletA,
      zoneId,
      code: `K${i + 1}`,
    });
    seatIds.push(seat.id);
  }
  const quota = options.quota === undefined ? 20 : options.quota;
  if (quota !== null)
    await q(
      world,
      `INSERT INTO wfc_hourly_quotas (tenant_id, outlet_id, day_of_week, hour, seats, updated_by)
       SELECT $1, $2, d, h, $3, $4 FROM generate_series(0, 6) d, generate_series(0, 23) h`,
      [world.tenantId, world.outletA, quota, actor],
    );
  const make = (split: Split) =>
    seedWfcProduct(world, actor, facilityId, split);
  const products = {
    // Rp120.000 for 60 minutes: over the peak floor of Rp39.000 an hour.
    reservation: await make({
      kind: "seat_reservation",
      seatFeeIdr: 100_000,
      creditIdr: 20_000,
    }),
    offPeak: await make({
      kind: "seat_reservation",
      access: "off_peak",
      seatFeeIdr: 100_000,
      creditIdr: 20_000,
    }),
    // Rp45.000 for 60 peak minutes: under the floor once the version is in force.
    cheap: await make({
      kind: "seat_reservation",
      seatFeeIdr: 40_000,
      creditIdr: 5_000,
    }),
    // A whole open day (00:00-23:59) at peak needs about Rp935.000.
    dayPass: await make({
      kind: "day_pass",
      seatFeeIdr: 1_500_000,
      creditIdr: 20_000,
    }),
    // Rp320.000: enough for 4 open peak hours, not for 12.
    shortPass: await make({
      kind: "day_pass",
      seatFeeIdr: 300_000,
      creditIdr: 20_000,
    }),
  };
  await seedSettings(world, actor, approver);
  return { world, actor, zoneId, facilityId, seatIds, ...products };
}

async function member(world: World): Promise<MemberScope> {
  const profile = await seedProfile(world.tenantId);
  return {
    context: memberTenantContext(world.tenantId),
    tenantId: world.tenantId,
    userId: profile.userId,
    customerProfileId: profile.id,
    status: "active",
  };
}

const setHours = (s: Shop, opensAt: string, closesAt: string) =>
  q(s.world, "UPDATE facilities SET operating_hours = $2 WHERE id = $1", [
    s.facilityId,
    JSON.stringify([{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], opensAt, closesAt }]),
  ]);

const claimsOf = (world: World) =>
  q<{ id: string; status: string; paid_idr: string }>(
    world,
    `SELECT id, status, paid_idr::text FROM wfc_seat_reservations
      WHERE tenant_id = $1 ORDER BY created_at`,
    [world.tenantId],
  );

const intentsOf = (world: World, linkId: string) =>
  q<{ id: string; method: string; status: string }>(
    world,
    `SELECT id, method, status FROM payment_intents
      WHERE payment_link_id = $1 ORDER BY created_at`,
    [linkId],
  );

const refundsOf = (world: World, linkId: string) =>
  q<{ amount_idr: string; requested_by: string; payment_intent_id: string }>(
    world,
    `SELECT r.amount_idr::text, r.requested_by, r.payment_intent_id
       FROM payment_refunds r
       JOIN payment_intents i ON i.tenant_id = r.tenant_id AND i.id = r.payment_intent_id
      WHERE i.payment_link_id = $1`,
    [linkId],
  );

const parkedOf = (world: World, intentId: string) =>
  q<{ amount_idr: string }>(
    world,
    "SELECT amount_idr::text FROM payment_unallocated_funds WHERE payment_intent_id = $1",
    [intentId],
  );

const total = (rows: { amount_idr: string }[]) =>
  rows.reduce((sum, row) => sum + Number(row.amount_idr), 0);

/** The provider confirms the code (verified webhook) at `at`. */
async function pay(
  world: World,
  intentId: string,
  amountIdr = PRICE,
  at = new Date(),
) {
  const [intent] = await q<{ provider_ref: string }>(
    world,
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return confirmPayment(
    world.context,
    intentId,
    {
      source: "verified_webhook",
      method: "qris",
      amountIdr,
      providerRef: intent!.provider_ref,
      at: at.toISOString(),
      receivedAt: at,
    },
    { type: "system" },
    at,
  );
}

const paidEvent = (world: World, intentId: string, linkId: string) =>
  ({
    id: randomUUID(),
    name: "payment.paid",
    tenantId: world.tenantId,
    outletId: world.outletA,
    payload: { intentId, paymentLinkId: linkId },
  }) as unknown as Parameters<typeof handleWfcPaymentPaid>[1];

const settle = (world: World, intentId: string, linkId: string) =>
  handleWfcPaymentPaid(world.context, paidEvent(world, intentId, linkId));

/** A held reservation tomorrow 10:00 WIB with its link and first code. */
async function hold(s: Shop, scope?: MemberScope) {
  const who = scope ?? (await member(s.world));
  const claim = await holdWfcSeat(who, {
    productId: s.reservation,
    startsAt: tomorrowAt("10:00"),
  });
  const [row] = await q<{ payment_link_id: string }>(
    s.world,
    "SELECT payment_link_id FROM wfc_seat_reservations WHERE id = $1",
    [claim.id],
  );
  const linkId = row!.payment_link_id;
  const [code] = await intentsOf(s.world, linkId);
  return { claim, scope: who, linkId, intentId: code!.id };
}

const expireHold = (s: Shop, claimId: string) =>
  q(
    s.world,
    "UPDATE wfc_seat_reservations SET hold_expires_at = now() - interval '1 minute' WHERE id = $1",
    [claimId],
  );

// ---- gate -------------------------------------------------------------------

describe("the sale gate", () => {
  it("flag off: 403, no claim, no link, nothing listed", async () => {
    const s = await shop();
    flag.WFC_SALES_ENABLED = false;
    const who = await member(s.world);
    expect(
      await failure(
        holdWfcSeat(who, {
          productId: s.reservation,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ status: 403, code: "WFC_SALES_DISABLED" });
    expect(await claimsOf(s.world)).toHaveLength(0);
    expect(
      await q(s.world, "SELECT 1 FROM payment_links WHERE tenant_id = $1", [
        s.world.tenantId,
      ]),
    ).toHaveLength(0);
    expect(
      await listWfcSaleProducts(who, { outletId: s.world.outletA }),
    ).toEqual([]);
  });

  it("an edge process sells nothing and settles nothing", async () => {
    const s = await shop();
    const who = await member(s.world);
    process.env.EDGE_MODE = "true";
    expect(
      await failure(
        holdWfcSeat(who, {
          productId: s.reservation,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ status: 403, code: "WFC_NEEDS_CLOUD" });
    expect(await claimsOf(s.world)).toHaveLength(0);
    expect(await settle(s.world, randomUUID(), randomUUID())).toBe("ignored");
    expect(await sweepWfcHolds(s.world.context)).toEqual({
      released: 0,
      settled: 0,
      skipped: 0,
    });
  });

  it("another tenant's product and another member's claim are not found", async () => {
    const s = await shop();
    const other = await shop();
    const stranger = await member(other.world);
    expect(
      await failure(
        holdWfcSeat(stranger, {
          productId: s.reservation,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ status: 404 });
    const { claim } = await hold(s);
    const neighbour = await member(s.world);
    expect(await failure(getWfcClaim(neighbour, claim.id))).toMatchObject({
      status: 404,
    });
    expect(await failure(getWfcClaim(stranger, claim.id))).toMatchObject({
      status: 404,
    });
    expect(await listMyWfcClaims(neighbour)).toEqual([]);
  });
});

// ---- hold -------------------------------------------------------------------

describe("hold", () => {
  it("holds 45 min on a 30 min link at the full price, QRIS only, token never shown", async () => {
    const s = await shop();
    const before = Date.now();
    const { claim, linkId } = await hold(s);
    expect(claim).toMatchObject({
      status: "pending_payment",
      priceIdr: PRICE,
      paidIdr: 0,
    });
    const holdMinutes = (Date.parse(claim.holdExpiresAt!) - before) / MINUTE;
    expect(holdMinutes).toBeGreaterThan(44.9);
    expect(holdMinutes).toBeLessThanOrEqual(45.1);
    const [link] = await q<Record<string, unknown>>(
      s.world,
      `SELECT subtotal_idr::text, total_idr::text, discount_idr::text, paid_idr::text, expires_at
         FROM payment_links WHERE id = $1`,
      [linkId],
    );
    expect(link).toMatchObject({
      subtotal_idr: "120000",
      total_idr: "120000",
      discount_idr: "0",
      paid_idr: "0",
    });
    const linkMinutes =
      ((link!.expires_at as Date).getTime() - before) / MINUTE;
    expect(linkMinutes).toBeGreaterThan(29.9);
    expect(linkMinutes).toBeLessThanOrEqual(30.1);
    expect((await intentsOf(s.world, linkId)).map((i) => i.method)).toEqual([
      "qris",
    ]);
    expect(claim.payment).toMatchObject({
      qrisPayload: "00020101WFC",
      amountIdr: PRICE,
    });
    const [sealed] = await q<{ token: string | null }>(
      s.world,
      "SELECT payment_link_token_sealed AS token FROM wfc_seat_reservations WHERE id = $1",
      [claim.id],
    );
    expect(sealed!.token).toBeTruthy();
    expect(JSON.stringify(claim)).not.toMatch(/token|\/bayar\//i);
  });

  it("one unpaid hold per member; the same request again returns it", async () => {
    const s = await shop();
    const first = await hold(s);
    const again = await holdWfcSeat(first.scope, {
      productId: s.reservation,
      startsAt: tomorrowAt("10:00"),
    });
    expect(again.id).toBe(first.claim.id);
    expect(
      await failure(
        holdWfcSeat(first.scope, {
          productId: s.reservation,
          startsAt: tomorrowAt("12:00"),
        }),
      ),
    ).toMatchObject({ code: "WFC_HOLD_OPEN" });
    expect(await claimsOf(s.world)).toHaveLength(1);
  });

  it("two members race for one seat: one wins", async () => {
    const s = await shop({ seats: 1 });
    const [a, b] = [await member(s.world), await member(s.world)];
    const input = {
      productId: s.reservation,
      seatId: s.seatIds[0],
      startsAt: tomorrowAt("10:00"),
    };
    const results = await Promise.allSettled([
      holdWfcSeat(a, input),
      holdWfcSeat(b, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toMatch(
      /^WFC_(SEAT_TAKEN|NO_SEAT|QUOTA_FULL)$/,
    );
    expect(await claimsOf(s.world)).toHaveLength(1);
  });

  it("a day pass and two reservations race for the last seat: one wins", async () => {
    const s = await shop({ seats: 1 });
    const [a, b, c] = [
      await member(s.world),
      await member(s.world),
      await member(s.world),
    ];
    const results = await Promise.allSettled([
      holdWfcSeat(a, { productId: s.dayPass, date: wibDate(1) }),
      holdWfcSeat(b, {
        productId: s.reservation,
        startsAt: tomorrowAt("10:00"),
      }),
      holdWfcSeat(c, {
        productId: s.reservation,
        startsAt: tomorrowAt("10:30"),
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect((r.reason as { code: string }).code).toMatch(
          /^WFC_(SEAT_TAKEN|NO_SEAT|QUOTA_FULL)$/,
        );
    expect(await claimsOf(s.world)).toHaveLength(1);
  });

  it("quota counts every hold: a full hour refuses even with a free seat", async () => {
    const s = await shop({ seats: 2, quota: 1 });
    await hold(s);
    expect(
      await failure(
        holdWfcSeat(await member(s.world), {
          productId: s.reservation,
          startsAt: tomorrowAt("10:30"),
        }),
      ),
    ).toMatchObject({ status: 409, code: "WFC_QUOTA_FULL" });
    await holdWfcSeat(await member(s.world), {
      productId: s.reservation,
      startsAt: tomorrowAt("12:00"),
    });
    expect(await claimsOf(s.world)).toHaveLength(2);
  });

  it("a missing quota cell is 0 seats", async () => {
    const s = await shop({ quota: null });
    // One cell (03:00) opens the outlet's sales; 10:00 has none.
    await q(
      s.world,
      `INSERT INTO wfc_hourly_quotas (tenant_id, outlet_id, day_of_week, hour, seats, updated_by)
       SELECT $1, $2, d, 3, 5, $3 FROM generate_series(0, 6) d`,
      [s.world.tenantId, s.world.outletA, s.actor],
    );
    expect(
      await failure(
        holdWfcSeat(await member(s.world), {
          productId: s.reservation,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ code: "WFC_QUOTA_FULL" });
    expect(await claimsOf(s.world)).toHaveLength(0);
  });

  it("quota is capped by the active seats: a seat out of service is not sold", async () => {
    const s = await shop({ seats: 2 });
    await q(s.world, "UPDATE wfc_seats SET status = 'inactive' WHERE id = $1", [
      s.seatIds[1],
    ]);
    await hold(s);
    expect(
      await failure(
        holdWfcSeat(await member(s.world), {
          productId: s.reservation,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ status: 409 });
    expect(await claimsOf(s.world)).toHaveLength(1);
  });

  it("refuses a slot outside the hours, across midnight or in the past", async () => {
    const s = await shop();
    await setHours(s, "08:00", "18:00");
    const who = await member(s.world);
    for (const startsAt of [
      tomorrowAt("07:30"),
      tomorrowAt("17:30"),
      tomorrowAt("23:30"),
      new Date(Date.now() - 5 * MINUTE).toISOString(),
    ])
      expect(
        await failure(holdWfcSeat(who, { productId: s.reservation, startsAt })),
      ).toMatchObject({ status: 422, code: "WFC_SLOT_INVALID" });
    expect(await claimsOf(s.world)).toHaveLength(0);
  });

  it("off-peak: refused without a peak schedule and in a peak minute", async () => {
    const s = await shop();
    const who = await member(s.world);
    const at = (time: string) =>
      holdWfcSeat(who, { productId: s.offPeak, startsAt: tomorrowAt(time) });
    expect(await failure(at("10:00"))).toMatchObject({
      code: "WFC_SLOT_INVALID",
    });
    await q(
      s.world,
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes, spend_per_extra_hour_idr,
          extra_minutes, max_devices, peak_schedule, base_speed_kbps, full_speed_kbps, tier_bonus_minutes)
       VALUES ($1, $2, $3, $4, 60, 30, 20000, 60, 3, $5, 2000, 10000, '{}')`,
      [
        randomUUID(),
        s.world.tenantId,
        s.world.outletA,
        s.zoneId,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startsAt: "10:30",
            endsAt: "13:00",
          },
        ]),
      ],
    );
    expect(await failure(at("10:00"))).toMatchObject({
      code: "WFC_SLOT_INVALID",
    });
    expect((await at("14:00")).access).toBe("off_peak");
  });

  it("re-checks the price floor on the real slot", async () => {
    const s = await shop();
    // Switched on before the version: Rp45.000 under the Rp39.000/h peak floor
    // after the service charge and food cost.
    expect(
      await failure(
        holdWfcSeat(await member(s.world), {
          productId: s.cheap,
          startsAt: tomorrowAt("10:00"),
        }),
      ),
    ).toMatchObject({ status: 422, code: "WFC_PRICE_BELOW_FLOOR" });
    // A Rp320.000 pass covers a 4-hour day, not a 12-hour one: the day's real
    // hours decide, not the hours when the product was switched on.
    await setHours(s, "08:00", "12:00");
    const short = await holdWfcSeat(await member(s.world), {
      productId: s.shortPass,
      date: wibDate(2),
    });
    expect(short.endsAt).toBe(wibAt(wibDate(2), "12:00"));
    await setHours(s, "08:00", "20:00");
    expect(
      await failure(
        holdWfcSeat(await member(s.world), {
          productId: s.shortPass,
          date: wibDate(3),
        }),
      ),
    ).toMatchObject({ status: 422, code: "WFC_PRICE_BELOW_FLOOR" });
    expect(await claimsOf(s.world)).toHaveLength(1);
  });
});

// ---- settlement -------------------------------------------------------------

describe("settlement", () => {
  it("an on-time full payment issues one seat; a replay changes nothing", async () => {
    const s = await shop();
    const { claim, scope, linkId, intentId } = await hold(s);
    await pay(s.world, intentId);
    expect(await settle(s.world, intentId, linkId)).toBe("confirmed");
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "confirmed", paid_idr: "120000" },
    ]);
    expect(await refundsOf(s.world, linkId)).toHaveLength(0);
    expect(await getWfcClaim(scope, claim.id)).toMatchObject({
      status: "confirmed",
      paidIdr: PRICE,
      holdExpiresAt: null,
    });
  });

  it("two codes paid: one seat, the second payment parked, no WFC refund", async () => {
    const s = await shop();
    const { claim, scope, linkId, intentId: first } = await hold(s);
    // The member asks for a new code after the first one lapsed (10 min).
    await refreshWfcPayment(
      scope,
      claim.id,
      new Date(Date.now() + 11 * MINUTE),
    );
    const codes = await intentsOf(s.world, linkId);
    expect(codes).toHaveLength(2);
    const second = codes[1]!.id;
    await pay(s.world, second);
    await pay(s.world, first).catch(() => null);
    expect(await settle(s.world, second, linkId)).toBe("confirmed");
    await settle(s.world, first, linkId);
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "confirmed", paid_idr: "120000" },
    ]);
    expect(total(await parkedOf(s.world, first))).toBe(PRICE);
    expect(
      (await refundsOf(s.world, linkId)).filter(
        (r) => r.requested_by === "system:wfc",
      ),
    ).toHaveLength(0);
  });

  it("a payment under the price is refused: no seat, no money taken, no refund", async () => {
    const s = await shop();
    const { claim, linkId, intentId } = await hold(s);
    // The payment layer refuses the short amount: the code is never paid.
    await expect(pay(s.world, intentId, PRICE - 1)).rejects.toMatchObject({
      decisionCode: "AMOUNT_MISMATCH",
    });
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "pending_payment", paid_idr: "0" },
    ]);
    expect((await intentsOf(s.world, linkId))[0]!.status).toBe("pending");
    expect(await refundsOf(s.world, linkId)).toEqual([]);
  });

  it("paid after the hold ran out: no seat, one full refund, a replay files nothing more", async () => {
    const s = await shop();
    const { claim, linkId, intentId } = await hold(s);
    await expireHold(s, claim.id);
    await pay(s.world, intentId);
    expect(await settle(s.world, intentId, linkId)).toBe(
      "late_refund_requested",
    );
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "cancelled", paid_idr: "120000" },
    ]);
    expect(await refundsOf(s.world, linkId)).toEqual([
      {
        amount_idr: "120000",
        requested_by: "system:wfc",
        payment_intent_id: intentId,
      },
    ]);
    expect(
      await q(
        s.world,
        "SELECT 1 FROM payment_admin_idempotency WHERE key LIKE '%' || $1",
        [wfcLateRefundKey(intentId)],
      ),
    ).toHaveLength(1);
  });

  it("swept first, paid later: the seat goes to someone else, the money back once", async () => {
    const s = await shop({ seats: 1 });
    const { claim, linkId, intentId } = await hold(s);
    await expireHold(s, claim.id);
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 1,
    });
    const next = await holdWfcSeat(await member(s.world), {
      productId: s.reservation,
      startsAt: tomorrowAt("10:00"),
    });
    expect(next.seatId).toBe(claim.seatId);
    await pay(s.world, intentId).catch(() => null);
    await settle(s.world, intentId, linkId);
    await settle(s.world, intentId, linkId);
    const rows = await claimsOf(s.world);
    expect(rows.find((r) => r.id === claim.id)!.status).toBe("cancelled");
    expect(rows.filter((r) => r.status === "confirmed")).toHaveLength(0);
    // Back exactly once: as a WFC refund, or parked for the payment layer's
    // own refund flow, never both.
    const refunds = await refundsOf(s.world, linkId);
    const parked = await parkedOf(s.world, intentId);
    expect(refunds.length + parked.length).toBe(1);
    expect(total(refunds) + total(parked)).toBe(PRICE);
  });

  it("a link opened while sales were on and paid after they closed is refunded in full", async () => {
    const s = await shop();
    const { linkId, intentId } = await hold(s);
    flag.WFC_SALES_ENABLED = false;
    await pay(s.world, intentId);
    expect(await settle(s.world, intentId, linkId)).toBe(
      "late_refund_requested",
    );
    expect((await claimsOf(s.world))[0]!.status).toBe("cancelled");
    expect((await refundsOf(s.world, linkId)).map((r) => r.amount_idr)).toEqual(
      ["120000"],
    );
  });

  it("the sweep never cancels a hold whose code already took money", async () => {
    const s = await shop();
    const { claim, linkId, intentId } = await hold(s);
    await pay(s.world, intentId);
    await expireHold(s, claim.id);
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 0,
    });
    expect((await claimsOf(s.world))[0]!.status).toBe("pending_payment");
    // The consumer decides by the provider's payment time against the hold
    // (moved before it here): refund, never a seat.
    expect(await settle(s.world, intentId, linkId)).toBe(
      "late_refund_requested",
    );
    expect(total(await refundsOf(s.world, linkId))).toBe(PRICE);
  });

  it("the sweep releases a lapsed hold and frees the seat", async () => {
    const s = await shop({ seats: 1 });
    const { claim, linkId } = await hold(s);
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 0,
    });
    await expireHold(s, claim.id);
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 1,
    });
    expect((await claimsOf(s.world))[0]!.status).toBe("cancelled");
    // The link and its code stop taking money.
    const [link] = await q<{ closed: boolean }>(
      s.world,
      "SELECT expires_at <= now() AS closed FROM payment_links WHERE id = $1",
      [linkId],
    );
    expect(link!.closed).toBe(true);
    expect((await intentsOf(s.world, linkId)).map((i) => i.status)).toEqual([
      "expired",
    ]);
    // The seat sells again.
    await holdWfcSeat(await member(s.world), {
      productId: s.reservation,
      startsAt: tomorrowAt("10:00"),
    });
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 0,
    });
  });

  it("a refund that fails: claim cancelled with its money, event done, member free; the sweep files it once", async () => {
    const s = await shop();
    const { claim, scope, linkId, intentId } = await hold(s);
    await expireHold(s, claim.id);
    await pay(s.world, intentId);
    refundFault.fail = true;
    expect(await settle(s.world, intentId, linkId)).toBe("late_refund_failed");
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "cancelled", paid_idr: "120000" },
    ]);
    expect(await refundsOf(s.world, linkId)).toHaveLength(0);
    // The one-hold index no longer locks the member out.
    await holdWfcSeat(scope, {
      productId: s.reservation,
      startsAt: tomorrowAt("12:00"),
    });
    refundFault.fail = false;
    // Inside the grace a redelivery may still come: the sweep waits.
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({ settled: 0 });
    const later = new Date(Date.now() + 16 * MINUTE);
    expect(await sweepWfcHolds(s.world.context, later)).toMatchObject({
      settled: 1,
    });
    expect(await sweepWfcHolds(s.world.context, later)).toMatchObject({
      settled: 0,
    });
    expect(await refundsOf(s.world, linkId)).toEqual([
      {
        amount_idr: "120000",
        requested_by: "system:wfc",
        payment_intent_id: intentId,
      },
    ]);
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
    expect(await refundsOf(s.world, linkId)).toHaveLength(1);
  });

  it("an event never delivered, paid on time: the sweep issues the seat after the grace", async () => {
    const s = await shop();
    const { claim, intentId, linkId } = await hold(s);
    await pay(s.world, intentId);
    const holdEnd = Date.parse(claim.holdExpiresAt!);
    expect(
      await sweepWfcHolds(s.world.context, new Date(holdEnd + MINUTE)),
    ).toMatchObject({ released: 0, settled: 0 });
    expect((await claimsOf(s.world))[0]!.status).toBe("pending_payment");
    expect(
      await sweepWfcHolds(s.world.context, new Date(holdEnd + 16 * MINUTE)),
    ).toMatchObject({ released: 0, settled: 1 });
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "confirmed", paid_idr: "120000" },
    ]);
    expect(await refundsOf(s.world, linkId)).toHaveLength(0);
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
  });

  it("an event never delivered, paid late: the sweep refunds once after the grace", async () => {
    const s = await shop();
    const { claim, intentId, linkId } = await hold(s);
    await expireHold(s, claim.id);
    await pay(s.world, intentId);
    expect(await sweepWfcHolds(s.world.context)).toMatchObject({
      released: 0,
      settled: 0,
    });
    const later = new Date(Date.now() + 16 * MINUTE);
    expect(await sweepWfcHolds(s.world.context, later)).toMatchObject({
      settled: 1,
    });
    expect(await sweepWfcHolds(s.world.context, later)).toMatchObject({
      settled: 0,
    });
    expect(await claimsOf(s.world)).toEqual([
      { id: claim.id, status: "cancelled", paid_idr: "120000" },
    ]);
    expect(total(await refundsOf(s.world, linkId))).toBe(PRICE);
    expect(await settle(s.world, intentId, linkId)).toBe("unchanged");
    expect(total(await refundsOf(s.world, linkId))).toBe(PRICE);
  });
});

// Today's day pass starts "now"; near midnight WIB there is no slot left.
const lateInWibDay =
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: WIB,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
  ) >= 22;

describe("day pass retry", () => {
  it.skipIf(lateInWibDay)(
    "today's day pass asked again a few minutes later is the same hold",
    async () => {
      const s = await shop();
      const who = await member(s.world);
      const input = { productId: s.dayPass, date: wibDate(0) };
      const first = await holdWfcSeat(who, input);
      const again = await holdWfcSeat(
        who,
        input,
        new Date(Date.now() + 2 * MINUTE),
      );
      expect(again.id).toBe(first.id);
      expect(await claimsOf(s.world)).toHaveLength(1);
    },
  );
});
