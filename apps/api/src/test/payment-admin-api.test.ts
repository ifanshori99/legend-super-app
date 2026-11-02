// WS-05 administration through the real HTTP and PostgreSQL boundaries.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const linkId = randomUUID();
const intentId = randomUUID();
const fundId = randomUUID();
const raceIntentId = randomUUID();
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const otherLink = randomUUID();
const otherIntent = randomUUID();
const caseId = randomUUID();
const userIds: string[] = [];
let manager: ReturnType<typeof agent>;
let scoped: ReturnType<typeof agent>;

async function signedIn(scope: "tenant" | "outlet") {
  const client = agent(app);
  const email = await signUp(client, `Payment admin ${scope}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      role.rows[0]!.id,
      scope,
      scope === "outlet" ? outletB : null,
    ],
  );
  return client;
}

beforeAll(async () => {
  manager = await signedIn("tenant");
  scoped = await signedIn("outlet");
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, $6)`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `ADMIN-${linkId.slice(0, 6)}`,
      userIds[0],
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, `admin-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [raceIntentId, tenantId, outletA, linkId, `admin-${raceIntentId}`],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[]}', $3, $4)`,
    [
      otherTenant,
      `other-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHER', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
  await owner.query(
    "INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by) VALUES ($1, $2, $3, $4, 'Other', 100000, 100000, 100000, 'seed')",
    [otherLink, otherTenant, otherOutlet, randomBytes(32).toString("hex")],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [otherIntent, otherTenant, otherOutlet, otherLink, `other-${otherIntent}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 120000, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, 20000, 'overpayment')`,
    [fundId, tenantId, outletA, intentId],
  );
  await owner.query(
    `INSERT INTO payment_reconciliation_cases (id, tenant_id, outlet_id, settlement_id, source, provider, reference, period_start, period_end, expected_idr, received_idr, variance_idr, reason)
     VALUES ($1, $2, $3, $4, 'edc', 'edc_bca', 'Batch test', '2026-10-01', '2026-10-01', 100000, 90000, -10000, 'Settlement mismatch')`,
    [caseId, tenantId, outletA, randomUUID()],
  );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = $1",
    [intentId],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = $1",
    [intentId],
  );
  await owner.query("DELETE FROM payment_unallocated_funds WHERE id = $1", [
    fundId,
  ]);
  await owner.query("DELETE FROM payment_reconciliation_cases WHERE id = $1", [
    caseId,
  ]);
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = $1",
    [raceIntentId],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    [intentId, raceIntentId, otherIntent],
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = $1", [otherLink]);
  await owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]);
  await owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]);
  await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query("DELETE FROM payment_links WHERE id = $1", [linkId]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [userIds],
  );
  await owner.end();
});

describe("WS-05 payment administration", () => {
  it("TEN-02 rejects a client-supplied tenant and requires a session", async () => {
    const anonymous = await agent(app).get("/api/payments/admin/refunds");
    expect(anonymous.status).toBe(401);
    const injected = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({
        idempotencyKey: `tenant-${randomUUID()}`,
        paymentIntentId: intentId,
        amountIdr: 1,
        reason: "Test",
        tenantId: randomUUID(),
      });
    expect(injected.status).toBe(422);
  });

  it("TEN-02 cannot refund an intent owned by another tenant", async () => {
    const response = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({
        idempotencyKey: `other-${randomUUID()}`,
        paymentIntentId: otherIntent,
        amountIdr: 1000,
        reason: "Cross tenant",
      });
    expect([403, 404]).toContain(response.status);
  });

  it("TEN-03 denies access to another outlet's payment", async () => {
    const response = await scoped
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({
        idempotencyKey: `scope-${randomUUID()}`,
        paymentIntentId: intentId,
        amountIdr: 1000,
        reason: "Out of scope",
      });
    expect([403, 404]).toContain(response.status);
  });

  it("PAY-04 reserves pending refunds and binds retries to the request fingerprint", async () => {
    const key = `refund-${randomUUID()}`;
    const input = {
      idempotencyKey: key,
      paymentIntentId: intentId,
      amountIdr: 60000,
      reason: "Return",
    };
    const first = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send(input);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe("pending");
    const retry = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send(input);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    const reused = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({ ...input, amountIdr: 50000 });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const over = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({
        ...input,
        idempotencyKey: `over-${randomUUID()}`,
        amountIdr: 40001,
      });
    expect(over.status).toBe(409);
    const list = await manager.get(
      `/api/payments/admin/refunds/refundable?outletId=${outletA}`,
    );
    expect(list.status).toBe(200);
    expect(
      list.body.data.payments.find(
        (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
      ),
    ).toMatchObject({ refundedAmountIdr: 60000, refundableAmountIdr: 40000 });
    const selfApprove = await manager
      .post(`/api/payments/admin/refunds/${first.body.data.id}/approve`)
      .set(originHeader)
      .send({ idempotencyKey: `approve-${randomUUID()}` });
    expect(selfApprove.status).toBe(403);
  });

  it("PAY-04 concurrent refunds cannot reserve more than the paid amount", async () => {
    const responses = await Promise.all(
      [1, 2].map(() =>
        manager
          .post("/api/payments/admin/refunds")
          .set(originHeader)
          .send({
            idempotencyKey: `race-${randomUUID()}`,
            paymentIntentId: raceIntentId,
            amountIdr: 60000,
            reason: "Concurrent refund",
          }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const result = await owner.query<{ total: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds WHERE payment_intent_id = $1 AND status <> 'failed'",
      [raceIntentId],
    );
    expect(result.rows[0]?.total).toBe("60000");
  });

  it("PAY-04 refunding unallocated funds creates a pending approval", async () => {
    const response = await manager
      .post(`/api/payments/admin/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: `fund-${randomUUID()}`,
        resolution: "refund",
        note: "Return excess to guest",
      });
    expect(response.status).toBe(200);
    const refunds = await owner.query<{ status: string; amount_idr: string }>(
      "SELECT status, amount_idr::text FROM payment_refunds WHERE unallocated_fund_id = $1",
      [fundId],
    );
    expect(refunds.rows).toEqual([{ status: "pending", amount_idr: "20000" }]);
  });

  it("EDC-06 resolves a settlement difference only with a note", async () => {
    const missing = await manager
      .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `case-${randomUUID()}`)
      .send({ note: "" });
    expect(missing.status).toBe(422);
    const resolved = await manager
      .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `case-${randomUUID()}`)
      .send({ note: "Bank fee investigated" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "resolved",
      varianceIdr: -10000,
    });
  });

  it("EDC-07 creates a terminal and denies another outlet's administrator", async () => {
    const body = {
      outletId: outletA,
      bankCode: "bca",
      terminalId: `T-${randomUUID()}`,
      merchantId: "MID-1",
      model: "Test terminal",
      connection: "usb",
      ipAddress: null,
      supportedMethods: ["card", "qris"],
      status: "active",
    };
    const denied = await scoped
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", `edc-${randomUUID()}`)
      .send(body);
    expect([403, 404]).toContain(denied.status);
    const created = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", `edc-${randomUUID()}`)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      outletId: outletA,
      bankCode: "bca",
      terminalId: body.terminalId,
    });
    await owner.query("DELETE FROM payment_edc_terminals WHERE id = $1", [
      created.body.data.id,
    ]);
  });
});
