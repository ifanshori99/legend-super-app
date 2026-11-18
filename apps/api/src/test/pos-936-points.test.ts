// legend-hpgyw part B (POS 936): paying part of a POS bill with member points.
//
// Written from docs/briefs/1039-sub-shared.md (money rules + the three routes)
// and the shared POS contract (posOrderDetailSchema, posTenderSchema: a
// `points` tender carries `pointsUsed` and `amountIdr`), not from service code.
//
//   GET  /api/pos/orders/:orderId/points
//        -> { data: { account: { memberId, memberName, balancePoints,
//             minRedeemPoints, maxRedeemPoints } | null } }
//   POST /api/pos/orders/:orderId/points/quote  { points } -> { data: { points, valueIdr } }
//   POST /api/pos/orders/:orderId/points/redeem { points, idempotencyKey }
//        -> { data: <order detail with a captured "points" tender> }
//
// Feature id: legend-hpgyw. Test names are POS-936-PTS-nn.
//
// Money rules proven here (founder: nobody is paid more, the outlet never loses):
// - the balance goes down by exactly the points redeemed, never below zero;
// - the points value never exceeds the REMAINING bill (total less tenders
//   already allocated), and the points allowed are rounded DOWN;
// - an order without a member has no points account (account: null);
// - a replay (same key) and two concurrent requests give ONE effect;
// - the points ledger liability released equals the tender amount, and every
//   journal entry of the tenant stays balanced;
// - another tenant or another outlet's cashier cannot see or spend them.
//
// Fixture: one isolated tenant, loyalty program with 1 point = Rp70 (not a
// round number on purpose, so the round-down is observable), Kopi x2 =
// Rp50.000 + PBJT 10% = Rp55.000. Remaining 55.000 / 70 = 785.71 points, so
// the most that can be redeemed is 785 points = Rp54.950 (786 would be
// Rp55.020, more than the bill).
//
// Assumptions where the brief is silent (also in the report):
// - responses are wrapped in `data`, like every other POS endpoint; redeem
//   answers 200 or 201.
// - the cashier role needs `pos.payment.accept` (plus `order.view`) to use the
//   routes; if the engineer registers a new points permission the fixture role
//   must get it too.
// - minRedeemPoints from the loyalty program is at most 100 (the tests redeem
//   100 points).
// - a quote or redeem above the allowed maximum (more than balance, or worth
//   more than the remaining bill) is refused with a 4xx and changes nothing;
//   for a quote a response is also accepted if its valueIdr is capped at or
//   below the remaining bill (never above it).
// - a quote/redeem on an order without a member is a 4xx and changes nothing.
// - another tenant or an outlet the caller has no role in answers 403 or 404.
// - a redeem ledger row stores the points and liability with either sign; only
//   the magnitude is compared.
// - the member is attached to the order by `orders.customer_profile_id` (the
//   same attribution the loyalty earn uses).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant,
  balanceOf,
  ledgerOf,
  owner as memberOwner,
  seedMember,
  seedProgram,
  type Profile,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";
import { memberQrFor } from "./member-qr-redeem-helper.ts";

const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10%. */
const ORDER_TOTAL_IDR = 55_000;
const POINT_VALUE_IDR = 70;
/** floor(55.000 / 70): 786 points would be worth Rp55.020 > the bill. */
const MAX_POINTS_FULL_BILL = 785;
const MAX_VALUE_FULL_BILL = MAX_POINTS_FULL_BILL * POINT_VALUE_IDR; // 54.950

const CASHIER_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "pos.discount.apply",
  "pos.refund.request",
  "shift.cash.operate",
];
const PIN = "582914";
const DEVICE_ID = randomUUID();

/** Receipt numbering double (the production port is wired elsewhere). */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? DEVICE_ID,
        number: `POS936-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

let app: Express;

type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};
type World = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  outletB: string;
  kopi: string;
  cashier: Staff; // tenant-wide, creates orders in both outlets
  supervisor: Staff; // approves refunds with a PIN
  outletACashier: Staff; // role only in outlet A
};
let world: World;
let other: { tenant: IsolatedTenant; cashier: Staff };

async function staff(
  tenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
  label: string,
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId, email };
}

async function cashierRole(tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  // Also carry everything the cashier template of the seeded tenant carries
  // (member attach, and any points permission registered there), so the
  // fixture role is a real cashier and not a hand-picked subset.
  const template = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [seededTenantId],
  );
  const permissions = [
    ...new Set([
      ...CASHIER_PERMISSIONS,
      ...(template.rows[0]?.permissions ?? []),
    ]),
  ];
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, tenantId, name, JSON.stringify(permissions)],
  );
  return id;
}

async function seedWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(`p936-${randomUUID().slice(0, 6)}`);
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  const outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B 936', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3`,
    [outletB, `B${randomUUID().slice(0, 7)}`.toUpperCase(), tenant.outletId],
  );
  const roleId = await cashierRole(tenant.tenantId, "Kasir Poin 936");
  const cashier = await staff(tenant, roleId, { type: "tenant" }, "Kasir Poin");
  const supervisorRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Poin 936', true, 'supervisor', $3, false, '["tenant"]')`,
    [
      supervisorRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.void.approve", "pos.refund.approve"]),
    ],
  );
  const supervisor = await staff(
    tenant,
    supervisorRole,
    { type: "tenant" },
    "Supervisor Poin",
  );
  // The member attach route may ask for a verified session (member-earn).
  await verifySessionMfa(cashier.email);
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === DEVICE_ID
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: DEVICE_ID,
  });
  const sessionContext = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    sessionContext,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await openPosShift(
    establishScopedTenantContext(sessionContext, { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId: DEVICE_ID },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const outletACashier = await staff(
    tenant,
    roleId,
    { type: "outlet", outletId: tenant.outletId },
    "Kasir Poin Outlet A",
  );
  const category = randomUUID();
  const kopi = randomUUID();
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Poin Uji', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [kopi, tenant.tenantId, tenant.brandId, category, randomUUID()],
    );
    for (const outletId of [tenant.outletId, outletB]) {
      const priceList = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceList, tenant.tenantId, outletId],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, priceList, kopi, KOPI_IDR],
      );
    }
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-936', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    outletB,
    kopi,
    cashier,
    supervisor,
    outletACashier,
  };
}

async function seedOther(): Promise<typeof other> {
  const tenant = await createIsolatedTenant(
    `p936o-${randomUUID().slice(0, 6)}`,
  );
  const roleId = await cashierRole(tenant.tenantId, "Kasir Tenant Lain");
  const cashier = await staff(
    tenant,
    roleId,
    { type: "tenant" },
    "Kasir Tenant Lain",
  );
  return { tenant, cashier };
}

beforeAll(async () => {
  app = createApp();
  world = await seedWorld();
  other = await seedOther();
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await memberOwner.end();
  await owner.end();
});

// ---- helpers ------------------------------------------------------------------

type CreatedOrder = { id: string; outletId: string };

/** A real POS order (Kopi x2 = Rp55.000) made through the public API. */
async function newOrder(
  options: {
    member?: Profile | null;
    outletId?: string;
    /** Leave the bill as a draft; by default it is submitted (payable). */
    draft?: boolean;
  } = {},
): Promise<CreatedOrder> {
  const outletId = options.outletId ?? world.tenant.outletId;
  const created = await world.cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: world.kopi, quantity: 2, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  const id = created.body.data.id as string;
  if (options.member)
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders
            SET customer_profile_id = $3, customer_attached_via = 'member_qr',
                customer_attached_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenant.tenantId, ulidToUuid(id), options.member!.id],
      ),
    );
  if (!options.draft) {
    // A draft bill is not payable (ORDER_NOT_PAYABLE); the cashier submits
    // it first, like every other POS payment test.
    const submitted = await world.cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(outletId)}/pos/orders/${id}/submit`,
      )
      .set(world.headers)
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        expectedStatus: created.body.data.status as string,
      });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  }
  return { id, outletId };
}

/** A member with `points` on the books (granted through the ledger service). */
async function memberWith(points: number): Promise<Profile> {
  const member = await seedMember(world.tenant.tenantId);
  if (points > 0) await grantPoints(world.tenant.tenantId, member.id, points);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(points);
  return member;
}

/** Cash already allocated to the bill, as the cash tender leaves it. */
async function seedCashTender(order: CreatedOrder, amountIdr: number) {
  await asTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, points_used, payment_intent_id, reference, status,
          requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, NULL, NULL, NULL, 'captured', now(), now())`,
      [world.tenant.tenantId, order.outletId, ulidToUuid(order.id), amountIdr],
    ),
  );
}

type Caller = Pick<Staff, "client">;

const get = (order: CreatedOrder, who: Caller = world.cashier) =>
  who.client
    .get(`/api/pos/orders/${order.id}/points`)
    .set(world.headers)
    .set(originHeader);

const quote = (
  order: CreatedOrder,
  points: unknown,
  who: Caller = world.cashier,
) =>
  who.client
    .post(`/api/pos/orders/${order.id}/points/quote`)
    .set(world.headers)
    .set(originHeader)
    .send({ points });

const redeem = async (
  order: CreatedOrder,
  points: unknown,
  options: { key?: string; who?: Caller; headers?: { Host: string } } = {},
) => {
  const memberToken = await memberQrFor(
    world.tenant.tenantId,
    order.id,
    points,
  );
  return (options.who ?? world.cashier).client
    .post(`/api/pos/orders/${order.id}/points/redeem`)
    .set(options.headers ?? world.headers)
    .set(originHeader)
    .send({
      points,
      idempotencyKey: options.key ?? randomUUID(),
      ...(memberToken ? { memberToken } : {}),
    });
};

async function pointsTenders(order: CreatedOrder) {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{
      amount_idr: string;
      points_used: number;
      status: string;
    }>(
      `SELECT amount_idr::text, points_used, status FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2 AND method = 'points'`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows;
}

const orderDetail = (order: CreatedOrder) =>
  world.cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}`,
    )
    .set(world.headers)
    .set(originHeader);

const redeemed = (status: number) => [200, 201].includes(status);
const refused = (status: number) => status >= 400 && status < 500;

// ---- GET account ----------------------------------------------------------------

describe("POS-936-PTS points account of a POS order", () => {
  it("POS-936-PTS-01 shows the member, balance and a max of the balance when the bill is worth more", async () => {
    const member = await memberWith(600);
    const order = await newOrder({ member });
    const response = await get(order);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const account = response.body.data.account;
    expect(account).toMatchObject({
      memberId: member.id,
      balancePoints: 600,
      // 600 points = Rp42.000 < Rp55.000: the balance is the limit.
      maxRedeemPoints: 600,
    });
    expect(typeof account.memberName).toBe("string");
    expect(account.memberName.length).toBeGreaterThan(0);
    expect(Number.isInteger(account.minRedeemPoints)).toBe(true);
    expect(account.minRedeemPoints).toBeGreaterThanOrEqual(1);
    expect(account.minRedeemPoints).toBeLessThanOrEqual(100);
  });

  it("POS-936-PTS-02 caps the max at the points worth the whole bill, rounded DOWN (never Rp55.020 for a Rp55.000 bill)", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    const response = await get(order);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const account = response.body.data.account;
    expect(account.balancePoints).toBe(5_000);
    expect(account.maxRedeemPoints).toBe(MAX_POINTS_FULL_BILL);
    expect(account.maxRedeemPoints * POINT_VALUE_IDR).toBeLessThanOrEqual(
      ORDER_TOTAL_IDR,
    );
  });

  it("POS-936-PTS-03 the max follows the REMAINING bill, not the total, once a tender is allocated", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    await seedCashTender(order, 20_000);
    const response = await get(order);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Remaining Rp35.000 / 70 = exactly 500 points.
    expect(response.body.data.account.maxRedeemPoints).toBe(500);
  });

  it("POS-936-PTS-04 an order without a member has no points account (account is null)", async () => {
    const order = await newOrder();
    const response = await get(order);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({ account: null });
  });

  it("POS-936-PTS-05 reading the account changes nothing (balance and tenders)", async () => {
    const member = await memberWith(300);
    const order = await newOrder({ member });
    await get(order);
    await get(order);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(300);
    expect(await pointsTenders(order)).toHaveLength(0);
  });
});

// ---- quote ----------------------------------------------------------------------

describe("POS-936-PTS quote of points value", () => {
  it("POS-936-PTS-10 the server prices the points from the loyalty program", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const response = await quote(order, 100);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({
      points: 100,
      valueIdr: 100 * POINT_VALUE_IDR,
    });
  });

  it("POS-936-PTS-11 the largest allowed quote never exceeds the remaining bill; one more point is refused or capped", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    const atMax = await quote(order, MAX_POINTS_FULL_BILL);
    expect(atMax.status, JSON.stringify(atMax.body)).toBe(200);
    expect(atMax.body.data.valueIdr).toBe(MAX_VALUE_FULL_BILL);

    const over = await quote(order, MAX_POINTS_FULL_BILL + 1);
    if (over.status === 200) {
      // A capped answer is acceptable; an answer above the bill is not.
      expect(over.body.data.valueIdr).toBeLessThanOrEqual(ORDER_TOTAL_IDR);
    } else {
      expect(refused(over.status), JSON.stringify(over.body)).toBe(true);
    }
  });

  it("POS-936-PTS-12 quoting spends nothing: balance and tenders are unchanged", async () => {
    const member = await memberWith(400);
    const order = await newOrder({ member });
    await quote(order, 100);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(400);
    expect(await pointsTenders(order)).toHaveLength(0);
  });

  it.each([[0], [-5], [1.5], ["100"], [null]])(
    "POS-936-PTS-13 refuses points that are not a positive whole number (%j)",
    async (points) => {
      const member = await memberWith(400);
      const order = await newOrder({ member });
      const response = await quote(order, points);
      expect([400, 422], JSON.stringify(response.body)).toContain(
        response.status,
      );
    },
  );

  it("POS-936-PTS-14 an order without a member cannot be quoted", async () => {
    const order = await newOrder();
    const response = await quote(order, 100);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
  });
});

// ---- redeem ---------------------------------------------------------------------

describe("POS-936-PTS redeem points as a payment", () => {
  it("POS-936-PTS-20 the balance drops by exactly the points redeemed and the bill gets a points tender of that value", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    const response = await redeem(order, 100);
    expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);
    // Same shape as the order detail, with the points allocation on it.
    expect(response.body.data.id).toBe(order.id);
    expect(response.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
    const tenders = response.body.data.tenders as {
      method: string;
      pointsUsed: number | null;
      amountIdr: number;
      status: string;
    }[];
    const pointsTender = tenders.filter((tender) => tender.method === "points");
    expect(pointsTender).toHaveLength(1);
    expect(pointsTender[0]).toMatchObject({
      pointsUsed: 100,
      amountIdr: 100 * POINT_VALUE_IDR,
      status: "captured",
    });
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(4_900);

    // The same allocation is what the cashier screen reads back.
    const detail = await orderDetail(order);
    expect(detail.status).toBe(200);
    expect(
      (detail.body.data.tenders as { method: string }[]).filter(
        (tender) => tender.method === "points",
      ),
    ).toHaveLength(1);
    // The account now shows the lower balance and a smaller maximum.
    const account = (await get(order)).body.data.account;
    expect(account.balancePoints).toBe(4_900);
    expect(account.maxRedeemPoints).toBe(
      Math.floor((ORDER_TOTAL_IDR - 7_000) / POINT_VALUE_IDR),
    );
  });

  it("POS-936-PTS-21 redeeming the maximum pays up to the bill and never over it (value <= remaining, rounded down)", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    const response = await redeem(order, MAX_POINTS_FULL_BILL);
    expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);
    const [tender] = await pointsTenders(order);
    expect(Number(tender!.amount_idr)).toBe(MAX_VALUE_FULL_BILL);
    expect(Number(tender!.amount_idr)).toBeLessThanOrEqual(ORDER_TOTAL_IDR);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
      5_000 - MAX_POINTS_FULL_BILL,
    );
  });

  it("POS-936-PTS-22 points worth more than the remaining bill are refused and nothing is spent", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    const response = await redeem(order, MAX_POINTS_FULL_BILL + 1);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await pointsTenders(order)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(5_000);
  });

  it("POS-936-PTS-23 the limit is the remaining bill after another tender, not the total", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    await seedCashTender(order, 20_000);
    const tooMuch = await redeem(order, 501); // Rp35.070 > Rp35.000 left
    expect(refused(tooMuch.status), JSON.stringify(tooMuch.body)).toBe(true);
    expect(await pointsTenders(order)).toHaveLength(0);
    const exact = await redeem(order, 500); // exactly Rp35.000
    expect(redeemed(exact.status), JSON.stringify(exact.body)).toBe(true);
    const [tender] = await pointsTenders(order);
    expect(Number(tender!.amount_idr)).toBe(35_000);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(4_500);
  });

  it("POS-936-PTS-24 more points than the balance are refused and the balance never goes negative", async () => {
    const member = await memberWith(50);
    const order = await newOrder({ member });
    const response = await redeem(order, 51);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await pointsTenders(order)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(50);
  });

  it("POS-936-PTS-25 an order without a member cannot redeem points", async () => {
    const order = await newOrder();
    const response = await redeem(order, 100);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await pointsTenders(order)).toHaveLength(0);
  });

  it.each([[0], [-1], [2.5], ["100"]])(
    "POS-936-PTS-26 refuses points that are not a positive whole number (%j) and spends nothing",
    async (points) => {
      const member = await memberWith(500);
      const order = await newOrder({ member });
      const response = await redeem(order, points);
      expect([400, 422], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await pointsTenders(order)).toHaveLength(0);
      expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(500);
    },
  );

  it("POS-936-PTS-27 a redeem without an idempotency key is refused and spends nothing", async () => {
    const member = await memberWith(500);
    const order = await newOrder({ member });
    const response = await world.cashier.client
      .post(`/api/pos/orders/${order.id}/points/redeem`)
      .set(world.headers)
      .set(originHeader)
      .send({ points: 100 });
    expect([400, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(500);
  });

  it("POS-936-PTS-29 a draft bill is not payable: redeem is refused (ORDER_NOT_PAYABLE) and spends nothing", async () => {
    const member = await memberWith(500);
    const order = await newOrder({ member, draft: true });
    const response = await redeem(order, 100);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(
      response.body.error?.code ?? response.body.code,
      JSON.stringify(response.body),
    ).toBe("ORDER_NOT_PAYABLE");
    expect(await pointsTenders(order)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(500);
  });

  it("POS-936-PTS-28 a redeem needs a signed-in cashier", async () => {
    const member = await memberWith(500);
    const order = await newOrder({ member });
    const response = await agent(app)
      .post(`/api/pos/orders/${order.id}/points/redeem`)
      .set(world.headers)
      .set(originHeader)
      .send({ points: 100, idempotencyKey: randomUUID() });
    expect(response.status).toBe(401);
    const account = await agent(app)
      .get(`/api/pos/orders/${order.id}/points`)
      .set(world.headers);
    expect(account.status).toBe(401);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(500);
  });
});

// ---- replay and concurrency ------------------------------------------------------

describe("POS-936-PTS one effect for replays and parallel requests", () => {
  it("POS-936-PTS-30 replaying the same key spends the points once", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const key = randomUUID();
    const first = await redeem(order, 100, { key });
    const second = await redeem(order, 100, { key });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    expect(redeemed(second.status), JSON.stringify(second.body)).toBe(true);
    expect(await pointsTenders(order)).toHaveLength(1);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    const redeemRows = (
      await ledgerOf(world.tenant.tenantId, member.id)
    ).filter((row) => row.type === "redeem");
    expect(redeemRows).toHaveLength(1);
  });

  it("POS-936-PTS-31 two parallel requests with the same key give one effect", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const key = randomUUID();
    const results = await Promise.all([
      redeem(order, 100, { key }),
      redeem(order, 100, { key }),
    ]);
    expect(
      results.some((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toBe(true);
    // No server error from the race.
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(await pointsTenders(order)).toHaveLength(1);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
  });

  it("POS-936-PTS-32 two parallel requests with different keys cannot pay the same bill twice", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    // Each alone fits the bill (Rp54.950); together they would be Rp109.900.
    const results = await Promise.all([
      redeem(order, MAX_POINTS_FULL_BILL),
      redeem(order, MAX_POINTS_FULL_BILL),
    ]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.filter((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toHaveLength(1);
    const tenders = await pointsTenders(order);
    expect(tenders).toHaveLength(1);
    const total = tenders.reduce((sum, row) => sum + Number(row.amount_idr), 0);
    expect(total).toBeLessThanOrEqual(ORDER_TOTAL_IDR);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
      5_000 - MAX_POINTS_FULL_BILL,
    );
  });

  it("POS-936-PTS-33 one balance spent on two bills at once never goes below zero", async () => {
    const member = await memberWith(600);
    const orderOne = await newOrder({ member });
    const orderTwo = await newOrder({ member });
    // 400 + 400 = 800 > 600: only one can succeed.
    const results = await Promise.all([
      redeem(orderOne, 400),
      redeem(orderTwo, 400),
    ]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.filter((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toHaveLength(1);
    const spent =
      (await pointsTenders(orderOne)).length +
      (await pointsTenders(orderTwo)).length;
    expect(spent).toBe(1);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(200);
  });
});

// ---- ledger and GL ------------------------------------------------------------------

describe("POS-936-PTS ledger and GL stay consistent", () => {
  it("POS-936-PTS-40 the liability released equals the tender value and the balance equals the ledger sum", async () => {
    const member = await memberWith(2_000);
    const order = await newOrder({ member });
    const response = await redeem(order, 250);
    expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);

    const rows = await ledgerOf(world.tenant.tenantId, member.id);
    const redeemRows = rows.filter((row) => row.type === "redeem");
    expect(redeemRows).toHaveLength(1);
    const [tender] = await pointsTenders(order);
    // Rp17.500 handed to the bill is exactly the Rp17.500 liability released.
    expect(Math.abs(Number(redeemRows[0]!.points))).toBe(250);
    expect(Math.abs(Number(redeemRows[0]!.liability_idr))).toBe(
      Number(tender!.amount_idr),
    );
    expect(Number(tender!.amount_idr)).toBe(250 * POINT_VALUE_IDR);
    // balance = what the ledger adds up to.
    const sum = rows.reduce(
      (total, row) =>
        total +
        (row.type === "redeem"
          ? -Math.abs(Number(row.points))
          : Number(row.points)),
      0,
    );
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(1_750);
    expect(sum).toBe(1_750);
  });

  it("POS-936-PTS-41 every journal entry of the tenant is balanced after redeems (debit = credit)", async () => {
    const member = await memberWith(3_000);
    const order = await newOrder({ member });
    const response = await redeem(order, 300);
    expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);
    const unbalanced = await owner.query<{ entry_id: string }>(
      `SELECT entry_id FROM journal_lines
        WHERE tenant_id = $1
        GROUP BY entry_id
       HAVING sum(debit_idr) <> sum(credit_idr)`,
      [world.tenant.tenantId],
    );
    expect(unbalanced.rows).toEqual([]);
  });
});

// ---- tenant / outlet isolation ---------------------------------------------------------

describe("POS-936-PTS other tenants and outlets", () => {
  it("POS-936-PTS-50 a cashier of another tenant sees and spends nothing of this tenant's order", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    // Their own host: the order does not exist in their tenant.
    const ownHost = { Host: other.tenant.hostname };
    const read = await other.cashier.client
      .get(`/api/pos/orders/${order.id}/points`)
      .set(ownHost)
      .set(originHeader);
    expect([403, 404], JSON.stringify(read.body)).toContain(read.status);
    const spend = await redeem(order, 100, {
      who: other.cashier,
      headers: ownHost,
    });
    expect([403, 404], JSON.stringify(spend.body)).toContain(spend.status);
    // Their session on this tenant's host: no role here.
    const onOurHost = await redeem(order, 100, { who: other.cashier });
    expect([401, 403, 404], JSON.stringify(onOurHost.body)).toContain(
      onOurHost.status,
    );
    expect(await pointsTenders(order)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(1_000);
  });

  it("POS-936-PTS-51 a cashier with a role only in outlet A cannot use points on an outlet B order", async () => {
    const member = await memberWith(1_000);
    const inB = await newOrder({ member, outletId: world.outletB });
    const read = await get(inB, world.outletACashier);
    expect([403, 404], JSON.stringify(read.body)).toContain(read.status);
    const spend = await redeem(inB, 100, { who: world.outletACashier });
    expect([403, 404], JSON.stringify(spend.body)).toContain(spend.status);
    expect(await pointsTenders(inB)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(1_000);

    // The same cashier still works in their own outlet.
    const inA = await newOrder({ member });
    const own = await redeem(inA, 100, { who: world.outletACashier });
    expect(redeemed(own.status), JSON.stringify(own.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
  });

  it("POS-936-PTS-52 an order id that does not exist answers 404 on all three routes", async () => {
    const ghost: CreatedOrder = {
      id: createUlid(),
      outletId: world.tenant.outletId,
    };
    expect((await get(ghost)).status).toBe(404);
    expect((await quote(ghost, 100)).status).toBe(404);
    expect((await redeem(ghost, 100)).status).toBe(404);
  });
});

// ---- points tender locks the bill's member and refunds --------------------------------

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: world.tenant.tenantId,
    brandId: null,
    deviceId: DEVICE_ID,
  });

const errorCodeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

const setCustomer = (order: CreatedOrder, body: Record<string, unknown>) =>
  world.cashier.client
    .put(`/api/pos/orders/${order.id}/customer`)
    .set(world.headers)
    .set(originHeader)
    .send(body);

async function customerOf(order: CreatedOrder): Promise<string | null> {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ customer_profile_id: string | null }>(
      "SELECT customer_profile_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows[0]?.customer_profile_id ?? null;
}

async function tenderRowCount(order: CreatedOrder): Promise<number> {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2",
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return Number(rows[0]?.count);
}

describe("POS-936-PTS a captured points tender locks the member and cannot be refunded", () => {
  it("POS-936-PTS-60 a refund of an order with a captured points tender is refused (409 REFUND_POINTS_TENDER_UNSUPPORTED) and nothing changes", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder({ member });
    // Rp50 in cash first so that 785 points (Rp54.950) settle the rest exactly.
    await seedCashTender(order, ORDER_TOTAL_IDR - MAX_VALUE_FULL_BILL);
    const paid = await redeem(order, MAX_POINTS_FULL_BILL);
    expect(redeemed(paid.status), JSON.stringify(paid.body)).toBe(true);
    const statusNow = (await orderDetail(order)).body.data.status as string;
    const completed = await world.cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/complete`,
      )
      .set(world.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({
        idempotencyKey: randomUUID(),
        expectedStatus: statusNow,
      });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const balanceBefore = await balanceOf(world.tenant.tenantId, member.id);
    const ledgerBefore = (await ledgerOf(world.tenant.tenantId, member.id))
      .length;
    const tendersBefore = await tenderRowCount(order);
    const pointsBefore = await pointsTenders(order);

    const { override } = await createPosOverride(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(world.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      world.cashier.userId,
      {
        outletId: order.outletId,
        action: "refund",
        valueIdr: 10_000,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: order.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(world.supervisor.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    const refund = await world.cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/corrections/refund`,
      )
      .set(world.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({
        idempotencyKey: randomUUID(),
        amountIdr: 10_000,
        reason: "customer_cancelled",
        reasonNote: "Pelanggan salah pesan",
        approvedBy: world.supervisor.userId,
        overrideId: override.id,
      });
    expect(refund.status, JSON.stringify(refund.body)).toBe(409);
    expect(errorCodeOf(refund.body)).toBe("REFUND_POINTS_TENDER_UNSUPPORTED");

    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
      balanceBefore,
    );
    expect((await ledgerOf(world.tenant.tenantId, member.id)).length).toBe(
      ledgerBefore,
    );
    expect(await tenderRowCount(order)).toBe(tendersBefore);
    expect(await pointsTenders(order)).toEqual(pointsBefore);
  });

  it("POS-936-PTS-61 once points are redeemed the bill's member cannot be detached or swapped (409 ORDER_HAS_POINTS_TENDER)", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });

    // Control: before any points tender the member can still be removed, so
    // the refusal below is about the points tender and nothing else.
    const free = await newOrder({ member });
    const detachFree = await setCustomer(free, { customerProfileId: null });
    expect(detachFree.status, JSON.stringify(detachFree.body)).toBe(200);
    expect(await customerOf(free)).toBeNull();

    const paid = await redeem(order, 100);
    expect(redeemed(paid.status), JSON.stringify(paid.body)).toBe(true);

    const detach = await setCustomer(order, { customerProfileId: null });
    expect(detach.status, JSON.stringify(detach.body)).toBe(409);
    expect(errorCodeOf(detach.body)).toBe("ORDER_HAS_POINTS_TENDER");

    const number = `+62812${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const stranger = await seedMember(world.tenant.tenantId, {
      whatsappHash: await whatsAppDigest(number),
    });
    const swap = await setCustomer(order, { whatsappNumber: number });
    expect(swap.status, JSON.stringify(swap.body)).toBe(409);
    expect(errorCodeOf(swap.body)).toBe("ORDER_HAS_POINTS_TENDER");

    // Still the original member, with the points still spent from them.
    expect(await customerOf(order)).toBe(member.id);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await balanceOf(world.tenant.tenantId, stranger.id)).toBe(0);
    expect(await pointsTenders(order)).toHaveLength(1);
  });

  // POS-936-PTS-62 (edge mode: EDGE_MODE=true answers 409 POINTS_NEED_CLOUD) is
  // not written: EDGE_MODE is read when the process boots, and the shared test
  // process runs the cloud app. Edge tests boot a separate process for it
  // (edge-boot-pepper.test.ts), which is out of scope for this file.
});
