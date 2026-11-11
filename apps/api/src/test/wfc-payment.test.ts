// legend-bz9h round 3: a WFC sale must match a real captured POS tender, and one
// capture may fund only what it bought. Written from the bz9h round-3 spec
// (scratchpad bz9h-spec3.md), never from the implementation.
//
// Rules under test (jangan sampai rugi: a free or recycled payment never buys):
//   C1  Only a `pos_order_tenders` row proves payment: same tenant and outlet,
//       status 'captured', amount_idr >= price, whose order (non-training) has a
//       NON-voided order line for the sale's menu item. `payment_intents` never
//       pay, linked or not (nothing ties an intent to its use).
//       Products (day pass, seat reservation) and bundles carry `menu_item_id`;
//       without it nothing can be bought.
//   C2/H2  Ledger `wfc_payment_captures` (tenant_id, capture_key) is unique and
//       written in the SAME transaction as each sale. capture_key =
//       lowercase(coalesce(tender.payment_intent_id, tender.id)). One capture
//       funds one sale across seat reservations, day passes and bundles, and
//       every alias of the reference (upper/lower case, id vs reference) maps to
//       the same key. A replay with the same product/bundle + customer returns
//       the first sale.
//   H1  One order line cannot fund more sales than its (non-voided) quantity:
//       409 PAYMENT_ALREADY_USED.
//   M2  A bundle purchase re-checks the price floor: 409 BUNDLE_PRICE_BELOW_FLOOR.
//   L1  bundleMinPriceIdr does not lose precision for huge totals.
//   L2  A customer that does not exist is 404 ("Pelanggan"), not a 500.
//   L3  The database refuses a seat_reservation product without duration.
//
// Assumptions (the spec leaves them open):
// - `requireCapturedPayment(tx, context, { outletId, paymentRef, priceIdr,
//   productMenuItemId? })` resolves when acceptable and rejects with an
//   `HttpError` (`status`, `code`) otherwise. It rejects 409 PAYMENT_NOT_CAPTURED
//   for anything that is not a usable tender (never 404, nothing leaked).
// - The ledger/line-quantity rules (PAYMENT_ALREADY_USED) are exercised through
//   the sale services (reserve+confirm, purchaseDayPass, purchaseWfcBundle) since
//   the ledger row is written with the sale.
// - A bundle without menu_item_id answers 409 with PAYMENT_NOT_CAPTURED or
//   BUNDLE_NOT_SELLABLE (the spec names both); the sale must write nothing.
// - Reserving a seat with a product that has no menu_item_id is allowed (the
//   payment, not the booking, is the gate): confirming it is 409.
// - Only the tender `id` is used as a case-aliased reference. A tender linked to
//   a payment_intent (payment_intent_id) is not seeded: its fixtures need
//   gateway rows whose constraints the spec does not define.
import { randomBytes, randomUUID } from "node:crypto";
import { ulidToUuid } from "@starter/shared/core";
import { bundleMinPriceIdr } from "@starter/shared/wfc";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { requireCapturedPayment } from "../services/wfc-payment.ts";
import {
  createWfcBundle,
  purchaseWfcBundle,
} from "../services/wfc-bundle.service.ts";
import {
  confirmWfcReservationPaid,
  createWfcSeat,
  purchaseDayPass,
  reserveWfcSeat,
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
  inHours,
  seedFacility,
  seedMenuItems,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const PRICE = 50_000;
/** Fixture order-line unit price: at or above every WFC price. */
const LINE_UNIT_IDR = 1_000_000;
const SEAT_PRICE = 50_000;
const DAY_PASS_PRICE = 75_000;
const BUNDLE_PRICE = 40_000;

type Failure = { status?: number; code?: string; message: string };

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

const NOT_CAPTURED = { status: 409, code: "PAYMENT_NOT_CAPTURED" };
const ALREADY_USED = { status: 409, code: "PAYMENT_ALREADY_USED" };

type IntentSeed = {
  tenantId: string;
  outletId: string;
  amountIdr: number;
  status?: "paid" | "pending" | "failed" | "refunded" | "expired";
  orderId?: string;
};

/** A gateway intent (and the link it needs). Returns its id and provider_ref. */
async function seedIntent(seed: IntentSeed) {
  const id = randomUUID();
  const linkId = randomUUID();
  const ref = `cap-${randomUUID().slice(0, 30)}`;
  const status = seed.status ?? "paid";
  const settled = status === "paid" || status === "refunded";
  await asTenant(seed.tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'wfc-payment-test')`,
      [
        linkId,
        seed.tenantId,
        seed.outletId,
        randomBytes(32).toString("hex"),
        `WP-${linkId.slice(0, 8)}`,
        seed.amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, paid_at, instructions, expires_at, provider_ref, order_id)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, $8,
               '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour', $9, $10)`,
      [
        id,
        seed.tenantId,
        seed.outletId,
        linkId,
        seed.amountIdr,
        `wp-${id}`,
        status,
        settled ? new Date().toISOString() : null,
        ref,
        seed.orderId ?? null,
      ],
    );
  });
  return { id, ref };
}

type TenderSeed = {
  tenantId: string;
  outletId: string;
  orderUlid: string;
  amountIdr: number;
  status?: "captured" | "authorized" | "failed" | "voided";
};

/** A POS tender on an existing POS order. Returns its id and reference. */
async function seedTender(seed: TenderSeed) {
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
        ulidToUuid(seed.orderUlid),
        seed.amountIdr,
        seed.status ?? "captured",
        reference,
      ],
    );
    return rows[0].id as string;
  });
  return { id, reference };
}

/** An order line with an explicit quantity (seedOrderItems only does quantity 1). */
async function seedLine(
  tenantId: string,
  input: {
    orderUlid: string;
    outletId: string;
    menuItemId: string;
    quantity?: number;
    unitPriceIdr?: number;
  },
): Promise<string> {
  const unitPrice = input.unitPriceIdr ?? LINE_UNIT_IDR;
  const id = randomUUID();
  const quantity = input.quantity ?? 1;
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO order_items
         (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
          unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
          reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, 'Menu uji', $6, $9, 0, $7, 'fired', 'served', $8)`,
      [
        id,
        tenantId,
        input.outletId,
        ulidToUuid(input.orderUlid),
        input.menuItemId,
        quantity,
        unitPrice * quantity,
        DATE,
        unitPrice,
      ],
    ),
  );
  return id;
}

/**
 * Voids a line of a (seeded, already completed) order. The POS-04 trigger freezes
 * the lines of a final order, so bypass it the way markTraining does: the fixture
 * stands in for a void that happened while the order was still open.
 */
async function voidLine(tenantId: string, lineId: string): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
      [tenantId, lineId],
    );
  });
}

/**
 * A POS-04 correction (void or refund) recorded against a completed order. The
 * tender stays captured and the lines stay non-voided, exactly as the real
 * correction flow leaves them. FKs are skipped (replica role): the fixture has
 * no shift or override rows, only the row the helper must see.
 */
async function seedCorrection(
  tenantId: string,
  input: { kind: "void" | "refund"; outletId: string; orderUlid: string },
): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    if (input.kind === "void")
      await client.query(
        `INSERT INTO pos_order_voids
           (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
            requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, 'R-1', 50000, 'mistake', 'uji', 'a', 'b', $4, now())`,
        [tenantId, input.outletId, ulidToUuid(input.orderUlid), randomUUID()],
      );
    else
      await client.query(
        `INSERT INTO pos_order_refunds
           (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
            requested_by, approved_by, approval_request_id, refunded_at)
         VALUES ($1, $2, $3, 50000, 'mistake', 'uji',
                 '[{"method":"cash","amountIdr":50000}]'::jsonb, 'a', 'b', $4, now())`,
        [tenantId, input.outletId, ulidToUuid(input.orderUlid), randomUUID()],
      );
  });
}

/** An active (not removed) order discount. */
async function seedDiscount(
  tenantId: string,
  input: { outletId: string; orderUlid: string; removed?: boolean },
): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO pos_order_discounts
         (tenant_id, outlet_id, order_id, source, kind, percent_bp, amount_idr, reason, reason_note,
          applied_by, approved_by, approval_request_id, removed_at, removed_by)
       VALUES ($1, $2, $3, 'manual', 'percent', 1000, 5000, 'mistake', 'uji diskon', 'a', 'b', $4,
               ${input.removed ? "now()" : "NULL"}, ${input.removed ? "'a'" : "NULL"})`,
      [tenantId, input.outletId, ulidToUuid(input.orderUlid), randomUUID()],
    );
  });
}

const check = (
  world: Pick<World, "context">,
  input: {
    outletId: string;
    paymentRef: string;
    priceIdr?: number;
    productMenuItemId?: string;
  },
) =>
  withTenant(db, world.context, (tx) =>
    requireCapturedPayment(tx, world.context, {
      priceIdr: PRICE,
      ...input,
    }),
  );

// ---- C1: the helper ----------------------------------------------------------

describe("C1 a payment intent never pays, linked or not", () => {
  async function intentWorld() {
    const world = await createWorld();
    const [menuItemId] = await seedMenuItems(world, 1);
    return { world, menuItemId: menuItemId! };
  }

  it("C1 a paid, unlinked intent of the same outlet is rejected 409 PAYMENT_NOT_CAPTURED by provider_ref and by id", async () => {
    const { world, menuItemId } = await intentWorld();
    const intent = await seedIntent({
      tenantId: world.tenantId,
      outletId: world.outletA,
      amountIdr: PRICE * 3,
    });
    for (const paymentRef of [intent.ref, intent.id])
      for (const productMenuItemId of [undefined, menuItemId])
        expect(
          await failure(
            check(world, {
              outletId: world.outletA,
              paymentRef,
              productMenuItemId,
            }),
          ),
        ).toMatchObject(NOT_CAPTURED);
  });

  it("C1 an intent linked to a food order is rejected too", async () => {
    const { world, menuItemId } = await intentWorld();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    const food = await seedIntent({
      tenantId: world.tenantId,
      outletId: world.outletA,
      amountIdr: PRICE,
      orderId: ulidToUuid(orderUlid),
    });
    for (const paymentRef of [food.ref, food.id])
      expect(
        await failure(
          check(world, {
            outletId: world.outletA,
            paymentRef,
            productMenuItemId: menuItemId,
          }),
        ),
      ).toMatchObject(NOT_CAPTURED);
  });

  it("C1 an unknown reference is a 409, never a 404 or a server error, also when it is not a uuid", async () => {
    const { world, menuItemId } = await intentWorld();
    for (const paymentRef of [
      randomUUID(),
      "not-a-uuid",
      `pay-${randomUUID()}`,
    ])
      expect(
        await failure(
          check(world, {
            outletId: world.outletA,
            paymentRef,
            productMenuItemId: menuItemId,
          }),
        ),
      ).toMatchObject(NOT_CAPTURED);
  });
});

describe("C1 a POS tender is accepted only for an order that bought the product", () => {
  async function tenderWorld(menuCount = 2) {
    const world = await createWorld();
    const [menuItemId, otherMenuItemId] = await seedMenuItems(world, menuCount);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await seedLine(world.tenantId, {
      orderUlid,
      outletId: world.outletA,
      menuItemId: menuItemId!,
    });
    return {
      world,
      menuItemId: menuItemId!,
      otherMenuItemId: otherMenuItemId!,
      orderUlid,
    };
  }

  it("F39 a captured tender whose order has the product's menu item is accepted by id and by reference", async () => {
    const { world, menuItemId, orderUlid } = await tenderWorld();
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    for (const paymentRef of [tender.id, tender.reference])
      await expect(
        check(world, {
          outletId: world.outletA,
          paymentRef,
          productMenuItemId: menuItemId,
        }),
      ).resolves.not.toThrow();
  });

  it("C1 the product must have a menu item: without productMenuItemId a tender never pays", async () => {
    const { world, orderUlid } = await tenderWorld();
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    expect(
      await failure(
        check(world, { outletId: world.outletA, paymentRef: tender.id }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("C1 a tender of a food order without a line for that menu item is rejected", async () => {
    const { world, otherMenuItemId, orderUlid } = await tenderWorld();
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.reference,
          productMenuItemId: otherMenuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("C1 a line that was voided no longer proves the payment", async () => {
    const world = await createWorld();
    const [menuItemId] = await seedMenuItems(world, 1);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    const lineId = await seedLine(world.tenantId, {
      orderUlid,
      outletId: world.outletA,
      menuItemId: menuItemId!,
    });
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    const input = {
      outletId: world.outletA,
      paymentRef: tender.id,
      productMenuItemId: menuItemId!,
    };
    await expect(check(world, input)).resolves.not.toThrow();
    await voidLine(world.tenantId, lineId);
    expect(await failure(check(world, input))).toMatchObject(NOT_CAPTURED);
  });

  it("C1 a tender of a training order never pays", async () => {
    const { world, menuItemId, orderUlid } = await tenderWorld();
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    await markTraining(world.tenantId, orderUlid);
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.id,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("C1 a tender below the price is rejected; one at or above is accepted", async () => {
    const { world, menuItemId, orderUlid } = await tenderWorld();
    const small = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE - 1,
    });
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: small.id,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
    const big = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE + 1,
    });
    await expect(
      check(world, {
        outletId: world.outletA,
        paymentRef: big.id,
        productMenuItemId: menuItemId,
      }),
    ).resolves.not.toThrow();
  });

  it("C1 a tender that is not captured is rejected (authorized, failed, voided)", async () => {
    const { world, menuItemId, orderUlid } = await tenderWorld();
    for (const status of ["authorized", "failed", "voided"] as const) {
      const tender = await seedTender({
        tenantId: world.tenantId,
        outletId: world.outletA,
        orderUlid,
        amountIdr: PRICE,
        status,
      });
      expect(
        await failure(
          check(world, {
            outletId: world.outletA,
            paymentRef: tender.id,
            productMenuItemId: menuItemId,
          }),
        ),
      ).toMatchObject(NOT_CAPTURED);
    }
  });

  it("TEN-03 a tender of another outlet is rejected", async () => {
    const { world, menuItemId } = await tenderWorld();
    const orderB = await seedOrder(world.tenantId, {
      outletId: world.outletB,
      profileId: null,
    });
    await seedLine(world.tenantId, {
      orderUlid: orderB,
      outletId: world.outletB,
      menuItemId,
    });
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletB,
      orderUlid: orderB,
      amountIdr: PRICE,
    });
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.id,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("TEN-01 a tender of another tenant is rejected and its existence is not revealed", async () => {
    const mine = await createWorld();
    const { world: theirs, menuItemId, orderUlid } = await tenderWorld();
    const tender = await seedTender({
      tenantId: theirs.tenantId,
      outletId: theirs.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    const foreign = await failure(
      check(mine, {
        outletId: mine.outletA,
        paymentRef: tender.id,
        productMenuItemId: menuItemId,
      }),
    );
    expect(foreign).toMatchObject(NOT_CAPTURED);
    // Same answer as for a reference that does not exist anywhere.
    const unknown = await failure(
      check(mine, {
        outletId: mine.outletA,
        paymentRef: randomUUID(),
        productMenuItemId: menuItemId,
      }),
    );
    expect(foreign.message).toBe(unknown.message);
    expect(foreign.message).not.toContain(tender.id);
    expect(foreign.message).not.toContain(String(PRICE));
  });
});

describe("A1 a corrected or underpriced POS sale never pays (architect round 3)", () => {
  async function lineWorld(unitPriceIdr?: number, tenderIdr = PRICE) {
    const world = await createWorld();
    const [menuItemId] = await seedMenuItems(world, 1);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await seedLine(world.tenantId, {
      orderUlid,
      outletId: world.outletA,
      menuItemId: menuItemId!,
      unitPriceIdr,
    });
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: tenderIdr,
    });
    return { world, menuItemId: menuItemId!, orderUlid, tender };
  }

  it("A1 a voided POS sale (correction void) cannot fund a WFC sale: 409 PAYMENT_NOT_CAPTURED", async () => {
    const { world, menuItemId, orderUlid, tender } = await lineWorld();
    await seedCorrection(world.tenantId, {
      kind: "void",
      outletId: world.outletA,
      orderUlid,
    });
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.id,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("A1 a POS sale with any refund cannot fund a WFC sale", async () => {
    const { world, menuItemId, orderUlid, tender } = await lineWorld();
    await seedCorrection(world.tenantId, {
      kind: "refund",
      outletId: world.outletA,
      orderUlid,
    });
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.reference,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("A2 a line cheaper than the price cannot be topped up by food on the same tender", async () => {
    // 10k line, 100k tender (90k of food): must not fund a 50k WFC sale.
    const { world, menuItemId, tender } = await lineWorld(10_000, 100_000);
    expect(
      await failure(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.id,
          productMenuItemId: menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);
  });

  it("A2 a line at exactly the price is accepted", async () => {
    const { world, menuItemId, tender } = await lineWorld(PRICE, PRICE);
    await expect(
      check(world, {
        outletId: world.outletA,
        paymentRef: tender.id,
        productMenuItemId: menuItemId,
      }),
    ).resolves.not.toThrow();
  });

  it("A3 an order with an active discount is refused; a removed discount is not", async () => {
    const active = await lineWorld();
    await seedDiscount(active.world.tenantId, {
      outletId: active.world.outletA,
      orderUlid: active.orderUlid,
    });
    expect(
      await failure(
        check(active.world, {
          outletId: active.world.outletA,
          paymentRef: active.tender.id,
          productMenuItemId: active.menuItemId,
        }),
      ),
    ).toMatchObject(NOT_CAPTURED);

    const removed = await lineWorld();
    await seedDiscount(removed.world.tenantId, {
      outletId: removed.world.outletA,
      orderUlid: removed.orderUlid,
      removed: true,
    });
    await expect(
      check(removed.world, {
        outletId: removed.world.outletA,
        paymentRef: removed.tender.id,
        productMenuItemId: removed.menuItemId,
      }),
    ).resolves.not.toThrow();
  });
});

// ---- D1 (bz9h round 4): only a COMPLETED order's tender pays -----------------
//
// Spec bz9h-spec4 D1: findTender also requires `orders.status = 'completed'`
// (paid in full and final). A tender of an open (draft) order may still be
// captured, but the order can still change, so it never pays: 409
// PAYMENT_NOT_CAPTURED. `seedOrder` seeds 'completed' by default; the fixtures
// above rely on that and stay unchanged.

/** Flips the status of a seeded order (the row is frozen once final, so bypass its trigger). */
async function setOrderStatus(
  tenantId: string,
  orderUlid: string,
  status: "draft" | "completed",
): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE orders SET status = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, ulidToUuid(orderUlid), status],
    );
  });
}

describe("D1 a tender pays only when its order is completed", () => {
  async function orderWorld(status: "draft" | "completed") {
    const world = await createWorld();
    const [menuItemId] = await seedMenuItems(world, 1);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
      status,
    });
    await seedLine(world.tenantId, {
      orderUlid,
      outletId: world.outletA,
      menuItemId: menuItemId!,
    });
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    return { world, menuItemId: menuItemId!, orderUlid, tender };
  }

  it("D1 a captured tender of a completed order is accepted by id and by reference", async () => {
    const { world, menuItemId, tender } = await orderWorld("completed");
    for (const paymentRef of [tender.id, tender.reference])
      await expect(
        check(world, {
          outletId: world.outletA,
          paymentRef,
          productMenuItemId: menuItemId,
        }),
      ).resolves.not.toThrow();
  });

  it("D1 a captured tender of an order that is not completed (draft) is rejected 409 PAYMENT_NOT_CAPTURED", async () => {
    const { world, menuItemId, tender } = await orderWorld("draft");
    for (const paymentRef of [tender.id, tender.reference])
      expect(
        await failure(
          check(world, {
            outletId: world.outletA,
            paymentRef,
            productMenuItemId: menuItemId,
          }),
        ),
      ).toMatchObject(NOT_CAPTURED);
  });

  it("D1 the same tender is rejected while its order is open and accepted once the order is completed", async () => {
    const { world, menuItemId, orderUlid, tender } = await orderWorld("draft");
    const input = {
      outletId: world.outletA,
      paymentRef: tender.id,
      productMenuItemId: menuItemId,
    };
    expect(await failure(check(world, input))).toMatchObject(NOT_CAPTURED);
    await setOrderStatus(world.tenantId, orderUlid, "completed");
    await expect(check(world, input)).resolves.not.toThrow();
  });

  it("D1 an order that stops being completed no longer proves the payment", async () => {
    const { world, menuItemId, orderUlid, tender } =
      await orderWorld("completed");
    const input = {
      outletId: world.outletA,
      paymentRef: tender.id,
      productMenuItemId: menuItemId,
    };
    await expect(check(world, input)).resolves.not.toThrow();
    await setOrderStatus(world.tenantId, orderUlid, "draft");
    expect(await failure(check(world, input))).toMatchObject(NOT_CAPTURED);
  });

  it("D1 the rejection is the same answer as for an unknown reference (nothing leaked)", async () => {
    const { world, menuItemId, tender } = await orderWorld("draft");
    const open = await failure(
      check(world, {
        outletId: world.outletA,
        paymentRef: tender.id,
        productMenuItemId: menuItemId,
      }),
    );
    const unknown = await failure(
      check(world, {
        outletId: world.outletA,
        paymentRef: randomUUID(),
        productMenuItemId: menuItemId,
      }),
    );
    expect(open).toMatchObject(NOT_CAPTURED);
    expect(open.message).toBe(unknown.message);
    expect(open.message).not.toContain(tender.id);
  });

  it("D1 a day pass cannot be bought with a tender of an open order; nothing is recorded", async () => {
    const s = await setup();
    const orderUlid = await seedOrder(s.world.tenantId, {
      outletId: s.world.outletA,
      profileId: null,
      status: "draft",
    });
    await seedLine(s.world.tenantId, {
      orderUlid,
      outletId: s.world.outletA,
      menuItemId: s.passMenu,
    });
    const tender = await seedTender({
      tenantId: s.world.tenantId,
      outletId: s.world.outletA,
      orderUlid,
      amountIdr: DAY_PASS_PRICE,
    });
    expect(await failure(s.buyPass(tender.id))).toMatchObject(NOT_CAPTURED);
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
    // Once the order is completed the very same tender buys the pass.
    await setOrderStatus(s.world.tenantId, orderUlid, "completed");
    const pass = await s.buyPass(tender.id);
    expect(pass.id).toBeTruthy();
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });
});

// ---- D2 (bz9h round 4): the POS order is locked, then the tender re-checked ----
//
// Spec bz9h-spec4 D2: after finding a candidate tender, requireCapturedPayment
// locks its POS order with the same lock as POS corrections (orders FOR UPDATE,
// then pos_orders FOR UPDATE) and RE-RUNS the lookup. A correction (void or
// refund) that commits while the sale waits for that lock must therefore make
// the sale fail 409 PAYMENT_NOT_CAPTURED, instead of paying with a capture that
// was just refunded.
//
// The test plays the POS correction by hand: transaction A takes the lock pair
// (same SQL order as the POS correction), the sale runs in B and must wait for
// A, then A records the correction and commits.

type HeldPosLock = {
  pid: number;
  recordCorrection: (kind: "void" | "refund") => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

/** Opens a transaction that holds `orders` then `pos_orders` FOR UPDATE for one order. */
async function holdPosOrderLock(
  tenantId: string,
  outletId: string,
  orderUlid: string,
): Promise<HeldPosLock> {
  const client = await owner.connect();
  const orderId = ulidToUuid(orderUlid);
  let finished = false;
  const finish = async (statement: "COMMIT" | "ROLLBACK") => {
    if (finished) return;
    finished = true;
    try {
      await client.query(statement);
    } finally {
      client.release();
    }
  };
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, orderId],
    );
    await client.query(
      "SELECT 1 FROM pos_orders WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE",
      [tenantId, orderId],
    );
    const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
    return {
      pid: rows[0].pid as number,
      recordCorrection: async (kind) => {
        // Same fixture shortcut as seedCorrection: skip FKs (no shift/override rows).
        await client.query("SET LOCAL session_replication_role = replica");
        if (kind === "void")
          await client.query(
            `INSERT INTO pos_order_voids
               (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
                requested_by, approved_by, approval_request_id, voided_at)
             VALUES ($1, $2, $3, 'R-1', 50000, 'mistake', 'uji', 'a', 'b', $4, now())`,
            [tenantId, outletId, orderId, randomUUID()],
          );
        else
          await client.query(
            `INSERT INTO pos_order_refunds
               (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
                requested_by, approved_by, approval_request_id, refunded_at)
             VALUES ($1, $2, $3, 50000, 'mistake', 'uji',
                     '[{"method":"cash","amountIdr":50000}]'::jsonb, 'a', 'b', $4, now())`,
            [tenantId, outletId, orderId, randomUUID()],
          );
      },
      commit: () => finish("COMMIT"),
      rollback: () => finish("ROLLBACK"),
    };
  } catch (error) {
    await finish("ROLLBACK");
    throw error;
  }
}

/**
 * Resolves true once some backend is waiting on `pid`'s locks, false if `done()`
 * turned true first (the call under test finished without ever waiting).
 * Polls the server instead of sleeping a fixed time.
 */
async function waitUntilBlockedBy(
  pid: number,
  done: () => boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return false;
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if ((rows[0].n as number) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Timed out waiting for the sale to wait on the POS order lock",
  );
}

describe("D2 a correction committed while the sale waits for the POS order lock rejects the sale", () => {
  async function lockWorld() {
    const world = await createWorld();
    const [menuItemId] = await seedMenuItems(world, 1);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await seedLine(world.tenantId, {
      orderUlid,
      outletId: world.outletA,
      menuItemId: menuItemId!,
    });
    const tender = await seedTender({
      tenantId: world.tenantId,
      outletId: world.outletA,
      orderUlid,
      amountIdr: PRICE,
    });
    return { world, menuItemId: menuItemId!, orderUlid, tender };
  }

  for (const kind of ["refund", "void"] as const) {
    it(`D2 a ${kind} committed after the payment check began makes requireCapturedPayment reject 409 PAYMENT_NOT_CAPTURED`, async () => {
      const { world, menuItemId, orderUlid, tender } = await lockWorld();
      const held = await holdPosOrderLock(
        world.tenantId,
        world.outletA,
        orderUlid,
      );
      try {
        let settled = false;
        const outcome = settle(
          check(world, {
            outletId: world.outletA,
            paymentRef: tender.id,
            productMenuItemId: menuItemId,
          }),
        ).finally(() => {
          settled = true;
        });
        const waited = await waitUntilBlockedBy(held.pid, () => settled);
        expect(
          waited,
          "the payment check must wait for the POS order lock held by the correction",
        ).toBe(true);
        await held.recordCorrection(kind);
        await held.commit();
        expect(await outcome).toMatchObject(NOT_CAPTURED);
      } finally {
        await held.rollback();
      }
    });
  }

  it("D2 when the lock holder commits no correction, the waiting payment check passes", async () => {
    const { world, menuItemId, orderUlid, tender } = await lockWorld();
    const held = await holdPosOrderLock(
      world.tenantId,
      world.outletA,
      orderUlid,
    );
    try {
      let settled = false;
      const outcome = settle(
        check(world, {
          outletId: world.outletA,
          paymentRef: tender.id,
          productMenuItemId: menuItemId,
        }),
      ).finally(() => {
        settled = true;
      });
      const waited = await waitUntilBlockedBy(held.pid, () => settled);
      expect(
        waited,
        "the payment check must wait for the POS order lock held by the correction",
      ).toBe(true);
      await held.commit();
      expect(await outcome).toBeNull();
    } finally {
      await held.rollback();
    }
  });

  it("D2 a day pass bought while a refund commits is rejected and leaves no sale and no capture row", async () => {
    const s = await setup();
    const { orderUlid, tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
      tenders: [DAY_PASS_PRICE],
    });
    const held = await holdPosOrderLock(
      s.world.tenantId,
      s.world.outletA,
      orderUlid,
    );
    try {
      let settled = false;
      const outcome = settle(s.buyPass(tender.id)).finally(() => {
        settled = true;
      });
      const waited = await waitUntilBlockedBy(held.pid, () => settled);
      expect(
        waited,
        "the sale must wait for the POS order lock held by the correction",
      ).toBe(true);
      await held.recordCorrection("refund");
      await held.commit();
      expect(await outcome).toMatchObject(NOT_CAPTURED);
    } finally {
      await held.rollback();
    }
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });
});

// ---- L1 ----------------------------------------------------------------------

describe("L1 bundleMinPriceIdr does not overflow", () => {
  it("L1 the 50% floor is exact for normal totals, rounded up to the rupiah", () => {
    expect(bundleMinPriceIdr(65_000)).toBe(32_500);
    expect(bundleMinPriceIdr(10_001)).toBe(5_001);
    expect(bundleMinPriceIdr(1)).toBe(1);
    expect(bundleMinPriceIdr(0)).toBe(0);
  });

  it("L1 the floor stays exact for the largest safe integers", () => {
    // ceil(total / 2), computed without total * 5000 (which exceeds 2^53).
    expect(bundleMinPriceIdr(Number.MAX_SAFE_INTEGER)).toBe(
      4_503_599_627_370_496,
    );
    expect(bundleMinPriceIdr(Number.MAX_SAFE_INTEGER - 1)).toBe(
      4_503_599_627_370_495,
    );
    expect(bundleMinPriceIdr(9_000_000_000_000_000)).toBe(
      4_500_000_000_000_000,
    );
    for (const total of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1,
      2 ** 52 + 1,
    ]) {
      const floor = bundleMinPriceIdr(total);
      expect(Number.isSafeInteger(floor)).toBe(true);
      expect(floor).toBeLessThanOrEqual(total);
      expect(floor * 2).toBeGreaterThanOrEqual(total);
      expect(floor * 2 - total).toBeLessThanOrEqual(1);
    }
  });
});

// ---- Sales through the services ---------------------------------------------

async function seedActor(tenantId: string): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC payment test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC payment test ${roleId.slice(0, 8)}`,
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
    menuItemId: string | null;
  },
) {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active,
          wfc_kind, duration_minutes, menu_item_id)
       VALUES ($1, $2, $3, $4, $5, 'single', $6, 1, true, $7, $8, $9)`,
      [
        id,
        world.tenantId,
        input.outletId,
        input.facilityId,
        `Produk WFC ${short()}`,
        input.price,
        input.wfcKind,
        input.wfcKind === "seat_reservation" ? 120 : null,
        input.menuItemId,
      ],
    ),
  );
  return id;
}

const idOf = (value: unknown): string => {
  const id = (value as { id?: string } | null)?.id;
  if (!id) throw new Error("expected a result with an id");
  return id;
};

const countRows = (tenantId: string, table: string) =>
  asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0].n as number;
  });

type CaptureRow = {
  capture_key: string;
  sale_kind: string;
  sale_id: string;
  order_id: string;
  menu_item_id: string;
  outlet_id: string;
};

const captureRows = (tenantId: string) =>
  asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT capture_key, sale_kind, sale_id, order_id, menu_item_id, outlet_id
         FROM wfc_payment_captures WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows as CaptureRow[];
  });

const at = (hours: number) => inHours(hours, NOW).toISOString();

/** One tenant: coworking facility, seat/day pass products and a bundle, all with menu items. */
async function setup() {
  const world = await createWorld();
  const [seatMenu, passMenu, bundleMenu, foodMenu] = await seedMenuItems(
    world,
    4,
  );
  const coworking = await seedCoworking(world, world.outletA);
  const zoneId = await seedZone(world, world.outletA);
  const seatProductId = await seedProduct(world, {
    outletId: world.outletA,
    facilityId: coworking,
    wfcKind: "seat_reservation",
    price: SEAT_PRICE,
    menuItemId: seatMenu!,
  });
  const dayPassProductId = await seedProduct(world, {
    outletId: world.outletA,
    facilityId: coworking,
    wfcKind: "day_pass",
    price: DAY_PASS_PRICE,
    menuItemId: passMenu!,
  });
  // Bundle components (plain products, 15.000 + 50.000 = 65.000, floor 32.500).
  const showerFacility = await seedFacility(world);
  const wfcFacility = await seedFacility(world);
  const showerProduct = await seedProduct(world, {
    outletId: world.outletA,
    facilityId: showerFacility,
    wfcKind: null,
    price: 15_000,
    menuItemId: null,
  });
  const passComponent = await seedProduct(world, {
    outletId: world.outletA,
    facilityId: wfcFacility,
    wfcKind: null,
    price: 50_000,
    menuItemId: null,
  });
  const actor = await seedActor(world.tenantId);
  const ctx = world.context;
  const newCustomer = async () => (await seedProfile(world.tenantId)).id;
  const customer = await newCustomer();

  /** A POS order with `lines` and one captured tender of `amountIdr` per entry of `tenders`. */
  const funded = async (input: {
    lines: { menuItemId: string; quantity?: number }[];
    tenders?: number[];
  }) => {
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    const lineIds: string[] = [];
    for (const line of input.lines)
      lineIds.push(
        await seedLine(world.tenantId, {
          orderUlid,
          outletId: world.outletA,
          menuItemId: line.menuItemId,
          quantity: line.quantity,
        }),
      );
    const tenders = [];
    for (const amountIdr of input.tenders ?? [1_000_000])
      tenders.push(
        await seedTender({
          tenantId: world.tenantId,
          outletId: world.outletA,
          orderUlid,
          amountIdr,
        }),
      );
    return { orderUlid, lineIds, tenders, tender: tenders[0]! };
  };

  const buyPass = (
    paymentRef: string,
    over: Partial<{ productId: string; customerProfileId: string }> = {},
  ) =>
    purchaseDayPass(
      ctx,
      actor,
      {
        productId: dayPassProductId,
        customerProfileId: customer,
        ...over,
        paymentRef,
      },
      NOW,
    );

  const makeSeat = async () =>
    idOf(
      await createWfcSeat(
        ctx,
        actor,
        { outletId: world.outletA, zoneId, code: `S-${short()}` },
        NOW,
      ),
    );
  const reserve = async (
    productId = seatProductId,
    customerProfileId = customer,
  ) =>
    idOf(
      await reserveWfcSeat(
        ctx,
        actor,
        {
          seatId: await makeSeat(),
          productId,
          customerProfileId,
          startsAt: at(2),
          idempotencyKey: `idem-${randomUUID()}`,
        },
        NOW,
      ),
    );
  const confirm = (reservationId: string, paymentRef: string) =>
    confirmWfcReservationPaid(ctx, actor, { reservationId, paymentRef }, NOW);

  const makeBundle = (
    over: { menuItemId?: string | null; priceIdr?: number } = {},
  ) =>
    createWfcBundle(
      ctx,
      actor,
      {
        name: "Pagi Produktif",
        priceIdr: (over.priceIdr ?? BUNDLE_PRICE) as never,
        items: [
          { facilityId: showerFacility, productId: showerProduct, quantity: 1 },
          { facilityId: wfcFacility, productId: passComponent, quantity: 1 },
        ],
        idempotencyKey: `wfc-bundle-${randomUUID()}`,
        ...(over.menuItemId === null
          ? {}
          : { menuItemId: over.menuItemId ?? bundleMenu! }),
      } as never,
      NOW,
    );
  const buyBundle = (
    bundleId: string,
    paymentRef: string,
    customerProfileId = customer,
  ) =>
    purchaseWfcBundle(
      ctx,
      actor,
      { bundleId, customerProfileId, paymentRef },
      NOW,
    );

  return {
    world,
    ctx,
    actor,
    seatMenu: seatMenu!,
    passMenu: passMenu!,
    bundleMenu: bundleMenu!,
    foodMenu: foodMenu!,
    seatProductId,
    dayPassProductId,
    passComponent,
    customer,
    newCustomer,
    funded,
    buyPass,
    reserve,
    confirm,
    makeBundle,
    buyBundle,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const salesCount = async (s: Setup) =>
  (await countRows(s.world.tenantId, "wfc_day_pass_purchases")) +
  (await countRows(s.world.tenantId, "wfc_bundle_purchases"));

describe("C1 a sale needs a captured tender of an order that bought the product", () => {
  it("C1 day pass: a captured tender of an order with the pass menu item buys it and is recorded in the ledger", async () => {
    const s = await setup();
    const { orderUlid, tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
      tenders: [DAY_PASS_PRICE],
    });
    const pass = await s.buyPass(tender.id);
    expect(await captureRows(s.world.tenantId)).toEqual([
      {
        capture_key: tender.id.toLowerCase(),
        sale_kind: "day_pass",
        sale_id: pass.id,
        order_id: ulidToUuid(orderUlid),
        menu_item_id: s.passMenu,
        outlet_id: s.world.outletA,
      },
    ]);
  });

  it("C1 an intent that is paid and unlinked cannot buy a day pass, a reservation or a bundle", async () => {
    const s = await setup();
    const intent = await seedIntent({
      tenantId: s.world.tenantId,
      outletId: s.world.outletA,
      amountIdr: 1_000_000,
    });
    const reservationId = await s.reserve();
    const bundle = await s.makeBundle();
    for (const ref of [intent.ref, intent.id]) {
      expect(await failure(s.buyPass(ref))).toMatchObject(NOT_CAPTURED);
      expect(await failure(s.confirm(reservationId, ref))).toMatchObject(
        NOT_CAPTURED,
      );
      expect(await failure(s.buyBundle(bundle.id, ref))).toMatchObject(
        NOT_CAPTURED,
      );
    }
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a food order tender (no line for the pass) cannot buy a day pass", async () => {
    const s = await setup();
    const { tender } = await s.funded({ lines: [{ menuItemId: s.foodMenu }] });
    expect(await failure(s.buyPass(tender.id))).toMatchObject(NOT_CAPTURED);
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a tender for the pass menu item cannot confirm a seat reservation (other menu item)", async () => {
    const s = await setup();
    const { tender } = await s.funded({ lines: [{ menuItemId: s.passMenu }] });
    const reservationId = await s.reserve();
    expect(await failure(s.confirm(reservationId, tender.id))).toMatchObject(
      NOT_CAPTURED,
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a voided order line cannot buy a day pass", async () => {
    const s = await setup();
    const { tender, lineIds } = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
    });
    await voidLine(s.world.tenantId, lineIds[0]!);
    expect(await failure(s.buyPass(tender.id))).toMatchObject(NOT_CAPTURED);
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a training order cannot buy a day pass", async () => {
    const s = await setup();
    const { tender, orderUlid } = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
    });
    await markTraining(s.world.tenantId, orderUlid);
    expect(await failure(s.buyPass(tender.id))).toMatchObject(NOT_CAPTURED);
    expect(await salesCount(s)).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a product without menu_item_id cannot be bought (day pass and seat reservation)", async () => {
    const s = await setup();
    const coworking = await seedCoworking(s.world, s.world.outletA);
    const noMenuPass = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: coworking,
      wfcKind: "day_pass",
      price: DAY_PASS_PRICE,
      menuItemId: null,
    });
    const noMenuSeat = await seedProduct(s.world, {
      outletId: s.world.outletA,
      facilityId: coworking,
      wfcKind: "seat_reservation",
      price: SEAT_PRICE,
      menuItemId: null,
    });
    // The order has lines for every menu item, so only the missing link blocks it.
    const { tender } = await s.funded({
      lines: [
        { menuItemId: s.passMenu },
        { menuItemId: s.seatMenu },
        { menuItemId: s.foodMenu },
      ],
    });
    expect(
      await failure(s.buyPass(tender.id, { productId: noMenuPass })),
    ).toMatchObject(NOT_CAPTURED);
    const reservationId = await s.reserve(noMenuSeat);
    expect(await failure(s.confirm(reservationId, tender.id))).toMatchObject(
      NOT_CAPTURED,
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a bundle without menu_item_id cannot be purchased, even with a valid tender", async () => {
    const s = await setup();
    const bundle = await s.makeBundle({ menuItemId: null });
    const { tender } = await s.funded({
      lines: [
        { menuItemId: s.bundleMenu },
        { menuItemId: s.passMenu },
        { menuItemId: s.seatMenu },
      ],
    });
    const rejected = await failure(s.buyBundle(bundle.id, tender.id));
    expect(rejected.status).toBe(409);
    expect(["PAYMENT_NOT_CAPTURED", "BUNDLE_NOT_SELLABLE"]).toContain(
      rejected.code,
    );
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("C1 a bundle with a menu item is bought with a tender of an order that has that item", async () => {
    const s = await setup();
    const bundle = await s.makeBundle();
    const { orderUlid, tender } = await s.funded({
      lines: [{ menuItemId: s.bundleMenu }],
      tenders: [BUNDLE_PRICE],
    });
    const purchase = await s.buyBundle(bundle.id, tender.id);
    expect(await captureRows(s.world.tenantId)).toEqual([
      {
        capture_key: tender.id.toLowerCase(),
        sale_kind: "bundle",
        sale_id: purchase.id,
        order_id: ulidToUuid(orderUlid),
        menu_item_id: s.bundleMenu,
        outlet_id: s.world.outletA,
      },
    ]);
  });

  it("C1 a seat reservation is confirmed by a tender and leaves a ledger row", async () => {
    const s = await setup();
    const reservationId = await s.reserve();
    const { orderUlid, tender } = await s.funded({
      lines: [{ menuItemId: s.seatMenu }],
      tenders: [SEAT_PRICE],
    });
    await s.confirm(reservationId, tender.reference);
    expect(await captureRows(s.world.tenantId)).toEqual([
      {
        capture_key: tender.id.toLowerCase(),
        sale_kind: "seat_reservation",
        sale_id: reservationId,
        order_id: ulidToUuid(orderUlid),
        menu_item_id: s.seatMenu,
        outlet_id: s.world.outletA,
      },
    ]);
  });
});

describe("C2 H2 one capture funds one sale, whatever its alias", () => {
  it("C2 a tender cannot fund a reservation and then a bundle (or the other way round)", async () => {
    const s = await setup();
    const bundle = await s.makeBundle();
    // One order with a line for each item and one generous tender: only the
    // ledger stops the second sale.
    const { tender } = await s.funded({
      lines: [
        { menuItemId: s.seatMenu },
        { menuItemId: s.bundleMenu },
        { menuItemId: s.passMenu },
      ],
      tenders: [1_000_000],
    });
    const first = await s.reserve();
    const second = await s.reserve();
    await s.confirm(first, tender.id);
    expect(await failure(s.buyBundle(bundle.id, tender.id))).toMatchObject(
      ALREADY_USED,
    );
    expect(await failure(s.buyPass(tender.id))).toMatchObject(ALREADY_USED);
    expect(await failure(s.confirm(second, tender.id))).toMatchObject(
      ALREADY_USED,
    );
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);

    // The other way round, on a fresh tender.
    const other = await s.funded({
      lines: [{ menuItemId: s.bundleMenu }, { menuItemId: s.seatMenu }],
      tenders: [1_000_000],
    });
    await s.buyBundle(bundle.id, other.tender.id);
    const third = await s.reserve();
    expect(await failure(s.confirm(third, other.tender.id))).toMatchObject(
      ALREADY_USED,
    );
    expect(await captureRows(s.world.tenantId)).toHaveLength(2);
  });

  it("C2 the id and the reference of one tender are the same capture", async () => {
    const s = await setup();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu, quantity: 5 }],
    });
    const other = await s.newCustomer();
    await s.buyPass(tender.id);
    expect(
      await failure(s.buyPass(tender.reference, { customerProfileId: other })),
    ).toMatchObject(ALREADY_USED);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
  });

  it("H2 an uppercase and a lowercase spelling of the reference are ONE sale", async () => {
    const s = await setup();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu, quantity: 5 }],
    });
    const upper = tender.id.toUpperCase();
    expect(upper).not.toBe(tender.id);
    const first = await s.buyPass(upper);
    // Same product and customer: a replay returns the first sale.
    const replay = await s.buyPass(tender.id);
    expect(replay.id).toBe(first.id);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
    // Another customer cannot take the same capture in either spelling.
    const other = await s.newCustomer();
    for (const ref of [tender.id, upper])
      expect(
        await failure(s.buyPass(ref, { customerProfileId: other })),
      ).toMatchObject(ALREADY_USED);
    const rows = await captureRows(s.world.tenantId);
    expect(rows).toHaveLength(1);
    // The key is stored lowercase.
    expect(rows[0]!.capture_key).toBe(tender.id.toLowerCase());
    expect(rows[0]!.sale_id).toBe(first.id);
  });

  it("H2 the uppercase spelling cannot fund a second sale of another kind", async () => {
    const s = await setup();
    const bundle = await s.makeBundle();
    const { tender } = await s.funded({
      lines: [
        { menuItemId: s.seatMenu, quantity: 3 },
        { menuItemId: s.bundleMenu, quantity: 3 },
      ],
    });
    await s.confirm(await s.reserve(), tender.id.toUpperCase());
    expect(await failure(s.buyBundle(bundle.id, tender.id))).toMatchObject(
      ALREADY_USED,
    );
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
  });

  it("H2 replaying a bundle purchase with the uppercase spelling returns the first purchase", async () => {
    const s = await setup();
    const bundle = await s.makeBundle();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.bundleMenu, quantity: 3 }],
    });
    const first = await s.buyBundle(bundle.id, tender.id);
    const again = await s.buyBundle(bundle.id, tender.id.toUpperCase());
    expect(again.id).toBe(first.id);
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(1);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("H2 two concurrent purchases with different spellings of one tender: exactly one sale", async () => {
    const s = await setup();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu, quantity: 5 }],
    });
    const other = await s.newCustomer();
    const results = await Promise.all([
      settle(s.buyPass(tender.id)),
      settle(s.buyPass(tender.id.toUpperCase(), { customerProfileId: other })),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject(ALREADY_USED);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("C2 the database itself refuses a second ledger row for one capture (unique tenant + key)", async () => {
    const s = await setup();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
    });
    const pass = await s.buyPass(tender.id);
    const [row] = await captureRows(s.world.tenantId);
    expect(row!.sale_id).toBe(pass.id);
    // 23505 = unique_violation, whatever sale or kind the second row claims.
    await expect(
      owner.query(
        `INSERT INTO wfc_payment_captures
           (tenant_id, outlet_id, capture_key, sale_kind, sale_id, order_id, menu_item_id)
         VALUES ($1, $2, $3, 'bundle', $4, $5, $6)`,
        [
          s.world.tenantId,
          row!.outlet_id,
          row!.capture_key,
          randomUUID(),
          row!.order_id,
          row!.menu_item_id,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("TEN-01 RLS hides the capture ledger from another tenant", async () => {
    const a = await setup();
    const b = await setup();
    const { tender } = await a.funded({ lines: [{ menuItemId: a.passMenu }] });
    await a.buyPass(tender.id);
    expect(await captureRows(a.world.tenantId)).toHaveLength(1);
    expect(await captureRows(b.world.tenantId)).toHaveLength(0);
  });
});

describe("H1 an order line cannot fund more sales than its quantity", () => {
  it("H1 two split tenders on one quantity-1 line: the second sale is 409 PAYMENT_ALREADY_USED", async () => {
    const s = await setup();
    const { tenders } = await s.funded({
      lines: [{ menuItemId: s.passMenu, quantity: 1 }],
      tenders: [DAY_PASS_PRICE, DAY_PASS_PRICE],
    });
    const other = await s.newCustomer();
    await s.buyPass(tenders[0]!.id);
    expect(
      await failure(s.buyPass(tenders[1]!.id, { customerProfileId: other })),
    ).toMatchObject(ALREADY_USED);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
    expect(await captureRows(s.world.tenantId)).toHaveLength(1);
  });

  it("H1 a quantity-2 line funds two sales and not a third", async () => {
    const s = await setup();
    const { tenders } = await s.funded({
      lines: [{ menuItemId: s.passMenu, quantity: 2 }],
      tenders: [DAY_PASS_PRICE, DAY_PASS_PRICE, DAY_PASS_PRICE],
    });
    await s.buyPass(tenders[0]!.id, {
      customerProfileId: await s.newCustomer(),
    });
    await s.buyPass(tenders[1]!.id, {
      customerProfileId: await s.newCustomer(),
    });
    expect(
      await failure(
        s.buyPass(tenders[2]!.id, { customerProfileId: await s.newCustomer() }),
      ),
    ).toMatchObject(ALREADY_USED);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(2);
    expect(await captureRows(s.world.tenantId)).toHaveLength(2);
  });

  it("H1 only non-voided quantity counts: a voided line adds no sale", async () => {
    const s = await setup();
    const { tenders, lineIds } = await s.funded({
      lines: [
        { menuItemId: s.passMenu, quantity: 1 },
        { menuItemId: s.passMenu, quantity: 1 },
      ],
      tenders: [DAY_PASS_PRICE, DAY_PASS_PRICE],
    });
    await voidLine(s.world.tenantId, lineIds[1]!);
    await s.buyPass(tenders[0]!.id, {
      customerProfileId: await s.newCustomer(),
    });
    expect(
      await failure(
        s.buyPass(tenders[1]!.id, { customerProfileId: await s.newCustomer() }),
      ),
    ).toMatchObject(ALREADY_USED);
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(1);
  });

  it("H1 the quantity limit is per order line: another order may buy the same item again", async () => {
    const s = await setup();
    const a = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
      tenders: [DAY_PASS_PRICE],
    });
    const b = await s.funded({
      lines: [{ menuItemId: s.passMenu }],
      tenders: [DAY_PASS_PRICE],
    });
    await s.buyPass(a.tender.id, { customerProfileId: await s.newCustomer() });
    await s.buyPass(b.tender.id, { customerProfileId: await s.newCustomer() });
    expect(await countRows(s.world.tenantId, "wfc_day_pass_purchases")).toBe(2);
  });
});

describe("M2 L2 bundle purchase checks", () => {
  it("M2 a purchase re-checks the price floor against the current component prices", async () => {
    const s = await setup();
    // 40.000 is above the floor of 65.000 (32.500) when the bundle is created.
    const bundle = await s.makeBundle({ priceIdr: BUNDLE_PRICE });
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.bundleMenu }],
      tenders: [1_000_000],
    });
    // The pass component gets dearer: total 115.000, floor 57.500 > 40.000.
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE facility_products SET price_idr = 100000 WHERE id = $1",
        [s.passComponent],
      ),
    );
    expect(await failure(s.buyBundle(bundle.id, tender.id))).toMatchObject({
      status: 409,
      code: "BUNDLE_PRICE_BELOW_FLOOR",
    });
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
  });

  it("L2 a customer that does not exist is 404 Pelanggan, not a 500, and nothing is recorded", async () => {
    const s = await setup();
    const bundle = await s.makeBundle();
    const { tender } = await s.funded({
      lines: [{ menuItemId: s.bundleMenu }],
      tenders: [BUNDLE_PRICE],
    });
    const rejected = await failure(
      s.buyBundle(bundle.id, tender.id, randomUUID()),
    );
    expect(rejected.status).toBe(404);
    expect(rejected.message).toContain("Pelanggan");
    expect(await countRows(s.world.tenantId, "wfc_bundle_purchases")).toBe(0);
    // The capture is not burnt by the failed sale: a real customer can still buy.
    expect(await captureRows(s.world.tenantId)).toHaveLength(0);
    const purchase = await s.buyBundle(bundle.id, tender.id);
    expect(purchase.id).toBeTruthy();
  });
});

describe("L3 a seat_reservation product needs a duration (database check)", () => {
  it("L3 the database refuses a seat_reservation product without duration_minutes; others may have none", async () => {
    const s = await setup();
    const coworking = await seedCoworking(s.world, s.world.outletA);
    const insert = (wfcKind: string | null, durationMinutes: number | null) =>
      owner.query(
        `INSERT INTO facility_products
           (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active,
            wfc_kind, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, 'single', 10000, 1, true, $6, $7)`,
        [
          randomUUID(),
          s.world.tenantId,
          s.world.outletA,
          coworking,
          `Cek durasi ${short()}`,
          wfcKind,
          durationMinutes,
        ],
      );
    // 23514 = check_violation
    await expect(insert("seat_reservation", null)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("seat_reservation", 60)).resolves.toBeTruthy();
    await expect(insert("day_pass", null)).resolves.toBeTruthy();
    await expect(insert(null, null)).resolves.toBeTruthy();
    // An existing seat product cannot lose its duration either.
    await expect(
      owner.query(
        "UPDATE facility_products SET duration_minutes = NULL WHERE id = $1",
        [s.seatProductId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
