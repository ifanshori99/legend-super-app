// legend-1145 (tier K, money, "jangan sampai rugi"): second opinion round 3 found two P1
// holes in the one-money-out-budget of an order (docs/qa/second-opinion-refund-kasir-ronde3-1145.md,
// docs/briefs/sub-1145.md). Written from those two documents, never from the services.
//
// P1-1  Apology voucher and finance refund (PAY-04) on an open-bill order paid by one
//       intent share no lock. Order paid 90.090: voucher 50.000 reads the room, finance
//       refunds 50.000 meanwhile, the voucher mints: 100.000 out of 90.090 paid.
//       Rule: the second one is refused 422 REFUND_OVER_ORDER_ROOM (finance), or the
//       voucher is refused with its own 422; never both live. Pending refunds count.
// P1-2  Swap chain: roti (A) swapped to the dearer kopi, charge paid, ORD-09 of the
//       replacement AND a refund of the charge both fit the whole-order budget, but
//       together pay chain A twice with the money of kopi B. Rule: money out on one
//       chain (ORD-09 + charge refunds + vouchers) <= what that chain paid (original
//       share + live charge money); B's own payment stays. Refused: 422
//       REFUND_OVER_ORDER_ROOM, no row written; in both orders.
//
// Barrier (P1-1): a temporary BEFORE INSERT trigger stalls the first writer on an
// advisory lock this test holds (pattern of dp-intent-lock-race.test.ts), so the
// writer has already read its room when the competitor runs. The wait is polled (the
// competitor settled, or waits on a lock held by the stalled writer), never slept.
//
// Assumptions (also reported):
// - The brief's Rp190.000 world is scaled to the 1095 world: QR order kopi 28.875 +
//   roti 20.790 = 49.665 (B = kopi, A = roti); the swap charge roti -> kopi is 8.085;
//   chain A paid 20.790 + 8.085 = 28.875, whole order paid 57.750.
// - Which of the two competitors is refused is the engineer's design (lock in finance,
//   or a re-read in the voucher): the tests assert the invariant (out <= paid, not both
//   live) and, for a refused finance refund or charge refund, 422 REFUND_OVER_ORDER_ROOM
//   with no row written. A serial voucher -> finance case must be that 422 exactly.
// - "request -> approve -> settle" of B is request + approve with the fake refund
//   gateway (the refund completes inside the approve call, as in
//   dp-intent-lock-race.test.ts); the pending variant stops after the request.
// - A charge refund is asserted at request time (a pending request already counts as
//   live money out); ORD-09 as resolve (422 room) or consumer (nothing filed).
// - If ORD-09 of the replacement is allowed to pay only the original share, a charge
//   refund up to the rest of the chain is fine too: the assertions are the chain bound.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1145-ronde3.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner, staffWithRole, type Staff } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { CART_TOTAL, PRICES } from "./order-recovery-helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
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
const CHAIN_A_PAID = ROTI_PAID + CHARGE_PAID; // 28.875: what chain A paid
const SWAP_ORDER_PAID = ORDER_PAID + CHARGE_PAID; // 57.750
const ADMIN = "/api/payments/admin";

let p: PosWorld;
let cashier: { client: ReturnType<typeof agent>; userId: string };
let finance: Staff; // files the finance refund
let approver: Staff; // a different person approves it
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
  const till = await userWithPermissions("Kasir Charge 1145", [
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
    label: "Finance 1145",
  });
  await verifySessionMfa(finance.email);
  approver = await staffWithRole(p.w.app, {
    template: "owner",
    tenantId: tenantId(),
    label: "Penyetuju Finance 1145",
  });
  await verifySessionMfa(approver.email);
  setPaymentRefundGateway(new FakeRefundGateway());
}, 300_000);

afterAll(async () => {
  setPaymentRefundGateway(null);
  await p.teardown();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Answer = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: { id?: string } };
};

function expectRoom422(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(ROOM_CODE);
}

const VOUCHER_REFUSALS = [
  "APOLOGY_VOUCHER_NOTHING_DUE",
  "APOLOGY_VOUCHER_OVER_ROOM",
  ROOM_CODE,
];
/** A voucher refused: its own 422 (or the room 422) or the lane guard 409; nothing minted. */
function expectVoucherRefused(answer: Answer) {
  expect([409, 422], JSON.stringify(answer.body)).toContain(answer.status);
  if (answer.status === 422)
    expect(VOUCHER_REFUSALS, JSON.stringify(answer.body)).toContain(
      answer.body.error?.code,
    );
}

let kitchenStation: string | null = null;

/** A kitchen complaint (no resolution): the issue an apology voucher is tied to. */
async function complaintIssue(orderId: string, lineId: string) {
  if (!kitchenStation) {
    kitchenStation = randomUUID();
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar 1145', 'beverage_bar')`,
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
): Promise<Ord09 | null> {
  let prepared: { issueId: string; approvalId: string };
  try {
    prepared = await p.prepareOrd09(lineId, approvedIdr);
  } catch {
    return null; // the report itself was refused: nothing filed
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

/** A refused ORD-09: resolve 422 room (or 409), or the consumer filed nothing. */
function expectOrd09Refused(attempt: Ord09 | null) {
  if (attempt === null) return;
  expect(attempt.filedIdr, "no refund filed (and none cut)").toBe(0);
  if (attempt.resolveStatus !== 200) {
    expect([409, 422]).toContain(attempt.resolveStatus);
    if (attempt.resolveStatus === 422)
      expect(attempt.resolveCode).toBe(ROOM_CODE);
  }
}

// ---------------------------------------------------------------------------
// Stall harness (pattern of dp-intent-lock-race.test.ts)
// ---------------------------------------------------------------------------

let holdKey = 9_714_500; // test-owned advisory keys, one per stall

/**
 * Stalls the first transaction that INSERTs into `table` a row matching `when` until
 * `release()`: a temp BEFORE INSERT trigger waits on an advisory lock this test holds.
 * `waitForStalled()` returns the stalled backend's pid.
 */
async function stallInserts(
  table: "vouchers" | "payment_refunds",
  when: string,
) {
  const hold = holdKey++;
  const blocker: PoolClient = await owner.connect();
  const name = `r1145_stall_${hold}`;
  const { rows } = await blocker.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const blockerPid = rows[0]!.pid;
  await blocker.query("SELECT pg_advisory_lock($1)", [hold]);
  await owner.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $f$`);
  await owner.query(`
    CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  return {
    async waitForStalled(): Promise<number> {
      for (let attempt = 0; attempt < 600; attempt++) {
        const { rows: waiters } = await owner.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
          [blockerPid],
        );
        if (waiters[0]) return waiters[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The writer never reached the stalling trigger");
    },
    async release() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
    },
    async cleanup() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      await owner
        .query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
        .catch(() => undefined);
      await owner
        .query(`DROP FUNCTION IF EXISTS ${name}()`)
        .catch(() => undefined);
      blocker.release();
    },
  };
}

/**
 * While the writer with backend `holderPid` is stalled: wait until the competitor has
 * settled, or waits on a lock held by the stalled writer, or 15 s passed. Polled; the
 * outcome is not asserted (the money assertions after the release decide).
 */
async function settledOrBlocked(
  holderPid: number,
  competitor: Promise<unknown>,
) {
  let settled = false;
  void competitor.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 600; attempt++) {
    if (settled) return "settled";
    const { rows } = await owner.query(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND $1::int = ANY(pg_blocking_pids(a.pid)) LIMIT 1`,
      [holderPid],
    );
    if (rows[0]) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return "timeout";
}

// ---------------------------------------------------------------------------
// P1-1 open bill paid by one intent: apology voucher and finance refund
// ---------------------------------------------------------------------------

/** An open bill (not pay-first) settled by a paid intent of CART_TOTAL (as 1131). */
async function paidOpenBill(amountIdr = CART_TOTAL) {
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, '1145-test')`,
    [
      linkId,
      tenantId(),
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `P1145-${linkId.slice(0, 8)}`,
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
    [intentId, tenantId(), outletId, linkId, amountIdr, `p1145-${intentId}`],
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

function requestFinanceRefund(intentId: string, amountIdr: number) {
  return finance.client
    .post(`${ADMIN}/refunds`)
    .set("Host", p.w.tenant.hostname)
    .set(originHeader)
    .send({
      idempotencyKey: `req-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian finance uji 1145",
    });
}

function approveFinanceRefund(refundId: string) {
  return approver.client
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set("Host", p.w.tenant.hostname)
    .set(originHeader)
    .send({ idempotencyKey: `apr-${randomUUID()}` });
}

/** Finance request, then (when filed) the approval by another person. */
async function financeChain(
  intentId: string,
  amountIdr: number,
  approve: boolean,
) {
  const requested = (await requestFinanceRefund(
    intentId,
    amountIdr,
  )) as unknown as Answer;
  let approved: Answer | null = null;
  if (approve && requested.status === 201 && requested.body.data?.id)
    approved = (await approveFinanceRefund(
      requested.body.data.id,
    )) as unknown as Answer;
  return { requested, approved };
}

/** Live finance money out (every status but failed) of the intent. */
async function financeLiveTotal(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'
        AND order_issue_id IS NULL`,
    [tenantId(), intentId],
  );
  return rows[0]!.n;
}

describe("1145 P1-1 apology voucher and finance refund share one lock and one budget", () => {
  it("serial: a live voucher of 50.000 on a 90.090 bill, then a finance refund of 50.000: 422 REFUND_OVER_ORDER_ROOM, no refund row", async () => {
    const bill = await paidOpenBill();
    const issue = await complaintIssue(bill.orderId, bill.kopiLine);
    const voucher = await p.staffVoucher(issue, 50_000);
    expect(voucher.status, JSON.stringify(voucher.body)).toBe(201);

    const answer = (await requestFinanceRefund(
      bill.intentId,
      50_000,
    )) as unknown as Answer;
    expectRoom422(answer);
    expect(await financeLiveTotal(bill.intentId), "no refund row").toBe(0);
    expect(await p.voucherValues(issue)).toEqual([50_000]);
  });

  it("race: the voucher read its room and waits before the mint; finance requests, approves and pays 50.000 meanwhile: never 100.000 out of 90.090", async () => {
    const bill = await paidOpenBill();
    const issue = await complaintIssue(bill.orderId, bill.kopiLine);
    const stall = await stallInserts(
      "vouchers",
      `NEW.tenant_id = '${tenantId()}'::uuid AND NEW.value_idr = 50000`,
    );
    let voucherRequest: Promise<unknown> | undefined;
    let chain: Promise<unknown> | undefined;
    try {
      const voucherAnswer = (async () =>
        (await p.staffVoucher(issue, 50_000)) as Answer)();
      voucherRequest = voucherAnswer;
      const voucherPid = await stall.waitForStalled();
      const financeAnswer = financeChain(bill.intentId, 50_000, true);
      chain = financeAnswer;
      await settledOrBlocked(voucherPid, financeAnswer);
      await stall.release();
      const voucher = await voucherAnswer;
      const finance1 = await financeAnswer;

      const live = await financeLiveTotal(bill.intentId);
      const vouchers = await p.voucherTotal([issue]);
      expect(
        live + vouchers,
        "finance refunds + live vouchers",
      ).toBeLessThanOrEqual(CART_TOTAL);
      // Exactly one of the two is refused, with a named 422.
      const financeOk = finance1.requested.status === 201;
      const voucherOk = voucher.status === 201;
      expect(financeOk && voucherOk, "both succeeded").toBe(false);
      if (!financeOk) {
        expectRoom422(finance1.requested);
        expect(live, "refused request wrote no row").toBe(0);
      }
      if (!voucherOk) expectVoucherRefused(voucher);
      expect(financeOk || voucherOk, "one of them takes the money").toBe(true);
    } finally {
      await stall.cleanup();
      await voucherRequest?.catch(() => undefined);
      await chain?.catch(() => undefined);
    }
  });

  it("race, pending variant: the voucher waits before the mint; finance files a refund of 50.000 (not approved): the pending refund and the voucher stay <= 90.090", async () => {
    const bill = await paidOpenBill();
    const issue = await complaintIssue(bill.orderId, bill.kopiLine);
    const stall = await stallInserts(
      "vouchers",
      `NEW.tenant_id = '${tenantId()}'::uuid AND NEW.value_idr = 50000`,
    );
    let voucherRequest: Promise<unknown> | undefined;
    let chain: Promise<unknown> | undefined;
    try {
      const voucherAnswer = (async () =>
        (await p.staffVoucher(issue, 50_000)) as Answer)();
      voucherRequest = voucherAnswer;
      const voucherPid = await stall.waitForStalled();
      const financeAnswer = financeChain(bill.intentId, 50_000, false);
      chain = financeAnswer;
      await settledOrBlocked(voucherPid, financeAnswer);
      await stall.release();
      const voucher = await voucherAnswer;
      const finance1 = await financeAnswer;

      const live = await financeLiveTotal(bill.intentId);
      expect(
        live + (await p.voucherTotal([issue])),
        "pending refund + live voucher",
      ).toBeLessThanOrEqual(CART_TOTAL);
      expect(
        finance1.requested.status === 201 && voucher.status === 201,
        "both succeeded",
      ).toBe(false);
      if (finance1.requested.status !== 201) expectRoom422(finance1.requested);
    } finally {
      await stall.cleanup();
      await voucherRequest?.catch(() => undefined);
      await chain?.catch(() => undefined);
    }
  });

  it("race, other direction: the finance refund read its cap and waits before it is stored; a voucher of 50.000 asks meanwhile: never 100.000 out of 90.090", async () => {
    const bill = await paidOpenBill();
    const issue = await complaintIssue(bill.orderId, bill.kopiLine);
    const stall = await stallInserts(
      "payment_refunds",
      `NEW.tenant_id = '${tenantId()}'::uuid AND NEW.payment_intent_id = '${bill.intentId}'::uuid`,
    );
    let financeRequest: Promise<unknown> | undefined;
    let voucherRequest: Promise<unknown> | undefined;
    try {
      const financeAnswer = (async () =>
        (await requestFinanceRefund(
          bill.intentId,
          50_000,
        )) as unknown as Answer)();
      financeRequest = financeAnswer;
      const financePid = await stall.waitForStalled();
      const voucherAnswer = (async () =>
        (await p.staffVoucher(issue, 50_000)) as Answer)();
      voucherRequest = voucherAnswer;
      await settledOrBlocked(financePid, voucherAnswer);
      await stall.release();
      const refund = await financeAnswer;
      const voucher = await voucherAnswer;

      expect(
        (await financeLiveTotal(bill.intentId)) +
          (await p.voucherTotal([issue])),
        "finance refund + live voucher",
      ).toBeLessThanOrEqual(CART_TOTAL);
      expect(
        refund.status === 201 && voucher.status === 201,
        "both succeeded",
      ).toBe(false);
      if (refund.status !== 201) expectRoom422(refund);
      if (voucher.status !== 201) expectVoucherRefused(voucher);
    } finally {
      await stall.cleanup();
      await financeRequest?.catch(() => undefined);
      await voucherRequest?.catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// P1-2 swap chain: ORD-09 of the replacement and a refund of the charge
// ---------------------------------------------------------------------------

type Charge = {
  paid: PaidOrder;
  issueId: string;
  chargeId: string;
  replacementLine: string;
};
type Channel = "cash" | "online";

/** QR order, roti (A) swapped for the dearer kopi: the swap charge (8.085) is open. */
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

/** QR order, roti swapped for kopi, the charge paid by `channel`. */
async function paidSwapChain(channel: Channel): Promise<Charge> {
  const charge = await openCharge();
  if (channel === "cash") await payChargeCash(charge);
  else await payChargeOnline(charge);
  return charge;
}

function refundCharge(channel: Channel, chargeId: string, amountIdr: number) {
  if (channel === "cash")
    return p.w.staffPost(
      p.w.supervisor,
      `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
      {
        amountIdr,
        reason: "Tamu minta uang selisih swap kembali",
        method: "cash",
      },
    ) as Promise<Answer>;
  return p.w.staffPost(
    p.w.supervisor,
    `/api/order-issue-charges/${encodeURIComponent(chargeId)}/refund`,
    { amountIdr, reason: "Tamu komplain, swap dibatalkan" },
  ) as Promise<Answer>;
}

/** Live money out through the charge (requested/completed manual rows, or gateway rows). */
async function chargeMoneyOut(channel: Channel, chargeId: string) {
  if (channel === "cash") {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT coalesce(sum(amount_idr), 0)::int AS n
         FROM order_issue_charge_manual_refunds
        WHERE tenant_id = $1 AND charge_id = $2
          AND status IN ('requested', 'completed')`,
      [tenantId(), chargeId],
    );
    return rows[0]!.n;
  }
  const { rows } = await owner.query<{ n: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenantId(), (await chargeIntentId(chargeId))!],
  );
  return rows[0]!.n;
}

/** Chain A's paid money is 28.875; B's kopi (28.875) must stay whole. */
function expectChainBound(ord09Idr: number, chargeOutIdr: number) {
  expect(
    ord09Idr + chargeOutIdr,
    "money out for chain A (ORD-09 + charge refunds) <= what chain A paid",
  ).toBeLessThanOrEqual(CHAIN_A_PAID);
  expect(
    SWAP_ORDER_PAID - (ord09Idr + chargeOutIdr),
    "the money paid for the untouched kopi B stays",
  ).toBeGreaterThanOrEqual(KOPI_PAID);
}

for (const channel of ["cash", "online"] as const)
  describe(`1145 P1-2 swap chain (${channel} charge): ORD-09 of the replacement and a charge refund pay chain A once`, () => {
    it("ORD-09 of the replacement first, then a refund of the charge (8.085): the refund is refused 422 REFUND_OVER_ORDER_ROOM unless the chain still has room", async () => {
      const charge = await paidSwapChain(channel);

      const ord09 = await ord09Attempt(charge.replacementLine, KOPI_PRICE);
      expect(ord09, "the replacement can be reported").not.toBeNull();
      expect(ord09!.resolveStatus, "ORD-09 of the replacement resolves").toBe(
        200,
      );
      expect(ord09!.consumerError).toBeNull();
      expect(ord09!.filedIdr, "ORD-09 refund filed").toBeGreaterThan(0);
      expect(ord09!.filedIdr).toBeLessThanOrEqual(CHAIN_A_PAID);

      const answer = await refundCharge(channel, charge.chargeId, CHARGE_PAID);
      const out = await chargeMoneyOut(channel, charge.chargeId);
      if (answer.status >= 200 && answer.status < 300) {
        expect(out).toBe(CHARGE_PAID);
      } else {
        expectRoom422(answer);
        expect(out, "refused: no row written").toBe(0);
      }
      expectChainBound(ord09!.filedIdr, out);
    });

    it("refund of the charge (8.085) first, then ORD-09 of the replacement: ORD-09 is refused (never cut), chain A pays at most 28.875", async () => {
      const charge = await paidSwapChain(channel);

      const first = await refundCharge(channel, charge.chargeId, CHARGE_PAID);
      expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(
        200,
      );
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);

      const ord09 = await ord09Attempt(charge.replacementLine, KOPI_PRICE);
      const out = await chargeMoneyOut(channel, charge.chargeId);
      expect(out).toBe(CHARGE_PAID);
      expectChainBound(ord09?.filedIdr ?? 0, out);
      if ((ord09?.filedIdr ?? 0) === 0) expectOrd09Refused(ord09);
    });
  });

describe("1145 P1-2 controls: a normal swap chain and a discounted order still pay in full", () => {
  it("control: ORD-09 of the replacement alone is filed, <= what chain A paid (28.875)", async () => {
    const charge = await paidSwapChain("cash");
    const ord09 = await ord09Attempt(charge.replacementLine, KOPI_PRICE);
    expect(ord09, "reported").not.toBeNull();
    expect(ord09!.resolveStatus).toBe(200);
    expect(ord09!.consumerError).toBeNull();
    expect(ord09!.filedIdr).toBeGreaterThan(0);
    expectChainBound(ord09!.filedIdr, 0);
  });

  it("control: a refund of the whole charge alone (8.085) is accepted", async () => {
    const charge = await paidSwapChain("cash");
    const answer = await refundCharge("cash", charge.chargeId, CHARGE_PAID);
    expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
    expect(await chargeMoneyOut("cash", charge.chargeId)).toBe(CHARGE_PAID);
  });

  it("control: plain order, ORD-09 of the roti is filed in full (20.790), never cut", async () => {
    const paid = await p.paidPlainOrder();
    const attempt = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expect(attempt?.resolveStatus).toBe(200);
    expect(attempt!.filedIdr).toBe(ROTI_PAID);
  });

  it("promo order (paid 42.735): ORD-09 of the kopi (8.085) is filed; the roti (20.790 > its share 13.986) is blocked, nothing filed (legend-wpn5v)", async () => {
    const paid = await p.paidPromoOrder();
    const kopi = await ord09Attempt(paid.kopiLine, KOPI_PRICE);
    const roti = await ord09Attempt(paid.rotiLine, ROTI_PRICE);
    expect(kopi?.resolveStatus, "kopi resolved").toBe(200);
    expect(roti?.resolveStatus, "roti resolved").toBe(200);
    expect(kopi!.filedIdr).toBe(8_085);
    expect(roti!.filedIdr).toBe(0);
    expect(sum([kopi!.filedIdr, roti!.filedIdr])).toBeLessThanOrEqual(
      PROMO_PAID,
    );
  });
});
