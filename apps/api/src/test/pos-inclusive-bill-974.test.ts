// Brief 974 card B (legend-npnh): harga inklusif (nett) di kasir POS. Written
// from docs/briefs/974-pos-laci-inklusif.md and the shared contract, never
// from computePosBill. Fail-first: today the POS bill refuses an inclusive
// price rule.
//
// Real Express app + PostgreSQL (cashierFixture of pos-cashier-test-helpers).
// Proof 3: an inclusive POS bill keeps the guest price as the total, with
//   net + service + tax = total and no tax on top of the gross price.
// Proof 4: the sales journal split (orderRevenueSplit) and the refund split
//   (refundSplit) of the stored inclusive order balance, and the tax payable is
//   never smaller than the tax collected.
// Proof 5: nett versus gross never leaks across tenants or outlets.
// Also: POS total = QR order total for the same item and outlet, and one table
//   session holds one pricing mode (409 QR_ORDER_PRICING_MODE_MIXED).
//
// Assumptions (brief silent, also reported):
//  - Fixture: Nasi Goreng Rp30.000 gross, PBJT 10% inclusive item rule
//    (tax = 30.000 - round_half_up(30.000 / 1,1) = 2.727, net 27.273); every
//    other item keeps the exclusive class rule. No service charge rule: the
//    cashierFixture zone carries 0% service.
//  - The POS order response does not expose prices_include_tax (the DTO's
//    money identity is exclusive-only), so the pricing mode, the parts and the
//    net are asserted on the stored `orders` row; the response is asserted for
//    status and totalIdr only.
//  - Outlet isolation: an outlet-scoped item rule (outlet_id set) applies only
//    to that outlet; a sibling outlet of the same tenant stays exclusive.
//  - A POS order of a table session is created with serviceType dine_in and the
//    session id on an open_bill session confirmed by staff.
//  - A cart mixing an inclusive and an exclusive item in ONE POS order is
//    refused with a 4xx and writes no order (the QR rule); the code is not
//    asserted.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { agent, originHeader, signUp } from "./helpers.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { orderRevenueSplit } from "../services/order-revenue.ts";
import { refundSplit } from "../services/pos-order-corrections.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";
import { fixtures, owner } from "./floor-test-helpers.ts";

const MEAL_GROSS = 30_000;
const MEAL = { gross: MEAL_GROSS, net: 27_273, tax: 2_727 };

const fixturesToClean: CashierFixture[] = [];

afterAll(async () => {
  for (const fx of fixturesToClean)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

async function world(label: string): Promise<CashierFixture> {
  const fx = await cashierFixture(label);
  fixturesToClean.push(fx);
  return fx;
}

/** An inclusive PBJT 10% item rule for Nasi Goreng, tenant-wide or one outlet. */
async function addInclusiveMealRule(
  fx: CashierFixture,
  outletId: string | null,
): Promise<void> {
  await asCashierTenant(fx.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, $3, $4, 'PB1 10% nett', 'pbjt', 1000, NULL, '[]', $5,
               true, true, true, 1, '2026-01-01', 'published', now(), $6)`,
      [
        randomUUID(),
        fx.tenant.tenantId,
        outletId,
        `PBJT-NETT-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify({
          itemClasses: [],
          categoryIds: [],
          itemIds: [fx.ids.meal],
        }),
        fx.staff.userId,
      ],
    ),
  );
}

type StoredOrder = {
  inclusive: boolean;
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
};

async function storedOrder(
  fx: CashierFixture,
  orderId: string,
): Promise<StoredOrder> {
  const { rows } = await owner.query<Record<string, string | boolean>>(
    `SELECT prices_include_tax, subtotal_idr::text, discount_idr::text,
            service_charge_idr::text, tax_idr::text, rounding_idr::text, total_idr::text
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  const row = rows[0];
  if (!row) throw new Error("order row missing");
  return {
    inclusive: row.prices_include_tax as boolean,
    subtotalIdr: Number(row.subtotal_idr),
    discountIdr: Number(row.discount_idr),
    serviceChargeIdr: Number(row.service_charge_idr),
    taxIdr: Number(row.tax_idr),
    roundingIdr: Number(row.rounding_idr),
    totalIdr: Number(row.total_idr),
  };
}

async function posMealOrder(
  fx: CashierFixture,
  quantity = 1,
  extra: Record<string, unknown> = {},
  base: string = fx.base,
) {
  const response = await fx.post(base, {
    channel: "pos",
    serviceType: "takeaway",
    items: [fx.line({ quantity })],
    idempotencyKey: randomUUID(),
    ...extra,
  });
  return response;
}

describe("legend-npnh bukti 3: bill inklusif di kasir", () => {
  it("npnh-3a one inclusive item: guest pays the gross price; net + tax = total; tax is not added on top", async () => {
    const fx = await world("inc-bill");
    await addInclusiveMealRule(fx, null);
    const created = await posMealOrder(fx);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.totalIdr).toBe(MEAL.gross);

    const order = await storedOrder(fx, created.body.data.id as string);
    expect(order).toMatchObject({
      inclusive: true,
      subtotalIdr: MEAL.gross,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: MEAL.tax,
      roundingIdr: 0,
      totalIdr: MEAL.gross,
    });
    // Not 30.000 + 3.000: the 10% is inside the price.
    expect(order.totalIdr).not.toBe(MEAL.gross + 3_000);
    expect(
      orderNetSubtotalIdr({
        subtotalIdr: order.subtotalIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        pricesIncludeTax: order.inclusive,
      }),
    ).toBe(MEAL.net);
  });

  it("npnh-3b exclusive items keep service and tax on top (regression)", async () => {
    const fx = await world("inc-regress");
    const created = await posMealOrder(fx);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.totalIdr).toBe(33_000);
    const order = await storedOrder(fx, created.body.data.id as string);
    expect(order).toMatchObject({
      inclusive: false,
      subtotalIdr: 30_000,
      taxIdr: 3_000,
      totalIdr: 33_000,
    });
  });

  it("npnh-3c any quantity: total stays the gross price, net + service + tax = total, rounding never short-changes the outlet", async () => {
    const fx = await world("inc-qty");
    await addInclusiveMealRule(fx, null);
    for (const quantity of [1, 2, 3, 4, 5, 7]) {
      const gross = MEAL_GROSS * quantity;
      const created = await posMealOrder(fx, quantity);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const order = await storedOrder(fx, created.body.data.id as string);
      expect(order.inclusive).toBe(true);
      // The guest never pays more or less than the menu price.
      expect(order.totalIdr).toBe(gross);
      expect(order.subtotalIdr).toBe(gross);
      const net = orderNetSubtotalIdr({
        subtotalIdr: order.subtotalIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        pricesIncludeTax: true,
      });
      expect(net + order.serviceChargeIdr + order.taxIdr).toBe(order.totalIdr);
      // Tax payable is at least the exact backed-out share (floor of 10/110).
      expect(order.taxIdr).toBeGreaterThanOrEqual(
        Math.floor((gross * 1000) / 11_000),
      );
      // And never more than a rupiah above it: no tax counted twice.
      expect(order.taxIdr).toBeLessThanOrEqual(
        Math.ceil((gross * 1000) / 11_000),
      );
      expect(net).toBeGreaterThan(0);
    }
  });

  it("npnh-3d a cart mixing an inclusive and an exclusive item in one POS order is refused and writes no order", async () => {
    const fx = await world("inc-mixcart");
    await addInclusiveMealRule(fx, null);
    const count = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1",
            [fx.tenant.tenantId],
          )
        ).rows[0]!.n,
      );
    const before = await count();
    const refused = await fx.post(fx.base, {
      channel: "pos",
      serviceType: "takeaway",
      items: [
        fx.line(),
        fx.line({ menuItemId: fx.ids.coffee, modifierIds: [fx.ids.modifier] }),
      ],
      idempotencyKey: randomUUID(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(await count()).toBe(before);
  });
});

describe("legend-npnh bukti 3: sama dengan pesanan QR", () => {
  it("npnh-3e the POS total equals the QR order total for the same item and outlet", async () => {
    const fx = await world("inc-qr");
    await addInclusiveMealRule(fx, null);

    const pos = await posMealOrder(fx);
    expect(pos.status, JSON.stringify(pos.body)).toBe(201);
    const posOrder = await storedOrder(fx, pos.body.data.id as string);

    const guest = await fx.newGuest("pay_first");
    const guestPost = (path: string, body: Record<string, unknown>) =>
      agent(fx.app)
        .post(`/api/table-sessions/${guest.sessionId}${path}`)
        .set(fx.headers)
        .set("Authorization", `Bearer ${guest.token}`)
        .set(originHeader)
        .send(body);
    const added = await guestPost("/cart/lines", {
      idempotencyKey: randomUUID(),
      modifierIds: [],
      menuItemId: fx.ids.meal,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const placed = await guestPost("/orders", {
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const qrOrder = await storedOrder(fx, placed.body.data.order.id as string);

    expect(qrOrder.inclusive).toBe(true);
    expect(posOrder.totalIdr).toBe(qrOrder.totalIdr);
    expect(posOrder.taxIdr).toBe(qrOrder.taxIdr);
    expect(posOrder.serviceChargeIdr).toBe(qrOrder.serviceChargeIdr);
    expect(posOrder.subtotalIdr).toBe(qrOrder.subtotalIdr);
  });
});

describe("legend-npnh: satu sesi meja satu mode harga", () => {
  async function openSession(fx: CashierFixture) {
    const guest = await fx.newGuest("open_bill");
    const confirmed = await fx.post(
      `/api/table-sessions/${guest.sessionId}/confirm`,
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return guest;
  }
  const sessionOrder = (
    fx: CashierFixture,
    sessionId: string,
    inclusiveItem: boolean,
  ) =>
    fx.post(fx.base, {
      channel: "pos",
      serviceType: "dine_in",
      tableSessionId: sessionId,
      items: [
        inclusiveItem
          ? fx.line()
          : fx.line({
              menuItemId: fx.ids.coffee,
              modifierIds: [fx.ids.modifier],
            }),
      ],
      idempotencyKey: randomUUID(),
    });
  const sessionOrderCount = async (fx: CashierFixture, sessionId: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1 AND table_session_id = $2",
          [fx.tenant.tenantId, sessionId],
        )
      ).rows[0]!.n,
    );

  it("npnh-mix-a an exclusive POS order after an inclusive one on the same session is 409 QR_ORDER_PRICING_MODE_MIXED; the same mode still joins", async () => {
    const fx = await world("inc-mixa");
    await addInclusiveMealRule(fx, null);
    const guest = await openSession(fx);

    const first = await sessionOrder(fx, guest.sessionId, true);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const same = await sessionOrder(fx, guest.sessionId, true);
    expect(same.status, JSON.stringify(same.body)).toBe(201);

    const refused = await sessionOrder(fx, guest.sessionId, false);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("QR_ORDER_PRICING_MODE_MIXED");
    expect(await sessionOrderCount(fx, guest.sessionId)).toBe(2);
  });

  it("npnh-mix-b an inclusive POS order after an exclusive one on the same session is 409 QR_ORDER_PRICING_MODE_MIXED", async () => {
    const fx = await world("inc-mixb");
    await addInclusiveMealRule(fx, null);
    const guest = await openSession(fx);

    const first = await sessionOrder(fx, guest.sessionId, false);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const refused = await sessionOrder(fx, guest.sessionId, true);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("QR_ORDER_PRICING_MODE_MIXED");
    expect(await sessionOrderCount(fx, guest.sessionId)).toBe(1);
  });
});

describe("legend-npnh bukti 4: jurnal dan refund inklusif seimbang", () => {
  type RevenueRow = Parameters<typeof orderRevenueSplit>[0];
  const toRow = (order: StoredOrder): RevenueRow => ({
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.discountIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    roundingIdr: order.roundingIdr,
    totalIdr: order.totalIdr,
    pricesIncludeTax: order.inclusive,
  });

  it("npnh-4a the sales journal split of a stored inclusive POS order balances: gross sales = net, tax payable = tax collected", async () => {
    const fx = await world("inc-journal");
    await addInclusiveMealRule(fx, null);
    for (const quantity of [1, 3, 7]) {
      const created = await posMealOrder(fx, quantity);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const order = await storedOrder(fx, created.body.data.id as string);
      expect(order.inclusive).toBe(true);

      const split = orderRevenueSplit(toRow(order));
      expect(split.totalIdr).toBe(order.totalIdr);
      expect(split.grossSalesIdr).toBe(
        orderNetSubtotalIdr({
          subtotalIdr: order.subtotalIdr,
          serviceChargeIdr: order.serviceChargeIdr,
          taxIdr: order.taxIdr,
          pricesIncludeTax: true,
        }),
      );
      // Credits (sales + service + tax + rounding - discount) = cash/gateway debit.
      expect(
        split.grossSalesIdr -
          split.discountIdr +
          split.serviceChargeIdr +
          split.pbjtIdr +
          split.roundingIdr,
      ).toBe(order.totalIdr);
      // Tax payable is not smaller than the tax collected in the price.
      expect(split.pbjtIdr).toBeGreaterThanOrEqual(order.taxIdr);
    }
  });

  it("npnh-4b a discounted inclusive order still balances in the sales split", async () => {
    const fx = await world("inc-journal-disc");
    await addInclusiveMealRule(fx, null);
    const created = await posMealOrder(fx, 2);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = await storedOrder(fx, created.body.data.id as string);
    const discounted: StoredOrder = {
      ...order,
      discountIdr: 5_000,
      totalIdr: order.totalIdr - 5_000,
    };
    const split = orderRevenueSplit(toRow(discounted));
    expect(
      split.grossSalesIdr -
        split.discountIdr +
        split.serviceChargeIdr +
        split.pbjtIdr +
        split.roundingIdr,
    ).toBe(discounted.totalIdr);
    expect(split.pbjtIdr).toBeGreaterThanOrEqual(order.taxIdr);
  });

  it("npnh-4c a full refund of an inclusive POS order reverses exactly the sale: net + service + tax = refund, tax = tax collected", async () => {
    const fx = await world("inc-refund-full");
    await addInclusiveMealRule(fx, null);
    const created = await posMealOrder(fx, 3);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = await storedOrder(fx, created.body.data.id as string);

    const split = refundSplit(
      {
        subtotalIdr: order.subtotalIdr,
        discountIdr: order.discountIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        pricesIncludeTax: order.inclusive,
      } as unknown as Parameters<typeof refundSplit>[0],
      order.totalIdr,
    );
    expect(
      split.grossSalesIdr -
        split.discountIdr +
        split.serviceChargeIdr +
        split.pbjtIdr,
    ).toBe(order.totalIdr);
    expect(split.pbjtIdr).toBe(order.taxIdr);
    expect(split.grossSalesIdr).toBe(
      order.subtotalIdr - order.serviceChargeIdr - order.taxIdr,
    );
  });

  it("npnh-4d a partial refund balances and never reverses more tax than its share, so tax payable is not understated", async () => {
    const fx = await world("inc-refund-part");
    await addInclusiveMealRule(fx, null);
    const created = await posMealOrder(fx, 2); // 60.000 gross
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = await storedOrder(fx, created.body.data.id as string);
    const half = order.totalIdr / 2;

    const split = refundSplit(
      {
        subtotalIdr: order.subtotalIdr,
        discountIdr: order.discountIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        pricesIncludeTax: order.inclusive,
      } as unknown as Parameters<typeof refundSplit>[0],
      half,
    );
    expect(
      split.grossSalesIdr -
        split.discountIdr +
        split.serviceChargeIdr +
        split.pbjtIdr,
    ).toBe(half);
    expect(split.pbjtIdr).toBeGreaterThanOrEqual(0);
    expect(split.grossSalesIdr).toBeGreaterThan(0);
    // Tax left payable >= the exact remaining share (floor), never below it.
    expect(order.taxIdr - split.pbjtIdr).toBeGreaterThanOrEqual(
      Math.floor(order.taxIdr / 2),
    );
  });
});

describe("legend-npnh bukti 5: nett vs gross tidak bocor lintas tenant dan outlet", () => {
  it("npnh-5a another tenant's inclusive rule never makes this tenant's POS bill inclusive", async () => {
    const inclusiveTenant = await world("inc-iso-a");
    await addInclusiveMealRule(inclusiveTenant, null);
    const exclusiveTenant = await world("inc-iso-b");

    const nett = await posMealOrder(inclusiveTenant);
    const gross = await posMealOrder(exclusiveTenant);
    expect(nett.status, JSON.stringify(nett.body)).toBe(201);
    expect(gross.status, JSON.stringify(gross.body)).toBe(201);
    expect(nett.body.data.totalIdr).toBe(30_000);
    expect(gross.body.data.totalIdr).toBe(33_000);
    expect(
      (await storedOrder(inclusiveTenant, nett.body.data.id as string))
        .inclusive,
    ).toBe(true);
    expect(
      (await storedOrder(exclusiveTenant, gross.body.data.id as string))
        .inclusive,
    ).toBe(false);
    // The other tenant's order id is not readable from this tenant's rows.
    const { rows } = await owner.query(
      "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2",
      [exclusiveTenant.tenant.tenantId, ulidToUuid(nett.body.data.id)],
    );
    expect(rows).toHaveLength(0);
  });

  it("npnh-5b an inclusive rule scoped to one outlet leaves a sibling outlet of the same tenant exclusive", async () => {
    const fx = await world("inc-iso-outlet");
    // Second outlet of the same tenant with the same menu price.
    const secondOutletId = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Dua Uji', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
      [
        secondOutletId,
        fx.tenant.tenantId,
        fx.tenant.brandId,
        fx.tenant.legalEntityId,
        `S2-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    await asCashierTenant(fx.tenant.tenantId, async (client) => {
      const priceListId = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceListId, fx.tenant.tenantId, secondOutletId],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), fx.tenant.tenantId, priceListId, fx.ids.meal, 30_000],
      );
    });
    await addInclusiveMealRule(fx, fx.tenant.outletId);

    const first = await posMealOrder(fx);
    const second = await posMealOrder(
      fx,
      1,
      {},
      `/api/outlets/${secondOutletId}/pos/orders`,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(first.body.data.totalIdr).toBe(30_000);
    expect(second.body.data.totalIdr).toBe(33_000);
    expect(
      (await storedOrder(fx, first.body.data.id as string)).inclusive,
    ).toBe(true);
    expect(
      (await storedOrder(fx, second.body.data.id as string)).inclusive,
    ).toBe(false);
  });
});

describe("legend-npnh: void setelah aturan pajak outlet dibalik", () => {
  const SUPERVISOR_PIN = "582914";

  it("npnh-void-a an open exclusive order still voids after the outlet rule flips to inclusive, keeping its stored money", async () => {
    const fx = await world("inc-void");
    const created = await posMealOrder(fx);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    const before = await storedOrder(fx, orderId);
    expect(before.inclusive).toBe(false);

    // The rule flips while the order is open: a reprice would now be inclusive.
    await owner.query(
      "UPDATE tax_rules SET price_includes_tax = true WHERE tenant_id = $1",
      [fx.tenant.tenantId],
    );

    const context = establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    });
    await owner.query(
      "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
      [fx.tenant.roleId, JSON.stringify(["pos.void.request"])],
    );
    const client = agent(fx.app);
    await signUp(client, "Void Flip Supervisor");
    const session = await client.get("/api/auth/get-session");
    const supervisorUserId = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Supervisor Void Uji', false, NULL, $3, false, '["tenant"]')`,
      [
        roleId,
        fx.tenant.tenantId,
        JSON.stringify(["order.view", "pos.void.approve"]),
      ],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [fx.tenant.tenantId, supervisorUserId, roleId],
    );
    await setStaffPin(
      context,
      supervisorUserId,
      { outletId: fx.tenant.outletId, userId: supervisorUserId },
      { pin: SUPERVISOR_PIN },
    );
    const { override } = await createPosOverride(
      context,
      fx.staff.userId,
      {
        outletId: fx.tenant.outletId,
        action: "void",
        valueIdr: before.totalIdr,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: orderId,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(supervisorUserId),
          pin: SUPERVISOR_PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );

    const voided = await fx.post(`${fx.base}/${orderId}/void`, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      expectedStatus: created.body.data.status,
      idempotencyKey: randomUUID(),
      approvedBy: supervisorUserId,
      overrideId: override.id as string,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const after = await storedOrder(fx, orderId);
    expect(after).toEqual(before);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows[0]?.status).toBe("voided");
  });
});
