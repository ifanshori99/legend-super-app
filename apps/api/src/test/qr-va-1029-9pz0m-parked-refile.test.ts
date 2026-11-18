// legend-1029 legend-9pz0m (money): the automatic refund of PARKED money (a
// payment_unallocated_funds row, refund tied by payment_refunds.unallocated_fund_id,
// e.g. late money on a code the guest voided by changing the payment method,
// founder Q15) that FAILS because its approval expired used to stay failed
// forever: nobody re-filed it and nobody was told, so the guest's money was
// stuck. New rule, the same as for refunds of a payment intent (legend-weuo2,
// system-refund-followup.test.ts), now also for parked funds:
//   1. A parked-fund system refund that failed with reason approval_expired is
//      re-filed automatically for what is still owed, bounded at 3 FAILED
//      refunds PER FUND (MAX_SYSTEM_REFUND_REFILE_ATTEMPTS = 3).
//   2. Never more than ONE live refund per fund (unique index
//      payment_refunds_unallocated_fund_live_uq), never more than the fund in
//      total (the guest is not paid more, the outlet is not out of pocket).
//   3. When the bound is spent: one audit row `payment.refund_followup_required`
//      and one in-app alarm to the outlet supervisor, once per refund id.
//   4. Replays, concurrent settles and re-delivered payment.funds_unallocated
//      events open nothing extra. Another tenant is never touched.
// Written from the brief and the existing tests (qr-va-1004-hs1rc, weuo2), not
// from the implementation.
//
// Assumptions (spec silent, the brief decides only the shape)
// - The refund fails without a person exactly as in system-refund-followup
//   (weuo2): its approval request is set `expired` and
//   `settleRefundFromChain` settles it to failed / approval_expired.
// - MAX_SYSTEM_REFUND_REFILE_ATTEMPTS = 3, literal here (the module is not
//   imported on purpose). 3 failed refunds of one fund => 3 refunds in total,
//   all failed, the third is NOT re-filed.
// - The re-filed refund carries the same requested_by as the first one (a
//   system actor, not pinned to a name) and the same amount (the fund amount).
// - Alarm: a `notifications` row for the outlet supervisor (the staff user of
//   the fixture holds a copy of the seeded supervisor template at outlet
//   scope); text contains "pengembalian" or "refund". Only the follow-up
//   moment raises it, not a failure that was re-filed.
// - Audit: audit_logs row, event->>'action' = 'payment.refund_followup_required',
//   event->>'objectId' = the failed refund id (as in weuo2).
// - Re-delivering payment.funds_unallocated after the bound is spent must not
//   open a fourth refund (the bound is per fund, not per event).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1029-9pz0m-parked-refile.test.ts" pnpm test
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentChannel } from "@starter/shared/payment";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner, seededTenantId } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** MAX_SYSTEM_REFUND_REFILE_ATTEMPTS (brief 850 / 1029). */
const MAX_ATTEMPTS = 3;
const FOLLOWUP_ACTION = "payment.refund_followup_required";
const BNI: PaymentChannel = { code: "bni", name: "BNI" };

/** The tenant under test. */
let fx: HoldFixture;
/** A second, unrelated tenant: must never be touched. */
let other: HoldFixture;

beforeAll(async () => {
  // The other tenant first: fixtures set process-wide ports and the LAST one
  // built wins.
  other = await holdFixture("qr-va-1029-9pz0m-other");
  fx = await holdFixture("qr-va-1029-9pz0m-parked");
  enableVaBank(fx.gateway);
  const port = fx.gateway as unknown as {
    channels(
      context: ScopedTenantContext,
      method?: string,
    ): Promise<PaymentChannel[]>;
  };
  port.channels = async (_context, method) =>
    method === "va" ? [{ code: "bmri", name: "Mandiri" }, BNI] : [];
  setPaymentGateway(fx.gateway);

  // A refund policy (one level) so every system refund opens an approval
  // request, which the tests then let expire; and the fixture's staff user is
  // the outlet supervisor who receives the follow-up alarm.
  const copyRole = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
           FROM roles WHERE tenant_id = $2 AND template_key = $3
         RETURNING id`,
        [fx.tenant.tenantId, seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const financeRole = await copyRole("finance");
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [fx.tenant.tenantId, financeRole],
  );
  const supervisorRole = await copyRole("supervisor");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [fx.tenant.tenantId, fx.staff.userId, supervisorRole, fx.tenant.outletId],
  );
});
afterEach(() => {
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------- fixtures

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Code = { id: string; ref: string; amount: number };
type Bill = {
  guest: Guest;
  orderId: string;
  linkId: string;
  a: Code;
};

function payRequest(guest: Guest, orderId: string, bankCode: "bmri" | "bni") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode,
    idempotencyKey: randomUUID(),
  });
}

async function codeOf(id: string): Promise<Code & { linkId: string }> {
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, id],
  );
  return {
    id,
    ref: rows[0]!.provider_ref,
    amount: rows[0]!.amount,
    linkId: rows[0]!.payment_link_id,
  };
}

async function billWithCodeA(): Promise<Bill> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await payRequest(guest, order.id, "bmri");
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const a = await codeOf(created.body.data.id as string);
  fx.gateway.script(a.id, { rawStatus: "01" });
  return { guest, orderId: order.id, linkId: a.linkId, a };
}

/** The guest swaps A for a code at another bank: A voided (guest_method_change). */
async function swapToB(b: Bill): Promise<Code> {
  const res = await payRequest(b.guest, b.orderId, "bni");
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.id, "a NEW code B").not.toBe(b.a.id);
  return codeOf(res.body.data.id as string);
}

/** A verified webhook "paid" (errors on a dead code are swallowed). */
async function webhook(code: Code) {
  try {
    await confirmPayment(
      fx.context,
      code.id,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr: code.amount,
        providerRef: code.ref,
        at: new Date().toISOString(),
      },
      { type: "system" },
      new Date(),
    );
  } catch {
    /* refused on a dead code: parked, asserted by the caller */
  }
}

type Envelope = ReturnType<typeof eventEnvelopeSchema.parse>;

async function eventsOf(
  intentIds: string[],
  name?: string,
): Promise<Envelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id=$1
        AND event->'payload'->>'intentId' = ANY($2::text[])
        AND ($3::text IS NULL OR event->>'name'=$3)
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentIds, name ?? null],
  );
  return rows.map((r) => eventEnvelopeSchema.parse(r.event));
}

function deliver(event: Envelope) {
  return withTenant(db, fx.context, (tx) =>
    deliverOrderPaymentEvent(fx.context, event, tx, new Date()),
  );
}

async function consumeAll(intentIds: string[]) {
  for (const event of await eventsOf(intentIds)) await deliver(event);
}

type Parked = { bill: Bill; b: Code; fundId: string; amount: number };

/**
 * Guest swaps A -> B, B pays and settles the bill, then A is paid late: A's
 * money is parked once and the system opens its (first) refund.
 */
async function parkedFundWithRefund(): Promise<Parked> {
  const bill = await billWithCodeA();
  const b = await swapToB(bill);
  fx.gateway.script(b.id, { status: "paid" });
  await webhook(b);
  await consumeAll([bill.a.id, b.id]);
  await webhook(bill.a);
  await consumeAll([bill.a.id, b.id]);
  const funds = await unallocatedFunds(fx, bill.a.id);
  expect(
    funds.map((f) => f.amountIdr),
    "A's late money is parked exactly once",
  ).toEqual([bill.a.amount]);
  const parked = { bill, b, fundId: funds[0]!.id, amount: bill.a.amount };
  const rows = await refundsOfFund(parked.fundId);
  expect(rows, "the first refund of the parked fund").toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "pending", amount: parked.amount });
  return parked;
}

// ----------------------------------------------------------------- DB readers

type RefundRow = {
  id: string;
  amount: number;
  status: string;
  failure_reason: string | null;
  requested_by: string;
  payment_intent_id: string;
  unallocated_fund_id: string | null;
};

async function refundsOfFund(fundId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id::text AS id, amount_idr::int AS amount, status, failure_reason,
            requested_by, payment_intent_id::text AS payment_intent_id,
            unallocated_fund_id::text AS unallocated_fund_id
       FROM payment_refunds
      WHERE tenant_id=$1 AND unallocated_fund_id=$2::uuid
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, fundId],
  );
  return rows;
}

const isLive = (row: RefundRow) => row.status !== "failed";
const liveOf = (rows: RefundRow[]) => rows.filter(isLive);
const liveSum = (rows: RefundRow[]) =>
  liveOf(rows).reduce((sum, row) => sum + row.amount, 0);

/** Money rules after every step: at most one live refund, never above the fund. */
async function expectCapped(p: Parked) {
  const rows = await refundsOfFund(p.fundId);
  expect(
    liveOf(rows).length,
    "more than one live refund for one fund",
  ).toBeLessThanOrEqual(1);
  expect(liveSum(rows), "refunds above the parked money").toBeLessThanOrEqual(
    p.amount,
  );
  return rows;
}

/** The refund fails without a person: its approval request expires. */
async function expireRefund(refundId: string) {
  await owner.query(
    "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
    [fx.tenant.tenantId, refundId],
  );
  const failed = await settleRefundFromChain(fx.context, refundId);
  expect(failed.status).toBe("failed");
}

async function auditRows(refundId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [fx.tenant.tenantId, refundId, FOLLOWUP_ACTION],
  );
  return rows;
}

async function supervisorAlarms() {
  const { rows } = await owner.query<{ title: string; body: string }>(
    `SELECT title, body FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`,
    [fx.tenant.tenantId, fx.staff.userId],
  );
  return rows;
}

async function expectOtherTenantUntouched() {
  const count = async (sql: string) =>
    (await owner.query<{ n: number }>(sql, [other.tenant.tenantId])).rows[0]!.n;
  expect(
    await count(
      "SELECT count(*)::int AS n FROM payment_unallocated_funds WHERE tenant_id=$1",
    ),
    "other tenant: no funds",
  ).toBe(0);
  expect(
    await count(
      "SELECT count(*)::int AS n FROM payment_refunds WHERE tenant_id=$1",
    ),
    "other tenant: no refunds",
  ).toBe(0);
  expect(
    await count(
      `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND event->>'action'='${FOLLOWUP_ACTION}'`,
    ),
    "other tenant: no follow-up audit",
  ).toBe(0);
}

// ------------------------------------------------------------------------ tests

describe("legend-9pz0m a parked-fund refund that failed approval_expired is re-filed", () => {
  it("legend-9pz0m approval expires once: one new pending refund of the whole fund, no alarm yet, replays and concurrent settles add nothing", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    const alarmsBefore = (await supervisorAlarms()).length;

    await expireRefund(first!.id);

    let rows = await expectCapped(p);
    expect(
      rows.find((row) => row.id === first!.id),
      "first refund failed",
    ).toMatchObject({ status: "failed", failure_reason: "approval_expired" });
    expect(rows, "the failed parked-fund refund was not re-filed").toHaveLength(
      2,
    );
    const refiled = liveOf(rows)[0]!;
    expect(refiled.id).not.toBe(first!.id);
    expect(refiled).toMatchObject({
      status: "pending",
      amount: p.amount,
      unallocated_fund_id: p.fundId,
      payment_intent_id: p.bill.a.id,
      requested_by: first!.requested_by,
    });
    // It is being handled: no alarm, no audit row.
    expect(await auditRows(first!.id)).toHaveLength(0);
    expect((await supervisorAlarms()).length).toBe(alarmsBefore);

    // At-least-once delivery of the failure: sequential and concurrent.
    await settleRefundFromChain(fx.context, first!.id);
    await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        settleRefundFromChain(fx.context, first!.id),
      ),
    );
    rows = await expectCapped(p);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [first!.id, refiled.id].sort(),
    );
    expect(liveSum(rows)).toBe(p.amount);

    // Re-delivering the parked-funds event adds no second live refund either.
    for (const event of await eventsOf(
      [p.bill.a.id],
      "payment.funds_unallocated",
    ))
      await Promise.allSettled([deliver(event), deliver(event)]);
    rows = await expectCapped(p);
    expect(liveOf(rows).map((row) => row.id)).toEqual([refiled.id]);
    expect(liveSum(rows)).toBe(p.amount);
    await expectOtherTenantUntouched();
  });

  it("legend-9pz0m the re-filed refund can fail and be re-filed again, always one live refund of the fund", async () => {
    const p = await parkedFundWithRefund();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const live = liveOf(await expectCapped(p));
      expect(live, `a live refund before failure ${attempt}`).toHaveLength(1);
      await expireRefund(live[0]!.id);
      const rows = await expectCapped(p);
      expect(rows, `re-filed after failure ${attempt}`).toHaveLength(
        attempt + 1,
      );
      expect(liveOf(rows)).toHaveLength(1);
      expect(liveSum(rows)).toBe(p.amount);
    }
    await expectOtherTenantUntouched();
  });
});

describe("legend-9pz0m the loop is bounded; then alarm and audit", () => {
  it("legend-9pz0m three failed refunds of one fund: no fourth refund; one audit row and one alarm, replays and re-delivered events add nothing", async () => {
    const p = await parkedFundWithRefund();
    const alarmsBefore = (await supervisorAlarms()).length;
    const failedIds: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const live = liveOf(await expectCapped(p));
      expect(live, `a live refund for attempt ${attempt}`).toHaveLength(1);
      failedIds.push(live[0]!.id);
      await expireRefund(live[0]!.id);
      if (attempt < MAX_ATTEMPTS) {
        // Still within the bound: re-filed, so not an alarm yet.
        expect(await auditRows(live[0]!.id)).toHaveLength(0);
        expect((await supervisorAlarms()).length).toBe(alarmsBefore);
      }
    }

    const rows = await expectCapped(p);
    expect(rows, "a refund beyond the bound was filed").toHaveLength(
      MAX_ATTEMPTS,
    );
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(liveSum(rows)).toBe(0);
    const last = failedIds[MAX_ATTEMPTS - 1]!;

    // Audit: exactly one row, for the refund that was not re-filed.
    expect(await auditRows(last)).toHaveLength(1);
    expect(await auditRows(failedIds[0]!)).toHaveLength(0);
    expect(await auditRows(failedIds[1]!)).toHaveLength(0);

    // Alarm: the outlet supervisor got one Indonesian notice.
    const alarms = (await supervisorAlarms()).slice(alarmsBefore);
    expect(alarms, "no alarm for a refund nobody will re-file").toHaveLength(1);
    expect(`${alarms[0]!.title} ${alarms[0]!.body}`).toMatch(
      /pengembalian|refund/i,
    );

    // Replays of the last failure and re-delivered fund events: nothing new.
    await settleRefundFromChain(fx.context, last);
    await Promise.allSettled(
      Array.from({ length: 3 }, () => settleRefundFromChain(fx.context, last)),
    );
    for (const event of await eventsOf(
      [p.bill.a.id],
      "payment.funds_unallocated",
    ))
      await Promise.allSettled([deliver(event), deliver(event)]);
    expect(await auditRows(last)).toHaveLength(1);
    expect((await supervisorAlarms()).length).toBe(alarmsBefore + 1);
    const after = await expectCapped(p);
    expect(after, "a fourth refund was opened").toHaveLength(MAX_ATTEMPTS);
    expect(liveSum(after)).toBe(0);
    await expectOtherTenantUntouched();
  });
});

describe("legend-9pz0m the bound is counted per fund", () => {
  it("legend-9pz0m a fund whose bound is spent does not use up the budget of another fund of the same tenant", async () => {
    const x = await parkedFundWithRefund();
    const y = await parkedFundWithRefund();
    expect(y.fundId).not.toBe(x.fundId);

    // Spend X completely.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const live = liveOf(await expectCapped(x));
      expect(live).toHaveLength(1);
      await expireRefund(live[0]!.id);
    }
    expect(await refundsOfFund(x.fundId)).toHaveLength(MAX_ATTEMPTS);
    expect(liveOf(await refundsOfFund(x.fundId))).toHaveLength(0);

    // Y's first failure is still re-filed, with Y's own money.
    const [yFirst] = await refundsOfFund(y.fundId);
    await expireRefund(yFirst!.id);
    const yRows = await expectCapped(y);
    expect(yRows, "Y was not re-filed after X spent its bound").toHaveLength(2);
    const yLive = liveOf(yRows);
    expect(yLive).toHaveLength(1);
    expect(yLive[0]).toMatchObject({
      status: "pending",
      amount: y.amount,
      unallocated_fund_id: y.fundId,
      payment_intent_id: y.bill.a.id,
    });
    // X got nothing more and Y raised no follow-up yet.
    expect(await refundsOfFund(x.fundId)).toHaveLength(MAX_ATTEMPTS);
    expect(await auditRows(yFirst!.id)).toHaveLength(0);
    await expectOtherTenantUntouched();
  });
});

// ------------------------------------------------ failures nobody re-files

/**
 * The refund fails the way a person (rejected) or the provider
 * (provider_declined) decided it; the failed row is what the re-file rules read.
 */
async function failRefundAs(refundId: string, reason: string) {
  await owner.query(
    "UPDATE payment_refunds SET status = 'failed', failure_reason = $3 WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, refundId, reason],
  );
}

async function redeliverFundEvents(p: Parked) {
  for (const event of await eventsOf(
    [p.bill.a.id],
    "payment.funds_unallocated",
  ))
    await Promise.allSettled([deliver(event), deliver(event)]);
}

describe("legend-9pz0m a decision of a person or the provider is not re-filed", () => {
  for (const reason of ["rejected", "provider_declined"]) {
    it(`legend-9pz0m a parked-fund refund that failed ${reason} stays failed, also when the funds event is delivered again`, async () => {
      const p = await parkedFundWithRefund();
      const [first] = await refundsOfFund(p.fundId);
      await failRefundAs(first!.id, reason);

      let rows = await expectCapped(p);
      expect(rows, `a ${reason} refund was re-filed`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first!.id, status: "failed" });

      await settleRefundFromChain(fx.context, first!.id);
      await redeliverFundEvents(p);
      rows = await expectCapped(p);
      expect(
        rows,
        `a re-delivered event opened a refund after ${reason}`,
      ).toHaveLength(1);
      expect(liveSum(rows)).toBe(0);
      await expectOtherTenantUntouched();
    });
  }

  it("legend-9pz0m a fund that has a resolution is not refunded again", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    await owner.query(
      "UPDATE payment_unallocated_funds SET resolution = 'credit', resolved_by = 'tester', resolved_at = now() WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, p.fundId],
    );
    await expireRefund(first!.id);
    await redeliverFundEvents(p);

    const rows = await expectCapped(p);
    expect(rows, "a resolved fund was refunded again").toHaveLength(1);
    expect(liveSum(rows)).toBe(0);
    await expectOtherTenantUntouched();
  });
});

describe("legend-9pz0m a facility refund of a parked fund is re-filed for the whole fund", () => {
  it("legend-9pz0m system:facility requester: the new refund keeps the requester and covers the full fund amount", async () => {
    const p = await parkedFundWithRefund();
    const [first] = await refundsOfFund(p.fundId);
    await owner.query(
      "UPDATE payment_refunds SET requested_by = 'system:facility' WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, first!.id],
    );
    await expireRefund(first!.id);

    const rows = await expectCapped(p);
    expect(rows).toHaveLength(2);
    const [refiled] = liveOf(rows);
    expect(refiled).toMatchObject({
      status: "pending",
      amount: p.amount,
      requested_by: "system:facility",
      unallocated_fund_id: p.fundId,
    });
    expect(liveSum(rows)).toBe(p.amount);
    await expectOtherTenantUntouched();
  });
});
