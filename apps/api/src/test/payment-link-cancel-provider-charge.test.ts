// legend-ukbq3, call sites: closing a swap charge (`order_issue_charges`) closes
// its payment link: staff waive / expire routes and the forced close of the
// table session (order-recovery-charge-staff, order-recovery-charge). The
// cashier collect call site is in payment-link-cancel-provider-charge-pos.
// FAIL-FIRST: today the close turns the guest's pending intent `expired`
// LOCALLY without asking the provider.
//
// Written from docs/briefs/ukbq3-payment-link-cancel.md (founder Q93 rules) and
// the public HTTP contract, not from the close implementation. Pattern of
// order-issue-charge-cancelled-link.test.ts (legend-i83ls), but with the
// provider already holding the guest's money BEFORE the close.
//
// Assumptions where the brief is silent:
// - "Provider already holds the money" = the status read answers raw "00".
//   Waive/expire may then (a) refuse (409, charge stays open, the notice pays
//   it), (b) apply the payment (charge paid by the guest's intent, exactly one
//   `order_issue.charge_paid`, no refund) or (c) close the charge and park /
//   refund the money once. Closing the intent locally as expired is not
//   accepted. The forced session close always succeeds (a table must be
//   closable), so only the intent and the money are asserted there.
// - "Unsure" = status read timeout, 5xx or another reference (design): the
//   staff close answers 409 PAYMENT_PROVIDER_UNCONFIRMED (charge stays `open`,
//   link and intent open, no refund, nothing parked).
//   The session close under an unsure provider is not tested (the brief does
//   not say whether a table may close while a charge cannot).
// - Control: provider says expired and the QR is long past its life -> waive
//   closes the charge as before.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  PROVIDER_UNSURE,
  backdateIntentExpiry,
  expectIntentOpen,
  expectLinkActive,
  expectLinkClosed,
  expectMoneyOnce,
  expectNoMoneyMoved,
  expectUnconfirmedResponse,
  installScriptedGateway,
  intentInfo,
  moneyOfIntent,
  paidEventsOf,
  providerWebhook,
  type ScriptedGateway,
} from "./payment-link-cancel-provider-helpers.ts";

let w: World;
let gateway: ScriptedGateway;

beforeAll(async () => {
  w = await createWorld();
  gateway = installScriptedGateway();
}, 120_000);

afterAll(async () => {
  setPaymentGateway(null);
  await w.teardown();
});

const DIFFERENCE = PRICES.kopi - PRICES.roti;
const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  return { ...order, issueId, charge: await chargeOf(issueId) };
}

type ChargeRow = {
  id: string;
  status: string;
  payment_link_id: string | null;
  payment_intent_id: string | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, status, payment_link_id, payment_intent_id
       FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function guestPay(guest: Guest, chargeId: string) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

/** The guest holds a live QR for the charge; the provider has not said anything yet. */
async function guestHoldsCode() {
  const opened = await openCharge();
  const created = await guestPay(opened.guest, opened.charge.id);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const intentId = created.body.data.id as string;
  expect((await intentInfo(w.tenant.tenantId, intentId)).status).toBe(
    "pending",
  );
  return { ...opened, intentId };
}
type Held = Awaited<ReturnType<typeof guestHoldsCode>>;

const providerHasPaid = (held: Held) =>
  gateway.script(held.intentId, { rawStatus: "00", amountIdr: AMOUNT });

function staffClose(held: Held, action: "waive" | "expire") {
  return w.staffPost(
    w.supervisor,
    `/api/order-issue-charges/${held.charge.id}/${action}`,
    { reason: "Tamu komplain lama menunggu" },
  );
}

function forceCloseSession(held: Held) {
  return w.staffPost(
    w.floorStaff,
    `/api/table-sessions/${held.guest.sessionId}/close`,
    { tableCleaned: false, waiterConfirmedEmpty: true },
  );
}

/** The provider's payment reaches the payment consumer, replayed. */
async function deliverNotices(held: Held) {
  await payLocally(held);
  await deliverEvents(held);
}

/** The verified webhook is recorded; the worker has not consumed it yet. */
async function payLocally(held: Held) {
  await providerWebhook(
    contextOf(w.tenant.tenantId),
    w.tenant.tenantId,
    held.intentId,
    AMOUNT,
  );
}

async function deliverEvents(held: Held) {
  const context = contextOf(w.tenant.tenantId);
  for (const event of await paidEventsOf(w.tenant.tenantId, held.intentId))
    for (let i = 0; i < 2; i += 1)
      await withTenant(db, context, (tx) =>
        deliverOrderPaymentEvent(context, event, tx),
      );
}

/** Money accounted once, the charge is paid at most once. */
async function expectOutcomeOnce(held: Held, label: string) {
  const row = await chargeOf(held.issueId);
  const applied =
    row.status === "paid" && row.payment_intent_id === held.intentId;
  expectMoneyOnce(
    label,
    await moneyOfIntent(w.tenant.tenantId, held.intentId),
    AMOUNT,
    applied,
  );
  const paidEvents = await w.outboxRows(
    "order_issue.charge_paid",
    held.issueId,
  );
  expect(paidEvents, `${label}: charge_paid count`).toHaveLength(
    applied ? 1 : 0,
  );
  return row;
}

describe("legend-ukbq3 staff waive / expire follow the provider", () => {
  for (const action of ["waive", "expire"] as const) {
    it(`ukbq3-charge-paid: ${action} while the provider already got the guest's money -> QR not closed locally, money applied or returned once`, async () => {
      const held = await guestHoldsCode();
      providerHasPaid(held);

      const closed = await staffClose(held, action);
      expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(500);

      expect(
        gateway.readsOf(held.intentId).length,
        "close never asked the provider",
      ).toBeGreaterThanOrEqual(1);
      await expectIntentOpen(
        w.tenant.tenantId,
        held.intentId,
        `${action} with the money at the provider`,
      );

      await deliverNotices(held);
      await expectOutcomeOnce(held, `${action} then notice`);
    });
  }

  it("ukbq3-charge-paid: waive pressed again and the notice replayed -> still one disposal of the money", async () => {
    const held = await guestHoldsCode();
    providerHasPaid(held);

    await staffClose(held, "waive");
    await deliverNotices(held);
    await staffClose(held, "waive");
    await staffClose(held, "expire");
    await deliverNotices(held);

    await expectOutcomeOnce(held, "repeated waive");
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`ukbq3-charge-unsure: provider answer ${JSON.stringify(answer)} -> waive and expire answer 409 PAYMENT_PROVIDER_UNCONFIRMED: charge, link and QR stay open, no refund`, async () => {
      const held = await guestHoldsCode();
      await backdateIntentExpiry(w.tenant.tenantId, held.intentId);
      gateway.script(held.intentId, answer);

      for (const action of ["waive", "expire"] as const)
        expectUnconfirmedResponse(
          await staffClose(held, action),
          `${action} with an unsure provider`,
        );

      expect(
        gateway.readsOf(held.intentId).length,
        "close never asked the provider",
      ).toBeGreaterThanOrEqual(1);
      await expectLinkActive(
        w.tenant.tenantId,
        held.intentId,
        "unsure provider",
      );
      expect((await chargeOf(held.issueId)).status).toBe("open");
      expect((await intentInfo(w.tenant.tenantId, held.intentId)).status).toBe(
        "pending",
      );
      expectNoMoneyMoved(
        "unsure provider",
        await moneyOfIntent(w.tenant.tenantId, held.intentId),
      );
    });
  }

  it("ukbq3-charge-expired: provider says expired and the QR is long past its life -> waive closes the charge, nothing is owed", async () => {
    const held = await guestHoldsCode();
    await backdateIntentExpiry(w.tenant.tenantId, held.intentId);
    gateway.script(held.intentId, { rawStatus: "02" });

    const closed = await staffClose(held, "waive");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(gateway.readsOf(held.intentId).length).toBeGreaterThanOrEqual(1);
    // The link is closed; the gateway code past its expiry stays `pending` on
    // purpose (the poller may still settle a late payment).
    await expectLinkClosed(
      w.tenant.tenantId,
      held.intentId,
      "provider expired",
    );
    expect((await chargeOf(held.issueId)).status).toBe("waived");
    expectNoMoneyMoved(
      "provider expired",
      await moneyOfIntent(w.tenant.tenantId, held.intentId),
    );
  });

  it("ukbq3-charge-empty: nobody opened a QR -> waive closes at once without asking the provider", async () => {
    const opened = await openCharge();
    const readsBefore = gateway.statusReads.length;

    const closed = await staffClose(opened as unknown as Held, "waive");

    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await chargeOf(opened.issueId)).status).toBe("waived");
    expect(gateway.statusReads).toHaveLength(readsBefore);
  });
});

describe("legend-ukbq3 forced close of the table session follows the provider", () => {
  it("ukbq3-charge-session-paid: forced close while the provider already got the money -> QR not closed locally, money applied or returned once", async () => {
    const held = await guestHoldsCode();
    providerHasPaid(held);

    const closed = await forceCloseSession(held);
    // A table must stay closable by staff.
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(500);

    expect(
      gateway.readsOf(held.intentId).length,
      "session close never asked the provider",
    ).toBeGreaterThanOrEqual(1);
    await expectIntentOpen(
      w.tenant.tenantId,
      held.intentId,
      "session close with the money at the provider",
    );

    await deliverNotices(held);
    await expectOutcomeOnce(held, "session close then notice");
  });
});

// Review 1 (finding 2): `payment.paid` is applied by the worker through the
// outbox. While the intent is already paid but the charge is still `open`,
// closing it would let the consumer refund the whole payment as "late". The
// close must wait (409, no refund), then the consumer applies the payment once.
describe("legend-ukbq3 intent paid but the worker has not applied it yet", () => {
  async function paidNotConsumed() {
    const held = await guestHoldsCode();
    providerHasPaid(held);
    await payLocally(held);
    expect((await intentInfo(w.tenant.tenantId, held.intentId)).status).toBe(
      "paid",
    );
    expect((await chargeOf(held.issueId)).status).toBe("open");
    return held;
  }

  async function expectWaiting(held: Held, label: string) {
    expect((await chargeOf(held.issueId)).status, label).toBe("open");
    expectNoMoneyMoved(
      label,
      await moneyOfIntent(w.tenant.tenantId, held.intentId),
    );
    expect(
      await w.outboxRows("order_issue.charge_paid", held.issueId),
      `${label}: charge_paid before the consumer ran`,
    ).toHaveLength(0);
  }

  async function consumerPaysOnce(held: Held) {
    await deliverEvents(held);
    const row = await chargeOf(held.issueId);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBe(held.intentId);
    await expectOutcomeOnce(held, "consumer applies the payment");
  }

  for (const action of ["waive", "expire"] as const)
    it(`ukbq3-charge-paid-unconsumed: ${action} -> 409, charge stays open, no refund; the consumer then pays it once`, async () => {
      const held = await paidNotConsumed();

      const closed = await staffClose(held, action);
      expect(closed.status, JSON.stringify(closed.body)).toBe(409);
      await expectWaiting(held, `${action} while paid but unconsumed`);
      // Retry after the 409 must not slip through either.
      expect((await staffClose(held, action)).status).toBe(409);
      await expectWaiting(held, `${action} retried`);

      await consumerPaysOnce(held);
    });

  it("ukbq3-charge-paid-unconsumed: forced session close -> 409, charge stays open, no refund; the consumer then pays it once", async () => {
    const held = await paidNotConsumed();

    const closed = await forceCloseSession(held);
    expect(closed.status, JSON.stringify(closed.body)).toBe(409);
    await expectWaiting(held, "session close while paid but unconsumed");

    await consumerPaysOnce(held);
  });
});
