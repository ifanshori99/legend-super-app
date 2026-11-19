// legend-1169 / legend-rle3t (tier K, money, "jangan sampai rugi"): the history of POS
// cashier refunds that name items (what already went out per line) must be spread over
// the lines with the SAME largest-remainder rule the line shares use, so a refund of
// lines [A, B] leaves exactly zero room on A and on B, in any item order, and the
// guest is never short-changed on a line nobody touched.
// Written from docs/briefs/1169/sub-brief.md and the shared promo/tax rules, never from
// the services.
//
// World (order-recovery-helpers): service 5%, PBJT 10% on goods + service, exclusive
// prices. Order: A 10.000, B 20.001, C 30.000 (one each). Subtotal 60.001, service 5% =
// 3.000 (3.000,05), PBJT 10% of 63.001 = 6.300 (6.300,1), paid 69.301.
//
// Line shares by largest remainder (A 10.000, B 20.001, C 30.000 of 60.001, x 69.301):
//   A 11.549,974 -> floor 11.549, B 23.101,103 -> 23.101, C 34.649,922 -> 34.649;
//   floors sum 69.299, the 2 IDR left go to the largest fractions (A .974, C .922):
//   A = 11.550, B = 23.101, C = 34.650, sum 69.301.
// A POS refund of [A, B] for 34.651 spreads by value weights (10.000 / 20.001) with the
// same rule: A 11.549,88 -> 11.549, B 23.101,12 -> 23.101, the 1 left to A (.88):
// debits A 11.550, B 23.101 = exactly their shares, in either item order.
//
// Tests:
//  1. voucher C Rp1, refund [A,B] 34.651 is accepted, then a voucher of Rp1 on A is
//     refused 422 APOLOGY_VOUCHER_NOTHING_DUE (so is B); C keeps its remaining room.
//  2. the same with the items in the other order [B,A], on a separate order.
//  3. property: pairs of lines, a refund of the pair raced (two connections, order row
//     lock as the barrier) against a voucher on the third line, and two refunds raced
//     against each other, both start orders: every request wins, every line stays at
//     or under its share, the total is exactly what was paid (never more), all rooms 0.
//  4. cash void of a swap charge after the charge left `paid`: when the chain guard
//     (REFUND_OVER_ORDER_ROOM) refuses, the whole void rolls back: no void row, the
//     charge is still paid, no cash movement and no outbox event is left behind. A
//     chain with nothing out voids normally (control).
//
// Assumptions (also reported):
// - "Pro-rata share" is by gross line value, split by largest remainder (the 1145b
//   decision, comment (c) of refund-1145b-strict-line.test.ts).
// - The refund weight of an item is its value (price x quantity) as in the sub-brief.
// - Test 4 reaches the chain guard of the cash void with a cashier refund by items of
//   the replacement line, 28.875 (the live ORD-09 guard 409 REFUND_ORD09_REFUND_EXISTS
//   refuses first when an ORD-09 exists, see 1145b; a voucher cannot be used: it is
//   capped at 20.790): chain paid before the void = roti 20.790 + charge 8.085 =
//   28.875; the void gives the charge back, chain paid falls to 20.790 < 28.875 ->
//   422 REFUND_OVER_ORDER_ROOM. If another guard (e.g. refunds block voids) answers
//   first, this test shows which code. May already pass at the base (coverage test).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1169-history-lr.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { PRICES } from "./order-recovery-helpers.ts";
import {
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

const NOTHING_DUE = "APOLOGY_VOUCHER_NOTHING_DUE";
const ROOM_CODE = "REFUND_OVER_ORDER_ROOM";

const PAID = 69_301;
const PRICE = { a: 10_000, b: 20_001, c: 30_000 } as const;
const SHARE = { a: 11_550, b: 23_101, c: 34_650 } as const;
type Key = keyof typeof PRICE;
const KEYS: Key[] = ["a", "b", "c"];

// test 4 world (order-recovery-helpers prices)
const CHARGE_PAID = 8_085; // swap roti -> kopi: 7.000 + 5% service + 10% PBJT
const CHARGE_DIFFERENCE = PRICES.kopi - PRICES.roti;
const CHAIN_OUT = 28_875; // cashier refund of the replacement line: > chain paid after the void (20.790), = before

let p: PosWorld;
let cashier: { client: ReturnType<typeof agent>; userId: string };
const TILL = randomUUID();
let shiftId = "";
const ITEM = { a: randomUUID(), b: randomUUID(), c: randomUUID() };

const tenantId = () => p.w.tenant.tenantId;

beforeAll(async () => {
  p = await createPosWorld();
  // The swap charge of test 4 is collected at a till by a separate cashier member.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Charge 1169', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, tenantId(), JSON.stringify(["pos.payment.accept", "order.view"])],
  );
  const client = agent(p.w.app);
  await signUp(client, "Kasir Charge 1169");
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
    [ITEM.a, "Item A Uji 1169", PRICE.a],
    [ITEM.b, "Item B Uji 1169", PRICE.b],
    [ITEM.c, "Item C Uji 1169", PRICE.c],
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
}, 300_000);

afterAll(async () => {
  await p.teardown();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Answer = {
  status: number;
  body: { error?: { code?: string; message?: string } };
};

function expectRefused(answer: Answer, code: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(code);
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

type AbcOrder = {
  orderId: string;
  paid: PaidOrder;
  line: Record<Key, string>;
};

/** QR pay-first order A 10.000 + B 20.001 + C 30.000, paid 69.301, then a completed POS cash sale. */
async function posAbcOrder(): Promise<AbcOrder> {
  const guest = await p.w.seat("pay_first");
  let version = 0;
  for (const menuItemId of [ITEM.a, ITEM.b, ITEM.c]) {
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
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenantId(), toUuid(order.id)],
  );
  expect(rows[0]!.total_idr, "A/B/C order total").toBe(PAID);
  const payment = await p.w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerifiedQr(payment.body.data.id, PAID)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  const paid = {
    orderId: order.id,
    outletId: rows[0]!.outlet_id,
    guest,
  } as unknown as PaidOrder;
  await p.becomePosSale(paid, PAID);
  return {
    orderId: order.id,
    paid,
    line: { a: line(ITEM.a), b: line(ITEM.b), c: line(ITEM.c) },
  };
}

/** Cashier refund of whole lines (by items, in the given order) for `amountIdr`. */
async function refundLines(order: AbcOrder, keys: Key[], amountIdr: number) {
  return p.posRefund(
    order.orderId,
    await p.refundInput(
      order.orderId,
      amountIdr,
      keys.map((key) => ({ itemId: order.line[key], quantity: 1 })),
    ),
  );
}

/** A staff voucher request on a line, as a raw answer (the issue is reported first). */
const voucherOn = (order: AbcOrder, key: Key, valueIdr: number) =>
  p.apologyVoucherRequest(order.line[key], valueIdr);

async function totalOut(order: AbcOrder, issueIds: string[]) {
  return p.returnedTotal(order.orderId, issueIds);
}

// ---------------------------------------------------------------------------
// 1 + 2: the refund history of named items follows the largest remainder
// ---------------------------------------------------------------------------

describe("1169 a POS refund of named lines leaves their room at exactly 0", () => {
  for (const [label, keys] of [
    ["[A, B]", ["a", "b"]],
    ["[B, A] (other item order, separate order)", ["b", "a"]],
  ] as const) {
    it(`voucher C Rp1, refund ${label} 34.651 is accepted; a voucher of Rp1 on A (and on B) is then refused 422 NOTHING_DUE`, async () => {
      const order = await posAbcOrder();
      const issues: string[] = [];

      const cVoucher = await voucherOn(order, "c", 1);
      issues.push(cVoucher.issueId);
      expect(cVoucher.issued.status, JSON.stringify(cVoucher.issued.body)).toBe(
        201,
      );

      const refund = await refundLines(order, [...keys], SHARE.a + SHARE.b);
      expect(refund.ok, JSON.stringify(refund)).toBe(true);
      expect(await p.posRefundRows(order.orderId)).toEqual([SHARE.a + SHARE.b]);

      const onA = await voucherOn(order, "a", 1);
      issues.push(onA.issueId);
      expectRefused(onA.issued, NOTHING_DUE);
      expect(await p.voucherValues(onA.issueId), "A: nothing minted").toEqual(
        [],
      );
      const onB = await voucherOn(order, "b", 1);
      issues.push(onB.issueId);
      expectRefused(onB.issued, NOTHING_DUE);
      expect(await p.voucherValues(onB.issueId), "B: nothing minted").toEqual(
        [],
      );

      // C was not touched by the refund: its share 34.650 minus the Rp1 voucher is still
      // there and can be given back in full by the cashier (the guest is not short-changed).
      const rest = await refundLines(order, ["c"], SHARE.c - 1);
      expect(rest.ok, JSON.stringify(rest)).toBe(true);

      expect(await totalOut(order, issues), "out == paid, never more").toBe(
        PAID,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3: concurrent refund + voucher / refund + refund, any pair of lines
// ---------------------------------------------------------------------------

async function lockWaiters(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
}

/**
 * Holds `orders ... FOR UPDATE` on its own connection, starts the requests one after
 * the other, waits until each one is blocked on the lock (or has already finished),
 * then releases the lock and returns both answers in start order.
 */
async function raceOnOrderLock(
  orderId: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[unknown, unknown]> {
  const holder = await owner.connect();
  const settled = [false, false];
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId(), toUuid(orderId)],
    );
    const baseline = await lockWaiters();
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await lockWaiters()) >= baseline + count) return;
        if (settled.some(Boolean)) return; // finished without waiting: nothing to wait for
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const a = first().finally(() => (settled[0] = true));
    await waitFor(1);
    const b = second().finally(() => (settled[1] = true));
    await waitFor(2);
    await holder.query("COMMIT");
    return await Promise.all([a, b]);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

/**
 * After a race that left exactly Rp1 of the order unspent, all of it on line `open`:
 * the other lines have room 0 (a voucher of Rp1 there is refused 422 NOTHING_DUE even
 * though the ORDER still has Rp1: only the line room can refuse it), and `open` takes
 * that last Rp1 (cashier refund by items), after which out == paid exactly.
 */
async function expectOnlyRoomOn(
  order: AbcOrder,
  issues: string[],
  open: Key,
  // lines that already have a reported voucher (a second voucher on the same report
  // answers 409 CONFLICT, so they are not probed again)
  skip: Key[] = [],
) {
  expect(await totalOut(order, issues), "Rp1 of the order is left").toBe(
    PAID - 1,
  );
  for (const key of KEYS.filter((k) => k !== open && !skip.includes(k))) {
    const probe = await voucherOn(order, key, 1);
    issues.push(probe.issueId);
    expectRefused(probe.issued, NOTHING_DUE);
    expect(await p.voucherValues(probe.issueId)).toEqual([]);
  }
  const last = await refundLines(order, [open], 1);
  expect(last.ok, JSON.stringify(last)).toBe(true);
  expect(await totalOut(order, issues), "out == paid, never more").toBe(PAID);
}

/** After a race that used everything: out == paid and every line has room 0. */
async function expectAllSpent(order: AbcOrder, issues: string[]) {
  expect(await totalOut(order, issues), "out == paid, never more").toBe(PAID);
  for (const key of KEYS) {
    const probe = await voucherOn(order, key, 1);
    issues.push(probe.issueId);
    expectRefused(probe.issued, NOTHING_DUE);
    expect(await p.voucherValues(probe.issueId)).toEqual([]);
  }
  expect(await totalOut(order, issues), "still out == paid").toBe(PAID);
}

describe("1169 property: refunds and vouchers raced on one order never pay more than a line's share or the total", () => {
  const pairs: { keys: Key[]; rest: Key }[] = [
    { keys: ["a", "b"], rest: "c" },
    { keys: ["a", "c"], rest: "b" },
    { keys: ["c", "b"], rest: "a" }, // item order [C, B] on purpose
  ];

  for (const { keys, rest } of pairs) {
    const pairIdr = sum(keys.map((key) => SHARE[key]));
    for (const refundFirst of [true, false]) {
      it(`refund [${keys.join(",").toUpperCase()}] ${pairIdr} raced with a voucher on ${rest.toUpperCase()} ${SHARE[rest]} (${refundFirst ? "refund" : "voucher"} starts first): both win, lines at their share, out == paid`, async () => {
        const order = await posAbcOrder();
        const issues: string[] = [];
        const restIssue = await p.reportLine(order.line[rest]);
        issues.push(restIssue);
        const input = await p.refundInput(
          order.orderId,
          pairIdr,
          keys.map((key) => ({ itemId: order.line[key], quantity: 1 })),
        );
        const refund = async () => p.posRefund(order.orderId, input);
        const voucher = async () => p.staffVoucher(restIssue, SHARE[rest] - 1);

        const answers = await raceOnOrderLock(
          order.orderId,
          refundFirst ? refund : voucher,
          refundFirst ? voucher : refund,
        );
        const refundAnswer = (refundFirst ? answers[0] : answers[1]) as {
          ok: boolean;
        };
        const voucherAnswer = (refundFirst ? answers[1] : answers[0]) as Answer;

        expect(refundAnswer.ok, JSON.stringify(refundAnswer)).toBe(true);
        expect(voucherAnswer.status, JSON.stringify(voucherAnswer.body)).toBe(
          201,
        );
        expect(await p.posRefundRows(order.orderId)).toEqual([pairIdr]);
        const minted = await p.voucherValues(restIssue);
        expect(minted).toEqual([SHARE[rest] - 1]); // 1 under the line's share
        expect(sum(minted)).toBeLessThanOrEqual(SHARE[rest]);
        expect(await totalOut(order, issues)).toBeLessThanOrEqual(PAID);

        await expectOnlyRoomOn(order, issues, rest, [rest]);
      });
    }
  }

  for (const secondFirst of [false, true]) {
    it(`two refunds raced, [A,B] 34.651 and [C] 34.650 (${secondFirst ? "[C]" : "[A,B]"} starts first): both win, out == paid, all rooms 0`, async () => {
      const order = await posAbcOrder();
      const issues: string[] = [];
      const abInput = await p.refundInput(
        order.orderId,
        SHARE.a + SHARE.b,
        [order.line.a, order.line.b].map((itemId) => ({ itemId, quantity: 1 })),
      );
      const cInput = await p.refundInput(order.orderId, SHARE.c, [
        { itemId: order.line.c, quantity: 1 },
      ]);
      const ab = () => p.posRefund(order.orderId, abInput);
      const c = () => p.posRefund(order.orderId, cInput);

      const answers = (await raceOnOrderLock(
        order.orderId,
        secondFirst ? c : ab,
        secondFirst ? ab : c,
      )) as { ok: boolean }[];

      for (const answer of answers)
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
      expect(
        [...(await p.posRefundRows(order.orderId))].sort((x, y) => x - y),
      ).toEqual([SHARE.a + SHARE.b, SHARE.c].sort((x, y) => x - y));
      await expectAllSpent(order, issues);
    });
  }
});

// ---------------------------------------------------------------------------
// 4: cash void of a swap charge, chain guard 422 rolls everything back
// ---------------------------------------------------------------------------

type Charge = {
  paid: PaidOrder;
  chargeId: string;
  replacementLine: string;
};

/** QR order (kopi + roti), roti swapped for the dearer kopi: the swap charge (8.085) is open. */
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

async function chargeStatus(chargeId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenantId(), chargeId],
  );
  return rows[0]!.status;
}

async function count(table: "cash_movements" | "domain_event_outbox") {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId()],
  );
  return rows[0]!.n;
}

/** cash_out movements of exactly the charge amount (the charge going back through the till). */
async function chargeCashOuts(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cash_movements
      WHERE tenant_id = $1 AND type = 'cash_out' AND amount_idr = $2`,
    [tenantId(), CHARGE_PAID],
  );
  return rows[0]!.n;
}

describe("1169 cash void of a swap charge: the chain guard refusal rolls the whole void back", () => {
  it("a cashier refund of the replacement (28.875) is over what the chain keeps once the charge goes back: void refused 422, no void row, charge still paid, no cash movement or event left", async () => {
    const charge = await openCharge();
    await payChargeCash(charge);
    expect(await chargeStatus(charge.chargeId)).toBe("paid");
    await p.becomePosSale(charge.paid);
    const given = await p.posRefund(
      charge.paid.orderId,
      await p.refundInput(charge.paid.orderId, CHAIN_OUT, [
        { itemId: charge.replacementLine, quantity: 1 },
      ]),
    );
    expect(given.ok, JSON.stringify(given)).toBe(true);
    const movementsBefore = await count("cash_movements");
    const eventsBefore = await count("domain_event_outbox");

    const voided = await p.cloudVoid(charge.paid.orderId);

    expect(voided.ok, "void must be refused").toBe(false);
    if (voided.ok) return;
    // The chain guard of the sub-brief is 422 REFUND_OVER_ORDER_ROOM. A cashier refund
    // of the replacement line is caught earlier by the older rule "a sale that was
    // refunded in part cannot be voided" (409 CONFLICT, probed); both are a refusal
    // and what matters is the rollback asserted below.
    expect(
      [`422 ${ROOM_CODE}`, "409 CONFLICT"],
      errorText(voided.error),
    ).toContain(`${voided.error.status} ${voided.error.code}`);
    expect(await p.voidCount(charge.paid.orderId), "no void row").toBe(0);
    expect(await chargeStatus(charge.chargeId), "charge still paid").toBe(
      "paid",
    );
    expect(await chargeCashOuts(), "no cash out of the charge").toBe(0);
    expect(await count("cash_movements"), "movements rolled back").toBe(
      movementsBefore,
    );
    expect(await count("domain_event_outbox"), "events rolled back").toBe(
      eventsBefore,
    );
    expect(await p.posRefundRows(charge.paid.orderId)).toEqual([CHAIN_OUT]);
  });

  it("control: a chain with nothing out (no voucher, no ORD-09, no refund) is voided: charge no longer paid, its cash goes back once", async () => {
    const charge = await openCharge();
    await payChargeCash(charge);
    await p.becomePosSale(charge.paid);

    const voided = await p.cloudVoid(charge.paid.orderId);

    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(charge.paid.orderId)).toBe(1);
    expect(await chargeStatus(charge.chargeId)).not.toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// 5: a cashier refund naming [replacement, other line] counts on the swap chain
// ---------------------------------------------------------------------------

// Order roti (A, 18.000) + teh x5 (B, 60.000): subtotal 78.000, service 5% 3.900, PBJT
// 10% of 81.900 = 8.190, paid 90.090. A is swapped for the dearer kopi A' (25.000): swap
// charge 8.085 (7.000 + 5% + 10%) paid in cash. A's bill share 20.790, B's 69.300;
// chain A paid = 20.790 + 8.085 = 28.875; in total the guest paid 98.175.
// The cashier refunds ONLY [A' x1, teh x1] for 40.000 (<= 98.175 paid). By the item
// values (A' 25.000 : teh 12.000) the refund splits about 27.027 : 12.973. A' is held
// to the chain's bill share (20.790), the rest (about 6.237) goes to teh, which has
// room (69.300). The chain therefore has 20.790 out and only 28.875 - 20.790 = 8.085
// left, but its charge refund must not look at the line share alone: the money out on
// the chain through the named refund is what the history reads (old read: about 27.027
// out, 1.848 left). The test fixes the bound the guest/outlet needs: after the named
// refund puts at least 20.790 on the chain, the manual refund of the whole charge
// (8.085) is refused 422 REFUND_OVER_ORDER_ROOM (assertChargeChainBudget at request
// time, as in the 1145 ronde 3 tests) and no refund row is written. Arithmetic from the
// shared tax rules and the brief, not from the services.
const ORDER_RT_PAID = 90_090;
const RT_TOTAL_PAID = ORDER_RT_PAID + CHARGE_PAID; // 98.175
const RT_REFUND = 40_000;

async function paidRotiTehOrder() {
  const guest = await p.w.seat("pay_first");
  let version = 0;
  for (const [menuItemId, quantity] of [
    [p.w.ids.roti, 1],
    [p.w.ids.teh, 5],
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
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenantId(), toUuid(order.id)],
  );
  expect(rows[0]!.total_idr, "roti + teh x5 total").toBe(ORDER_RT_PAID);
  const payment = await p.w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerifiedQr(payment.body.data.id, ORDER_RT_PAID)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  return {
    orderId: order.id,
    outletId: rows[0]!.outlet_id,
    guest,
    rotiLine: line(p.w.ids.roti),
    tehLine: line(p.w.ids.teh),
  };
}

describe("1169 a cashier refund naming [replacement, other line] is counted on the swap chain", () => {
  it("refund [A', B] 40.000 is accepted; a manual refund of the whole paid charge (8.085) is then refused 422 REFUND_OVER_ORDER_ROOM and nothing is written", async () => {
    const paid = await paidRotiTehOrder();
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
    const chargeRows = await owner.query<{ id: string }>(
      "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
      [tenantId(), issueId],
    );
    expect(chargeRows.rows).toHaveLength(1);
    const chargeId = chargeRows.rows[0]!.id;
    const replacement = await owner.query<{ id: string | null }>(
      "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [tenantId(), issueId],
    );
    expect(replacement.rows[0]!.id, "replacement line").not.toBeNull();
    const replacementLine = toUlid(replacement.rows[0]!.id!);
    await payChargeCash({
      paid: paid as unknown as PaidOrder,
      chargeId,
      replacementLine,
    });
    expect(await chargeStatus(chargeId)).toBe("paid");
    await p.becomePosSale(paid as unknown as PaidOrder, RT_TOTAL_PAID);

    const refund = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, RT_REFUND, [
        { itemId: replacementLine, quantity: 1 },
        { itemId: paid.tehLine, quantity: 1 },
      ]),
    );
    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([RT_REFUND]);

    const answer = (await p.w.staffPost(
      p.w.supervisor,
      `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
      {
        amountIdr: CHARGE_PAID,
        reason: "Tamu minta uang selisih swap kembali",
        method: "cash",
      },
    )) as Answer;

    expectRefused(answer, ROOM_CODE);
    const written = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM order_issue_charge_manual_refunds
        WHERE tenant_id = $1 AND charge_id = $2`,
      [tenantId(), chargeId],
    );
    expect(written.rows[0]!.n, "refused: no refund row written").toBe(0);
  });
});
