// legend-4n8rs (brief docs/briefs/912-3p1.md, Putaran 3, part A): a VA or QR that
// can still be paid refuses a new code from EVERY path that issues one. A new
// code is issued only after the old one is final or expired at the provider, or
// was released legitimately (payment_va_releases). Refusal is HTTP 409 with the
// same codes the guest path uses: ORDER_CODE_ACTIVE (no bill split) and
// SPLIT_CODE_ACTIVE (a bill split part). A refused call asks the provider for
// nothing, stores no intent, and leaves the old code pending.
//
// Written from the brief and the public payment contract, not from the code.
//
// Setups:
//   A. POS bill with a public link (token). The first code is a VA issued
//      through the token itself; a VA has no QRIS hold, so the only possible
//      reason for a refusal is the active code rule.
//   B. Breakfast order token, a QRIS code issued through the token.
//   C. Order recovery charge payment, a QRIS code issued by the first attempt.
//   D. Guest split bill: part codes.
//
// Assumptions:
// - Code of refusal: body.error.code is exactly ORDER_CODE_ACTIVE for token,
//   refresh, breakfast and recovery charge (link without a part); exactly
//   SPLIT_CODE_ACTIVE for a bill split part.
// - "Final at the provider" = status expired and provider_final_at set.
// - "Lapsed VA, not final" = status expired, expires_at long past, no
//   provider_final_at: it is still live (a VA stays live until the provider
//   says it is final) until a payment_va_releases row exists for it.
// - Idempotency replay (same key, same body) answers 2xx with the same intent,
//   never 409, and asks the provider for nothing.
// - D: every part of a guest split bill sits on the order's one payment link.
//   A bill-level code is a payment_intents row on that link with
//   bill_split_id NULL.
// - Cashier (POS tender) and breakfast refresh are not covered here: the
//   cashier path is owned by the tender flow, covered by the existing POS tests.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-912-4n8rs-active-code.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import {
  asOwnerTenant,
  createBreakfastWorld,
  endPools,
  newMember,
  payLink,
  placeOrder as placeBreakfastOrder,
  seedTicket,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  CountingGateway,
  bindLinkToOrder,
  expectRefusal,
  intentCount,
  intentRow,
  intentsOnLink,
  qrisBody,
  seedLiveCode,
  vaBody,
} from "./qr-va-912-3p1-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const tenantsToClose: string[] = [];

/** The code is final at the provider: expired and provider_final_at set. */
async function makeFinal(tenantId: string, intentId: string) {
  await owner.query(
    `UPDATE payment_intents
        SET status = 'expired', provider_final_at = now(),
            expires_at = now() - interval '10 minutes'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId],
  );
}

// ------------------------------------------------------- A. POS bill token

describe("legend-4n8rs A: public token of a POS bill with an active VA code", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-4n8rs-a");
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  /** A bill with its token and one VA code issued through the token (201). */
  async function billWithVa() {
    const order = await newSubmittedOrder(fx, 0);
    const { token, linkId } = await bindLinkToOrder(fx, order);
    const first = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(vaBody());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    return { order, token, linkId, intentId: first.body.data.id as string };
  }

  it("legend-4n8rs POST links/:token/intents is refused 409 ORDER_CODE_ACTIVE while the old code can still be paid: no provider call, no new intent, old code pending", async () => {
    const { token, linkId, intentId } = await billWithVa();
    const tenantId = fx.tenant.tenantId;
    const created = fx.gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, intentId);
    expect(before.status).toBe("pending");

    // The same choice with a new key stays refused: nothing is voided, nothing
    // is asked from the provider.
    const refused = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(vaBody());
    expectRefusal(refused, "ORDER_CODE_ACTIVE");
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentsOnLink(tenantId, linkId)).toEqual([intentId]);
    expect(
      await intentRow(tenantId, intentId),
      "the old code is left pending",
    ).toEqual(before);

    // A different choice is the guest changing method (founder Q15, legend-9vmit):
    // the old code is voided first (released row, no staff), then one new code
    // is issued. The old code can no longer settle the bill: late money parks.
    const swapped = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(await intentCount(tenantId), "exactly one new intent").toBe(
      intents + 1,
    );
    expect((await intentRow(tenantId, intentId)).status).toBe("expired");
    const { rows: releases } = await owner.query<{ kind: string }>(
      "SELECT kind FROM payment_va_releases WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, intentId],
    );
    expect(releases.map((r) => r.kind)).toEqual(["guest_method_change"]);
    const replacement = (await intentsOnLink(tenantId, linkId)).filter(
      (id) => id !== intentId,
    );
    expect(replacement, "one live replacement code").toHaveLength(1);
  });

  it("legend-4n8rs POST links/:token/intents/:intentId/refresh is refused 409 ORDER_CODE_ACTIVE while another code on the link can still be paid", async () => {
    const { order, token, linkId, intentId } = await billWithVa();
    const tenantId = fx.tenant.tenantId;
    // A local expired code without a provider reference: what a guest refreshes.
    const expiredId = randomUUID();
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'expired', $7::jsonb,
               now() - interval '20 minutes')`,
      [
        expiredId,
        tenantId,
        fx.tenant.outletId,
        linkId,
        order.totalIdr,
        `r3p1-${expiredId}`,
        JSON.stringify({
          method: "qris",
          qrPayload: "00020101021226OLDQR",
          issuer: null,
        }),
      ],
    );
    const created = fx.gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, intentId);

    const refused = await agent(fx.app).post(
      `/api/payments/links/${token}/intents/${expiredId}/refresh`,
    );
    expectRefusal(refused, "ORDER_CODE_ACTIVE");
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentRow(tenantId, intentId)).toEqual(before);
  });

  it("legend-4n8rs control: the old code is expired and final at the provider, a new code is issued 201", async () => {
    const { token, intentId } = await billWithVa();
    const tenantId = fx.tenant.tenantId;
    await makeFinal(tenantId, intentId);
    const created = fx.gateway.requests.length;

    const issued = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(fx.gateway.requests.length).toBe(created + 1);
    expect(issued.body.data.id).not.toBe(intentId);
  });

  it("legend-4n8rs control: a lapsed VA that the provider has not finalised still blocks; once it is released legitimately a new code is issued 201", async () => {
    const { order, token, intentId } = await billWithVa();
    const tenantId = fx.tenant.tenantId;
    await owner.query(
      `UPDATE payment_intents
          SET status = 'expired', expires_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, intentId],
    );
    const created = fx.gateway.requests.length;

    const blocked = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expectRefusal(blocked, "ORDER_CODE_ACTIVE");
    expect(fx.gateway.requests.length).toBe(created);

    await asOwnerTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO payment_va_releases
           (tenant_id, id, outlet_id, payment_intent_id, order_id, reason, released_by,
            approved_by, override_id, status, attempts, next_check_at, last_provider_status)
         VALUES ($1, $2, $3, $4, $5, 'Bank tidak menjawab status VA', 'seed-staff',
                 'seed-manager', $6, 'open', 0, now() + interval '1 day', NULL)`,
        [
          tenantId,
          randomUUID(),
          fx.tenant.outletId,
          intentId,
          ulidToUuid(order.id),
          randomUUID(),
        ],
      ),
    );

    const issued = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(fx.gateway.requests.length).toBe(created + 1);
  });

  it("legend-4n8rs control: the same request replayed (same idempotency key) answers 2xx with the same intent, never 409, and asks the provider for nothing", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const { token } = await bindLinkToOrder(fx, order);
    const key = randomUUID();
    const first = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(vaBody(key));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const created = fx.gateway.requests.length;
    const intents = await intentCount(fx.tenant.tenantId);

    const replay = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(vaBody(key));
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(fx.gateway.requests.length).toBe(created);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });
});

// ------------------------------------------- A2. failed code with parked money

describe("legend-4n8rs A2: public token, failed code that is not final and has parked money", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-4n8rs-a2");
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  /** 409 with body.error.code FUNDS_UNRESOLVED (parked money owed back first). */
  function expectFundsUnresolved(response: { status: number; body: unknown }) {
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    const error = (response.body as { error?: { code?: string } }).error;
    expect(error?.code, JSON.stringify(response.body)).toBe("FUNDS_UNRESOLVED");
  }

  /**
   * A bill with its token, and a code on its link that is status failed with a
   * provider reference and no provider_final_at (the provider may still take
   * money on it), plus an open parked fund (resolved_at null) on that code.
   */
  async function billWithFailedCodeAndFunds() {
    const order = await newSubmittedOrder(fx, 0);
    const { token, linkId } = await bindLinkToOrder(fx, order);
    const tenantId = fx.tenant.tenantId;
    const intentId = await asOwnerTenant(tenantId, (client) =>
      seedLiveCode(client, {
        tenantId,
        outletId: fx.tenant.outletId,
        linkId,
        amountIdr: order.totalIdr,
        method: "qris",
      }),
    );
    await owner.query(
      `UPDATE payment_intents SET status = 'failed'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, intentId],
    );
    await owner.query(
      `INSERT INTO payment_unallocated_funds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 10000, 'overpayment')`,
      [randomUUID(), tenantId, fx.tenant.outletId, intentId],
    );
    return { order, token, linkId, intentId };
  }

  it("legend-4n8rs POST links/:token/intents is refused 409 FUNDS_UNRESOLVED while a failed, not-final code has open parked money: no provider call, no new intent", async () => {
    const { token, linkId, intentId } = await billWithFailedCodeAndFunds();
    const tenantId = fx.tenant.tenantId;
    const created = fx.gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, intentId);

    for (const body of [vaBody(), qrisBody()]) {
      const refused = await agent(fx.app)
        .post(`/api/payments/links/${token}/intents`)
        .send(body);
      expectFundsUnresolved(refused);
    }
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentsOnLink(tenantId, linkId)).toEqual([intentId]);
    expect(await intentRow(tenantId, intentId)).toEqual(before);
  });

  it("legend-4n8rs POST links/:token/intents/:intentId/refresh is refused 409 FUNDS_UNRESOLVED while a failed, not-final code on the link has open parked money", async () => {
    const { order, token, linkId, intentId } =
      await billWithFailedCodeAndFunds();
    const tenantId = fx.tenant.tenantId;
    // A local expired code without a provider reference: what a guest refreshes.
    const expiredId = randomUUID();
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'expired', $7::jsonb,
               now() - interval '20 minutes')`,
      [
        expiredId,
        tenantId,
        fx.tenant.outletId,
        linkId,
        order.totalIdr,
        `r3b-${expiredId}`,
        JSON.stringify({
          method: "qris",
          qrPayload: "00020101021226OLDQR",
          issuer: null,
        }),
      ],
    );
    const created = fx.gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, intentId);

    const refused = await agent(fx.app).post(
      `/api/payments/links/${token}/intents/${expiredId}/refresh`,
    );
    expectFundsUnresolved(refused);
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentRow(tenantId, intentId)).toEqual(before);
  });

  it("legend-4n8rs control: the parked money is resolved and the failed code is final at the provider, a new code is issued 201", async () => {
    const { token, intentId } = await billWithFailedCodeAndFunds();
    const tenantId = fx.tenant.tenantId;
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution = 'refund', resolved_by = 'test', resolved_at = now()
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenantId, intentId],
    );
    await owner.query(
      `UPDATE payment_intents SET provider_final_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, intentId],
    );
    const created = fx.gateway.requests.length;

    const issued = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(fx.gateway.requests.length).toBe(created + 1);
    expect(issued.body.data.id).not.toBe(intentId);
  });
});

// ------------------------------------------------------- B. breakfast token

describe("legend-4n8rs B: breakfast order token with an active code", () => {
  let app: Express;
  let world: BreakfastWorld;
  let gateway: CountingGateway;
  beforeAll(async () => {
    app = createApp();
    world = await createBreakfastWorld(app);
    tenantsToClose.push(world.tenant.tenantId);
    gateway = new CountingGateway();
    setPaymentGateway(gateway);
  }, 180_000);
  afterAll(() => {
    setPaymentGateway(null);
  });

  const issue = (token: string) =>
    agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .set(world.headers)
      .send(qrisBody());

  async function token() {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const order = await placeBreakfastOrder(world, member, ticketId);
    return payLink(world, member, ticketId, order.id);
  }

  it("legend-4n8rs breakfast token: a second code while the first can still be paid is refused 409 ORDER_CODE_ACTIVE: no provider call, no new intent, first code pending", async () => {
    const t = await token();
    const first = await issue(t);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body.data.id as string;
    const tenantId = world.tenant.tenantId;
    const created = gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, firstId);

    const refused = await issue(t);
    expectRefusal(refused, "ORDER_CODE_ACTIVE");
    expect(gateway.requests.length).toBe(created);
    expect(gateway.cancels, "no cancel sent for the old code").toEqual([]);
    expect(await intentCount(tenantId)).toBe(intents);
    expect(await intentRow(tenantId, firstId)).toEqual(before);
  });

  it("legend-4n8rs control: breakfast first code expired and final, a new code is issued 201", async () => {
    const t = await token();
    const first = await issue(t);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await makeFinal(world.tenant.tenantId, first.body.data.id as string);
    const created = gateway.requests.length;

    const next = await issue(t);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(gateway.requests.length).toBe(created + 1);
  });
});

// -------------------------------------------------- C. order recovery charge

describe("legend-4n8rs C: order recovery charge payment with an active code", () => {
  let w: World;
  let gateway: CountingGateway;
  const DIFFERENCE = PRICES.kopi - PRICES.roti;
  beforeAll(async () => {
    w = await createWorld();
    tenantsToClose.push(w.tenant.tenantId);
    gateway = new CountingGateway();
    setPaymentGateway(gateway);
  }, 180_000);

  const context = (): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );

  /** A paid order whose roti was swapped for kopi, with its charge opened. */
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
    const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!
      .event;
    const ctx = context();
    await withTenant(db, ctx, async (tx) => {
      await deliverSwapKitchenEvent(ctx, event, tx);
      await deliverIssueChargeEvent(ctx, event, tx);
    });
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [w.tenant.tenantId, issueId],
    );
    expect(rows).toHaveLength(1);
    return { guest: order.guest, chargeId: rows[0]!.id, issueId };
  }

  function payCharge(
    guest: Guest,
    chargeId: string,
    method: "qris" | "va" = "qris",
  ) {
    return agent(w.app)
      .post(
        `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
      )
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .send({
        method,
        ...(method === "va" ? { bankCode: "bmri" } : {}),
        idempotencyKey: randomUUID(),
      });
  }

  async function chargeIntent(issueId: string) {
    const { rows } = await owner.query<{ payment_intent_id: string | null }>(
      `SELECT payment_intent_id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [w.tenant.tenantId, issueId],
    );
    return rows[0]!.payment_intent_id;
  }

  // The same method again returns the pending code (a deliberate replay of the
  // choice); another method while that code can still be paid is refused.
  it("legend-4n8rs recovery charge: paying again with the SAME method returns the same pending code 201: no provider call, no new intent", async () => {
    const { guest, chargeId, issueId } = await openCharge();
    const tenantId = w.tenant.tenantId;
    const first = await payCharge(guest, chargeId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body.data.id as string;
    const created = gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, firstId);

    const again = await payCharge(guest, chargeId);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).toBe(firstId);
    expect(gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentRow(tenantId, firstId)).toEqual(before);
    expect(await chargeIntent(issueId)).toBe(firstId);
  });

  it("legend-4n8rs recovery charge: a DIFFERENT method while the first code can still be paid is refused 409 ORDER_CODE_ACTIVE: no provider call, no new intent, first code pending, charge keeps it", async () => {
    const { guest, chargeId, issueId } = await openCharge();
    const tenantId = w.tenant.tenantId;
    const first = await payCharge(guest, chargeId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body.data.id as string;
    const created = gateway.requests.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, firstId);
    const linked = await chargeIntent(issueId);
    expect(linked).toBe(firstId);

    const refused = await payCharge(guest, chargeId, "va");
    expectRefusal(refused, "ORDER_CODE_ACTIVE");
    expect(gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentRow(tenantId, firstId)).toEqual(before);
    expect(await chargeIntent(issueId), "charge keeps its first code").toBe(
      firstId,
    );
  });

  it("legend-4n8rs control: recovery charge first code expired and final, a new code is issued 201", async () => {
    const { guest, chargeId } = await openCharge();
    const first = await payCharge(guest, chargeId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await makeFinal(w.tenant.tenantId, first.body.data.id as string);
    const created = gateway.requests.length;

    const next = await payCharge(guest, chargeId);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(gateway.requests.length).toBe(created + 1);
  });
});

// ------------------------------------------------------ D. guest split parts

/** A guest order cut into two equal parts. */
async function splitBillOf(fx: HoldFixture) {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  return { guest, order, parts };
}

describe("legend-4n8rs D: guest split bill, part codes", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-4n8rs-d");
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  const payPart = (
    guest: Awaited<ReturnType<typeof splitBillOf>>["guest"],
    partId: string,
    method: "qris" | "va",
  ) =>
    fx.guestPost(guest, "/payments", {
      target: { kind: "split", billSplitId: partId },
      method,
      payerSecret: secretFor(partId),
      ...(method === "va" ? { bankCode: "bmri" } : {}),
      idempotencyKey: randomUUID(),
    });

  it("legend-4n8rs split part asks another code while its own VA can still be paid: the guest changes method (Q15), old VA voided with a released row, one new code", async () => {
    const { guest, parts } = await splitBillOf(fx);
    const part = parts[0]!;
    const va = await payPart(guest, part.id, "va");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const vaId = va.body.data.id as string;
    const tenantId = fx.tenant.tenantId;
    const intents = await intentCount(tenantId);

    const swapped = await payPart(guest, part.id, "qris");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(swapped.body.data.target).toMatchObject({
      kind: "split",
      billSplitId: part.id,
    });
    expect(await intentCount(tenantId), "exactly one new intent").toBe(
      intents + 1,
    );
    expect((await intentRow(tenantId, vaId)).status).toBe("expired");
    const { rows: releases } = await owner.query<{ kind: string }>(
      "SELECT kind FROM payment_va_releases WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, vaId],
    );
    expect(releases.map((r) => r.kind)).toEqual(["guest_method_change"]);
  });

  it("legend-4n8rs a code of another part does not block this part: its QR is issued 201", async () => {
    const { guest, parts } = await splitBillOf(fx);
    const first = await payPart(guest, parts[0]!.id, "va");
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const other = await payPart(guest, parts[1]!.id, "qris");
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.data.target).toMatchObject({
      kind: "split",
      billSplitId: parts[1]!.id,
    });
    expect(
      (await intentRow(fx.tenant.tenantId, first.body.data.id)).status,
    ).toBe("pending");
  });

  it("legend-4n8rs a bill-level active code (no bill split) on the order's link blocks a part: 409 SPLIT_CODE_ACTIVE, no new intent", async () => {
    const { guest, order, parts } = await splitBillOf(fx);
    const tenantId = fx.tenant.tenantId;
    // Part 0 gets a VA only to learn the order's link; part 1 stays untouched.
    const first = await payPart(guest, parts[0]!.id, "va");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const { rows } = await owner.query<{ payment_link_id: string }>(
      "SELECT payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.body.data.id],
    );
    const linkId = rows[0]!.payment_link_id;
    await asOwnerTenant(tenantId, (client) =>
      seedLiveCode(client, {
        tenantId,
        outletId: fx.tenant.outletId,
        linkId,
        amountIdr: order.totalIdr,
        method: "va",
        billSplitId: null,
      }),
    );
    const created = fx.gateway.requests.length;
    const intents = await intentCount(tenantId);

    const refused = await payPart(guest, parts[1]!.id, "qris");
    expectRefusal(refused, "SPLIT_CODE_ACTIVE");
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
  });
});

// One cleanup for the whole file: the pools are shared by the setups.
afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // Audit rows are append-only, so these tenants stay; give them a valid creator.
  for (const id of tenantsToClose)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      id,
      randomUUID(),
    ]);
  await endPools();
});
