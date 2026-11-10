// QR pay-first sale guard for gateway refunds (bead legend-xtzpb, tier K / money):
// a paid payment intent I that a fired QR pay-first order already uses (the guest
// paid the QR order through I) must not also be refunded through PAY-04 - the
// guest would get the money back while the kitchen already cooks the order.
//
// Real Express app, Better Auth, services and PostgreSQL. Seeding and request
// helpers are copied from payment-refund-pos-tender-guard.test.ts.
//
// Assumptions where the brief is not exact:
// - A QR sale holds an intent when an orders row has channel 'qr', payment_mode
//   'pay_first', payment_intent_id = I, fired_at NOT NULL and no pos_orders row (a QR-channel order cannot have one).
//   The held amount is total_idr - deposit_applied_idr.
// - Refund requests over HTTP answer 409 { error: { code: REFUND_INTENT_IN_QR_SALE } }.
//   At approve time the refund row ends 'failed' with failure_reason
//   'cap_exceeded' and the gateway is never called; the approve HTTP answer is
//   409 with the same code (same style as the POS tender guard).
// - Q1 depends on the fix: without it the refund is accepted (201).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const ADMIN = "/api/payments/admin";
const GUARD_CODE = "REFUND_INTENT_IN_QR_SALE";

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const app = createApp();
let staff: Staff;
let approver: ReturnType<typeof agent>; // finance + outlet supervisor, never the requester
const approverUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];

const key = (prefix = "qrsale") => `${prefix}-${randomUUID()}`;

/** A paid intent (with evidence) that belongs to no order or reservation. */
async function paidIntent(amountIdr: number): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'qr-sale-guard-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `QG-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        amountIdr,
        `qg-pay-${intentId}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        seededTenantId,
        seededOutletA,
        intentId,
        `evidence-${intentId}`,
        amountIdr,
      ],
    );
  });
  linkIds.push(linkId);
  intentIds.push(intentId);
  return intentId;
}

type QrOrderOptions = {
  totalIdr: number;
  depositAppliedIdr?: number;
  status?: "sent" | "voided" | "draft" | "awaiting_payment";
  paymentMode?: "pay_first" | "open_bill";
  fired?: boolean;
  channel?: "qr" | "pos";
};

/** A raw QR order that points at `intentId` (see the options for its state). */
async function qrOrder(
  intentId: string,
  {
    totalIdr,
    depositAppliedIdr = 0,
    status = "sent",
    paymentMode = "pay_first",
    fired = true,
    channel = "qr",
  }: QrOrderOptions,
): Promise<string> {
  const id = randomUUID();
  orderIds.push(id);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         deposit_applied_idr, status, business_date, placed_at, payment_intent_id, fired_at)
       VALUES ($1, $2, $3, $4, $11, 'dine_in', $5, $6, 0, 0, 0, 0, $6,
         $7, $8, '2026-11-09', now(), $9, CASE WHEN $10::boolean THEN now() ELSE NULL END)`,
      [
        id,
        seededTenantId,
        seededOutletA,
        `QG-${randomUUID().slice(0, 8)}`,
        paymentMode,
        totalIdr,
        depositAppliedIdr,
        status,
        intentId,
        fired,
        channel,
      ],
    );
    // A POS-channel order always has a pos_orders row (the DB ties its channel to the order's).
    if (channel === "pos")
      await client.query(
        `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
         VALUES ($1, $2, $3, 'pos', now(), now())`,
        [id, seededTenantId, seededOutletA],
      );
  });
  return id;
}

const requestRefund = (intentId: string, amountIdr: number) =>
  staff.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian uji pesanan QR",
    });

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    failure_reason: string | null;
  }>(
    "SELECT id, status, amount_idr::text AS amount, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [seededTenantId, intentId],
  );
  return rows;
}

async function refundablePayment(intentId: string) {
  const response = await staff.client.get(
    `${ADMIN}/refunds/refundable?outletId=${seededOutletA}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as
    | {
        paidAmountIdr: number;
        refundedAmountIdr: number;
        refundableAmountIdr: number;
      }
    | undefined;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "QR Sale Guard Owner",
  });
  await verifySessionMfa(staff.email);
  approver = agent(app);
  const approverEmail = await signUp(approver, "QR Sale Guard Finance");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  approverUserIds.push(approverId);
  await verifySessionMfa(approverEmail);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("finance")],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("supervisor"), seededOutletA],
  );
  // One tier for every amount: Finance decides in a single level.
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [seededTenantId, await roleId("finance")],
  );
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  const { rows: refunds } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refunds.map((r) => r.id)],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  // Fired orders may be immutable: skip user triggers in a dedicated
  // transaction so the rest of the cleanup keeps FK checks.
  await asOwner(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [seededTenantId, orderIds],
    );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
  });
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, approverUserIds],
  );
  await owner.end();
});

describe("PAY-04 an intent a fired QR pay-first order uses cannot be refunded", () => {
  it("PAY-04 Q1 a 100000 intent fully used by a fired QR order: refunding 100000 is refused with REFUND_INTENT_IN_QR_SALE and stores nothing", async () => {
    const intentId = await paidIntent(100_000);
    await qrOrder(intentId, { totalIdr: 100_000 });

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);
  });

  it("PAY-04 Q2 a deposit part is not held: total 100000 with 30000 deposit holds 70000 of a 70000 intent, nothing is refundable", async () => {
    const intentId = await paidIntent(70_000);
    await qrOrder(intentId, { totalIdr: 100_000, depositAppliedIdr: 30_000 });

    const response = await requestRefund(intentId, 70_000);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);

    // Assumption: a fully used intent is either listed with 0 refundable or
    // not listed at all; both mean the user cannot refund it.
    expect((await refundablePayment(intentId))?.refundableAmountIdr ?? 0).toBe(
      0,
    );
  });

  it("PAY-04 Q3 an order that uses only 60000 of the intent leaves 40000: 40001 is refused, 40000 is created", async () => {
    const intentId = await paidIntent(100_000);
    await qrOrder(intentId, { totalIdr: 60_000 });

    expect((await refundablePayment(intentId))?.refundableAmountIdr).toBe(
      40_000,
    );
    const over = await requestRefund(intentId, 40_001);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(over.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);

    const ok = await requestRefund(intentId, 40_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe("pending");
  });

  it("PAY-04 Q4 a voided, never fired order (late payment) holds nothing: the intent is refundable in full", async () => {
    const intentId = await paidIntent(100_000);
    await qrOrder(intentId, {
      totalIdr: 100_000,
      status: "voided",
      fired: false,
    });

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe("pending");
    expect(await refundRows(intentId)).toHaveLength(1);
  });

  it("PAY-04 Q5 a pending refund filed before the order is fired cannot be paid out: the refund ends failed with cap_exceeded and the gateway is never called", async () => {
    const intentId = await paidIntent(100_000);
    const orderId = await qrOrder(intentId, {
      totalIdr: 100_000,
      status: "awaiting_payment",
      fired: false,
    });
    const refundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 100000, 'Diajukan sebelum pesanan dikirim', 'pending', $5)`,
      [refundId, seededTenantId, seededOutletA, intentId, staff.userId],
    );
    // The kitchen fires the order after the refund was filed.
    await asOwner(async (client) => {
      await client.query(
        "UPDATE orders SET status = 'sent', fired_at = now() WHERE id = $1",
        [orderId],
      );
    });

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set(originHeader)
        .send({ idempotencyKey: key("apr") });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe(GUARD_CODE);
      expect(await refundRows(intentId)).toEqual([
        expect.objectContaining({
          id: refundId,
          status: "failed",
          failure_reason: "cap_exceeded",
        }),
      ]);
      expect(fake.calls).toHaveLength(0);
    } finally {
      setPaymentRefundGateway(null);
    }
  });

  it("PAY-04 Q6 an open-bill QR order that was never fired holds nothing", async () => {
    const intentId = await paidIntent(100_000);
    await qrOrder(intentId, {
      totalIdr: 100_000,
      status: "draft",
      paymentMode: "open_bill",
      fired: false,
    });

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("PAY-04 Q6 a POS-channel order (has a pos_orders row) naming the intent is not a QR sale: the QR guard does not answer for it", async () => {
    const intentId = await paidIntent(100_000);
    await qrOrder(intentId, { totalIdr: 100_000, channel: "pos" });

    const response = await requestRefund(intentId, 100_000);

    // Assumption: the DB forbids a pos_orders row on a QR-channel order, so
    // "order with a pos_orders row" is tested as a POS-channel order. Without a
    // captured POS tender nothing holds the intent, so the refund is accepted.
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});
