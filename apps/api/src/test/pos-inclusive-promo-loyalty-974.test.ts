// Brief 974 card B (legend-npnh), follow-up proof: promo/voucher discount and
// loyalty points on an inclusive (harga nett) POS order match the QR order of
// the same item and outlet. Written from docs/briefs/974-pos-laci-inklusif.md,
// the shared contract and the fixtures of pos-inclusive-bill-974.test.ts and
// ws03-inclusive-order.test.ts, never from computePosBill.
//
// Real Express app + PostgreSQL (cashierFixture of pos-cashier-test-helpers).
// The promo engine port is a test double, as in qr-order-api.test.ts and
// qr-pos-lock-order.test.ts: it quotes 10% of the sum of the line totals it is
// handed (or nothing). So the discount shows which basis (gross price or net)
// each channel hands to the engine.
//
// Proof P: the POS discount on an inclusive order is never larger than the QR
//   discount for the same item and outlet (guest never gets more off; outlet
//   never loses more); total, service and tax equal the QR order too.
// Proof L: the loyalty basis (eligible spend = gross sales - discount, the
//   `order.paid` rule of member-earn.test.ts) is the same for POS and QR, and
//   it is the net price, never the total that holds tax and service.
//
// Assumptions (spec silent, also reported):
//  - QR order is the reference: where the correct behavior is unclear, POS must
//    equal QR (not merely be <=). Both are asserted.
//  - The promo and voucher discount share one engine port (comment of
//    qr-pos-lock-order.test.ts), so the POS promo path (`source: "promo"`)
//    stands for the voucher path; a voucher code needs real apology voucher
//    rows that this fixture does not seed.
//  - The double applies whenever it is called (QR checkout calls it without a
//    code, see qr-pos-lock-order.test.ts), so the POS promo code and the QR
//    quote code are sent for realism, not as the switch.
//  - The loyalty points come from `order.paid` events (outbox, consumer
//    `loyalty-earn`). Instead of paying and delivering events, the basis is
//    computed with `orderRevenueSplit` of the stored order row, the emitter's
//    documented split (order-revenue.unit.test.ts, member-earn.test.ts header);
//    points use the default program rate of member-earn.test.ts (1 point per
//    Rp10.000 of eligible spend, rounded down).
//  - A POS promo discount is posted on a draft order with the cashier role
//    extended by `pos.discount.apply`; no device token or shift is needed (as in
//    qr-pos-lock-order.test.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr, ulidToUuid } from "@starter/shared/core";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { agent, originHeader } from "./helpers.ts";
import { orderRevenueSplit } from "../services/order-revenue.ts";
import type { OrderPromoPort } from "../services/order-promo-port.ts";
import { setPosOrderPromoPort } from "../services/pos-order-ports.ts";
import { setQrOrderPromoPort } from "../services/qr-order-ports.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const MEAL_GROSS = 30_000;
/** Default loyalty program of member-earn.test.ts: 1 point per Rp10.000. */
const POINT_STEP_IDR = 10_000;

const fixturesToClean: CashierFixture[] = [];

// ---- Promo double ----------------------------------------------------------------

let promoMode: "ten_percent" | "none" = "ten_percent";

const promoDouble: OrderPromoPort = {
  async quote(_tx, _ctx, input) {
    const total = input.lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
    const discount = promoMode === "none" ? 0 : Math.floor(total / 10);
    return {
      result: { evaluations: [], totalDiscountIdr: idr(discount) },
      totalDiscountIdr: idr(discount),
    };
  },
  async redeem(tx, ctx, input) {
    return promoDouble.quote(tx, ctx, input);
  },
  async release() {
    return { released: false, releasedDiscountIdr: idr(0) };
  },
};

beforeAll(() => {
  setPosOrderPromoPort(promoDouble);
  setQrOrderPromoPort(promoDouble);
});

afterAll(async () => {
  setPosOrderPromoPort(null);
  setQrOrderPromoPort(null);
  for (const fx of fixturesToClean)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Fixture ---------------------------------------------------------------------

async function world(label: string): Promise<CashierFixture> {
  const fx = await cashierFixture(label);
  fixturesToClean.push(fx);
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["pos.discount.apply"])],
  );
  return fx;
}

/** An inclusive PBJT 10% item rule for Nasi Goreng, tenant-wide. */
async function addInclusiveMealRule(fx: CashierFixture): Promise<void> {
  await asCashierTenant(fx.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, 'PB1 10% nett', 'pbjt', 1000, NULL, '[]', $4,
               true, true, true, 1, '2026-01-01', 'published', now(), $5)`,
      [
        randomUUID(),
        fx.tenant.tenantId,
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

/** A POS takeaway order of `quantity` meals, with the promo applied if asked. */
async function posOrder(
  fx: CashierFixture,
  quantity: number,
  withPromo: boolean,
): Promise<StoredOrder> {
  const created = await fx.post(fx.base, {
    channel: "pos",
    serviceType: "takeaway",
    items: [fx.line({ quantity })],
    idempotencyKey: randomUUID(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  if (withPromo) {
    const discounted = await fx.post(`${fx.base}/${orderId}/discounts`, {
      source: "promo",
      kind: "amount",
      promoCode: "HEMAT10",
      reason: "promo_engine",
      reasonNote: "Promo uji",
      idempotencyKey: randomUUID(),
    });
    expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(
      300,
    );
  }
  const stored = await storedOrder(fx, orderId);
  // The guest sees the stored total on the order.
  const fresh = await fx.get(`${fx.base}/${orderId}`);
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  expect(fresh.body.data.totalIdr).toBe(stored.totalIdr);
  return stored;
}

/** A QR pay-first order of `quantity` meals, with the promo quoted if asked. */
async function qrOrder(
  fx: CashierFixture,
  quantity: number,
  withPromo: boolean,
): Promise<StoredOrder> {
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
    quantity,
    expectedCartVersion: 0,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  if (withPromo) {
    const quoted = await guestPost("/quote", { promoCode: "HEMAT10" });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
  }
  const placed = await guestPost("/orders", {
    expectedCartVersion: added.body.data.cart.version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return storedOrder(fx, placed.body.data.order.id as string);
}

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

/**
 * Loyalty basis of `order.paid`: gross sales (net of service and tax) less the
 * discount (member-earn.test.ts, "eligible spend"). Throws if the stored row
 * does not balance (OrderRevenueMismatch).
 */
function loyaltyBasis(order: StoredOrder) {
  const split = orderRevenueSplit(toRow(order));
  const eligibleIdr = split.grossSalesIdr - split.discountIdr;
  return {
    split,
    eligibleIdr,
    points: Math.floor(eligibleIdr / POINT_STEP_IDR),
  };
}

// ---- Proof P: promo / voucher ----------------------------------------------------

describe("legend-npnh promo: diskon order POS inklusif tidak lebih besar dari QR", () => {
  it("npnh-promo-a the POS promo discount is at most the QR discount for the same item and outlet; both are equal (QR reference)", async () => {
    promoMode = "ten_percent";
    const fx = await world("inc-promo-a");
    await addInclusiveMealRule(fx);
    for (const quantity of [1, 3]) {
      const gross = MEAL_GROSS * quantity;
      const qr = await qrOrder(fx, quantity, true);
      const pos = await posOrder(fx, quantity, true);

      expect(qr.inclusive).toBe(true);
      expect(pos.inclusive).toBe(true);
      expect(qr.discountIdr).toBeGreaterThan(0);
      // Safety: never more off than the QR guest gets.
      expect(pos.discountIdr).toBeLessThanOrEqual(qr.discountIdr);
      // Reference: exactly the QR discount.
      expect(pos.discountIdr).toBe(qr.discountIdr);
      // The promo is taken off the gross price, never more than the bill.
      expect(pos.subtotalIdr).toBe(gross);
      expect(pos.discountIdr).toBeLessThanOrEqual(pos.subtotalIdr);
      expect(pos.totalIdr).toBe(gross - pos.discountIdr);
    }
  });

  it("npnh-promo-b a discounted inclusive POS order equals the QR order: total, service, tax; tax is not smaller; net + service + tax - discount stays balanced", async () => {
    promoMode = "ten_percent";
    const fx = await world("inc-promo-b");
    await addInclusiveMealRule(fx);
    const qr = await qrOrder(fx, 2, true);
    const pos = await posOrder(fx, 2, true);

    expect(pos.totalIdr).toBe(qr.totalIdr);
    expect(pos.serviceChargeIdr).toBe(qr.serviceChargeIdr);
    expect(pos.taxIdr).toBe(qr.taxIdr);
    expect(pos.roundingIdr).toBe(qr.roundingIdr);
    // The outlet never owes less tax than the QR order of the same sale.
    expect(pos.taxIdr).toBeGreaterThanOrEqual(qr.taxIdr);

    const split = orderRevenueSplit(toRow(pos));
    expect(
      split.grossSalesIdr -
        split.discountIdr +
        split.serviceChargeIdr +
        split.pbjtIdr +
        split.roundingIdr,
    ).toBe(pos.totalIdr);
  });

  it("npnh-promo-c no promo: POS and QR carry no discount and the guest pays the full gross price", async () => {
    promoMode = "none";
    const fx = await world("inc-promo-c");
    await addInclusiveMealRule(fx);
    const qr = await qrOrder(fx, 2, false);
    // Assumption: a promo that quotes nothing may be refused or ignored by the
    // POS discount route (spec silent), so no promo is posted here.
    const pos = await posOrder(fx, 2, false);

    expect(qr.discountIdr).toBe(0);
    expect(pos.discountIdr).toBe(0);
    expect(pos.totalIdr).toBe(MEAL_GROSS * 2);
    expect(pos.totalIdr).toBe(qr.totalIdr);
  });
});

// ---- Proof L: loyalty ------------------------------------------------------------

describe("legend-npnh loyalty: poin inklusif dari basis yang sama (bukan pajak/service)", () => {
  it("npnh-loyalty-a no promo: the POS loyalty basis equals the QR basis and is the net price, not the total that holds tax", async () => {
    promoMode = "none";
    const fx = await world("inc-loy-a");
    await addInclusiveMealRule(fx);
    const quantity = 3; // Rp90.000 gross, tax inside
    const qr = await qrOrder(fx, quantity, false);
    const pos = await posOrder(fx, quantity, false);

    const qrBasis = loyaltyBasis(qr);
    const posBasis = loyaltyBasis(pos);
    expect(posBasis.eligibleIdr).toBe(qrBasis.eligibleIdr);
    expect(posBasis.points).toBe(qrBasis.points);

    // Eligible spend is the net: gross - service - tax.
    expect(posBasis.eligibleIdr).toBe(
      orderNetSubtotalIdr({
        subtotalIdr: pos.subtotalIdr,
        serviceChargeIdr: pos.serviceChargeIdr,
        taxIdr: pos.taxIdr,
        pricesIncludeTax: true,
      }),
    );
    // Not the total: the tax inside the price earns no points.
    expect(pos.taxIdr).toBeGreaterThan(0);
    expect(posBasis.eligibleIdr).toBeLessThan(pos.totalIdr);
    expect(posBasis.eligibleIdr + pos.serviceChargeIdr + pos.taxIdr).toBe(
      pos.totalIdr,
    );
    // Points never exceed what the total-based count would give less the tax:
    // 90.000 total gives 9 points, the 81.8xx net gives 8.
    expect(posBasis.points).toBeLessThan(
      Math.floor(pos.totalIdr / POINT_STEP_IDR),
    );
  });

  it("npnh-loyalty-b with a promo: eligible spend is gross sales less the discount, equal to QR, and still excludes tax and service", async () => {
    promoMode = "ten_percent";
    const fx = await world("inc-loy-b");
    await addInclusiveMealRule(fx);
    const quantity = 3;
    const qr = await qrOrder(fx, quantity, true);
    const pos = await posOrder(fx, quantity, true);

    const qrBasis = loyaltyBasis(qr);
    const posBasis = loyaltyBasis(pos);
    expect(posBasis.split.discountIdr).toBe(pos.discountIdr);
    expect(posBasis.eligibleIdr).toBe(qrBasis.eligibleIdr);
    expect(posBasis.points).toBe(qrBasis.points);

    // Points never come from tax or service: eligible + them + rounding = total.
    expect(
      posBasis.eligibleIdr +
        posBasis.split.serviceChargeIdr +
        posBasis.split.pbjtIdr +
        posBasis.split.roundingIdr,
    ).toBe(pos.totalIdr);
    expect(posBasis.eligibleIdr).toBeLessThan(pos.totalIdr);
    // Never more points than the QR guest earns for the same sale.
    expect(posBasis.points).toBeLessThanOrEqual(qrBasis.points);
  });

  it("npnh-loyalty-c an exclusive POS order keeps its basis: gross before tax, so inclusive and exclusive sales of the same menu earn on the pre-tax amount", async () => {
    promoMode = "none";
    const fx = await world("inc-loy-c");
    // No inclusive rule: the cashierFixture class rule stays exclusive.
    const pos = await posOrder(fx, 3, false);
    expect(pos.inclusive).toBe(false);
    const basis = loyaltyBasis(pos);
    expect(basis.eligibleIdr).toBe(MEAL_GROSS * 3);
    expect(basis.eligibleIdr + pos.taxIdr).toBe(pos.totalIdr);
  });
});
