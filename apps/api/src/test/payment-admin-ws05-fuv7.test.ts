// WS-05 / legend-fuv7: unallocated funds and routing contract gaps, plus the
// money guarantee that one fund is resolved once (PRD §3.13, PAY-04).
// Written from the shared payment contract, not from the services.
//
// Assumptions (spec is silent):
// - `reason` is the fund's origin: 'overpayment' | 'double_payment' (the
//   values the existing column already takes).
// - `approvalRef` is null while a fund is open (also after a refund was
//   requested) and equals the refund id once that refund completes.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  paymentRoutingSchema,
  unallocatedFundsSchema,
} from "@starter/shared/payment";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const linkIds: string[] = [];
const intentIds: string[] = [];
const userIds: string[] = [];
let managerOne: ReturnType<typeof agent>;
let managerTwo: ReturnType<typeof agent>;

async function tenantManager(label: string) {
  const client = agent(app);
  const email = await signUp(client, `Fuv7 ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  // valid_from is stamped by the database clock but checked against the API
  // clock; the test DB (Colima VM) can run ahead of the API, so back-date the
  // grant by an hour (as payment-admin-multi-fund does), not a minute. A grant
  // still in the API's future answers 403/404 on the outlet list.
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, role.rows[0]!.id],
  );
  return client;
}

/** A paid 100000 bill that received 120000: 20000 sits in one open fund. */
async function seedFund(
  reason: "overpayment" | "double_payment" = "overpayment",
) {
  const intentId = randomUUID();
  const fundId = randomUUID();
  const linkId = randomUUID();
  intentIds.push(intentId);
  linkIds.push(linkId);
  // One bill per fund: a bill's funds must add up to what arrived minus applied.
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, $6)`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `FUV7-${linkId.slice(0, 6)}`,
      userIds[0],
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, `fuv7-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 120000, now())`,
    [tenantId, outletA, intentId, `fuv7-evidence-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, 20000, $5)`,
    [fundId, tenantId, outletA, intentId, reason],
  );
  return { intentId, fundId };
}

const resolvePath = (fundId: string) =>
  `/api/payments/admin/unallocated-funds/${fundId}/resolve`;

type FundRow = {
  id: string;
  reason?: string;
  approvalRef?: string | null;
  status: string;
  resolution: string | null;
};
async function listFunds(
  client: ReturnType<typeof agent>,
  status: "open" | "resolved",
) {
  const response = await client.get(
    `/api/payments/admin/unallocated-funds?outletId=${outletA}&status=${status}&limit=100`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as FundRow[];
}

beforeAll(async () => {
  managerOne = await tenantManager("one");
  managerTwo = await tenantManager("two");
});

afterEach(() => {
  setPaymentRefundGateway(null);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [userIds],
  );
  await owner.end();
});

describe("WS-05 fuv7 contract: unallocated funds carry reason and approvalRef", () => {
  const base = {
    id: randomUUID(),
    tenantId,
    outletId: outletA,
    paymentIntentId: randomUUID(),
    amountIdr: 20000,
    resolution: null,
    resolvedBy: null,
  };

  it("PAY-04 the fund contract accepts a reason and an approval reference", () => {
    const parsed = unallocatedFundsSchema.safeParse({
      ...base,
      reason: "overpayment",
      approvalRef: null,
    });
    expect(parsed.success).toBe(true);
    const resolved = unallocatedFundsSchema.safeParse({
      ...base,
      reason: "double_payment",
      resolution: "refund",
      resolvedBy: randomUUID(),
      approvalRef: "APR-0001",
    });
    expect(resolved.success).toBe(true);
    if (resolved.success)
      expect(resolved.data).toMatchObject({
        reason: "double_payment",
        approvalRef: "APR-0001",
      });
  });

  it("PAY-04 the fund contract refuses a reason outside overpayment or double payment", () => {
    const parsed = unallocatedFundsSchema.safeParse({
      ...base,
      reason: "because",
      approvalRef: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("PAY-04 an open fund shows its reason and no approval yet", async () => {
    const { fundId } = await seedFund("double_payment");
    const fund = (await listFunds(managerOne, "open")).find(
      (f) => f.id === fundId,
    );
    expect(fund).toBeDefined();
    expect(fund?.reason).toBe("double_payment");
    expect(fund?.approvalRef).toBeNull();
  });

  it("PAY-04 resolving by refund keeps the fund open without approval until the refund completes, then records the refund as its approval and keeps the reason", async () => {
    // Established design (payment-refund-default-tier / -approval tests): the
    // request only files a refund. The fund stays open (resolution null,
    // approvalRef null) until the money has actually left; completion sets
    // approvalRef to the refund id. Completion is reached the way finance
    // would: the payout is exhausted and a second owner settles it by hand
    // (payment-refund-manual-settle.test.ts).
    const { fundId } = await seedFund("overpayment");
    const response = await managerOne
      .post(resolvePath(fundId))
      .set(originHeader)
      .send({
        idempotencyKey: `fuv7-${randomUUID()}`,
        resolution: "refund",
        note: "Return excess to guest",
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: fundId,
      status: "open",
      resolution: null,
      approvalRef: null,
      reason: "overpayment",
    });
    const stillOpen = (await listFunds(managerOne, "open")).find(
      (f) => f.id === fundId,
    );
    expect(stillOpen).toMatchObject({
      reason: "overpayment",
      approvalRef: null,
      resolution: null,
    });
    expect(
      (await listFunds(managerOne, "resolved")).some((f) => f.id === fundId),
    ).toBe(false);

    const refunds = await owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    expect(refunds.rows).toHaveLength(1);
    const refundId = refunds.rows[0]!.id;

    // legend-980: a refund is settleable by hand only when the provider answers
    // `failed`; any other answer is refused as uncertain (409).
    const fake = new FakeRefundGateway();
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: "PR-DECLINED",
      code: "declined",
    });
    setPaymentRefundGateway(fake);

    // Bring the refund to the settleable state (approved by a third person,
    // payout exhausted), then a second owner settles it by hand.
    await tenantManager("approver");
    const approverId = userIds[userIds.length - 1]!;
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'approved', approved_by = $3, decided_at = now(),
              payout_attempts = 8, last_payout_error = 'MANUAL_RECONCILIATION',
              payout_claimed_until = NULL, payout_claim_token = NULL,
              created_at = now() - interval '3 hours', updated_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId, approverId],
    );
    const settled = await managerTwo
      .post(`/api/payments/admin/refunds/${refundId}/settle-manually`)
      .set(originHeader)
      .send({
        idempotencyKey: `fuv7-settle-${randomUUID()}`,
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        channel: "bank_transfer",
        externalReference: `TRX-${randomUUID().slice(0, 8)}`,
        amountIdr: 20_000,
        note: "Paid by hand to the guest",
      });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.data).toMatchObject({
      id: refundId,
      status: "completed",
    });

    const resolved = (await listFunds(managerOne, "resolved")).find(
      (f) => f.id === fundId,
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "refund",
      reason: "overpayment",
      approvalRef: refundId,
    });
    expect(
      (await listFunds(managerOne, "open")).some((f) => f.id === fundId),
    ).toBe(false);
  });

  it("PAY-04 resolving an unknown fund is refused and a session is required", async () => {
    const missing = await managerOne
      .post(resolvePath(randomUUID()))
      .set(originHeader)
      .send({
        idempotencyKey: `fuv7-${randomUUID()}`,
        resolution: "refund",
        note: "No such fund",
      });
    expect(missing.status).toBe(404);
    const anonymous = await agent(app)
      .post(resolvePath(randomUUID()))
      .set(originHeader)
      .send({
        idempotencyKey: `fuv7-${randomUUID()}`,
        resolution: "refund",
        note: "Anonymous",
      });
    expect(anonymous.status).toBe(401);
  });
});

describe("WS-05 fuv7 contract: tenant default routing has no outlet", () => {
  it("PRD 3.13 the routing record accepts a null outlet for the tenant default", () => {
    const parsed = paymentRoutingSchema.safeParse({
      id: randomUUID(),
      tenantId,
      outletId: null,
      method: "qris",
      provider: "doit",
      fallbackProvider: null,
      enabled: true,
    });
    expect(parsed.success).toBe(true);
    const outletRule = paymentRoutingSchema.safeParse({
      id: randomUUID(),
      tenantId,
      outletId: outletA,
      method: "qris",
      provider: "doit",
      fallbackProvider: null,
      enabled: true,
    });
    expect(outletRule.success).toBe(true);
  });

  it("PRD 3.13 the tenant routing screen is the tenant scope with no outlet", async () => {
    const response = await managerOne.get("/api/payments/admin/routing");
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe("tenant");
    expect(response.body.data.outletId).toBeNull();
    for (const route of response.body.data.routes as {
      outletId: string | null;
    }[])
      expect(route.outletId).toBeNull();
  });
});

describe("WS-05 fuv7 money: one fund is resolved once", () => {
  const countRefunds = async (fundId: string) => {
    const { rows } = await owner.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(amount_idr), 0)::text AS total
         FROM payment_refunds WHERE unallocated_fund_id = $1 AND status <> 'failed'`,
      [fundId],
    );
    return { count: Number(rows[0]!.n), total: Number(rows[0]!.total) };
  };

  it("PAY-04 two connections resolving one fund with different keys: one succeeds, the rest conflict", async () => {
    const { fundId, intentId } = await seedFund();
    const send = (client: ReturnType<typeof agent>) =>
      client
        .post(resolvePath(fundId))
        .set(originHeader)
        .send({
          idempotencyKey: `race-${randomUUID()}`,
          resolution: "refund",
          note: "Parallel resolve",
        });
    const responses = await Promise.all([
      send(managerOne),
      send(managerTwo),
      send(managerOne),
      send(managerTwo),
    ]);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    // Money: at most the fund's 20000 is on its way out, and never more than
    // the 100000 bill plus the fund can cover.
    const { count, total } = await countRefunds(fundId);
    expect(count).toBe(1);
    expect(total).toBeLessThanOrEqual(20000);
    const { rows } = await owner.query<{ total: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds WHERE payment_intent_id = $1 AND status <> 'failed'",
      [intentId],
    );
    expect(Number(rows[0]!.total)).toBeLessThanOrEqual(20000);
  });

  it("PAY-04 the same idempotency key sent on two connections still creates one refund", async () => {
    const { fundId } = await seedFund();
    const body = {
      idempotencyKey: `same-${randomUUID()}`,
      resolution: "refund",
      note: "Same key twice",
    };
    const responses = await Promise.all(
      [managerOne, managerTwo].map((client) =>
        client.post(resolvePath(fundId)).set(originHeader).send(body),
      ),
    );
    for (const response of responses) expect(response.status).toBeLessThan(500);
    expect(responses.some((r) => r.status === 200)).toBe(true);
    const { count, total } = await countRefunds(fundId);
    expect(count).toBe(1);
    expect(total).toBeLessThanOrEqual(20000);
  });

  it("PAY-04 a resolved fund cannot be resolved again, again", async () => {
    const { fundId } = await seedFund();
    const first = await managerOne
      .post(resolvePath(fundId))
      .set(originHeader)
      .send({
        idempotencyKey: `once-${randomUUID()}`,
        resolution: "refund",
        note: "First",
      });
    expect(first.status).toBe(200);
    // Refund again: conflict. Credit is not wired yet (503 today); it must
    // either conflict or stay unavailable, never succeed on a handled fund.
    const accepted = { refund: [409], credit: [409, 503] } as const;
    for (const resolution of ["refund", "credit"] as const) {
      const again = await managerTwo
        .post(resolvePath(fundId))
        .set(originHeader)
        .send({
          idempotencyKey: `once-${randomUUID()}`,
          resolution,
          note: "Again",
        });
      expect(accepted[resolution]).toContain(again.status);
    }
    const { count } = await countRefunds(fundId);
    expect(count).toBe(1);
  });
});
