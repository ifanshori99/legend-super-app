// legend-1145b (tier K, money, "jangan sampai rugi"): two CTO decisions on the money
// one order may give back (docs/briefs/sub-1145b.md, written from the brief and the
// shared promo/tax rules, never from the services).
//
// (a) legend-wpn5v, STRICT line cap: an ORD-09 refund on a PLAIN line (not a swap
//     chain) is capped at that line's pro-rata share of what the guest paid minus what
//     already went out for that line, the same rule as an apology voucher. The old
//     escape "room >= share" let a repriced refund of one line take another line's money.
// (b) legend-4yez0: the cash void of a recovery charge gets the same chain check as the
//     gateway path: once ORD-09 paid on the swap chain, voiding the order (which gives
//     the cash charge back) is refused 422 REFUND_OVER_ORDER_ROOM and the void rolls back.
//
// World (order-recovery-helpers): service 5%, PBJT 10% on goods + service, exclusive
// prices (factor 1,155 on a net goods amount). Prices: kopi 25.000, teh 12.000, roti 18.000.
//
// (a) The architect's example scaled to the world. A = kopi x1 (25.000), B = roti x3
//     (54.000, "buy 2 roti get 1 roti free" = an item discount of 18.000 on B only),
//     C = teh x1 (12.000). Subtotal 91.000, discount 18.000, net 73.000, service 5% =
//     3.650, PBJT 10% of 76.650 = 7.665, paid 84.315 (asserted on the stored order).
//     Free-item rule (packages/shared/src/crm/promo.ts freeItemBenefit): the free unit
//     is also a buy unit, so a multiple needs 2 + 1 roti; 3 roti -> 1 multiple -> 1 free.
//     Pro-rata shares of the 84.315 paid (by gross line value, 91.000):
//       A 25.000 / 91.000 * 84.315 = 23.163,46  -> 23.163
//       B 54.000 / 91.000 * 84.315 = 50.033,08  -> 50.033
//       C 12.000 / 91.000 * 84.315 = 11.118,46  -> 11.118   (sum 84.314/84.315)
//     The promo-repriced ORD-09 of A (kept B + C cost 36.000 + 12.000 = 48.000, goods due
//     73.000 - 48.000 = 25.000, x 1,155) is 28.875: 5.7k above A's share, money of B and
//     C. Rule: ORD-09 of A <= A's share (+3 IDR rounding): refused at resolve (422
//     REFUND_OVER_ORDER_ROOM) or at the consumer (nothing filed) or capped at the share.
//     (Probed: with the promo kept, ORD-09 of A files 23.164 = its share, base and fix
//     agree; those tests are controls. The over-share case needs a promo that is
//     WITHDRAWN by an earlier refund, see (a2).)
//     Never loosened: a voucher on B up to B's share (50.000 <= 50.033) still passes and C
//     keeps its money (paid - out >= C's share).
//
// (a2) The promo order of the old h1dyy tests (PROMO_PAID 42.735: kopi 25.000 + teh 12.000 +
//     roti 18.000, "buy 2 of kopi/teh get roti free", subtotal 55.000, discount 18.000,
//     service 1.850, PBJT 3.885). Shares by gross line: kopi 25/55*42.735 = 19.425, teh
//     12/55*42.735 = 9.324,0, roti 18/55*42.735 = 13.986 (sum 42.735). A failed kopi
//     withdraws the promo and refunds 8.085 (order-recovery-refund-promo H3). The roti
//     after it recomputes 20.790 (kept teh only, goods 18.000, x 1,155) = 6.804 over the
//     roti's share 13.986, money of teh: refused (422 room at resolve, or nothing filed at
//     the consumer). Out <= paid, teh's share (9.324) stays paid.
//
// (b) QR order kopi + roti (49.665), roti swapped for the dearer kopi, swap charge 8.085
//     paid in cash (collect-at-pos) or online; chain A paid 20.790 + 8.085 = 28.875;
//     ORD-09 of the replacement is filed; the order becomes a POS cash sale; the cloud
//     void gives the charge cash back -> chain A would be paid twice.
//
// (c) Round 4 (docs/qa/second-opinion-refund-kasir-ronde4-1156.md, CTO decision 4): the
//     per-line shares are split by LARGEST REMAINDER, so they add up to exactly what the
//     guest paid, and a legitimate refund is never cut by 1 IDR. SO order: A = 10.000,
//     B = 20.001; subtotal 30.001, service 5% = 1.500 (1.500,05), PBJT 10% of 31.501 =
//     3.150 (3.150,1), paid 34.651. Floor shares: A 10.000*34.651/30.001 = 11.549,88 ->
//     11.549, B 20.001*34.651/30.001 = 23.101,12 -> 23.101; floors sum 34.650, the 1 IDR
//     left goes to the largest fraction (A, .88): A = 11.550, B = 23.101, sum 34.651.
//     ORD-09 of A by the component rounding of the refund engine is 11.550 (10.000 + 500 +
//     1.050, the SO's arithmetic). Pairs: after a same-price swap (A -> A', 10.000) whose
//     replacement fails, ORD-09 files exactly 11.550 (no 422); a voucher on A passes at
//     11.550 and is refused 422 at 11.551; B's voucher 23.101 passes next to A's 11.550
//     (sum 34.651 = paid). (A finance refund is no probe: a fired QR sale answers 409
//     REFUND_INTENT_IN_QR_SALE for any amount.) The +1 pair on the swap chain is a voucher
//     on the replacement line: 11.550 passes, 11.551 is refused 422.
//
// Assumptions (also reported):
// - "Pro-rata share" is by gross line value (the architect's example only makes sense so);
//   a 3 IDR slack covers rounding. A capped ORD-09 (filed at or under the share) is as
//   good as a refused one: the assertions are the bound, not which gate answers.
// - Which gate refuses the over-share ORD-09 (resolve or consumer) is the engineer's
//   design; the room refusal at resolve is exactly 422 REFUND_OVER_ORDER_ROOM.
// - Decision 2 asks for 422 REFUND_OVER_ORDER_ROOM on the cash void, but the live-ORD-09
//   guard (409 REFUND_ORD09_REFUND_EXISTS) refuses first; both are accepted and the void
//   test is not red at the base (reported). The gateway void must be refused too.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1145b-strict-line.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { PRICES } from "./order-recovery-helpers.ts";
import {
  ORDER_PAID,
  PROMO_PAID,
  ROTI_PAID,
  ROTI_PRICE,
  contextOf,
  createPosWorld,
  errorText,
  sum,
  toUlid,
  toUuid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 240_000 });

const ROOM_CODE = "REFUND_OVER_ORDER_ROOM";
const SLACK = 3; // rounding slack, IDR (a typed 3 IDR chain slack as in ORD-09 caps)

// (a) world
const ABC_PAID = 84_315;
const A_SHARE = 23_163;
const B_SHARE = 50_033;
const C_SHARE = 11_118;
const A_REPRICED = 28_875; // what the promo repricing would file for A (over its share)

// (b) world
const CHARGE_PAID = 8_085; // swap roti -> kopi: 7.000 + 5% service + 10% PBJT
const CHARGE_DIFFERENCE = PRICES.kopi - PRICES.roti;
const CHAIN_A_PAID = ROTI_PAID + CHARGE_PAID; // 28.875
const KOPI_PRICE = PRICES.kopi;

let p: PosWorld;
let cashier: { client: ReturnType<typeof agent>; userId: string };
const TILL = randomUUID();
let shiftId = "";
const SO_A = randomUUID(); // menu items of the round-4 order
const SO_B = randomUUID();
const SO_A2 = randomUUID(); // same price as A: the replacement of a same-price swap
const SO_PAID = 34_651;
const SO_A_SHARE = 11_550;
const SO_B_SHARE = 23_101;

const tenantId = () => p.w.tenant.tenantId;

beforeAll(async () => {
  p = await createPosWorld();
  // The charge is collected at a till by a separate cashier member with its own device.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Charge 1145b', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, tenantId(), JSON.stringify(["pos.payment.accept", "order.view"])],
  );
  const client = agent(p.w.app);
  await signUp(client, "Kasir Charge 1145b");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId(), userId, roleId],
  );
  cashier = { client, userId };
  await registerTestDevice(owner, {
    tenantId: tenantId(),
    outletId: p.w.tenant.outletId,
    deviceId: TILL,
  });
  for (const [id, name, price] of [
    [SO_A, "Item A Uji 1156", 10_000],
    [SO_B, "Item B Uji 1156", 20_001],
    [SO_A2, "Item A Ganti Uji 1156", 10_000],
  ] as const) {
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        id,
        tenantId(),
        p.w.tenant.brandId,
        p.w.ids.category,
        name,
        randomUUID(),
      ],
    );
    await owner.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId(), p.w.ids.priceList, id, price],
    );
  }
  // Auto promotion (no code): buy 2 roti, get 1 roti free (an item discount on roti only).
  await owner.query(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
        conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
        budget_idr)
     VALUES ($1, $2, 'Beli 2 roti gratis 1 roti', '', 'active', NULL, false,
             now() - interval '1 hour', NULL, $3, $4, 'g_1145b', true, 0, NULL, NULL, NULL)`,
    [
      randomUUID(),
      tenantId(),
      JSON.stringify([
        {
          kind: "item_quantity",
          menuItemIds: [p.w.ids.roti],
          minQuantity: 2,
        },
      ]),
      JSON.stringify({
        kind: "free_items",
        menuItemIds: [p.w.ids.roti],
        quantityPerMultiple: 1,
      }),
    ],
  );
}, 300_000);

afterAll(async () => {
  await p.teardown();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Answer = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: { id?: string } };
};

type Ord09 = {
  issueId: string;
  resolveStatus: number;
  resolveCode: string | undefined;
  consumerError: { status?: number; code?: string } | null;
  filedIdr: number;
};

/** The ORD-09 path of the guest: report, resolve (route), then the consumer. */
async function ord09Attempt(
  lineId: string,
  approvedIdr: number,
): Promise<Ord09> {
  const prepared = await p.prepareOrd09(lineId, approvedIdr);
  const resolved = await p.resolveOrd09(prepared.issueId, prepared.approvalId);
  let consumerError: Ord09["consumerError"] = null;
  if (resolved.status === 200) {
    const event = await p.ord09Event(prepared.issueId);
    if (event)
      try {
        await p.deliverOrd09(event);
      } catch (error) {
        consumerError = error as { status?: number; code?: string };
      }
  }
  return {
    issueId: prepared.issueId,
    resolveStatus: resolved.status,
    resolveCode: (resolved.body as Answer["body"]).error?.code,
    consumerError,
    filedIdr: await p.recoveryRefundTotal([prepared.issueId]),
  };
}

/** A refused ORD-09 names its refusal: resolve 422 room (or 409), or the consumer filed nothing. */
function expectRefusalIsClean(attempt: Ord09) {
  if (attempt.resolveStatus !== 200) {
    expect([409, 422], JSON.stringify(attempt)).toContain(
      attempt.resolveStatus,
    );
    if (attempt.resolveStatus === 422)
      expect(attempt.resolveCode, JSON.stringify(attempt)).toBe(ROOM_CODE);
  }
}

async function payVerifiedQr(intentId: string, amountIdr: number) {
  const context = contextOf(tenantId());
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2`,
    [tenantId(), intentId],
  );
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

// ---------------------------------------------------------------------------
// (a) strict plain-line cap
// ---------------------------------------------------------------------------

type AbcOrder = { orderId: string; aLine: string; bLine: string; cLine: string };

/** A = kopi x1, B = roti x3 (one free), C = teh x1; paid 84.315 by a verified QRIS payment. */
async function paidAbcOrder(): Promise<AbcOrder> {
  const guest = await p.w.seat("pay_first");
  let version = 0;
  for (const [menuItemId, quantity] of [
    [p.w.ids.kopi, 1],
    [p.w.ids.teh, 1],
    [p.w.ids.roti, 3],
  ] as const) {
    const added = await p.w
      .as(guest)
      .add({ menuItemId, quantity, expectedCartVersion: version });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  const placed = await p.w.as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
  const { rows } = await owner.query<{
    subtotal_idr: number;
    discount_idr: number;
    total_idr: number;
  }>(
    `SELECT subtotal_idr::int, discount_idr::int, total_idr::int
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), toUuid(order.id)],
  );
  expect(rows[0], "A/B/C order amounts").toEqual({
    subtotal_idr: 91_000,
    discount_idr: 18_000,
    total_idr: ABC_PAID,
  });
  const payment = await p.w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerifiedQr(payment.body.data.id, ABC_PAID)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  return {
    orderId: order.id,
    aLine: line(p.w.ids.kopi),
    bLine: line(p.w.ids.roti),
    cLine: line(p.w.ids.teh),
  };
}

describe("1145b (a) an ORD-09 on a plain line never takes more than that line's share", () => {
  it("control (promo kept): ORD-09 of A (kopi, 25.000 of 91.000) on the promo order: filed <= A's share 23.163 (+3), or refused 422 REFUND_OVER_ORDER_ROOM; never the repriced 28.875", async () => {
    const abc = await paidAbcOrder();

    const attempt = await ord09Attempt(abc.aLine, KOPI_PRICE);

    expect(attempt.consumerError, JSON.stringify(attempt)).toBeNull();
    expect(
      attempt.filedIdr,
      `ORD-09 of A filed ${attempt.filedIdr}; A's share is ${A_SHARE}, the promo repricing would file ${A_REPRICED}`,
    ).toBeLessThanOrEqual(A_SHARE + SLACK);
    if (attempt.filedIdr === 0) expectRefusalIsClean(attempt);
    expect(attempt.filedIdr, "total out <= paid").toBeLessThanOrEqual(
      ABC_PAID,
    );
  });

  it("ORD-09 of C (teh, 12.000 of 91.000) is cut the same way: filed <= C's share 11.118 (+3)", async () => {
    const abc = await paidAbcOrder();

    const attempt = await ord09Attempt(abc.cLine, PRICES.teh);

    expect(attempt.consumerError, JSON.stringify(attempt)).toBeNull();
    expect(attempt.filedIdr).toBeLessThanOrEqual(C_SHARE + SLACK);
    if (attempt.filedIdr === 0) expectRefusalIsClean(attempt);
  });

  it("A's ORD-09 attempt, then a voucher on B up to B's share (50.000 <= 50.033): the voucher passes, total out <= paid and C keeps its money", async () => {
    const abc = await paidAbcOrder();

    const ord09 = await ord09Attempt(abc.aLine, KOPI_PRICE);
    expect(ord09.filedIdr).toBeLessThanOrEqual(A_SHARE + SLACK);

    const voucher = await p.apologyVoucherRequest(abc.bLine, 50_000);
    expect(
      voucher.issued.status,
      `voucher on B up to B's share (${B_SHARE}): ${JSON.stringify(voucher.issued.body)}`,
    ).toBe(201);

    const out = sum([
      ord09.filedIdr,
      await p.voucherTotal([voucher.issueId]),
    ]);
    expect(out, "ORD-09 + voucher <= paid").toBeLessThanOrEqual(ABC_PAID);
    expect(
      ABC_PAID - out,
      "C's money (its share 11.118) is still paid and kept",
    ).toBeGreaterThanOrEqual(C_SHARE - SLACK);
  });

  it("control: a plain order, ORD-09 of the roti fits its share and is filed in full (20.790)", async () => {
    const paid = await p.paidPlainOrder();
    const attempt = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expect(attempt.resolveStatus, JSON.stringify(attempt)).toBe(200);
    expect(attempt.consumerError).toBeNull();
    expect(attempt.filedIdr).toBe(ROTI_PAID);
  });

  it("control: a voucher on B alone (20.000, inside its share) passes", async () => {
    const abc = await paidAbcOrder();
    const voucher = await p.apologyVoucherRequest(abc.bLine, 20_000);
    expect(voucher.issued.status, JSON.stringify(voucher.issued.body)).toBe(
      201,
    );
    expect(await p.voucherTotal([voucher.issueId])).toBe(20_000);
  });
});

const PROMO_KOPI_SHARE = 19_425;
const PROMO_TEH_SHARE = 9_324;
const PROMO_ROTI_SHARE = 13_986;

// Order matters: paidPromoOrder seeds a second promotion (buy 2 kopi/teh, roti free) that would
// also hit the A/B/C order of (a), so (a2) stays after (a).
describe("1145b (a2) a repriced ORD-09 on a plain line never passes the line's share", () => {
  it("kopi ORD-09 (promo withdrawn, 8.085), then the roti (recompute 20.790): filed <= roti's share 13.986 (+3) or refused 422 room; total out <= paid; teh keeps its share", async () => {
    const paid = await p.paidPromoOrder();

    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    expect(kopi.resolveStatus, JSON.stringify(kopi)).toBe(200);
    expect(kopi.filedIdr, "kopi withdraws the promo").toBe(8_085);

    const roti = await ord09Attempt(paid.rotiLine, ROTI_PRICE);

    expect(roti.consumerError, JSON.stringify(roti)).toBeNull();
    expect(
      roti.filedIdr,
      `roti filed ${roti.filedIdr}; its share is ${PROMO_ROTI_SHARE}, the recompute would file ${ROTI_PAID}`,
    ).toBeLessThanOrEqual(PROMO_ROTI_SHARE + SLACK);
    if (roti.filedIdr === 0) expectRefusalIsClean(roti);
    const out = kopi.filedIdr + roti.filedIdr;
    expect(out, "total out <= paid").toBeLessThanOrEqual(PROMO_PAID);
    expect(
      PROMO_PAID - out,
      "teh's money stays paid",
    ).toBeGreaterThanOrEqual(PROMO_TEH_SHARE - SLACK);
  });

  it("roti ORD-09 first (free item, nothing left), then the kopi (recompute 28.875): filed <= kopi's share 19.425 (+3) or refused; total out <= paid", async () => {
    const paid = await p.paidPromoOrder();

    const roti = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);

    expect(kopi.consumerError, JSON.stringify(kopi)).toBeNull();
    expect(
      kopi.filedIdr,
      `kopi filed ${kopi.filedIdr}; its share is ${PROMO_KOPI_SHARE}`,
    ).toBeLessThanOrEqual(PROMO_KOPI_SHARE + SLACK);
    if (kopi.filedIdr === 0) expectRefusalIsClean(kopi);
    expect(roti.filedIdr + kopi.filedIdr).toBeLessThanOrEqual(PROMO_PAID);
  });

  it("kopi ORD-09 (8.085), then a voucher on the roti inside its share (13.000 <= 13.986) still passes", async () => {
    const paid = await p.paidPromoOrder();
    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    expect(kopi.filedIdr).toBe(8_085);

    const voucher = await p.apologyVoucherRequest(paid.rotiLine, 13_000);

    expect(voucher.issued.status, JSON.stringify(voucher.issued.body)).toBe(
      201,
    );
    expect(
      kopi.filedIdr + (await p.voucherTotal([voucher.issueId])),
    ).toBeLessThanOrEqual(PROMO_PAID);
  });
});

// ---------------------------------------------------------------------------
// (b) cash void of a recovery charge after ORD-09 paid on its chain
// ---------------------------------------------------------------------------

type Channel = "cash" | "online";
type Charge = { paid: PaidOrder; issueId: string; chargeId: string; replacementLine: string };

/** QR order, roti swapped for the dearer kopi: the swap charge (8.085) is open. */
async function openCharge(): Promise<Charge> {
  const paid = await p.paidPlainOrder();
  const issueId = await p.reportLine(paid.rotiLine);
  const approvalId = await p.w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: CHARGE_DIFFERENCE,
    status: "approved",
    requestedBy: p.w.floorStaff.userId,
  });
  const swapped = await p.w.staffPost(
    p.w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: p.w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const event = (await p.w.outboxRows("order_issue.resolved", issueId))[0]!
    .event;
  const context = contextOf(tenantId());
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const charge = await owner.query<{ id: string }>(
    "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [tenantId(), issueId],
  );
  expect(charge.rows).toHaveLength(1);
  const replacement = await owner.query<{ id: string | null }>(
    "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [tenantId(), issueId],
  );
  expect(replacement.rows[0]!.id, "replacement line").not.toBeNull();
  return {
    paid,
    issueId,
    chargeId: charge.rows[0]!.id,
    replacementLine: toUlid(replacement.rows[0]!.id!),
  };
}

async function ensureShift(orderId: string) {
  if (shiftId) return;
  const business = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenantId(), toUuid(orderId)],
  );
  shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
    [
      shiftId,
      tenantId(),
      p.w.tenant.outletId,
      TILL,
      cashier.userId,
      business.rows[0]!.d,
      randomUUID(),
      "b".repeat(64),
    ],
  );
}

async function payChargeCash(charge: Charge) {
  await ensureShift(charge.paid.orderId);
  const token = signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenantId(),
    brandId: null,
    deviceId: TILL,
  });
  const res = await cashier.client
    .post(`/api/order-issue-charges/${charge.chargeId}/collect-at-pos`)
    .set("Host", p.w.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, token)
    .send({
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: CHARGE_PAID,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function payChargeOnline(charge: Charge) {
  const created = await agent(p.w.app)
    .post(
      `/api/table-sessions/${charge.paid.guest.sessionId}/issue-charges/${charge.chargeId}/payments`,
    )
    .set("Host", p.w.tenant.hostname)
    .set("Authorization", `Bearer ${charge.paid.guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const intentId = created.body.data.id as string;
  const context = contextOf(tenantId());
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: CHARGE_PAID,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2`,
    [tenantId(), intentId],
  );
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(
      context,
      eventEnvelopeSchema.parse(rows[0]!.event),
      tx,
    ),
  );
}

/** QR order, roti swapped for kopi, the charge paid by `channel`, the order a POS cash sale. */
async function paidSwapSale(channel: Channel): Promise<Charge> {
  const charge = await openCharge();
  if (channel === "cash") await payChargeCash(charge);
  else await payChargeOnline(charge);
  return charge;
}

describe("1145b (b) voiding an order whose swap chain already paid ORD-09", () => {
  it("cash charge: ORD-09 of the replacement is filed, then the cloud void is refused (409 ORD-09 lane or 422 REFUND_OVER_ORDER_ROOM); no void row", async () => {
    const charge = await paidSwapSale("cash");
    const ord09 = await ord09Attempt(charge.replacementLine, KOPI_PRICE);
    expect(ord09.resolveStatus, "ORD-09 of the replacement resolves").toBe(200);
    expect(ord09.consumerError).toBeNull();
    expect(ord09.filedIdr, "ORD-09 filed").toBeGreaterThan(0);
    expect(ord09.filedIdr).toBeLessThanOrEqual(CHAIN_A_PAID);
    await p.becomePosSale(charge.paid);

    const voided = await p.cloudVoid(charge.paid.orderId);

    expect(voided.ok, "void must be refused").toBe(false);
    if (voided.ok) return;
    // Finding: the older lane guard (legend-aja6g) refuses a void of any order with a
    // live ORD-09 first, 409 REFUND_ORD09_REFUND_EXISTS, so the chain check of
    // decision 2 (422 REFUND_OVER_ORDER_ROOM) cannot be reached through a live ORD-09.
    // Both refusals are accepted: what matters is the money (no void, no cash out).
    expect(
      [
        "409 REFUND_ORD09_REFUND_EXISTS",
        `422 ${ROOM_CODE}`,
      ],
      errorText(voided.error),
    ).toContain(`${voided.error.status} ${voided.error.code}`);
    expect(await p.voidCount(charge.paid.orderId), "void rolled back").toBe(0);
    expect(await p.recoveryRefundTotal([ord09.issueId])).toBe(ord09.filedIdr);
  });

  it("gateway charge: ORD-09 of the replacement is filed, then the cloud void is still refused; no void row", async () => {
    const charge = await paidSwapSale("online");
    const ord09 = await ord09Attempt(charge.replacementLine, KOPI_PRICE);
    expect(ord09.resolveStatus, "ORD-09 of the replacement resolves").toBe(200);
    expect(ord09.consumerError).toBeNull();
    expect(ord09.filedIdr, "ORD-09 filed").toBeGreaterThan(0);
    await p.becomePosSale(charge.paid);

    const voided = await p.cloudVoid(charge.paid.orderId);

    expect(voided.ok, "void must be refused").toBe(false);
    if (voided.ok) return;
    expect(voided.error.status ?? 0, errorText(voided.error)).toBeLessThan(500);
    expect(await p.voidCount(charge.paid.orderId), "void rolled back").toBe(0);
  });

  it("control: a cash-charged swap sale WITHOUT ORD-09 is voided as before", async () => {
    const charge = await paidSwapSale("cash");
    await p.becomePosSale(charge.paid);

    const voided = await p.cloudVoid(charge.paid.orderId);

    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(charge.paid.orderId)).toBe(1);
  });

  it("control: a plain cash sale (no charge) is voided as before", async () => {
    const paid = await p.paidPlainOrder();
    await p.becomePosSale(paid, ORDER_PAID);

    const voided = await p.cloudVoid(paid.orderId);

    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(paid.orderId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (c) round 4: line shares by largest remainder, no 1 IDR cut of a legitimate refund
// ---------------------------------------------------------------------------

type SoOrder = {
  orderId: string;
  aLine: string;
  bLine: string;
};

/** QR pay-first order A 10.000 + B 20.001, paid 34.651, not completed. */
async function paidSoOrder(): Promise<SoOrder> {
  const guest = await p.w.seat("pay_first");
  let version = 0;
  for (const menuItemId of [SO_A, SO_B]) {
    const added = await p.w
      .as(guest)
      .add({ menuItemId, quantity: 1, expectedCartVersion: version });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  const placed = await p.w.as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
  const { rows } = await owner.query<{ total_idr: number }>(
    "SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenantId(), toUuid(order.id)],
  );
  expect(rows[0]!.total_idr, "round-4 order total").toBe(SO_PAID);
  const payment = await p.w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerifiedQr(payment.body.data.id, SO_PAID)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  return {
    orderId: order.id,
    aLine: line(SO_A),
    bLine: line(SO_B),
  };
}

/** A swapped for A' at the same price (no difference, no charge); returns the replacement line. */
async function sameWaySwapOfA(so: SoOrder): Promise<string> {
  const issueId = await p.reportLine(so.aLine);
  const swapped = await p.w.staffPost(
    p.w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "swap", replacementItemId: SO_A2 },
  );
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const event = (await p.w.outboxRows("order_issue.resolved", issueId))[0]!
    .event;
  const context = contextOf(tenantId());
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
  const replacement = await owner.query<{ id: string | null }>(
    "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [tenantId(), issueId],
  );
  expect(replacement.rows[0]!.id, "replacement line").not.toBeNull();
  return toUlid(replacement.rows[0]!.id!);
}

describe("1145b (c) line shares add up exactly to what was paid", () => {
  it("control, no swap: ORD-09 of A files exactly 11.550 (not cut to 11.549)", async () => {
    const so = await paidSoOrder();
    const attempt = await ord09Attempt(so.aLine, 10_000);
    expect(attempt.resolveStatus, JSON.stringify(attempt)).toBe(200);
    expect(attempt.consumerError).toBeNull();
    expect(attempt.filedIdr).toBe(SO_A_SHARE);
  });

  it("same-price swap, the replacement fails: ORD-09 files exactly 11.550 (no 422); the order's total out never passes the 34.651 paid", async () => {
    const so = await paidSoOrder();
    const replacementLine = await sameWaySwapOfA(so);

    const attempt = await ord09Attempt(replacementLine, 10_000);
    expect(
      attempt.resolveStatus,
      `the legitimate 11.550 is not refused: ${JSON.stringify(attempt)}`,
    ).toBe(200);
    expect(attempt.consumerError).toBeNull();
    expect(attempt.filedIdr, "exactly the legitimate refund").toBe(SO_A_SHARE);
    expect(attempt.filedIdr).toBeLessThanOrEqual(SO_PAID);
  });

  it("same-price swap, voucher on the replacement: 11.550 passes exactly", async () => {
    const so = await paidSoOrder();
    const replacementLine = await sameWaySwapOfA(so);
    const ok = await p.apologyVoucherRequest(replacementLine, SO_A_SHARE);
    expect(ok.issued.status, JSON.stringify(ok.issued.body)).toBe(201);
  });

  it("same-price swap, voucher on the replacement: 11.551 (+1 rupiah) is refused 422, nothing minted", async () => {
    const so = await paidSoOrder();
    const replacementLine = await sameWaySwapOfA(so);
    const over = await p.apologyVoucherRequest(replacementLine, SO_A_SHARE + 1);
    expect(over.issued.status, JSON.stringify(over.issued.body)).toBe(422);
    expect(await p.voucherTotal([over.issueId])).toBe(0);
  });

  it("voucher on A: 11.551 is refused 422 (+1 rupiah), nothing minted", async () => {
    const so = await paidSoOrder();
    const over = await p.apologyVoucherRequest(so.aLine, SO_A_SHARE + 1);
    expect(over.issued.status, JSON.stringify(over.issued.body)).toBe(422);
    expect(await p.voucherTotal([over.issueId])).toBe(0);
  });

  it("voucher on A 11.550 and on B 23.101 both pass: the line shares add up to exactly the 34.651 paid", async () => {
    const so = await paidSoOrder();
    const a = await p.apologyVoucherRequest(so.aLine, SO_A_SHARE);
    expect(a.issued.status, JSON.stringify(a.issued.body)).toBe(201);
    const b = await p.apologyVoucherRequest(so.bLine, SO_B_SHARE);
    expect(b.issued.status, JSON.stringify(b.issued.body)).toBe(201);
    expect(
      await p.voucherTotal([a.issueId, b.issueId]),
      "shares of all lines = paid",
    ).toBe(SO_PAID);
    expect(SO_A_SHARE + SO_B_SHARE).toBe(SO_PAID);
  });
});
