// legend-1004 legend-hs1rc (P1, money): late money on a VA code that the guest
// voided by changing the payment method (release kind guest_method_change) must
// be handed back AUTOMATICALLY (founder Q15), exactly once, never more than
// arrived. Written from the second-opinion P1 finding (scenario and proposed
// test) and the 940 late-payment test, not from the implementation.
//
// Scenario: guest swaps VA A -> VA B, pays B, the order is settled and its
// events are consumed, THEN A is paid late (webhook, provider poll, replays).
//
// Rules under test
// - Exactly ONE parked fund for A and exactly ONE payment_refunds row per
//   fundId, amount == A's paid amount (never more), after ALL outbox events of
//   the scenario were consumed, also after: a duplicate webhook, a provider
//   poll, a replayed webhook, re-delivering payment.funds_unallocated many
//   times (also at once).
// - The bill is paid once, by B only. A is never allocated to the bill; A stays
//   `expired`; no payment.paid event for A; nothing is refunded against B.
// - The outlet is not charged the difference: bill booked = B only, refunds
//   total = A's money only.
// - Another tenant gets no funds, refunds or payment events.
// - Control: a late payment on a release of kind `staff` keeps the OLD
//   behavior: parked once, NO refund opened by this path.
//
// Assumptions (also in the report)
// - "Consume ALL outbox" = deliver every outbox event of the scenario's intents
//   (A and B, any name) through `deliverOrderPaymentEvent`, as the worker does.
//   The brief says the outbox, not a worker call, is the consumer entry point.
// - Refund status is not pinned (pending/approved/completed): approval and
//   payout safety stay as they are. Only existence, count and amount.
// - A refund row for the fund is found by `unallocated_fund_id` (as in the
//   breakfast tests) and also by payment_intent_id = A (a refund tied to A even
//   without the fund link still counts and must not be a second one).
// - The swap is bmri -> bni on the same guest order (as in the 9vmit file).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1004-hs1rc-method-change-late-refund.test.ts" heavy pnpm test
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
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentChannel } from "@starter/shared/payment";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import {
  evidenceRows,
  outboxCountOf,
  releaseKit,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BNI: PaymentChannel = { code: "bni", name: "BNI" };
const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status transfer lebih dari sehari";

/** The tenant under test. */
let fx: HoldFixture;
/** A second, unrelated tenant: must never be touched. */
let other: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

beforeAll(async () => {
  // The other tenant first: fixtures set process-wide ports (device resolver)
  // and the LAST one built wins.
  other = await holdFixture("qr-va-1004-hs1rc-other");
  fx = await holdFixture("qr-va-1004-hs1rc-late-refund");
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
  kit = releaseKit(fx);
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

type Bill = {
  guest: Guest;
  orderId: string;
  linkId: string;
  /** The first code A (VA bmri). */
  aId: string;
  aRef: string;
  aAmount: number;
};
type Code = { id: string; ref: string; amount: number };

function payRequest(guest: Guest, orderId: string, bankCode: "bmri" | "bni") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode,
    idempotencyKey: randomUUID(),
  });
}

async function billWithCodeA(): Promise<Bill> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await payRequest(guest, order.id, "bmri");
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const aId = created.body.data.id as string;
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, aId],
  );
  fx.gateway.script(aId, { rawStatus: "01" });
  return {
    guest,
    orderId: order.id,
    linkId: rows[0]!.payment_link_id,
    aId,
    aRef: rows[0]!.provider_ref,
    aAmount: rows[0]!.amount,
  };
}

/** The guest swaps A for a code at another bank: A voided (guest_method_change). */
async function swapToB(b: Bill): Promise<Code> {
  const res = await payRequest(b.guest, b.orderId, "bni");
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  expect(id, "a NEW code B").not.toBe(b.aId);
  const { rows } = await owner.query<{ amount: number; provider_ref: string }>(
    "SELECT amount_idr::int AS amount, provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, id],
  );
  const releases = await owner.query<{ kind: string }>(
    "SELECT kind FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, b.aId],
  );
  expect(releases.rows.map((r) => r.kind)).toEqual(["guest_method_change"]);
  return { id, ref: rows[0]!.provider_ref, amount: rows[0]!.amount };
}

/** A verified webhook "paid" (errors on a dead code are swallowed; effects are
 * asserted by the caller). */
async function webhook(intentId: string, ref: string, amountIdr: number) {
  try {
    await confirmPayment(
      fx.context,
      intentId,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr,
        providerRef: ref,
        at: new Date().toISOString(),
      },
      { type: "system" },
      new Date(),
    );
  } catch {
    /* refused on a dead code: parked, asserted by the caller */
  }
}

async function runVaRecon() {
  const job = await tryImport<{
    runPaymentVaReleaseReconJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>("../worker/payment-va-release-recon.job.ts", "VA release recon job");
  if (typeof job.runPaymentVaReleaseReconJob !== "function")
    throw new Error(
      "worker/payment-va-release-recon.job.ts must export runPaymentVaReleaseReconJob(context, now, { force })",
    );
  return job.runPaymentVaReleaseReconJob(fx.context, new Date(), {
    force: true,
  });
}

/** The provider poll reports A paid (recon job reads it). */
async function pollAPaid(b: Bill) {
  fx.gateway.script(b.aId, { status: "paid" });
  await runVaRecon();
}

// ------------------------------------------------------------- outbox consumer

type Envelope = ReturnType<typeof eventEnvelopeSchema.parse>;

async function eventsOf(
  tenantId: string,
  intentIds: string[],
  name?: string,
): Promise<Envelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id=$1
        AND event->'payload'->>'intentId' = ANY($2::text[])
        AND ($3::text IS NULL OR event->>'name'=$3)
      ORDER BY created_at, id`,
    [tenantId, intentIds, name ?? null],
  );
  return rows.map((r) => eventEnvelopeSchema.parse(r.event));
}

function deliver(event: Envelope) {
  return withTenant(db, fx.context, (tx) =>
    deliverOrderPaymentEvent(fx.context, event, tx, new Date()),
  );
}

/** Consume ALL outbox events of the scenario, oldest first, as the worker does. */
async function consumeAll(b: Bill, next: Code) {
  const events = await eventsOf(fx.tenant.tenantId, [b.aId, next.id]);
  for (const event of events) await deliver(event);
  return events.length;
}

// ----------------------------------------------------------------- DB readers

type RefundRow = {
  id: string;
  amount: number;
  status: string;
  payment_intent_id: string;
  unallocated_fund_id: string | null;
};

async function refundsOfIntentOrFund(
  intentId: string,
  fundIds: string[],
): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id::text AS id, amount_idr::int AS amount, status,
            payment_intent_id::text AS payment_intent_id,
            unallocated_fund_id::text AS unallocated_fund_id
       FROM payment_refunds
      WHERE tenant_id=$1
        AND (payment_intent_id=$2 OR unallocated_fund_id = ANY($3::uuid[]))
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId, fundIds],
  );
  return rows;
}

async function paidIdr(linkId: string) {
  const { rows } = await owner.query<{ paid: number; total: number }>(
    "SELECT paid_idr::int AS paid, total_idr::int AS total FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, linkId],
  );
  return rows[0]!;
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2::uuid",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

// ------------------------------------------------------------------ assertions

/** B pays and the order is settled: its events are consumed. */
async function payBAndSettle(b: Bill, next: Code) {
  fx.gateway.script(next.id, { status: "paid" });
  await webhook(next.id, next.ref, next.amount);
  await consumeAll(b, next);
  expect((await paidIdr(b.linkId)).paid, "B settles the bill once").toBe(
    next.amount,
  );
  expect(await outboxCountOf(fx, "payment.paid", next.id)).toBe(1);
  return orderStatus(b.orderId);
}

/** Exactly one fund and one refund for A's late money, nothing else moved. */
async function expectOneRefundOfA(
  b: Bill,
  next: Code,
  orderStatusAfterB: string,
) {
  const funds = await unallocatedFunds(fx, b.aId);
  expect(
    funds.map((f) => f.amountIdr),
    "A's late money is parked exactly once",
  ).toEqual([b.aAmount]);
  expect(await evidenceRows(fx, b.aId)).toHaveLength(1);

  const refunds = await refundsOfIntentOrFund(b.aId, [funds[0]!.id]);
  expect(
    refunds,
    "exactly one refund row for A's fund (the guest is handed A back, Q15)",
  ).toHaveLength(1);
  expect(refunds[0]!.unallocated_fund_id).toBe(funds[0]!.id);
  expect(refunds[0]!.payment_intent_id).toBe(b.aId);
  expect(refunds[0]!.amount, "refund == what A received, never more").toBe(
    b.aAmount,
  );

  // The outlet is not charged: no refund against B, the bill books B only.
  expect(
    (await refundsOfIntentOrFund(next.id, [])).filter(
      (r) => r.payment_intent_id === next.id,
    ),
    "nothing is refunded against the paying code B",
  ).toEqual([]);
  const link = await paidIdr(b.linkId);
  expect(link.paid, "bill paid once, by B only").toBe(next.amount);
  expect(link.paid).toBeLessThanOrEqual(link.total);
  expect(await intentStatus(b.aId), "A never becomes paid").toBe("expired");
  expect(await outboxCountOf(fx, "payment.paid", b.aId)).toBe(0);
  expect(await outboxCountOf(fx, "payment.paid", next.id)).toBe(1);
  expect(await orderStatus(b.orderId), "the settled order is untouched").toBe(
    orderStatusAfterB,
  );
  return { fundId: funds[0]!.id, refundId: refunds[0]!.id };
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
      "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id=$1 AND event->>'name' LIKE 'payment.%'",
    ),
    "other tenant: no payment events",
  ).toBe(0);
}

// ------------------------------------------------------------------------ tests

describe("legend-hs1rc late money on a method-change voided code is refunded once", () => {
  it("legend-hs1rc webhook: B paid and consumed, then A paid late (twice): one fund, one refund of A's amount", async () => {
    const b = await billWithCodeA();
    const next = await swapToB(b);
    const orderAfterB = await payBAndSettle(b, next);

    await webhook(b.aId, b.aRef, b.aAmount);
    await webhook(b.aId, b.aRef, b.aAmount); // same notice delivered twice
    expect(
      await outboxCountOf(fx, "payment.funds_unallocated", b.aId),
      "A's money produced its parked-funds event",
    ).toBe(1);
    await consumeAll(b, next);

    const ids = await expectOneRefundOfA(b, next, orderAfterB);
    expect(ids.refundId).toBeTruthy();
    await expectOtherTenantUntouched();
  });

  it("legend-hs1rc provider poll: B paid and consumed, then the poll reports A paid (twice): one fund, one refund", async () => {
    const b = await billWithCodeA();
    const next = await swapToB(b);
    const orderAfterB = await payBAndSettle(b, next);

    await pollAPaid(b);
    await pollAPaid(b);
    await consumeAll(b, next);

    await expectOneRefundOfA(b, next, orderAfterB);
    await expectOtherTenantUntouched();
  });

  it("legend-hs1rc webhook + poll + replay + re-delivered payment.funds_unallocated (also at once): still one refund of A's amount", async () => {
    const b = await billWithCodeA();
    const next = await swapToB(b);
    const orderAfterB = await payBAndSettle(b, next);

    await webhook(b.aId, b.aRef, b.aAmount);
    await consumeAll(b, next);
    const first = await expectOneRefundOfA(b, next, orderAfterB);

    // Poll and a replayed webhook after the refund exists.
    await pollAPaid(b);
    await webhook(b.aId, b.aRef, b.aAmount);
    await consumeAll(b, next);
    expect(await expectOneRefundOfA(b, next, orderAfterB)).toEqual(first);

    // Re-deliver the parked-funds event many times, sequentially and at once.
    const funds = await eventsOf(
      fx.tenant.tenantId,
      [b.aId],
      "payment.funds_unallocated",
    );
    expect(funds.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i++) for (const event of funds) await deliver(event);
    await Promise.allSettled(funds.map((event) => deliver(event)));
    await Promise.allSettled(funds.map((event) => deliver(event)));
    await consumeAll(b, next);

    expect(await expectOneRefundOfA(b, next, orderAfterB)).toEqual(first);
    await expectOtherTenantUntouched();
  });

  it("legend-hs1rc A paid late BEFORE B: A parked once and refunded once; B then settles the bill once", async () => {
    const b = await billWithCodeA();
    const next = await swapToB(b);

    await webhook(b.aId, b.aRef, b.aAmount);
    await consumeAll(b, next);
    fx.gateway.script(next.id, { status: "paid" });
    await webhook(next.id, next.ref, next.amount);
    await consumeAll(b, next);

    await expectOneRefundOfA(b, next, await orderStatus(b.orderId));
    await expectOtherTenantUntouched();
  });
});

describe("legend-hs1rc control: a staff release keeps the old behavior", () => {
  it("legend-hs1rc late money on a STAFF-released code is parked once and NO refund is opened by this path", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const created = await payRequest(guest, order.id, "bmri");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const aId = created.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
      payment_link_id: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref,
              payment_link_id::text AS payment_link_id
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId],
    );
    const amount = rows[0]!.amount;
    // Staff releases the lapsed code (Q93: approval, 30 minutes after expiry).
    fx.gateway.script(aId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents
          SET expires_at = now() - $3::int * interval '1 minute', status = 'expired'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId, RELEASE_AFTER_MIN + 1],
    );
    const approval = await kit.managerApproval(order.id, amount);
    const released = await fx.post(`${fx.base}/${order.id}/va/release`, {
      paymentIntentId: aId,
      ...approval,
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const kinds = await owner.query<{ kind: string }>(
      "SELECT kind FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
      [fx.tenant.tenantId, aId],
    );
    expect(kinds.rows.map((r) => r.kind)).toEqual(["staff"]);

    await webhook(aId, rows[0]!.provider_ref, amount);
    await webhook(aId, rows[0]!.provider_ref, amount);
    for (const event of await eventsOf(fx.tenant.tenantId, [aId]))
      await deliver(event);

    const funds = await unallocatedFunds(fx, aId);
    expect(funds.map((f) => f.amountIdr)).toEqual([amount]);
    expect(
      await refundsOfIntentOrFund(
        aId,
        funds.map((f) => f.id),
      ),
      "staff release: no automatic refund through this path",
    ).toEqual([]);
    expect((await paidIdr(rows[0]!.payment_link_id)).paid).toBe(0);
    await expectOtherTenantUntouched();
  });
});
