// legend-1059 (area C, bead kuh0w, founder Q41): a cashier may release a wrong
// voucher and apply another one on the same order.
//
// Written from the shared contract (applyPosDiscount, removePosDiscount,
// addPosTender, posOrderDetailSchema), the founder money rules in
// docs/briefs/1039-sub-shared.md and pos-936-voucher.test.ts, not from the
// service code. Routes and fixtures are those of pos-936-voucher.test.ts.
//
//   POST   /api/outlets/:outletId/pos/orders/:orderId/discounts  { source: "voucher", voucherCode, ... }
//   DELETE /api/outlets/:outletId/pos/orders/:orderId/discounts/:discountId
//   POST   /api/outlets/:outletId/pos/orders/:orderId/tenders    (cash)
//
// Feature id: kuh0w (tests kuh0w-nn).
//
// Rules proven here (founder: nobody is paid more, the outlet never loses,
// a voucher is never used twice):
// - release, then apply another voucher (or the same one) on the SAME order
//   works: the released voucher is whole again (issued, no order), the new one
//   is redeemed to the order, the bill is repriced; the old line cannot free
//   the new voucher by being released again;
// - one live voucher per order stays a 409 (CTO decision of pos-936);
// - the cut is capped by the subtotal (Q40) and by the remaining bill (422);
// - release x apply x pay at the same time never leaves a voucher used twice,
//   a bill paid more than its total, or a completed bill paid less;
// - another tenant or outlet path can neither release nor re-use;
// - a training order prices a voucher without consuming it.
//
// Assumptions (also in the report):
// - applying through POST .../discounts with source "voucher", kind "amount",
//   reason "promo_engine" is the neutral body used by pos-936-voucher.test.ts.
// - training: legend-dbrw3 says a training sale prices the voucher and never
//   consumes it; here that holds through the POS discount route too.
// - releasing after a partial cash tender may be refused (then the voucher stays
//   with the order); the test accepts that and only requires nothing to move.

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
import {
  markTraining,
  owner as memberOwner,
} from "./member-loyalty-helpers.ts";

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
        number: `P1059-${String(sequence).padStart(6, "0")}`,
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
     VALUES ($1, $2, 'POS Kasir Voucher 1059', false, NULL, $3, false, '["tenant"]')`,
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
       VALUES ($1, $2, $3, 'Voucher Uji 1059', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-V1059', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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
  worldA = await seedWorld("v1059a");
  worldB = await seedWorld("v1059b");
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  for (const world of [worldA, worldB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      world.tenant.tenantId,
      randomUUID(),
    ]);
  await memberOwner.end();
  await owner.end();
});

/**
 * Discount lines the bill shows now. (Raw pos_order_discounts rows are not
 * counted: a released line may stay in the table as history.)
 */
async function liveDiscounts(world: World, orderId: string): Promise<number> {
  return (await readOrder(world, orderId)).discounts.length;
}

/** The discount line's id on an order, from the order read model. */
const lineOf = (order: Order, index = 0) => order.discounts[index]!;

/** Vouchers (of `codes`) whose redeemed_order_id points at `orderId`. */
async function redeemedOnOrder(
  world: World,
  orderId: string,
  codes: string[],
): Promise<string[]> {
  const holders: string[] = [];
  for (const code of codes) {
    const state = await voucherState(world, code);
    if (state.redeemedOrderId === ulidToUuid(orderId)) holders.push(code);
  }
  return holders;
}

/** Order submitted (payable) and its current status. */
async function payableOrder(world: World): Promise<Order> {
  const order = await openOrder(world);
  if (order.status === "draft") {
    const submitted = await pos(world).submit(order.id, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  return readOrder(world, order.id);
}

const UNUSED = { status: "issued", redeemedOrderId: null };

// ---- kuh0w (founder Q41): release a wrong voucher, apply another ---------------

describe("kuh0w release then apply another voucher on the same order", () => {
  it("kuh0w-01 a cashier releases a wrong voucher and applies a different one on the SAME order: 200, the bill is repriced to the second voucher", async () => {
    const order = await openOrder(worldA);
    const wrong = await seedVoucher(worldA, 10_000);
    const right = await seedVoucher(worldA, 5_000);
    const applied = await pos(worldA).voucher(order.id, wrong);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);

    const released = await pos(worldA).remove(
      order.id,
      lineOf(applied.body.data).id,
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    expect(await voucherState(worldA, wrong)).toEqual(UNUSED);

    const second = await pos(worldA).voucher(order.id, right);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    const after = second.body.data as Order;
    expect(after.discounts).toHaveLength(1);
    expect(after.discountIdr).toBe(5_000);
    // (50.000 - 5.000) x 1,1 = 49.500
    expect(after.totalIdr).toBe(49_500);
    expectMoneyConsistent(after);
    expect(await liveDiscounts(worldA, order.id)).toBe(1);
    expect(await voucherState(worldA, right)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    // The first voucher came back whole and was not touched by the second apply.
    expect(await voucherState(worldA, wrong)).toEqual(UNUSED);
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 5_000,
      totalIdr: 49_500,
    });
  });

  it("kuh0w-02 the released voucher can be applied again on the same order", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 10_000);
    const applied = await pos(worldA).voucher(order.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const released = await pos(worldA).remove(
      order.id,
      lineOf(applied.body.data).id,
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);

    const again = await pos(worldA).voucher(order.id, code);
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data).toMatchObject({
      discountIdr: 10_000,
      totalIdr: 44_000,
    });
    expect(await liveDiscounts(worldA, order.id)).toBe(1);
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
  });

  it("kuh0w-03 several release and apply rounds on one order always leave exactly one live voucher and the right bill", async () => {
    const order = await openOrder(worldA);
    const codes = [
      await seedVoucher(worldA, 10_000),
      await seedVoucher(worldA, 7_000),
      await seedVoucher(worldA, 3_000),
    ];
    let current: Order | null = null;
    for (const code of codes) {
      if (current) {
        const released = await pos(worldA).remove(order.id, lineOf(current).id);
        expect(released.status, JSON.stringify(released.body)).toBeLessThan(
          300,
        );
      }
      const applied = await pos(worldA).voucher(order.id, code);
      expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
      current = applied.body.data as Order;
      expect(current.discounts).toHaveLength(1);
    }
    const last = await readOrder(worldA, order.id);
    expect(last.discountIdr).toBe(3_000);
    expectMoneyConsistent(last);
    expect(await liveDiscounts(worldA, order.id)).toBe(1);
    expect(await redeemedOnOrder(worldA, order.id, codes)).toEqual([codes[2]]);
    expect(await voucherState(worldA, codes[0]!)).toEqual(UNUSED);
    expect(await voucherState(worldA, codes[1]!)).toEqual(UNUSED);
  });

  it("kuh0w-04 a released voucher goes back to the pool: another order uses it, then it cannot be used on a third order (never used twice)", async () => {
    const first = await openOrder(worldA);
    const second = await openOrder(worldA);
    const third = await openOrder(worldA);
    const code = await seedVoucher(worldA, 10_000);
    const replacement = await seedVoucher(worldA, 4_000);

    const applied = await pos(worldA).voucher(first.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    expect(
      (await pos(worldA).remove(first.id, lineOf(applied.body.data).id)).status,
    ).toBeLessThan(300);
    // The first order carries a replacement voucher now.
    const swap = await pos(worldA).voucher(first.id, replacement);
    expect(swap.status, JSON.stringify(swap.body)).toBeLessThan(300);

    const reuse = await pos(worldA).voucher(second.id, code);
    expect(reuse.status, JSON.stringify(reuse.body)).toBeLessThan(300);
    const blocked = await pos(worldA).voucher(third.id, code);
    expect([404, 409, 422], JSON.stringify(blocked.body)).toContain(
      blocked.status,
    );

    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(second.id),
    });
    expect(await liveDiscounts(worldA, first.id)).toBe(1);
    expect(await liveDiscounts(worldA, second.id)).toBe(1);
    expect(await liveDiscounts(worldA, third.id)).toBe(0);
    expect((await readOrder(worldA, first.id)).discountIdr).toBe(4_000);
    expect((await readOrder(worldA, third.id)).discountIdr).toBe(0);
  });

  it("kuh0w-05 releasing the old line again (same key or new key) never frees the voucher that replaced it", async () => {
    const order = await openOrder(worldA);
    const wrong = await seedVoucher(worldA, 10_000);
    const right = await seedVoucher(worldA, 5_000);
    const applied = await pos(worldA).voucher(order.id, wrong);
    const oldLine = lineOf(applied.body.data);
    const key = randomUUID();
    expect(
      (await pos(worldA).remove(order.id, oldLine.id, key)).status,
    ).toBeLessThan(300);
    expect((await pos(worldA).voucher(order.id, right)).status).toBeLessThan(
      300,
    );

    const sameKey = await pos(worldA).remove(order.id, oldLine.id, key);
    expect(sameKey.status).toBeLessThan(500);
    const newKey = await pos(worldA).remove(order.id, oldLine.id);
    expect(newKey.status).toBeLessThan(500);

    expect(await voucherState(worldA, right)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 5_000,
      totalIdr: 49_500,
    });
    expect(await liveDiscounts(worldA, order.id)).toBe(1);
  });

  it("kuh0w-06 while a voucher is live a second one is still a 409 and stays unused (one voucher per order)", async () => {
    const order = await openOrder(worldA);
    const live = await seedVoucher(worldA, 10_000);
    const extra = await seedVoucher(worldA, 5_000);
    expect((await pos(worldA).voucher(order.id, live)).status).toBeLessThan(
      300,
    );
    const second = await pos(worldA).voucher(order.id, extra);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(await voucherState(worldA, extra)).toEqual(UNUSED);
    expect((await readOrder(worldA, order.id)).discountIdr).toBe(10_000);
  });
});

describe("kuh0w the cut stays capped by the subtotal after release and apply (Q40)", () => {
  it("kuh0w-07 a huge voucher applied after a release cuts at most the subtotal: no negative total, tax on the net, used once", async () => {
    const order = await openOrder(worldA);
    const small = await seedVoucher(worldA, 5_000);
    const huge = await seedVoucher(worldA, 1_000_000);
    const applied = await pos(worldA).voucher(order.id, small);
    expect(
      (await pos(worldA).remove(order.id, lineOf(applied.body.data).id)).status,
    ).toBeLessThan(300);

    const res = await pos(worldA).voucher(order.id, huge);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const after = res.body.data as Order;
    expect(after.discountIdr).toBeGreaterThan(0);
    expect(after.discountIdr).toBeLessThanOrEqual(after.subtotalIdr);
    expect(after.totalIdr).toBeGreaterThanOrEqual(0);
    expectMoneyConsistent(after);
    expect(await liveDiscounts(worldA, order.id)).toBe(1);
    expect(await voucherState(worldA, huge)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    expect(await voucherState(worldA, small)).toEqual(UNUSED);
  });

  it("kuh0w-08 after a partial cash tender a swapped voucher worth more than the REMAINING bill is refused 422; the first voucher stays released, nothing is overpaid", async () => {
    const order = await payableOrder(worldA);
    const small = await seedVoucher(worldA, 5_000);
    const big = await seedVoucher(worldA, 40_000);
    const applied = await pos(worldA).voucher(order.id, small);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    // Total is now Rp49.500; Rp30.000 is paid in cash, Rp19.500 remains.
    const current = await readOrder(worldA, order.id);
    expect(
      (await pos(worldA).cash(order.id, current.status, 30_000)).status,
    ).toBe(201);
    const released = await pos(worldA).remove(
      order.id,
      lineOf(applied.body.data).id,
    );
    // Releasing may itself be refused once money is taken (then nothing moved).
    if (released.status >= 300) {
      expect(released.status).toBeLessThan(500);
      expect(await voucherState(worldA, small)).toEqual({
        status: "redeemed",
        redeemedOrderId: ulidToUuid(order.id),
      });
      return;
    }
    const swapped = await pos(worldA).voucher(order.id, big);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(422);
    expect(await voucherState(worldA, big)).toEqual(UNUSED);
    const after = await readOrder(worldA, order.id);
    expect(paidOf(after)).toBe(30_000);
    expect(paidOf(after)).toBeLessThanOrEqual(after.totalIdr);
    expectMoneyConsistent(after);
  });
});

describe("kuh0w release x apply x pay at the same time", () => {
  it("kuh0w-09 releasing the first voucher, applying the second and paying in cash all at once: no voucher used twice, the bill is never overpaid or left under-paid", async () => {
    for (let round = 0; round < 6; round++) {
      const order = await payableOrder(worldA);
      const first = await seedVoucher(worldA, 10_000);
      const second = await seedVoucher(worldA, 5_000);
      const applied = await pos(worldA).voucher(order.id, first);
      expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
      const line = lineOf(applied.body.data);
      const status = (await readOrder(worldA, order.id)).status;

      const results = await Promise.all([
        pos(worldA).remove(order.id, line.id),
        pos(worldA).voucher(order.id, second),
        pos(worldA).cash(order.id, status, 55_000),
      ]);
      for (const res of results)
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);

      const final = await readOrder(worldA, order.id);
      expectMoneyConsistent(final);
      // At most one voucher on the bill, and the books agree with the bill.
      expect(final.discounts.length).toBeLessThanOrEqual(1);
      expect(await liveDiscounts(worldA, order.id)).toBe(
        final.discounts.length,
      );
      const holders = await redeemedOnOrder(worldA, order.id, [first, second]);
      expect(holders).toHaveLength(final.discounts.length);
      // Nobody is paid more: the cash taken never exceeds the final bill.
      expect(paidOf(final)).toBeLessThanOrEqual(final.totalIdr);
      // A closed bill is paid in full: the outlet does not lose.
      if (final.status === "completed")
        expect(paidOf(final)).toBeGreaterThanOrEqual(final.totalIdr);
      // A voucher that is not on the bill is unused.
      for (const code of [first, second])
        if (!holders.includes(code))
          expect(await voucherState(worldA, code)).toEqual(UNUSED);
    }
  }, 60_000);

  it("kuh0w-10 releasing and applying at once on an unpaid order ends with exactly one consistent state; both vouchers are never used together", async () => {
    for (let round = 0; round < 6; round++) {
      const order = await openOrder(worldA);
      const first = await seedVoucher(worldA, 10_000);
      const second = await seedVoucher(worldA, 5_000);
      const applied = await pos(worldA).voucher(order.id, first);
      const line = lineOf(applied.body.data);

      const results = await Promise.all([
        pos(worldA).remove(order.id, line.id),
        pos(worldA).voucher(order.id, second),
      ]);
      for (const res of results)
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);

      const final = await readOrder(worldA, order.id);
      expectMoneyConsistent(final);
      expect(final.discounts.length).toBeLessThanOrEqual(1);
      expect(await liveDiscounts(worldA, order.id)).toBe(
        final.discounts.length,
      );
      const holders = await redeemedOnOrder(worldA, order.id, [first, second]);
      expect(holders).toHaveLength(final.discounts.length);
      // Whatever order the two requests ran in, the cashier can always finish
      // the swap afterwards: release what is live, apply the wanted one.
      if (final.discounts.length === 1 && holders[0] !== second) {
        const fix = await pos(worldA).remove(order.id, lineOf(final).id);
        expect(fix.status, JSON.stringify(fix.body)).toBeLessThan(300);
        const retry = await pos(worldA).voucher(order.id, second);
        expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(300);
      } else if (final.discounts.length === 0) {
        const retry = await pos(worldA).voucher(order.id, second);
        expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(300);
      }
      const settled = await readOrder(worldA, order.id);
      expect(settled.discountIdr).toBe(5_000);
      expect(await voucherState(worldA, second)).toEqual({
        status: "redeemed",
        redeemedOrderId: ulidToUuid(order.id),
      });
      expect(await voucherState(worldA, first)).toEqual(UNUSED);
    }
  }, 60_000);

  it("kuh0w-11 two cashiers' requests racing to apply the same released voucher on two orders: exactly one order gets it", async () => {
    const one = await openOrder(worldA);
    const two = await openOrder(worldA);
    const code = await seedVoucher(worldA, 8_000);
    const applied = await pos(worldA).voucher(one.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    expect(
      (await pos(worldA).remove(one.id, lineOf(applied.body.data).id)).status,
    ).toBeLessThan(300);

    const results = await Promise.all([
      pos(worldA).voucher(one.id, code),
      pos(worldA).voucher(two.id, code),
    ]);
    const won = results.filter((res) => res.status < 300);
    expect(won, JSON.stringify(results.map((res) => res.body))).toHaveLength(1);
    for (const res of results.filter((r) => r.status >= 300))
      expect([404, 409, 422]).toContain(res.status);
    const winner = results[0]!.status < 300 ? one : two;
    const loser = winner === one ? two : one;
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(winner.id),
    });
    expect(await liveDiscounts(worldA, winner.id)).toBe(1);
    expect(await liveDiscounts(worldA, loser.id)).toBe(0);
  });
});

describe("kuh0w another tenant or outlet cannot release or re-apply", () => {
  it("kuh0w-12 another tenant's cashier cannot release this order's voucher; the owner can, and then another tenant still cannot use the released code", async () => {
    const order = await openOrder(worldA);
    const code = await seedVoucher(worldA, 10_000);
    const applied = await pos(worldA).voucher(order.id, code);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const line = lineOf(applied.body.data);

    const foreignRelease = await pos(worldB).remove(order.id, line.id);
    expect(foreignRelease.status, JSON.stringify(foreignRelease.body)).toBe(
      404,
    );
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });

    const released = await pos(worldA).remove(order.id, line.id);
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    expect(await voucherState(worldA, code)).toEqual(UNUSED);

    const theirOrder = await openOrder(worldB);
    const foreignUse = await pos(worldB).voucher(theirOrder.id, code);
    expect([404, 409, 422], JSON.stringify(foreignUse.body)).toContain(
      foreignUse.status,
    );
    expect(await liveDiscounts(worldB, theirOrder.id)).toBe(0);
    expect(await voucherState(worldA, code)).toEqual(UNUSED);

    // The owner tenant can apply it again, on the same order.
    const again = await pos(worldA).voucher(order.id, code);
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
  });

  it("kuh0w-13 an order is not reachable through another outlet's path, for release or for a swap; the right path still swaps", async () => {
    const order = await openOrder(worldA);
    const wrong = await seedVoucher(worldA, 10_000);
    const right = await seedVoucher(worldA, 5_000);
    const applied = await pos(worldA).voucher(order.id, wrong);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    const line = lineOf(applied.body.data);

    const elsewhere = pos(worldA, worldA.otherOutletId);
    const release = await elsewhere.remove(order.id, line.id);
    expect([403, 404], JSON.stringify(release.body)).toContain(release.status);
    const apply = await elsewhere.voucher(order.id, right);
    expect([403, 404], JSON.stringify(apply.body)).toContain(apply.status);
    expect(await voucherState(worldA, wrong)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(order.id),
    });
    expect(await voucherState(worldA, right)).toEqual(UNUSED);

    // Control on the right outlet path: release then apply the other one.
    expect((await pos(worldA).remove(order.id, line.id)).status).toBeLessThan(
      300,
    );
    const swapped = await pos(worldA).voucher(order.id, right);
    expect(swapped.status, JSON.stringify(swapped.body)).toBeLessThan(300);
    expect(await readOrder(worldA, order.id)).toMatchObject({
      discountIdr: 5_000,
      totalIdr: 49_500,
    });
  });
});

describe("kuh0w training mode changes no money", () => {
  async function trainingOrder(): Promise<Order> {
    const order = await openOrder(worldA);
    await markTraining(worldA.tenant.tenantId, order.id);
    const stamped = await owner.query<{ is_training: boolean }>(
      "SELECT is_training FROM pos_orders WHERE tenant_id = $1 AND order_id = $2",
      [worldA.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(stamped.rows[0]?.is_training).toBe(true);
    return order;
  }

  it("kuh0w-14 on a training order a voucher is priced but never consumed, also across a release and a swap; the voucher is still whole for a real bill", async () => {
    // Assumption (legend-dbrw3 / crm-promo-training.test.ts): a training sale
    // prices the voucher and leaves it issued.
    const training = await trainingOrder();
    const wrong = await seedVoucher(worldA, 10_000);
    const right = await seedVoucher(worldA, 5_000);

    const applied = await pos(worldA).voucher(training.id, wrong);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    expect(await voucherState(worldA, wrong)).toEqual(UNUSED);

    const released = await pos(worldA).remove(
      training.id,
      lineOf(applied.body.data).id,
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    const swapped = await pos(worldA).voucher(training.id, right);
    expect(swapped.status, JSON.stringify(swapped.body)).toBeLessThan(300);
    expect(await voucherState(worldA, wrong)).toEqual(UNUSED);
    expect(await voucherState(worldA, right)).toEqual(UNUSED);

    // A real bill still gets the full value of the same vouchers.
    const real = await openOrder(worldA);
    const used = await pos(worldA).voucher(real.id, wrong);
    expect(used.status, JSON.stringify(used.body)).toBeLessThan(300);
    expect(used.body.data.discountIdr).toBe(10_000);
    expect(await voucherState(worldA, wrong)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(real.id),
    });
  });

  it("kuh0w-15 releasing a voucher on a training order never frees a voucher that a real bill holds", async () => {
    const real = await openOrder(worldA);
    const training = await trainingOrder();
    const code = await seedVoucher(worldA, 10_000);
    const onReal = await pos(worldA).voucher(real.id, code);
    expect(onReal.status, JSON.stringify(onReal.body)).toBeLessThan(300);
    const spare = await seedVoucher(worldA, 5_000);
    const onTraining = await pos(worldA).voucher(training.id, spare);
    expect(onTraining.status, JSON.stringify(onTraining.body)).toBeLessThan(
      300,
    );

    // Try to free the real bill's voucher through the training order.
    const cross = await pos(worldA).remove(
      training.id,
      lineOf(onReal.body.data).id,
    );
    expect(cross.status, JSON.stringify(cross.body)).toBeLessThan(500);
    expect(await voucherState(worldA, code)).toEqual({
      status: "redeemed",
      redeemedOrderId: ulidToUuid(real.id),
    });
    expect((await readOrder(worldA, real.id)).discountIdr).toBe(10_000);
  });
});
