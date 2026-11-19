// legend-1131 (tier K, money, "jangan sampai rugi"): ONE money-out budget per order.
// Second opinion 1129 found two P1 holes: (1) apology voucher, then an ORD-09 refund of
// the same money (Rp200.000 out of a Rp100.000 payment); (2) apology voucher, then a
// refund of the swap-difference charge (Rp140.000 out of Rp120.000 paid).
//
// Rule under test (docs/briefs/1131-fix-1095-so-ronde2.md, sub-1131.md):
//   room = paid - live money out (cashier refunds, ORD-09, charge refunds, provider /
//          gateway refunds) - live apology vouchers; every path refuses a request above
//   the room, never cuts it silently, in BOTH directions:
//   staff over the room -> 422 REFUND_OVER_ORDER_ROOM (ORD-09 settlement, charge manual
//   request, charge online refund) or the voucher's own 422 (APOLOGY_VOUCHER_*).
//   The async ORD-09 consumer over the room files no refund (audit refund_blocked).
//
// Written from the briefs and the existing 1095 / 980 / 982 / 985 / 1116 tests, never
// from the implementation. Real routes and the real consumers (delivered by hand, as
// the worker does); only parked-money / provider facts are raw rows (as in 1116).
//
// Assumptions (also reported):
// - The brief's Rp100.000 world is scaled to the 1095 world: QR order kopi 28.875 +
//   roti 20.790 = 49.665; the swap charge roti -> kopi is 8.085 (7.000 + 5% + 10%).
// - ORD-09 over the room: the resolve route answers 422 REFUND_OVER_ORDER_ROOM (asserted
//   where voucher money alone makes the room too small). In the property table an
//   earlier existing refusal (409) or a refusal by the consumer (no refund filed) is
//   accepted too: the money assertions decide.
// - Finance manual refund (PAY-04) has no service change in 1131 (its bill-money cap
//   already holds): those cases are controls with the invariant "no money moves".
// - The approval-time re-check of a manual charge refund cannot be reached through the
//   routes (a pending request already counts as live money out), so it is not asserted.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1131-order-budget.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { registerTestDevice } from "./device-seed.ts";
import { owner, staffWithRole, type Staff } from "./floor-test-helpers.ts";
import { ulidToUuid } from "@starter/shared/core";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { CART_TOTAL, PRICES } from "./order-recovery-helpers.ts";
import {
  KOPI_PAID,
  ORDER_PAID,
  PROMO_PAID,
  ROTI_PAID,
  ROTI_PRICE,
  contextOf,
  createPosWorld,
  sum,
  toUlid,
  toUuid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 240_000 });

const ROOM_CODE = "REFUND_OVER_ORDER_ROOM";
const KOPI_PRICE = PRICES.kopi;
const CHARGE_PAID = 8_085; // swap roti -> kopi: 7.000 + 5% service + 10% PBJT
const CHARGE_DIFFERENCE = PRICES.kopi - PRICES.roti;
const ADMIN = "/api/payments/admin";

let p: PosWorld;
let approver: Staff; // order.recovery.handle + pos.refund.approve
let cashier: { client: ReturnType<typeof agent>; userId: string };
let finance: Staff;
const TILL = randomUUID();
let shiftId = "";

const tenantId = () => p.w.tenant.tenantId;

async function userWithPermissions(
  label: string,
  permissions: string[],
): Promise<Staff> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [roleId, tenantId(), label, JSON.stringify(permissions)],
  );
  const client = agent(p.w.app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId(), userId, roleId],
  );
  return { client, userId, email };
}

beforeAll(async () => {
  p = await createPosWorld();
  approver = await userWithPermissions("Penyetuju Refund 1131", [
    "order.view",
    "order.recovery.handle",
    "pos.refund.approve",
  ]);
  const till = await userWithPermissions("Kasir Charge 1131", [
    "pos.payment.accept",
    "order.view",
  ]);
  cashier = { client: till.client, userId: till.userId };
  await registerTestDevice(owner, {
    tenantId: tenantId(),
    outletId: p.w.tenant.outletId,
    deviceId: TILL,
  });
  finance = await staffWithRole(p.w.app, {
    template: "owner",
    tenantId: tenantId(),
    label: "Finance 1131",
  });
  await verifySessionMfa(finance.email);
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

function expectRoom422(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(ROOM_CODE);
}

const VOUCHER_REFUSALS = [
  "APOLOGY_VOUCHER_NOTHING_DUE",
  "APOLOGY_VOUCHER_OVER_ROOM",
];
/**
 * A voucher over the room is refused with the voucher's own 422, or by the existing
 * lane guard (409 CONFLICT: the item is already refunded by ORD-09). Never issued.
 */
function expectVoucherRefused(answer: Answer) {
  expect([409, 422], JSON.stringify(answer.body)).toContain(answer.status);
  if (answer.status === 422)
    expect(VOUCHER_REFUSALS, JSON.stringify(answer.body)).toContain(
      answer.body.error?.code,
    );
}

type Ord09 = {
  issueId: string;
  resolveStatus: number;
  resolveCode: string | undefined;
  consumerError: { status?: number; code?: string } | null;
  filedIdr: number;
};

let kitchenStation: string | null = null;

/**
 * A kitchen complaint (type complaint, no resolution): the issue an apology voucher is
 * tied to. It is a DIFFERENT issue from the ORD-09 report (unfulfillable) of the same
 * line, as in the second opinion scenario.
 */
async function complaintIssue(orderId: string, lineId: string) {
  if (!kitchenStation) {
    kitchenStation = randomUUID();
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar 1131', 'beverage_bar')`,
      [kitchenStation, tenantId(), p.w.tenant.outletId],
    );
  }
  const answer = await p.w.staffPost(
    p.w.supervisor,
    `/api/outlets/${p.w.tenant.outletId}/orders/${toUlid(orderId)}/issues`,
    {
      orderItemId: toUlid(lineId),
      type: "complaint",
      reason: "complaint",
      reasonNote: "Pelanggan kecewa, minta voucher maaf",
      stationId: kitchenStation,
      employeeId: null,
      resolution: null,
      voucherId: null,
      approvedBy: null,
      idempotencyKey: `iss-${randomUUID()}`,
    },
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.data.id as string;
}

/** Complaint + staff apology voucher request (raw answer, no expectation). */
async function voucherOn(orderId: string, lineId: string, valueIdr: number) {
  const issueId = await complaintIssue(orderId, lineId);
  return {
    issueId,
    issued: (await p.staffVoucher(issueId, valueIdr)) as Answer,
  };
}

/** The voucher must be issued; returns the complaint issue. */
async function voucherOk(orderId: string, lineId: string, valueIdr: number) {
  const out = await voucherOn(orderId, lineId, valueIdr);
  expect(out.issued.status, JSON.stringify(out.issued.body)).toBe(201);
  expect(await p.voucherValues(out.issueId)).toEqual([valueIdr]);
  return out.issueId;
}

/** The ORD-09 path of the guest: report, resolve (route), then the consumer. */
async function ord09Attempt(
  lineId: string,
  approvedIdr: number,
): Promise<Ord09 | null> {
  let prepared: { issueId: string; approvalId: string };
  try {
    prepared = await p.prepareOrd09(lineId, approvedIdr);
  } catch {
    return null; // the report itself was refused: an earlier stop, nothing filed
  }
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

/** An ORD-09 attempt over the room: refused at resolve (422 room) or not filed, never cut. */
function expectOrd09OverRoom(attempt: Ord09 | null) {
  if (attempt === null) return;
  expect(attempt.filedIdr, "no refund filed (and none cut to the room)").toBe(
    0,
  );
  if (attempt.resolveStatus !== 200) {
    expect([409, 422]).toContain(attempt.resolveStatus);
    if (attempt.resolveStatus === 422)
      expect(attempt.resolveCode).toBe(ROOM_CODE);
  }
}

async function expectTotalWithin(
  issueIds: string[],
  paidIdr: number,
  extraOutIdr = 0,
) {
  const ids = [...new Set(issueIds)];
  expect(
    (await p.voucherTotal(ids)) +
      (await p.recoveryRefundTotal(ids)) +
      extraOutIdr,
    "vouchers + ORD-09 refunds + other money out",
  ).toBeLessThanOrEqual(paidIdr);
}

// ---------------------------------------------------------------------------
// P1-1 voucher, then ORD-09 / ORD-09, then voucher
// ---------------------------------------------------------------------------

describe("1131 P1-1 apology voucher and ORD-09 share one budget (both directions)", () => {
  it("vouchers took the whole paid amount, then ORD-09 of the roti: resolve answers 422 REFUND_OVER_ORDER_ROOM, no refund", async () => {
    const paid = await p.paidPlainOrder();
    const kopi = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);
    const roti = await voucherOk(paid.orderId, paid.rotiLine, ROTI_PAID);

    const { issueId, approvalId } = await p.prepareOrd09(
      paid.rotiLine,
      ROTI_PRICE,
    );
    const resolved = await p.resolveOrd09(issueId, approvalId);
    expectRoom422(resolved as Answer);
    expect(await p.ord09Rows([issueId])).toEqual([]);
    expect(await p.voucherTotal([kopi, roti])).toBe(ORDER_PAID);
    await expectTotalWithin([kopi, roti, issueId], ORDER_PAID);
  });

  it("a voucher on the kopi, then ORD-09 of the SAME kopi (28.875 > room 20.790): refused, voucher intact", async () => {
    const paid = await p.paidPlainOrder();
    const voucher = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);

    const attempt = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    expectOrd09OverRoom(attempt);
    expect(await p.voucherValues(voucher)).toEqual([KOPI_PAID]);
    await expectTotalWithin(
      [voucher, ...(attempt ? [attempt.issueId] : [])],
      ORDER_PAID,
    );
  });

  it("vouchers 28.875 + 10.000 leave 10.790: the ORD-09 of the roti (20.790) is refused, not cut to 10.790", async () => {
    const paid = await p.paidPlainOrder();
    const kopi = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);
    const roti = await voucherOk(paid.orderId, paid.rotiLine, 10_000);

    const attempt = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expectOrd09OverRoom(attempt);
    await expectTotalWithin(
      [kopi, roti, ...(attempt ? [attempt.issueId] : [])],
      ORDER_PAID,
    );
  });

  it("control: a voucher on the kopi leaves exactly the roti: its ORD-09 (20.790) is filed, total = paid", async () => {
    const paid = await p.paidPlainOrder();
    const voucher = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);
    const ord09 = await p.recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    expect(
      (await p.voucherTotal([voucher])) +
        (await p.recoveryRefundTotal([ord09])),
    ).toBe(ORDER_PAID);
  });

  it("ORD-09 of the roti first (20.790 filed), then a voucher: 28.876 refused, 28.875 issued, nothing more", async () => {
    const paid = await p.paidPlainOrder();
    const ord09 = await p.recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    const kopi = await complaintIssue(paid.orderId, paid.kopiLine);
    const over = await p.staffVoucher(kopi, ORDER_PAID - ROTI_PAID + 1);
    expectVoucherRefused(over as Answer);
    expect(await p.voucherValues(kopi), "refused, not cut").toEqual([]);

    const exact = await p.staffVoucher(kopi, ORDER_PAID - ROTI_PAID);
    // The exact room may be issued, or refused by the existing lane guard (409).
    expect([201, 409], JSON.stringify(exact.body)).toContain(exact.status);
    const more = await voucherOn(paid.orderId, paid.rotiLine, 1);
    expectVoucherRefused(more.issued as Answer);
    await expectTotalWithin([ord09, kopi, more.issueId], ORDER_PAID);
  });

  it("ORD-09 of the kopi first (28.875 filed): a voucher of the roti above 20.790 is refused, 20.790 issued", async () => {
    const paid = await p.paidPlainOrder();
    const ord09 = await p.recoveryRefundFor(
      paid.kopiLine,
      KOPI_PRICE,
      KOPI_PAID,
    );
    const roti = await complaintIssue(paid.orderId, paid.rotiLine);
    expectVoucherRefused((await p.staffVoucher(roti, ROTI_PAID + 1)) as Answer);
    expect(await p.voucherValues(roti)).toEqual([]);
    const exact = await p.staffVoucher(roti, ROTI_PAID);
    expect([201, 409], JSON.stringify(exact.body)).toContain(exact.status);
    await expectTotalWithin([ord09, roti], ORDER_PAID);
  });

  it("async consumer: ORD-09 resolved while the room was there, money leaves meanwhile (gateway refund 30.000): no refund filed, audited refund_blocked / over_order_room", async () => {
    const paid = await p.paidPlainOrder();
    const { issueId, approvalId } = await p.prepareOrd09(
      paid.rotiLine,
      ROTI_PRICE,
    );
    const resolved = await p.resolveOrd09(issueId, approvalId);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const event = await p.ord09Event(issueId);
    expect(event).not.toBeNull();

    const intent = await intentOf(paid.orderId);
    await gatewayRefund(intent.id, 30_000); // 49.665 - 30.000 = 19.665 < 20.790

    let thrown: { status?: number } | null = null;
    try {
      await p.deliverOrd09(event!);
    } catch (error) {
      thrown = error as { status?: number };
    }
    if (thrown) expect([409, 422]).toContain(thrown.status);
    expect(await p.ord09Rows([issueId]), "no refund filed").toEqual([]);
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event::text LIKE $2
          AND event::text LIKE '%refund_blocked%'
          AND event::text LIKE '%over_order_room%'`,
      [tenantId(), `%${issueId}%`],
    );
    expect(
      rows[0]!.n,
      "audit refund_blocked / over_order_room",
    ).toBeGreaterThan(0);
  });

  it("race: a voucher for the kopi and an ORD-09 of the kopi at the same time never pay out 57.750 of 49.665", async () => {
    const paid = await p.paidPlainOrder();
    const issue = await complaintIssue(paid.orderId, paid.kopiLine);
    const prepared = await p.prepareOrd09(paid.kopiLine, KOPI_PRICE);
    const [voucher, resolved] = await Promise.all([
      p.staffVoucher(issue, KOPI_PAID),
      p.resolveOrd09(prepared.issueId, prepared.approvalId),
    ]);
    expect(voucher.status).toBeLessThan(500);
    expect(resolved.status).toBeLessThan(500);
    if (resolved.status === 200) {
      const event = await p.ord09Event(prepared.issueId);
      if (event)
        try {
          await p.deliverOrd09(event);
        } catch (error) {
          expect([409, 422]).toContain((error as { status?: number }).status);
        }
    }
    await expectTotalWithin([issue, prepared.issueId], ORDER_PAID);
  });
});

// ---------------------------------------------------------------------------
// P1-2 voucher, then swap-charge refund (manual cash and online) / reverse
// ---------------------------------------------------------------------------

type Intent = { id: string; providerRef: string | null };

async function intentOf(orderId: string): Promise<Intent> {
  const found = await owner.query<{ id: string; provider_ref: string }>(
    `SELECT i.id, i.provider_ref FROM orders o
       JOIN payment_intents i ON i.tenant_id = o.tenant_id
        AND (i.id = o.payment_intent_id
             OR (o.payment_link_id IS NOT NULL AND i.payment_link_id = o.payment_link_id))
      WHERE o.tenant_id = $1 AND o.id = $2
      ORDER BY i.created_at LIMIT 1`,
    [tenantId(), toUuid(orderId)],
  );
  expect(found.rows, "the QR order has a payment intent").toHaveLength(1);
  return { id: found.rows[0]!.id, providerRef: found.rows[0]!.provider_ref };
}

/** The provider returned `amountIdr` of the QR payment on its own (real recorder). */
async function recordProviderRefund(intent: Intent, amountIdr: number) {
  const evidence = await owner.query<{ provider_ref: string }>(
    `SELECT provider_ref FROM payment_evidence
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY received_at`,
    [tenantId(), intent.id],
  );
  const refs = [
    ...(intent.providerRef ? [intent.providerRef] : []),
    ...evidence.rows.map((row) => row.provider_ref),
  ];
  const context = contextOf(tenantId());
  for (const providerPaymentRef of refs) {
    const result = await withTenant(db, context, (tx) =>
      recordProviderRefundInTx(
        tx,
        context,
        {
          provider: "doit",
          providerRefundId: `rf_${randomUUID().slice(0, 12)}`,
          providerPaymentRef,
          amountIdr,
          source: "payment_webhook",
          expectedIntentId: intent.id,
          force: true,
        },
        new Date(),
      ),
    );
    if (result.status === "recorded" || result.status === "duplicate") return;
  }
  throw new Error("provider refund was not recorded");
}

/** A refund of ours through the gateway on the intent (no order issue). */
async function gatewayRefund(intentId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_refunds
       (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3::bigint, 'Refund gateway uji 1131', 'pending',
            'refund-1131-test'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), intentId, amountIdr],
  );
}

type Charge = {
  paid: PaidOrder;
  issueId: string;
  chargeId: string;
  replacementLine: string;
};

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

async function chargeIntentId(chargeId: string): Promise<string | null> {
  const { rows } = await owner.query<{ id: string | null }>(
    "SELECT payment_intent_id AS id FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenantId(), chargeId],
  );
  return rows[0]!.id;
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
      "a".repeat(64),
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

type Channel = "cash" | "online";

/**
 * Second opinion scenario: QR order paid, swap to a dearer item, charge paid, the
 * provider returns the whole base payment (fact recorded, order not voided): the order
 * is now paid only by the charge (8.085).
 */
async function chargeOnlyOrder(channel: Channel): Promise<Charge> {
  const charge = await openCharge();
  if (channel === "cash") await payChargeCash(charge);
  else await payChargeOnline(charge);
  await recordProviderRefund(await intentOf(charge.paid.orderId), ORDER_PAID);
  return charge;
}

/** Voucher on the replacement line; `valueIdr` must be issued (setup). */
async function voucherOnReplacement(charge: Charge, valueIdr: number) {
  return voucherOk(charge.paid.orderId, charge.replacementLine, valueIdr);
}

function requestManualRefund(chargeId: string, amountIdr: number) {
  return p.w.staffPost(
    p.w.supervisor,
    `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
    {
      amountIdr,
      reason: "Tamu minta uang selisih swap kembali",
      method: "cash",
    },
  );
}

async function manualRefundRows(chargeId: string) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: number;
    status: string;
  }>(
    `SELECT id, amount_idr::int AS amount_idr, status
       FROM order_issue_charge_manual_refunds
      WHERE tenant_id = $1 AND charge_id = $2 ORDER BY requested_at, id`,
    [tenantId(), chargeId],
  );
  return rows;
}

const LIVE_MANUAL = ["requested", "completed"];

async function onlineRefundTotal(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenantId(), intentId],
  );
  return rows[0]!.n;
}

/** Refund of the charge through its channel; returns the raw answer. */
async function refundCharge(
  channel: Channel,
  chargeId: string,
  amountIdr: number,
) {
  if (channel === "cash") return requestManualRefund(chargeId, amountIdr);
  return p.w.staffPost(
    p.w.supervisor,
    `/api/order-issue-charges/${encodeURIComponent(chargeId)}/refund`,
    { amountIdr, reason: "Tamu komplain, swap dibatalkan" },
  );
}

async function chargeMoneyOut(channel: Channel, chargeId: string) {
  if (channel === "cash")
    return sum(
      (await manualRefundRows(chargeId))
        .filter((row) => LIVE_MANUAL.includes(row.status))
        .map((row) => row.amount_idr),
    );
  return onlineRefundTotal((await chargeIntentId(chargeId))!);
}

for (const channel of ["cash", "online"] as const)
  describe(`1131 P1-2 apology voucher and swap-charge refund (${channel}) share one budget`, () => {
    it("voucher 8.085 on the replacement line, then a refund of the charge (8.085): 422 REFUND_OVER_ORDER_ROOM, nothing requested", async () => {
      const charge = await chargeOnlyOrder(channel);
      const voucherIssue = await voucherOnReplacement(charge, CHARGE_PAID);

      const answer = await refundCharge(channel, charge.chargeId, CHARGE_PAID);
      expectRoom422(answer as Answer);
      expect(await chargeMoneyOut(channel, charge.chargeId)).toBe(0);
      expect(await p.voucherTotal([voucherIssue])).toBe(CHARGE_PAID);
    });

    it("voucher 3.000: a refund of 5.086 is refused (room 5.085), 5.085 is accepted; total 8.085 = paid", async () => {
      const charge = await chargeOnlyOrder(channel);
      const voucherIssue = await voucherOnReplacement(charge, 3_000);

      const over = await refundCharge(
        channel,
        charge.chargeId,
        CHARGE_PAID - 3_000 + 1,
      );
      expectRoom422(over as Answer);
      expect(await chargeMoneyOut(channel, charge.chargeId)).toBe(0);

      const exact = await refundCharge(
        channel,
        charge.chargeId,
        CHARGE_PAID - 3_000,
      );
      expect(exact.status, JSON.stringify(exact.body)).toBeGreaterThanOrEqual(
        200,
      );
      expect(exact.status, JSON.stringify(exact.body)).toBeLessThan(300);
      expect(
        (await chargeMoneyOut(channel, charge.chargeId)) +
          (await p.voucherTotal([voucherIssue])),
      ).toBe(CHARGE_PAID);
    });

    it("reverse: the refund of the charge first (8.085), then a voucher is refused, no voucher row", async () => {
      const charge = await chargeOnlyOrder(channel);
      const first = await refundCharge(channel, charge.chargeId, CHARGE_PAID);
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);

      const out = await voucherOn(
        charge.paid.orderId,
        charge.replacementLine,
        1_000,
      );
      expectVoucherRefused(out.issued as Answer);
      expect(await p.voucherValues(out.issueId)).toEqual([]);
      expect(await chargeMoneyOut(channel, charge.chargeId)).toBe(CHARGE_PAID);
    });

    it("reverse partial: a refund of 5.085 first, then a voucher of 3.001 is refused and 3.000 is issued", async () => {
      const charge = await chargeOnlyOrder(channel);
      const first = await refundCharge(channel, charge.chargeId, 5_085);
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);

      const out = await voucherOn(
        charge.paid.orderId,
        charge.replacementLine,
        3_001,
      );
      expectVoucherRefused(out.issued as Answer);
      expect(await p.voucherValues(out.issueId)).toEqual([]);
      const exact = await p.staffVoucher(out.issueId, 3_000);
      expect(exact.status, JSON.stringify(exact.body)).toBe(201);
      expect(
        (await chargeMoneyOut(channel, charge.chargeId)) +
          (await p.voucherTotal([out.issueId])),
      ).toBe(CHARGE_PAID);
    });
  });

describe("1131 cash charge: the manual refund approval pays only what the budget allows", () => {
  it("control: voucher 3.000, refund 5.085 requested, then approved by another person: cash_out 5.085, total = paid", async () => {
    const charge = await chargeOnlyOrder("cash");
    const voucherIssue = await voucherOnReplacement(charge, 3_000);
    const requested = await requestManualRefund(
      charge.chargeId,
      CHARGE_PAID - 3_000,
    );
    expect(requested.status, JSON.stringify(requested.body)).toBeLessThan(300);
    const [row] = await manualRefundRows(charge.chargeId);
    const approved = await p.w.staffPost(
      approver,
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(row!.id)}/approve`,
      { shiftId },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);
    expect(
      (await manualRefundRows(charge.chargeId)).map((r) => r.status),
    ).toEqual(["completed"]);
    expect(
      (await chargeMoneyOut("cash", charge.chargeId)) +
        (await p.voucherTotal([voucherIssue])),
    ).toBe(CHARGE_PAID);
  });
});

// ---------------------------------------------------------------------------
// Finance manual refund (PAY-04) after vouchers: no money moves over the budget
// ---------------------------------------------------------------------------

function financeRefund(intentId: string, amountIdr: number) {
  return finance.client
    .post(`${ADMIN}/refunds`)
    .set("Host", p.w.tenant.hostname)
    .set(originHeader)
    .send({
      idempotencyKey: `req-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian finance uji 1131",
    });
}

async function financeLiveTotal(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'
        AND order_issue_id IS NULL`,
    [tenantId(), intentId],
  );
  return rows[0]!.n;
}

/** The POS sale of a QR order: a captured QRIS tender that names the QR intent. */
async function becomePosQrisSale(paid: PaidOrder, intentId: string) {
  const uuid = toUuid(paid.orderId);
  await owner.query(
    "UPDATE orders SET channel = 'pos', status = 'completed' WHERE tenant_id = $1 AND id = $2",
    [tenantId(), uuid],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
     VALUES ($1, $2, $3, 'pos', now())`,
    [uuid, tenantId(), paid.outletId],
  );
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
        amount_idr, received_idr, change_idr, status, requested_at, resolved_at,
        payment_intent_id)
     VALUES ($1, $2, $3, 'qris', 'doit', $4, NULL, NULL, 'captured',
             now() - interval '1 minute', now(), $5)`,
    [tenantId(), paid.outletId, uuid, ORDER_PAID, intentId],
  );
}

describe("1131 finance manual refund after vouchers", () => {
  it("QR order, vouchers for the whole paid amount: a finance refund of 1.000 is refused and stores nothing", async () => {
    const paid = await p.paidPlainOrder();
    const kopi = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);
    const roti = await voucherOk(paid.orderId, paid.rotiLine, ROTI_PAID);
    const intent = await intentOf(paid.orderId);

    const answer = await financeRefund(intent.id, 1_000);
    expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    expect(await financeLiveTotal(intent.id)).toBe(0);
    expect(await p.voucherTotal([kopi, roti])).toBe(ORDER_PAID);
  });

  it("POS sale paid by QRIS, vouchers 28.875: a finance refund above the remaining 20.790 is refused; total out <= paid", async () => {
    const paid = await p.paidPlainOrder();
    const intent = await intentOf(paid.orderId);
    await becomePosQrisSale(paid, intent.id);
    const voucher = await voucherOk(paid.orderId, paid.kopiLine, KOPI_PAID);

    const over = await financeRefund(intent.id, ROTI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBeGreaterThanOrEqual(400);
    expect(over.status, JSON.stringify(over.body)).toBeLessThan(500);
    expect(await financeLiveTotal(intent.id)).toBe(0);

    // Whatever the finance lane accepts for the rest, the guest never gets more than paid.
    const rest = await financeRefund(intent.id, ROTI_PAID);
    expect(rest.status).toBeLessThan(500);
    expect(
      (await financeLiveTotal(intent.id)) + (await p.voucherTotal([voucher])),
    ).toBeLessThanOrEqual(ORDER_PAID);
  });
});

// ---------------------------------------------------------------------------
// Property: every path permutation keeps total out + vouchers <= paid
// ---------------------------------------------------------------------------

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

type QrPath = "voucherKopi" | "voucherRoti" | "ord09Kopi" | "ord09Roti";
const QR_PATHS: QrPath[] = [
  "voucherKopi",
  "voucherRoti",
  "ord09Kopi",
  "ord09Roti",
];

describe("1131 property (QR order): voucher / ORD-09 permutations: vouchers + ORD-09 <= paid, nothing cut", () => {
  for (const order of permutations(QR_PATHS))
    it(`${order.join(" -> ")}: total out <= ${ORDER_PAID}`, async () => {
      const paid = await p.paidPlainOrder();
      const issueIds: string[] = [];
      let accepted = 0;
      let firstAccepted = false;
      for (const [index, step] of order.entries()) {
        let ok = false;
        if (step === "voucherKopi" || step === "voucherRoti") {
          const line = step === "voucherKopi" ? paid.kopiLine : paid.rotiLine;
          const value = step === "voucherKopi" ? KOPI_PAID : ROTI_PAID;
          const out = await voucherOn(paid.orderId, line, value);
          issueIds.push(out.issueId);
          expect(
            out.issued.status,
            JSON.stringify(out.issued.body),
          ).toBeLessThan(500);
          ok = out.issued.status === 201;
          if (!ok) expect(await p.voucherValues(out.issueId)).toEqual([]);
        } else {
          const kopi = step === "ord09Kopi";
          const attempt = await ord09Attempt(
            kopi ? paid.kopiLine : paid.rotiLine,
            kopi ? KOPI_PRICE : ROTI_PRICE,
          );
          if (attempt) {
            issueIds.push(attempt.issueId);
            expect(attempt.resolveStatus).toBeLessThan(500);
            ok = attempt.filedIdr > 0;
            // Filed in full, never cut to the room.
            if (ok) expect(attempt.filedIdr).toBe(kopi ? KOPI_PAID : ROTI_PAID);
          }
        }
        if (ok) accepted += 1;
        if (index === 0) firstAccepted = ok;
      }
      await expectTotalWithin(issueIds, ORDER_PAID);
      expect(firstAccepted, "the first path fits the paid amount").toBe(true);
      expect(accepted).toBeGreaterThan(0);
    });
});

type PosPath = "voucherKopi" | "voucherRoti" | "finance";

describe("1131 property (POS QRIS sale): vouchers + finance manual refund <= paid", () => {
  for (const order of permutations<PosPath>([
    "voucherKopi",
    "voucherRoti",
    "finance",
  ]))
    it(`${order.join(" -> ")}: total out <= ${ORDER_PAID}`, async () => {
      const paid = await p.paidPlainOrder();
      const intent = await intentOf(paid.orderId);
      await becomePosQrisSale(paid, intent.id);
      const issueIds: string[] = [];
      for (const step of order) {
        if (step === "finance") {
          const answer = await financeRefund(intent.id, 20_000);
          expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
        } else {
          const out = await voucherOn(
            paid.orderId,
            step === "voucherKopi" ? paid.kopiLine : paid.rotiLine,
            step === "voucherKopi" ? KOPI_PAID : ROTI_PAID,
          );
          issueIds.push(out.issueId);
          expect(out.issued.status).toBeLessThan(500);
        }
      }
      expect(
        (await p.voucherTotal(issueIds)) + (await financeLiveTotal(intent.id)),
        "vouchers + finance refunds",
      ).toBeLessThanOrEqual(ORDER_PAID);
    });
});

// ---------------------------------------------------------------------------
// Architect round: per-line rule, no over-refusal on a discounted order,
// open-bill intent + finance manual refund
// ---------------------------------------------------------------------------

describe("1131 per-line rule (Q25): the money of one line is given once, whichever path", () => {
  it("voucher for the whole roti (20.790), then ORD-09 of the same roti: refused although the ORDER still has room 28.875; roti total <= 20.790", async () => {
    const paid = await p.paidPlainOrder();
    const voucher = await voucherOk(paid.orderId, paid.rotiLine, ROTI_PAID);

    const attempt = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expectOrd09OverRoom(attempt);
    await expectTotalWithin(
      [voucher, ...(attempt ? [attempt.issueId] : [])],
      ROTI_PAID,
    );
  });

  it("reverse: ORD-09 of the roti first (20.790 filed), then a voucher on the same roti is refused although the order has room", async () => {
    const paid = await p.paidPlainOrder();
    const ord09 = await p.recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    const out = await voucherOn(paid.orderId, paid.rotiLine, 1_000);
    expectVoucherRefused(out.issued);
    expect(await p.voucherValues(out.issueId)).toEqual([]);
    await expectTotalWithin([ord09, out.issueId], ROTI_PAID);
  });
});

describe("1131 no over-refusal: a discounted order lets every line's ORD-09 through up to paid", () => {
  it("promo order (discount 18.000, paid 42.735): the ORD-09 of the kopi is filed (8.085); the teh (9.325 by component rounding) is refused over its line share 9.324 (legend-wpn5v)", async () => {
    const paid = await p.paidPromoOrder();
    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    const teh = await ord09Attempt(paid.tehLine, PRICES.teh);
    expect(kopi, "kopi report accepted").not.toBeNull();
    expect(teh, "teh report accepted").not.toBeNull();
    expect(kopi!.resolveStatus, "kopi resolved").toBe(200);
    expect(kopi!.consumerError, "kopi consumer").toBeNull();
    // Exact: a failed kopi withdraws the promo, so it refunds 8.085 (order-recovery-refund-promo H3).
    expect(kopi!.filedIdr, "kopi refund is its own paid share").toBe(8_085);
    // Strict plain line (legend-wpn5v): teh share = 12.000 x 42.735 / 55.000 =
    // 9.324; its pro-rata refund rounds to 9.325, over the share: refused at
    // the resolve gate, nothing filed.
    expect(teh!.resolveStatus, "teh refused").toBe(422);
    expect(teh!.resolveCode).toBe(ROOM_CODE);
    expect(teh!.filedIdr).toBe(0);
    expect(kopi!.filedIdr + teh!.filedIdr).toBeLessThanOrEqual(PROMO_PAID);
  });

  it("promo order: the ORD-09 of the kopi (8.085) is filed; the roti (promo recompute 20.790 > its share 13.986) is blocked at the consumer, nothing filed (legend-wpn5v)", async () => {
    const paid = await p.paidPromoOrder();
    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    const roti = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expect(kopi?.resolveStatus, "kopi resolved").toBe(200);
    expect(roti?.resolveStatus, "roti resolved").toBe(200);
    expect(kopi!.filedIdr).toBe(8_085);
    // roti share = 18.000 x 42.735 / 55.000 = 13.986 < 20.790: refused, never cut.
    expect(roti!.consumerError).toBeNull();
    expect(roti!.filedIdr).toBe(0);
    expect(kopi!.filedIdr + roti!.filedIdr).toBeLessThanOrEqual(PROMO_PAID);
  });
});

describe("1131 open-bill QR order paid by an intent: voucher, then finance manual refund", () => {
  /** An open bill (not pay-first) settled by a paid intent of `amountIdr` (as 1116). */
  async function paidOpenBill(amountIdr: number) {
    const made = await p.w.openBillOrder();
    const orderUuid = ulidToUuid(made.order.id);
    const { rows } = await owner.query<{ outlet_id: string }>(
      "SELECT outlet_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [tenantId(), orderUuid],
    );
    const outletId = rows[0]!.outlet_id;
    const kopi = made.order.items.find(
      (item) => item.menuItemId === p.w.ids.kopi,
    )!;
    const linkId = randomUUID();
    const intentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, '1131-test')`,
      [
        linkId,
        tenantId(),
        outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `P1131-${linkId.slice(0, 8)}`,
        CART_TOTAL,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now())`,
      [intentId, tenantId(), outletId, linkId, amountIdr, `p1131-${intentId}`],
    );
    await owner.query(
      `UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'sealed-test',
              payment_intent_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), orderUuid, linkId, intentId],
    );
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method,
          source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        tenantId(),
        outletId,
        intentId,
        `EV-${randomBytes(6).toString("hex")}`,
        amountIdr,
      ],
    );
    return { orderId: made.order.id, kopiLine: kopi.id, intentId };
  }

  it("voucher 50.000 on a 90.090 bill, then a finance refund of 41.000 (total 91.000 > paid): refused or capped, vouchers + refund <= paid", async () => {
    const bill = await paidOpenBill(CART_TOTAL);
    const voucher = await voucherOk(bill.orderId, bill.kopiLine, 50_000);

    const answer = await financeRefund(bill.intentId, 41_000);
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    expect(
      (await financeLiveTotal(bill.intentId)) +
        (await p.voucherTotal([voucher])),
      "voucher + finance refund",
    ).toBeLessThanOrEqual(CART_TOTAL);
  });

  it("reverse: a finance refund of 50.000 first, then a voucher of 41.000 is refused (room 40.090)", async () => {
    const bill = await paidOpenBill(CART_TOTAL);
    const refunded = await financeRefund(bill.intentId, 50_000);
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(500);

    const out = await voucherOn(bill.orderId, bill.kopiLine, 41_000);
    expect(out.issued.status, JSON.stringify(out.issued.body)).toBeLessThan(
      500,
    );
    expect(
      (await financeLiveTotal(bill.intentId)) +
        (await p.voucherTotal([out.issueId])),
      "finance refund + voucher",
    ).toBeLessThanOrEqual(CART_TOTAL);
  });
});
