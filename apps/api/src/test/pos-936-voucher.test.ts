// POS 936 part A (legend-hpgyw): paying the remaining bill with a voucher.
//
// Written from the shared contract (packages/shared/src/pos: applyPosDiscount,
// removePosDiscount, addPosTender, posOrderDetailSchema; packages/shared/src/crm
// voucher schemas) and the founder money rules in docs/briefs/1039-sub-shared.md,
// not from the service code. Fixtures follow pos-order-version.test.ts (real
// Express app, RLS database, device token + open shift for cash tenders) and
// order-promo-db.test.ts (a value voucher seeded with code_hash = sha256(code)).
//
// Money rules proved here (founder: nobody is paid more, the outlet never loses):
//   - the server computes the cut: the client never sends an amount;
//   - a cut above the REMAINING bill (total minus tenders already allocated),
//     not only above the subtotal, is refused;
//   - PBJT 10% (+ service, none configured here) is recomputed on the net
//     subtotal after the cut, so the guest is not charged tax on money waived;
//   - a voucher is used once: two concurrent requests and a replayed
//     idempotency key have ONE effect; removing a discount releases that
//     voucher only, and a second removal (new key or same key) can never
//     release the voucher again once it was re-applied elsewhere.
//
// Assumptions where the contract is silent:
//   - a voucher is applied through POST .../discounts with source "voucher",
//     kind "amount", voucherCode and reason "promo_engine" (CONTRACT-GAPS says
//     the body needs a kind and reason for vouchers; this is the neutral pair).
//     The server derives the rupiah from the voucher (valueIdr), never the body.
//   - CTO decision (rule that limits payment): a voucher worth more than the
//     remaining bill is REFUSED 422 DISCOUNT_EXCEEDS_SUBTOTAL, never capped;
//     bill, tenders and the voucher stay unchanged.
//   - CTO decision: one promo/voucher per order. A second voucher is refused
//     409 CONFLICT and stays unused; the first stays used until removed, and
//     removing it frees it and reprices the bill.
//   - a voucher that is unknown, from another tenant or already used is
//     refused with 404, 409 or 422 and changes nothing.
//   - another tenant or another outlet reaches an order only as 404 (or 403
//     for the outlet path); the order and the voucher stay untouched.
//   - the first order is Kopi x2 = Rp50.000 + PBJT 10% = Rp55.000 (as in
//     pos-discount-threshold-cap.test.ts).

import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const TOTAL_IDR = 55_000;

type World = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  deviceId: string;
  userId: string;
  client: ReturnType<typeof agent>;
  otherOutletId: string;
};

let app: Express;
let worldA: World;
let worldB: World;
const devices = new Map<string, { tenantId: string; outletId: string }>();
const sha256 = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");

/** Minimal gapless receipt double (an order covered in full needs a receipt). */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      sequence += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `POS9-${String(sequence).padStart(6, "0")}`,
        sequenceNumber: sequence,
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
    async voidForOrder() {
      return null;
    },
  };
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function seedWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    role: randomUUID(),
    device: randomUUID(),
    otherOutlet: randomUUID(),
  };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Voucher', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.role,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ]),
    ],
  );
  // A second outlet of the same tenant (same brand and legal entity).
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $2, tenant_id, brand_id, legal_entity_id, $3, 'Outlet Lain', address, timezone, opening_hours, status
       FROM outlets WHERE id = $1`,
    [
      tenant.outletId,
      ids.otherOutlet,
      `OUT-B-${randomUUID().slice(0, 6)}`.toUpperCase(),
    ],
  );
  const client = agent(app);
  await signUp(client, `Kasir ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.role],
  );
  devices.set(ids.device, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Voucher Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await db.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-VCH', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi: ids.kopi,
    deviceId: ids.device,
    userId,
    client,
    otherOutletId: ids.otherOutlet,
  };
}

function deviceToken(world: World) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: world.tenant.tenantId,
    brandId: null,
    deviceId: world.deviceId,
  });
}

/** Calls as the world's cashier on its terminal; `outletId` defaults to its own. */
function pos(world: World, outletId = world.tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const authed = (request: Test) =>
    request
      .set(world.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken(world));
  return {
    create: () =>
      authed(world.client.post(base)).send({
        idempotencyKey: randomUUID(),
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: world.kopi, quantity: 2, modifierIds: [] }],
      }),
    get: (orderId: string) => authed(world.client.get(`${base}/${orderId}`)),
    submit: (orderId: string, expectedStatus: string) =>
      authed(world.client.post(`${base}/${orderId}/submit`)).send({
        idempotencyKey: randomUUID(),
        expectedStatus,
      }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      authed(world.client.post(`${base}/${orderId}/tenders`)).send({
        idempotencyKey: randomUUID(),
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    voucher: (orderId: string, code: string, idempotencyKey = randomUUID()) =>
      authed(world.client.post(`${base}/${orderId}/discounts`)).send({
        idempotencyKey,
        source: "voucher",
        kind: "amount",
        voucherCode: code,
        reason: "promo_engine",
      }),
    remove: (
      orderId: string,
      discountId: string,
      idempotencyKey = randomUUID(),
    ) =>
      authed(
        world.client.delete(
          `${base}/${orderId}/discounts/${encodeURIComponent(discountId)}`,
        ),
      ).send({ idempotencyKey }),
  };
}

type Order = {
  id: string;
  status: string;
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
  discounts: { id: string; source: string; amountIdr: number }[];
  tenders: { amountIdr: number; status: string }[];
};

async function openOrder(world: World): Promise<Order> {
  const created = await pos(world).create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(TOTAL_IDR);
  return created.body.data as Order;
}

async function readOrder(world: World, orderId: string): Promise<Order> {
  const read = await pos(world).get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as Order;
}

/** A value voucher, as the CRM stores it: only the code hash is kept. */
async function seedVoucher(world: World, valueIdr: number): Promise<string> {
  const code = `V${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;
  await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', $4, now() - interval '1 hour', NULL)`,
      [randomUUID(), world.tenant.tenantId, sha256(code), valueIdr],
    ),
  );
  return code;
}

async function voucherState(
  world: World,
  code: string,
): Promise<{ status: string; redeemedOrderId: string | null }> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<{ status: string; redeemed_order_id: string | null }>(
      "SELECT status, redeemed_order_id FROM vouchers WHERE tenant_id = $1 AND code_hash = $2",
      [world.tenant.tenantId, sha256(code)],
    ),
  );
  return {
    status: rows[0]!.status,
    redeemedOrderId: rows[0]!.redeemed_order_id,
  };
}

async function discountRows(world: World, orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_discounts
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [world.tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

const paidOf = (order: Order) =>
  order.tenders
    .filter((tender) => tender.status === "captured")
    .reduce((sum, tender) => sum + tender.amountIdr, 0);

/** The bill adds up: subtotal - discount + service + tax + rounding = total. */
function expectMoneyConsistent(order: Order) {
  expect(order.totalIdr).toBe(
    order.subtotalIdr -
      order.discountIdr +
      order.serviceChargeIdr +
      order.taxIdr +
      order.roundingIdr,
  );
  expect(order.discountIdr).toBe(
    order.discounts.reduce((sum, line) => sum + line.amountIdr, 0),
  );
  // PBJT 10% on the net subtotal, never on money that was waived.
  expect(order.taxIdr).toBe(
    Math.round((order.subtotalIdr - order.discountIdr) * 0.1),
  );
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    const device = devices.get(deviceId);
    return device && device.tenantId === tenantId ? device.outletId : null;
  });
  worldA = await seedWorld("v936a");
  worldB = await seedWorld("v936b");
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  for (const world of [worldA, worldB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      world.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("pos-936 voucher: the server computes the cut and the bill", () => {
  it("applies the voucher value, recomputes PBJT on the net subtotal and marks the voucher used", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 20_000);

    const res = await pos(worldA).voucher(order.id, code);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const after = res.body.data as Order;
    expect(after.discountIdr).toBe(20_000);
    expect(after.discounts).toHaveLength(1);
    expect(after.discounts[0]).toMatchObject({
      source: "voucher",
      amountIdr: 20_000,
    });
    expect(after.serviceChargeIdr).toBe(0);
    // (50.000 - 20.000) x 10% = 3.000; total 33.000.
    expect(after.taxIdr).toBe(3_000);
    expect(after.totalIdr).toBe(33_000);
    expectMoneyConsistent(after);

    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    // What the cashier reads back later is the same bill.
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 20_000,
      taxIdr: 3_000,
      totalIdr: 33_000,
    });
  });

  it("a voucher worth more than the whole bill cuts at most the bill: no negative total, tax on the net", async () => {
    // The promo engine prices the cut from the bill (never above the eligible
    // subtotal); the 422 rule applies when that cut exceeds what is still
    // owed (next test). Here the cut (<= Rp50.000) fits the unpaid Rp55.000.
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 1_000_000);

    const res = await pos(worldA).voucher(order.id, code);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const after = res.body.data as Order;
    expect(after.discountIdr).toBeGreaterThan(0);
    expect(after.discountIdr).toBeLessThanOrEqual(after.subtotalIdr);
    expect(after.totalIdr).toBeGreaterThanOrEqual(0);
    expectMoneyConsistent(after);
    expect((await voucherState(worldA, code)).status).toBe("redeemed");
  });

  it("a voucher above the REMAINING bill after a partial cash tender is refused 422; bill, tender and voucher stay as they were", async () => {
    const order = await openOrder(worldA);
    if (order.status === "draft") {
      const submitted = await pos(worldA).submit(order.id, "draft");
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    }
    const current = await readOrder(worldA, order.id);
    // Rp30.000 of the Rp55.000 bill is paid in cash; Rp25.000 remains.
    const cash = await pos(worldA).cash(order.id, current.status, 30_000);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(25_000);
    const before = await readOrder(worldA, order.id);

    // Rp40.000 is below the subtotal but above what is still owed.
    const code = await seedVoucher(worldA, 40_000);
    const res = await pos(worldA).voucher(order.id, code);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error?.code ?? res.body.code).toBe(
      "DISCOUNT_EXCEEDS_SUBTOTAL",
    );

    expect(await discountRows(worldA, order.id)).toBe(0);
    const after = await readOrder(worldA, order.id);
    expect(after).toMatchObject({
      discountIdr: 0,
      taxIdr: before.taxIdr,
      totalIdr: before.totalIdr,
      status: before.status,
    });
    expect(paidOf(after)).toBe(30_000);
    expect(after.tenders).toHaveLength(1);
    expect(await voucherState(worldA, code)).toEqual({
      status: "issued",
      redeemedOrderId: null,
    });
  });

  it("a small voucher after a partial tender cuts exactly its value and leaves the right remainder", async () => {
    const order = await openOrder(worldA);
    if (order.status === "draft")
      expect((await pos(worldA).submit(order.id, "draft")).status).toBe(200);
    const current = await readOrder(worldA, order.id);
    expect(
      (await pos(worldA).cash(order.id, current.status, 30_000)).status,
    ).toBe(201);

    const code = await seedVoucher(worldA, 10_000);
    const res = await pos(worldA).voucher(order.id, code);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const after = res.body.data as Order;
    expect(after.discountIdr).toBe(10_000);
    // (50.000 - 10.000) x 1,1 = 44.000; Rp30.000 paid, Rp14.000 remains.
    expect(after.totalIdr).toBe(44_000);
    expect(after.totalIdr - paidOf(after)).toBe(14_000);
    expectMoneyConsistent(after);
  });
});

describe("pos-936 voucher: used once, concurrent and replayed", () => {
  it("two orders racing for the same voucher: exactly one wins, the other is refused and untouched", async () => {
    const [first, second] = [
      await openOrder(worldA),
      await openOrder(worldA),
    ] as const;
    const code = await seedVoucher(worldA, 15_000);

    const results = await Promise.all([
      pos(worldA).voucher(first.id, code),
      pos(worldA).voucher(second.id, code),
    ]);
    const won = results.filter((res) => res.status < 300);
    const lost = results.filter((res) => res.status >= 300);
    expect(
      results.map((res) => res.status),
      JSON.stringify(results.map((res) => res.body)),
    ).toHaveLength(2);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect([404, 409, 422]).toContain(lost[0]!.status);

    const winnerId = results[0]!.status < 300 ? first.id : second.id;
    const loserId = winnerId === first.id ? second.id : first.id;
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(winnerId),
    });
    expect(await discountRows(worldA, winnerId)).toBe(1);
    expect(await discountRows(worldA, loserId)).toBe(0);
    expect(await readOrder(worldA, loserId)).toMatchObject({
      discountIdr: 0,
      totalIdr: TOTAL_IDR,
    });
    expect((await readOrder(worldA, winnerId)).discountIdr).toBe(15_000);
  });

  it("the same voucher sent twice at once with different keys lands one discount on the order", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 12_000);

    const results = await Promise.all([
      pos(worldA).voucher(order.id, code),
      pos(worldA).voucher(order.id, code),
    ]);
    expect(results.filter((res) => res.status < 300).length).toBeGreaterThan(0);
    for (const res of results)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(await discountRows(worldA, order.id)).toBe(1);
    const after = await readOrder(worldA, order.id);
    expect(after.discountIdr).toBe(12_000);
    expectMoneyConsistent(after);
  });

  it("two different vouchers racing onto one order: one is applied, the other is a 409 and stays unused", async () => {
    const order = await openOrder(worldA);
    const codeA = await seedVoucher(worldA, 10_000);
    const codeB = await seedVoucher(worldA, 5_000);

    const results = await Promise.all([
      pos(worldA).voucher(order.id, codeA),
      pos(worldA).voucher(order.id, codeB),
    ]);
    const won = results.filter((res) => res.status < 300);
    const lost = results.filter((res) => res.status >= 300);
    expect(won, JSON.stringify(results.map((res) => res.body))).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.status).toBe(409);

    expect(await discountRows(worldA, order.id)).toBe(1);
    const winnerCode = results[0]!.status < 300 ? codeA : codeB;
    const loserCode = winnerCode === codeA ? codeB : codeA;
    expect((await voucherState(worldA, winnerCode)).status).toBe("redeemed");
    expect(await voucherState(worldA, loserCode)).toEqual({
      status: "issued",
      redeemedOrderId: null,
    });
    expectMoneyConsistent(await readOrder(worldA, order.id));
  });

  it("replaying the same idempotency key returns the same discount and cuts once", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 20_000);
    const key = randomUUID();

    const first = await pos(worldA).voucher(order.id, code, key);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const replay = await pos(worldA).voucher(order.id, code, key);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);

    expect(replay.body.data.discounts).toHaveLength(1);
    expect(replay.body.data.discounts[0].id).toBe(
      first.body.data.discounts[0].id,
    );
    expect(await discountRows(worldA, order.id)).toBe(1);
    const after = await readOrder(worldA, order.id);
    expect(after).toMatchObject({ discountIdr: 20_000, totalIdr: 33_000 });
  });

  it("the same key replayed concurrently has one effect", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 20_000);
    const key = randomUUID();

    const results = await Promise.all([
      pos(worldA).voucher(order.id, code, key),
      pos(worldA).voucher(order.id, code, key),
    ]);
    expect(results.filter((res) => res.status < 300).length).toBeGreaterThan(0);
    for (const res of results)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(await discountRows(worldA, order.id)).toBe(1);
    expect((await readOrder(worldA, order.id)).discountIdr).toBe(20_000);
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
  });

  it("a used voucher is refused on another order and that order stays whole", async () => {
    const first = await openOrder(worldA);
    const second = await openOrder(worldA);
    const code = await seedVoucher(worldA, 10_000);
    expect((await pos(worldA).voucher(first.id, code)).status).toBeLessThan(
      300,
    );

    const again = await pos(worldA).voucher(second.id, code);
    expect([404, 409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await discountRows(worldA, second.id)).toBe(0);
    expect(await readOrder(worldA, second.id)).toMatchObject({
      discountIdr: 0,
      totalIdr: TOTAL_IDR,
    });
  });
});

describe("pos-936 voucher: another tenant or outlet", () => {
  it("a voucher of another tenant is not accepted and stays unused there", async () => {
    const order = await openOrder(worldA);
    const foreign = await seedVoucher(worldB, 20_000);

    const res = await pos(worldA).voucher(order.id, foreign);
    expect([404, 409, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(await discountRows(worldA, order.id)).toBe(0);
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 0,
      totalIdr: TOTAL_IDR,
    });
    expect((await voucherState(worldB, foreign)).status).toBe("issued");
  });

  it("another tenant's cashier cannot apply a voucher to, or remove one from, this tenant's order", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 20_000);
    const applied = await pos(worldA).voucher(order.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const discountId = applied.body.data.discounts[0].id as string;
    const spare = await seedVoucher(worldA, 5_000);

    // Same order id, sent from tenant B's host and cashier.
    const apply = await pos(worldB).voucher(order.id, spare);
    expect(apply.status, JSON.stringify(apply.body)).toBe(404);
    const remove = await pos(worldB).remove(order.id, discountId);
    expect(remove.status, JSON.stringify(remove.body)).toBe(404);

    expect(await discountRows(worldA, order.id)).toBe(1);
    expect((await voucherState(worldA, code)).status).toBe("redeemed");
    expect((await voucherState(worldA, spare)).status).toBe("issued");
  });

  it("an order of this outlet is not reachable through another outlet's path", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 20_000);
    const applied = await pos(worldA).voucher(order.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const discountId = applied.body.data.discounts[0].id as string;
    const spare = await seedVoucher(worldA, 5_000);

    const elsewhere = pos(worldA, worldA.otherOutletId);
    const apply = await elsewhere.voucher(order.id, spare);
    expect([403, 404], JSON.stringify(apply.body)).toContain(apply.status);
    const remove = await elsewhere.remove(order.id, discountId);
    expect([403, 404], JSON.stringify(remove.body)).toContain(remove.status);

    expect(await discountRows(worldA, order.id)).toBe(1);
    expect((await voucherState(worldA, code)).status).toBe("redeemed");
    expect((await voucherState(worldA, spare)).status).toBe("issued");
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 20_000,
      totalIdr: 33_000,
    });
  });
});

describe("pos-936 voucher: removing releases that voucher only", () => {
  it("a second voucher on the same order is refused 409; removing the first frees it and reprices the bill", async () => {
    const order = await openOrder(worldA);
    const codeA = await seedVoucher(worldA, 10_000);
    const codeB = await seedVoucher(worldA, 5_000);
    const appliedA = await pos(worldA).voucher(order.id, codeA);
    expect(appliedA.status, JSON.stringify(appliedA.body)).toBeLessThan(300);
    const lineA = (appliedA.body.data as Order).discounts[0]!;

    // One promo or voucher per order: the second is a conflict, nothing moves.
    const appliedB = await pos(worldA).voucher(order.id, codeB);
    expect(appliedB.status, JSON.stringify(appliedB.body)).toBe(409);
    expect(appliedB.body.error?.code ?? appliedB.body.code).toBe("CONFLICT");
    expect(await discountRows(worldA, order.id)).toBe(1);
    expect(await voucherState(worldA, codeB)).toEqual({
      status: "issued",
      redeemedOrderId: null,
    });
    expect(await voucherState(worldA, codeA)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 10_000,
      totalIdr: 44_000,
    });

    const removed = await pos(worldA).remove(order.id, lineA.id);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    const left = removed.body.data as Order;
    expect(left.discounts).toHaveLength(0);
    // Back to the full bill: Rp50.000 + PBJT Rp5.000.
    expect(left).toMatchObject({
      discountIdr: 0,
      taxIdr: 5_000,
      totalIdr: TOTAL_IDR,
    });
    expectMoneyConsistent(left);
    expect(await voucherState(worldA, codeA)).toEqual({
      status: "issued",
      redeemedOrderId: null,
    });
    // B was never touched by the removal.
    expect((await voucherState(worldA, codeB)).status).toBe("issued");
  });

  it("a freed voucher can be used again, and a repeated removal never frees it from its new order", async () => {
    const first = await openOrder(worldA);
    const second = await openOrder(worldA);
    const code = await seedVoucher(worldA, 10_000);
    const applied = await pos(worldA).voucher(first.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const discountId = applied.body.data.discounts[0].id as string;

    const removeKey = randomUUID();
    const removed = await pos(worldA).remove(first.id, discountId, removeKey);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    expect(removed.body.data).toMatchObject({
      discountIdr: 0,
      totalIdr: TOTAL_IDR,
    });
    expect((await voucherState(worldA, code)).status).toBe("issued");

    // The freed voucher goes onto the second order.
    const reused = await pos(worldA).voucher(second.id, code);
    expect(reused.status, JSON.stringify(reused.body)).toBeLessThan(300);
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(second.id),
    });

    // Same intent again, with a new key and with the old key: no second release.
    const newKey = await pos(worldA).remove(first.id, discountId);
    expect(newKey.status).toBeLessThan(500);
    const sameKey = await pos(worldA).remove(first.id, discountId, removeKey);
    expect(sameKey.status).toBeLessThan(500);

    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(second.id),
    });
    expect(await readOrder(worldA, second.id)).toMatchObject({
      discountIdr: 10_000,
      totalIdr: 44_000,
    });
  });
});
