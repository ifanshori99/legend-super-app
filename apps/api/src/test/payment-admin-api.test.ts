// WS-05 administration through the real HTTP and PostgreSQL boundaries.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { EdcError } from "@starter/shared/edc";
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
const terminalIds: string[] = [];
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
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
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
  // Closing a reconciliation case asks for approval: the tenant needs a policy.
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1, 'reconciliation_case', NULL, id, 1, true
     FROM roles WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId],
  );
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
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
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
    "DELETE FROM payment_cashier_defaults WHERE terminal_id = ANY($1::uuid[])",
    [terminalIds],
  );
  await owner.query(
    "DELETE FROM payment_edc_terminals WHERE id = ANY($1::uuid[])",
    [terminalIds],
  );
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
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = $1",
    [raceIntentId],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = $1",
    [raceIntentId],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [otherTenant, otherIntent],
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

  it("TEN-02 cannot release or re-open another tenant's quarantined refund", async () => {
    const otherRefund = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                    requested_by, approved_by, decided_at, last_payout_error)
       VALUES ($1, $2, $3, $4, 1000, 'Other tenant refund', 'approved', 'seed', 'seed-approver', now(), 'PAYOUT_QUARANTINED')`,
      [otherRefund, otherTenant, otherOutlet, otherIntent],
    );
    for (const action of ["release", "reopen"]) {
      const response = await manager
        .post(`/api/payments/admin/refunds/${otherRefund}/quarantine/${action}`)
        .set(originHeader)
        .send({
          idempotencyKey: `cross-${randomUUID()}`,
          note: "Cross tenant attempt",
        });
      expect([403, 404]).toContain(response.status);
    }
    const { rows } = await owner.query(
      "SELECT status, last_payout_error FROM payment_refunds WHERE id = $1",
      [otherRefund],
    );
    expect(rows[0]).toEqual({
      status: "approved",
      last_payout_error: "PAYOUT_QUARANTINED",
    });
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
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 100000, now())`,
      [tenantId, outletA, raceIntentId, `late-${raceIntentId}`],
    );

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
    await owner.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = $1",
      [raceIntentId],
    );
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
    // The excess is held on its own fund: the bill's refundable amount (40000
    // after the 60000 pending refund above) is untouched (PAY-04).
    const list = await manager.get(
      `/api/payments/admin/refunds/refundable?outletId=${outletA}`,
    );
    expect(
      list.body.data.payments.find(
        (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
      ),
    ).toMatchObject({ refundedAmountIdr: 60000, refundableAmountIdr: 40000 });
    const again = await manager
      .post(`/api/payments/admin/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: `fund-${randomUUID()}`,
        resolution: "refund",
        note: "Second attempt",
      });
    expect(again.status).toBe(409);
    const credit = await manager
      .post(`/api/payments/admin/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: `fund-${randomUUID()}`,
        resolution: "credit",
        note: "Credit not wired",
      });
    expect(credit.status).toBe(503);
  });

  it("PAY-04 late payment cannot refund the same unallocated money as a bill refund", async () => {
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 100000, now())`,
      [tenantId, outletA, raceIntentId, `late-${raceIntentId}`],
    );

    await owner.query(
      `INSERT INTO payment_unallocated_funds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
       VALUES ($1, $2, $3, 40000, 'overpayment')`,
      [tenantId, outletA, raceIntentId],
    );
    const listing = await manager.get(
      `/api/payments/admin/refunds/refundable?outletId=${outletA}`,
    );
    expect(
      listing.body.data.payments.find(
        (p: { paymentIntentId: string }) => p.paymentIntentId === raceIntentId,
      ),
    ).toBeUndefined();
    const response = await manager
      .post("/api/payments/admin/refunds")
      .set(originHeader)
      .send({
        idempotencyKey: `late-refund-${randomUUID()}`,
        paymentIntentId: raceIntentId,
        amountIdr: 1,
        reason: "Late payment refund",
      });
    expect(response.status).toBe(409);
  });

  it("EDC-06 resolving a settlement difference needs a note and only asks for approval", async () => {
    const missing = await manager
      .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `case-${randomUUID()}`)
      .send({ note: "" });
    expect(missing.status).toBe(422);
    const requested = await manager
      .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `case-${randomUUID()}`)
      .send({ note: "Bank fee investigated" });
    expect(requested.status).toBe(200);
    expect(requested.body.data).toMatchObject({
      status: "pending_approval",
      varianceIdr: -10000,
      requestedBy: userIds[0],
      approvedBy: null,
    });
    expect(requested.body.data.approvalRequestId).toEqual(expect.any(String));
    const pending = await owner.query<{ status: string }>(
      `SELECT status FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_reconciliation_case' AND object_id = $2`,
      [tenantId, caseId],
    );
    expect(pending.rows.map((r) => r.status)).toEqual(["pending"]);
    const again = await manager
      .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `case-${randomUUID()}`)
      .send({ note: "Bank fee investigated again" });
    expect(again.status).toBe(409);
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
  it("EDC-07 EDC_TERMINAL_BUSY is a declared EDC reason the UI can check", () => {
    const busy = new EdcError("EDC_TERMINAL_BUSY");
    expect(busy.reason).toBe("EDC_TERMINAL_BUSY");
    expect(busy.code).toBe("CONFLICT");
    expect(busy.message.startsWith("EDC_TERMINAL_BUSY")).toBe(true);
  });
  it("EDC-07 a terminal's identity cannot change while it has an open EDC transaction", async () => {
    // Codex finding 3: an inquiry asks the configured terminal, so swapping
    // TID/MID/IP under an unfinished sale would let the new device's
    // `not_found` allow a second charge.
    const created = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", `edc-${randomUUID()}`)
      .send({
        outletId: outletA,
        bankCode: "bca",
        terminalId: `T-${randomUUID()}`,
        merchantId: "MID-OPEN",
        model: "Busy terminal",
        connection: "lan",
        ipAddress: "10.0.0.5",
        supportedMethods: ["card"],
        status: "active",
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    terminalIds.push(id);
    const txId = randomUUID();
    await owner.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace, dispatched_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-test', 55000, 'card', 'unknown', $7, now())`,
      [
        txId,
        tenantId,
        outletA,
        id,
        `ADM-${txId.slice(0, 8)}`,
        randomUUID(),
        `T${txId.replace(/-/g, "").slice(0, 12)}`,
      ],
    );
    const patch = (body: Record<string, unknown>) =>
      manager
        .patch(`/api/payments/admin/edc/terminals/${id}`)
        .set(originHeader)
        .set("Idempotency-Key", `edc-${randomUUID()}`)
        .send(body);
    try {
      for (const change of [
        { terminalId: `T-${randomUUID()}` },
        { merchantId: "MID-OTHER" },
        { ipAddress: "10.0.0.9" },
        { connection: "usb" },
        { bankCode: "bni" },
      ]) {
        const refused = await patch(change);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain("EDC_TERMINAL_BUSY");
      }
      // Not identity: allowed. Same values re-sent: allowed.
      expect((await patch({ model: "Renamed" })).status).toBe(200);
      expect((await patch({ merchantId: "MID-OPEN" })).status).toBe(200);
      const stored = await owner.query<{ merchant_id: string }>(
        "SELECT merchant_id FROM payment_edc_terminals WHERE id = $1",
        [id],
      );
      expect(stored.rows[0]!.merchant_id).toBe("MID-OPEN");

      // Once the transaction is final the terminal can be replaced.
      await owner.query(
        "UPDATE edc_transactions SET status = 'failed', completed_at = now() WHERE id = $1",
        [txId],
      );
      expect((await patch({ merchantId: "MID-OTHER" })).status).toBe(200);
    } finally {
      await owner.query("DELETE FROM edc_transactions WHERE id = $1", [txId]);
    }
  });
  it("EDC-07 config writes need an Idempotency-Key, replay it and reject reuse", async () => {
    const body = {
      outletId: outletA,
      bankCode: "bni",
      terminalId: `T-${randomUUID()}`,
      merchantId: "MID-BNI",
      model: "Replay terminal",
      connection: "lan",
      ipAddress: "10.0.0.20",
      supportedMethods: ["card"],
      status: "active",
    };
    const noKey = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .send(body);
    expect(noKey.status).toBeGreaterThanOrEqual(400);
    expect(noKey.status).toBeLessThan(500);
    const key = `edc-${randomUUID()}`;
    const first = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);
    terminalIds.push(first.body.data.id);
    const replay = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const reused = await manager
      .post("/api/payments/admin/edc/terminals")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send({ ...body, merchantId: "MID-OTHER" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const rows = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payment_edc_terminals WHERE tenant_id = $1 AND terminal_id = $2",
      [tenantId, body.terminalId],
    );
    expect(rows.rows[0]?.count).toBe("1");
    // Audit + outbox in the same transaction as the write.
    const outbox = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'edc_terminal.created'",
      [tenantId, first.body.data.id],
    );
    expect(outbox.rows[0]?.count).toBe("1");
  });

  it("EDC-07 terminals of two banks coexist in one outlet and route per cashier", async () => {
    const make = async (bankCode: string, supportedMethods: string[]) => {
      const response = await manager
        .post("/api/payments/admin/edc/terminals")
        .set(originHeader)
        .set("Idempotency-Key", `edc-${randomUUID()}`)
        .send({
          outletId: outletA,
          bankCode,
          terminalId: `T-${randomUUID()}`,
          merchantId: `MID-${bankCode}`,
          model: `${bankCode} terminal`,
          connection: "usb",
          ipAddress: null,
          supportedMethods,
          status: "active",
        });
      expect(response.status).toBe(201);
      terminalIds.push(response.body.data.id);
      return response.body.data.id as string;
    };
    const bca = await make("bca", ["card"]);
    const mandiri = await make("mandiri", ["qris"]);
    const listed = await manager.get(
      `/api/payments/admin/edc/terminals?outletId=${outletA}&limit=100`,
    );
    expect(listed.status).toBe(200);
    const banks = listed.body.data
      .filter((t: { id: string }) => t.id === bca || t.id === mandiri)
      .map((t: { bankCode: string }) => t.bankCode)
      .sort();
    expect(banks).toEqual(["bca", "mandiri"]);
    const cashierId = userIds[0]!;
    const put = (terminalId: string, defaultMethod: string) =>
      manager
        .put(`/api/payments/admin/edc/cashier-defaults/${cashierId}`)
        .set(originHeader)
        .set("Idempotency-Key", `cashier-${randomUUID()}`)
        .send({ outletId: outletA, terminalId, defaultMethod });
    // A card default cannot point at the QRIS-only Mandiri terminal.
    expect((await put(mandiri, "edc_card")).status).toBe(400);
    const card = await put(bca, "edc_card");
    expect(card.status).toBe(200);
    expect(card.body.data).toMatchObject({ terminalId: bca });
    const qris = await put(mandiri, "edc_qris");
    expect(qris.status).toBe(200);
    expect(qris.body.data).toMatchObject({
      terminalId: mandiri,
      defaultMethod: "edc_qris",
    });
  });
});
