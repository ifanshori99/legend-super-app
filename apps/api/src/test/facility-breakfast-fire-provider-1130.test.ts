// legend-9sw2w (1130 P2): breakfast paths that cancel an order LOCALLY without
// the payment provider's word. Written from the founder rule Q93 ("jangan
// sampai rugi", docs/briefs/ukbq3-payment-link-cancel.md) and the public
// contract (staff HTTP endpoint, worker sweep, payment.paid consumer), not
// from the implementation. Real app, Better Auth, payment service, PostgreSQL;
// only the gateway is a scripted double.
//
// Run: LEGEND_TEST_FILES="src/test/facility-breakfast-fire-provider-1130.test.ts" heavy pnpm test
//
// Assumptions where the brief is silent:
// - The money still at risk is the guest's OTHER open QR code (B) of the same
//   link, opened before the first code (A) was paid. A local cancel closes B
//   locally while the provider may already hold money for it. A is scripted
//   "00" (paid) so the world is coherent for any design; B carries the answer.
// - "Provider says unpaid" = raw "01": order cancels, A refunded once in
//   full, B has no money. These tests pin today's safe behaviour (green).
// - "Provider holds B's money" = raw "00": cancelling is fine only if every
//   received rupiah goes back exactly once (A and B, each once, never above
//   what was received).
// - "Unclear" = status read timeout, 5xx or an answer about another provider
//   reference: no local cancel, B gets no refund / parked fund. A held call
//   may reject (409) or skip the order, so its error is tolerated and only
//   the resulting state is asserted. A clear answer later completes the
//   cancel with one refund.
// - Consumer "split" / "committed" refusals refund the extra code and never
//   cancel the order (covered by BRK-PAY-02); only the late-payment refusal
//   that cancels the order is written here.
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  MINUTE,
  asOwnerTenant,
  createBreakfastWorld,
  deliver,
  dropBreakfastWorld,
  endPools,
  kitchenTicketCount,
  linkedOf,
  newMember,
  openIntent,
  openSecondIntent,
  paidEvent,
  payLink,
  placeOrder,
  runSweep,
  seedTicket,
  setFireAt,
  settle,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import {
  PROVIDER_UNSURE,
  installScriptedGateway,
  moneyOfIntent,
  paidEventsOf,
  type IntentMoney,
  type ScriptedGateway,
} from "./payment-link-cancel-provider-helpers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";

let app: Express;
let world: BreakfastWorld;
let gateway: ScriptedGateway;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  world = await createBreakfastWorld(app);
  gateway = installScriptedGateway();
});

afterAll(async () => {
  setPaymentGateway(null);
  await dropBreakfastWorld(world);
  await endPools();
});

type Setup = Awaited<ReturnType<typeof twoCodes>>;

/** An awaiting_payment order whose guest opened two QR codes (A then B). */
async function twoCodes() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const a = await openIntent(world, token);
  const b = await openSecondIntent(world, token);
  expect(b.id).not.toBe(a.id);
  gateway.script(a.id, { rawStatus: "00", amountIdr: order.totalIdr });
  return { ticketId, order, a, b, total: order.totalIdr };
}

/** A is paid and consumed (order paid, due to fire); B stays open at the provider. */
async function paidWithOpenCode() {
  const setup = await twoCodes();
  await settle(world, setup.a.id, setup.total);
  await deliver(world, await paidEvent(world, setup.a.id));
  expect((await linkedOf(world, setup.order.id)).status).toBe("paid");
  await setFireAt(world, setup.order.id, new Date(Date.now() - 5 * MINUTE));
  return setup;
}

/** A was paid at the provider but the ticket ended before the notice arrived. */
async function latePayment() {
  const setup = await twoCodes();
  await settle(world, setup.a.id, setup.total);
  const event = await paidEvent(world, setup.a.id);
  await endSession(setup.ticketId);
  expect((await linkedOf(world, setup.order.id)).status).toBe(
    "awaiting_payment",
  );
  return { ...setup, event };
}

async function endSession(ticketId: string) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE access_tickets
          SET ends_at = now() - interval '1 minute',
              cleaning_ends_at = now() + interval '9 minutes'
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
}

async function markPaidCodeRefunded(setup: Setup) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE payment_intents SET status = 'refunded'
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.tenantId, setup.a.id],
    ),
  );
}

/** A held call may reject or be skipped; only the resulting state counts. */
async function attempt(call: () => Promise<unknown>) {
  try {
    await call();
  } catch {
    // held: asserted through the state
  }
}

/** The worker wakes after the ticket ended (it ends 60 min after seeding). */
const sweepAfterEnd = () => runSweep(world, new Date(Date.now() + 90 * MINUTE));

const returnedOf = (money: IntentMoney) =>
  Math.max(money.refundsIdr, money.parkedIdr);

async function moneyOf(setup: Setup) {
  return {
    a: await moneyOfIntent(world.tenant.tenantId, setup.a.id),
    b: await moneyOfIntent(world.tenant.tenantId, setup.b.id),
  };
}

/** The provider's notices for B reach the consumer, replayed. */
async function deliverNoticesOfB(setup: Setup) {
  for (const event of await paidEventsOf(world.tenant.tenantId, setup.b.id))
    for (let i = 0; i < 2; i += 1) await deliver(world, event);
}

/**
 * Outlet never out of pocket, nobody paid back more than received, no double
 * refund: A and B are each returned at most once and never above `total`; on
 * a cancel A goes back in full, B goes back in full only if the provider held
 * money for it.
 */
function expectMadeWhole(
  label: string,
  money: { a: IntentMoney; b: IntentMoney },
  total: number,
  bHeldMoney: boolean,
) {
  for (const [name, m] of [
    ["A", money.a],
    ["B", money.b],
  ] as const) {
    expect(
      m.refundCount,
      `${label}: ${name} refunded twice`,
    ).toBeLessThanOrEqual(1);
    expect(m.fundCount, `${label}: ${name} parked twice`).toBeLessThanOrEqual(
      1,
    );
    expect(
      returnedOf(m),
      `${label}: ${name} returned above received`,
    ).toBeLessThanOrEqual(total);
  }
  expect(returnedOf(money.a), `${label}: A returned in full`).toBe(total);
  expect(returnedOf(money.b), `${label}: B returned`).toBe(
    bHeldMoney ? total : 0,
  );
}

/**
 * The held state after an unclear provider answer: the order is not
 * cancelled, nothing refunded or parked, and the provider was asked.
 */
async function expectHeld(
  setup: Setup,
  status: "paid" | "awaiting_payment",
  label: string,
) {
  const linked = await linkedOf(world, setup.order.id);
  expect(linked.status, `${label}: order cancelled on an unclear answer`).toBe(
    status,
  );
  expect(linked.cancelledAt).toBeNull();
  expect(await kitchenTicketCount(world, setup.order.id)).toBe(0);
  const money = await moneyOf(setup);
  for (const [name, m] of [
    ["A", money.a],
    ["B", money.b],
  ] as const) {
    expect(m.refundCount, `${label}: ${name} refund requested`).toBe(0);
    expect(m.fundCount, `${label}: ${name} money parked`).toBe(0);
  }
  expect(
    gateway.readsOf(setup.b.id).length,
    `${label}: provider never asked about the other open code`,
  ).toBeGreaterThanOrEqual(1);
}

describe("legend-9sw2w BRK-FIREPROV breakfast local cancel asks the provider first", () => {
  // ---- sweep after the ticket ended (local cancel, ticket dead) -----------
  it("BRK-FIREPROV-01 sweep, provider says the other code is unpaid -> cancels, A refunded once in full, no double refund on replay", async () => {
    const setup = await paidWithOpenCode();
    gateway.script(setup.b.id, { rawStatus: "01" });

    await sweepAfterEnd();
    await sweepAfterEnd();

    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    expect(await kitchenTicketCount(world, setup.order.id)).toBe(0);
    const money = await moneyOf(setup);
    expectMadeWhole("unpaid B", money, setup.total, false);
    expect(money.a.refundCount).toBe(1);
  });

  it("BRK-FIREPROV-02 sweep, provider already holds B's money -> every rupiah (A and B) returned exactly once, replays change nothing", async () => {
    const setup = await paidWithOpenCode();
    gateway.script(setup.b.id, { rawStatus: "00", amountIdr: setup.total });

    await sweepAfterEnd();
    await deliverNoticesOfB(setup);
    await sweepAfterEnd();
    await deliverNoticesOfB(setup);

    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    expectMadeWhole("paid B", await moneyOf(setup), setup.total, true);
    expect(
      gateway.readsOf(setup.b.id).length,
      "provider never asked about the other open code",
    ).toBeGreaterThanOrEqual(1);
  });

  it("BRK-FIREPROV-03 sweep, unclear provider answer -> no cancel, no refund; a clear answer later cancels with one refund", async () => {
    for (const answer of PROVIDER_UNSURE) {
      const setup = await paidWithOpenCode();
      gateway.script(setup.b.id, answer);

      await attempt(sweepAfterEnd);

      await expectHeld(setup, "paid", `sweep ${JSON.stringify(answer)}`);
      gateway.script(setup.b.id, { rawStatus: "01" });
      await sweepAfterEnd();
      await sweepAfterEnd();
      expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
      const money = await moneyOf(setup);
      expectMadeWhole("retry", money, setup.total, false);
      expect(money.a.refundCount).toBe(1);
    }
  });

  // ---- staff "Kirim sekarang" after the ticket ended -----------------------
  it("BRK-FIREPROV-04 staff fire after the ticket ended, unclear provider answer -> not 200, order not cancelled, nothing refunded, nothing in the kitchen", async () => {
    for (const answer of PROVIDER_UNSURE) {
      const setup = await paidWithOpenCode();
      await endSession(setup.ticketId);
      gateway.script(setup.b.id, answer);

      const response = await staffFire(world, setup.order.id);

      expect(response.status, JSON.stringify(response.body)).not.toBe(200);
      await expectHeld(setup, "paid", `staff fire ${JSON.stringify(answer)}`);
      gateway.script(setup.b.id, { rawStatus: "01" });
      await sweepAfterEnd();
      expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    }
  });

  // ---- paid order whose paid code is no longer paid (payment_refunded) ------
  it("BRK-FIREPROV-05 paid code no longer paid, unclear provider answer -> order not cancelled, nothing refunded; a clear answer later cancels, A returned at most once and never above paid", async () => {
    for (const answer of PROVIDER_UNSURE) {
      const setup = await paidWithOpenCode();
      await markPaidCodeRefunded(setup);
      gateway.script(setup.b.id, answer);

      await attempt(() => runSweep(world, new Date()));

      await expectHeld(
        setup,
        "paid",
        `refunded paid code ${JSON.stringify(answer)}`,
      );
      gateway.script(setup.b.id, { rawStatus: "01" });
      await runSweep(world, new Date());
      await runSweep(world, new Date());
      expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
      const money = await moneyOf(setup);
      expect(money.a.refundCount).toBeLessThanOrEqual(1);
      expect(returnedOf(money.a)).toBeLessThanOrEqual(setup.total);
      expect(money.b.refundCount + money.b.fundCount).toBe(0);
    }
  });

  // ---- payment consumer refuses a late payment and cancels -----------------
  it("BRK-FIREPROV-06 consumer, late payment, provider says the other code is unpaid -> cancels, A refunded once in full, replay changes nothing", async () => {
    const setup = await latePayment();
    gateway.script(setup.b.id, { rawStatus: "01" });

    await deliver(world, setup.event);
    await deliver(world, setup.event);

    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    expect(await kitchenTicketCount(world, setup.order.id)).toBe(0);
    const money = await moneyOf(setup);
    expectMadeWhole("late A", money, setup.total, false);
    expect(money.a.refundCount).toBe(1);
  });

  it("BRK-FIREPROV-07 consumer, late payment, provider already holds B's money -> A and B each returned exactly once, replays change nothing", async () => {
    const setup = await latePayment();
    gateway.script(setup.b.id, { rawStatus: "00", amountIdr: setup.total });

    await deliver(world, setup.event);
    await deliverNoticesOfB(setup);
    await deliver(world, setup.event);
    await deliverNoticesOfB(setup);

    expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
    expectMadeWhole("late A, paid B", await moneyOf(setup), setup.total, true);
    expect(
      gateway.readsOf(setup.b.id).length,
      "provider never asked about the other open code",
    ).toBeGreaterThanOrEqual(1);
  });

  it("BRK-FIREPROV-08 consumer, late payment, unclear provider answer -> order not cancelled, B gets no refund; a clear answer later cancels with one refund of A", async () => {
    for (const answer of PROVIDER_UNSURE) {
      const setup = await latePayment();
      gateway.script(setup.b.id, answer);

      await attempt(() => deliver(world, setup.event));

      const linked = await linkedOf(world, setup.order.id);
      expect(
        linked.status,
        `consumer ${JSON.stringify(answer)}: order cancelled on an unclear answer`,
      ).toBe("awaiting_payment");
      const held = await moneyOf(setup);
      expect(held.b.refundCount + held.b.fundCount).toBe(0);
      expect(held.a.refundCount).toBeLessThanOrEqual(1);
      expect(returnedOf(held.a)).toBeLessThanOrEqual(setup.total);
      expect(
        gateway.readsOf(setup.b.id).length,
        "provider never asked about the other open code",
      ).toBeGreaterThanOrEqual(1);

      gateway.script(setup.b.id, { rawStatus: "01" });
      await deliver(world, setup.event);
      await deliver(world, setup.event);
      expect((await linkedOf(world, setup.order.id)).status).toBe("cancelled");
      const money = await moneyOf(setup);
      expectMadeWhole("retry", money, setup.total, false);
      expect(money.a.refundCount).toBe(1);
    }
  });

  // ---- a good payment never waits on the provider --------------------------
  it("BRK-FIREPROV-09 consumer, code A covers the bill in time, unclear provider answer for B -> order paid, no refund, no hold", async () => {
    for (const answer of PROVIDER_UNSURE) {
      const setup = await twoCodes();
      await settle(world, setup.a.id, setup.total);
      const event = await paidEvent(world, setup.a.id);
      gateway.script(setup.b.id, answer);

      await deliver(world, event);
      await deliver(world, event);

      const linked = await linkedOf(world, setup.order.id);
      expect(
        linked.status,
        `consumer ${JSON.stringify(answer)}: good payment waited on the provider`,
      ).toBe("paid");
      expect(linked.cancelledAt).toBeNull();
      const money = await moneyOf(setup);
      for (const [name, m] of [
        ["A", money.a],
        ["B", money.b],
      ] as const) {
        expect(m.refundCount, `${name} refunded`).toBe(0);
        expect(m.fundCount, `${name} parked`).toBe(0);
      }
    }
  });
});
