// Founder Q63 / brief 523: authority is capped by the cumulative refund of a
// bill, including earlier refunds and other payment intents of that bill.
// Real HTTP, roles, approval matrix, PostgreSQL and payout service; only the
// external provider is replaced by the existing idempotent fake gateway.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { outletContext } from "../services/device-pin-support";
import {
  openRefundChainAtRequest,
  runRefundPayout,
} from "../services/payment-refund.service";
import { seedTenantRoleTemplates } from "../services/access.service";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const otherOutletId = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const ADMIN = "/api/payments/admin";
type Client = ReturnType<typeof agent>;
type Level = "supervisor" | "outlet_manager" | "general_manager" | "owner";
const LIMITS = [
  { level: "supervisor", limit: 200_000 },
  { level: "outlet_manager", limit: 1_000_000 },
  { level: "general_manager", limit: 5_000_000 },
] as const;
const users: string[] = [];
const links: string[] = [];
const intents: string[] = [];
const refunds: string[] = [];
const orders: string[] = [];
const mappedKeys: string[] = [];
const approvers = new Map<Level, { client: Client; id: string }>();
let requester: Client;
let requesterId: string;
let savedPolicies: Record<string, unknown>[] = [];
let gateway: FakeRefundGateway;
const key = () => `q63-${randomUUID()}`;

async function roleId(level: string) {
  const result = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, level],
  );
  if (!result.rows[0]) throw new Error(`Missing role ${level}`);
  return result.rows[0].id;
}

async function grant(
  userId: string,
  level: string,
  scope: string | null = null,
  expired = false,
) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $6::timestamptz, $2)`,
    [
      tenantId,
      userId,
      await roleId(level),
      scope === null ? "tenant" : "outlet",
      scope,
      expired ? new Date(Date.now() - 60_000) : null,
    ],
  );
}

async function user(label: string) {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  users.push(id);
  await verifySessionMfa(email);
  return { client, id };
}

async function policy(level: string, step = 1) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, $3)`,
    [tenantId, await roleId(level), step],
  );
}

async function seedBill(amounts: number[]) {
  const linkId = randomUUID();
  links.push(linkId);
  const paid = amounts.reduce((total, amount) => total + amount, 0);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [
      linkId,
      tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `Q63-${linkId.slice(0, 8)}`,
      paid,
      requesterId,
    ],
  );
  const billIntents: string[] = [];
  for (const amount of amounts) {
    const id = randomUUID();
    intents.push(id);
    billIntents.push(id);
    await owner.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [id, tenantId, outletId, linkId, amount, key()],
    );
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [tenantId, outletId, id, `evidence-${id}`, amount],
    );
  }
  return { linkId, intentIds: billIntents, paid };
}

async function request(intentId: string, amountIdr: number) {
  const response = await requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key(),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian pesanan untuk batas persetujuan",
    });
  expect(response.status).toBe(201);
  expect(response.body.data.status).toBe("pending");
  const id = response.body.data.id as string;
  refunds.push(id);
  return id;
}

async function openChain(id: string) {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  const context = outletContext(tenant, outletId);
  await withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(eq(paymentRefunds.tenantId, tenantId), eq(paymentRefunds.id, id)),
      );
    if (!refund) throw new Error("Missing refund");
    await openRefundChainAtRequest(tx, context, refund, new Date());
  });
  const result = await owner.query<{ id: string }>(
    "SELECT id FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2 AND status = 'pending' ORDER BY level",
    [tenantId, id],
  );
  return result.rows[0]!.id;
}

async function seedPosOrder(intentIds: string[], amountIdr: number) {
  const orderId = randomUUID();
  orders.push(orderId);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
       'completed', '2026-11-11', now())`,
    [orderId, tenantId, outletId, `Q63-${orderId.slice(0, 8)}`, amountIdr],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
     VALUES ($1, $2, $3, 'pos', now(), now())`,
    [orderId, tenantId, outletId],
  );
  await owner.query(
    "UPDATE payment_intents SET order_id = $2 WHERE id = ANY($1::uuid[])",
    [intentIds, orderId],
  );
  return orderId;
}

async function nativeRefund(
  orderId: string,
  amountIdr: number,
  method: string,
  lines: { method: string; amountIdr: number; reference: null }[] = [
    { method, amountIdr, reference: null },
  ],
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_order_refunds (id, tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
       lines, requested_by, approved_by, approval_request_id, refunded_at)
     VALUES ($1, $2, $3, $4, $5, 'customer_cancelled', 'Riwayat pengembalian POS', $6::jsonb,
       'q63-old-cashier', 'q63-old-approver', $7, now())`,
    [
      id,
      tenantId,
      outletId,
      orderId,
      amountIdr,
      JSON.stringify(lines),
      randomUUID(),
    ],
  );
  return id;
}

/**
 * A cash void already recorded for a POS order (brief 532b P3): the cash tender
 * and the pos_order_voids row both carry Rp`cashIdr`. The order was also paid
 * by the QRIS bill, so total cash out stays within what was paid.
 */
async function materializedCashVoid(orderId: string, cashIdr: number) {
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
       amount_idr, status, reference, requested_at, resolved_at, received_idr, change_idr)
     VALUES ($1, $2, $3, 'cash', 'manual', $4, 'captured', $5, now(), now(), $4, 0)`,
    [tenantId, outletId, orderId, cashIdr, `Q63-VOID-${orderId}`],
  );
  await owner.query(
    `INSERT INTO pos_order_voids (tenant_id, outlet_id, order_id, receipt_number, amount_idr,
       reason, reason_note, requested_by, approved_by, approval_request_id, voided_at)
     VALUES ($1, $2, $3, $4, $5, 'customer_cancelled', 'Void tunai sudah terjadi',
       'q63-old-cashier', 'q63-old-approver', $6, now())`,
    [
      tenantId,
      outletId,
      orderId,
      `Q63V-${orderId.slice(0, 8)}`,
      cashIdr,
      randomUUID(),
    ],
  );
}

async function rawRefund(
  intentId: string,
  amountIdr: number,
  status: "pending" | "completed",
  requestedBy = requesterId,
) {
  const id = randomUUID();
  refunds.push(id);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
       requested_by, approved_by, decided_at, completed_at, provider_ref)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dari modul pesanan', $6, $7,
       $8, $9, $9, $10)`,
    [
      id,
      tenantId,
      outletId,
      intentId,
      amountIdr,
      status,
      requestedBy,
      status === "completed" ? approvers.get("supervisor")!.id : null,
      status === "completed" ? new Date() : null,
      status === "completed" ? `prior-${id}` : null,
    ],
  );
  return id;
}

async function mapNativeGateway(
  posRefundId: string,
  intentId: string,
  refundId: string,
) {
  const mappedKey = `pos-refund-gateway:${posRefundId}:${intentId}`;
  mappedKeys.push(mappedKey);
  await owner.query(
    `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [tenantId, mappedKey, "a".repeat(64), JSON.stringify({ refundId })],
  );
}

async function decideInbox(refundId: string) {
  const requestId = await openChain(refundId);
  return approvers
    .get("supervisor")!
    .client.post(`/api/approvals/${requestId}/decisions`)
    .set(originHeader)
    .set("Idempotency-Key", key())
    .send({ decision: "approved", reason: "Bukti pengembalian sesuai" });
}

const approve = (client: Client, id: string, idempotencyKey = key()) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey });

async function refundState(id: string) {
  const result = await owner.query<{ status: string; payout_attempts: number }>(
    "SELECT status, payout_attempts FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return result.rows[0]!;
}

function paidOut() {
  return gateway.calls.reduce((total, call) => total + call.amountIdr, 0);
}

beforeAll(async () => {
  const requesting = await user("Q63 requester");
  requester = requesting.client;
  requesterId = requesting.id;
  await grant(requesterId, "owner");
  for (const level of [
    "supervisor",
    "outlet_manager",
    "general_manager",
    "owner",
  ] as const) {
    const actor = await user(`Q63 ${level}`);
    // Finance permits the payment admin endpoint and is the matrix's role.
    // The named operational role is what sets the monetary ceiling.
    await grant(actor.id, "finance");
    await grant(
      actor.id,
      level,
      level === "supervisor" || level === "outlet_manager" ? outletId : null,
    );
    approvers.set(level, actor);
  }
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await policy("finance");
});

beforeEach(() => {
  gateway = new FakeRefundGateway();
  setPaymentRefundGateway(gateway);
});
afterEach(() => setPaymentRefundGateway(null));

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = ANY($2::text[])",
    [tenantId, refunds],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intents,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    links,
  ]);
  await owner.query(
    "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = ANY($2::text[])",
    [tenantId, mappedKeys],
  );
  const cleanup = await owner.connect();
  try {
    await cleanup.query("BEGIN");
    await cleanup.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "pos_order_voids",
      "pos_order_tenders",
      "pos_order_refunds",
      "pos_orders",
    ]) {
      await cleanup.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
        [tenantId, orders],
      );
    }
    await cleanup.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
    await cleanup.query("COMMIT");
  } catch (error) {
    await cleanup.query("ROLLBACK");
    throw error;
  } finally {
    cleanup.release();
  }
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
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
    [tenantId, users],
  );
  await owner.end();
});

describe("PAY-04 Q63 server refund approval ceilings", () => {
  for (const { level, limit } of LIMITS) {
    it(`${level} approves exactly Rp${limit} once, with no payout above captured money`, async () => {
      const bill = await seedBill([limit]);
      const id = await request(bill.intentIds[0]!, limit);
      const actor = approvers.get(level)!;
      const idempotencyKey = key();
      const response = await approve(actor.client, id, idempotencyKey);
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("completed");
      expect((await approve(actor.client, id, idempotencyKey)).status).toBe(
        200,
      );
      expect((await approve(actor.client, id)).status).toBe(200);
      expect(gateway.executionCount).toBe(1);
      expect(paidOut()).toBe(limit);
      expect(bill.paid - paidOut()).toBe(0);
    });

    it(`${level} refuses Rp1 over Rp${limit} before any provider payout`, async () => {
      const bill = await seedBill([limit + 1]);
      const id = await request(bill.intentIds[0]!, limit + 1);
      const response = await approve(approvers.get(level)!.client, id);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect((await refundState(id)).status).toBe("pending");
      expect((await refundState(id)).payout_attempts).toBe(0);
      expect(gateway.calls).toHaveLength(0);
      expect(paidOut()).toBe(0);
      expect(bill.paid - paidOut()).toBe(bill.paid);
    });

    it(`${level} cannot split a refund across payment intents to exceed Rp${limit} cumulatively`, async () => {
      const firstAmount = Math.floor(limit / 2);
      const bill = await seedBill([limit, limit]);
      const first = await request(bill.intentIds[0]!, firstAmount);
      expect((await approve(approvers.get(level)!.client, first)).status).toBe(
        200,
      );
      expect((await refundState(first)).status).toBe("completed");
      const second = await request(bill.intentIds[1]!, limit - firstAmount + 1);
      const refused = await approve(approvers.get(level)!.client, second);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect((await refundState(second)).status).toBe("pending");
      expect(gateway.executionCount).toBe(1);
      expect(paidOut()).toBe(firstAmount);
      expect(bill.paid - paidOut()).toBeGreaterThanOrEqual(0);
    });
  }

  it("parallel approvals for two intents of one bill never jointly exceed the supervisor ceiling", async () => {
    const amount = 150_001;
    const bill = await seedBill([amount, amount]);
    const ids = await Promise.all(
      bill.intentIds.map((id) => request(id, amount)),
    );
    const responses = await Promise.all(
      ids.map((id) => approve(approvers.get("supervisor")!.client, id)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 403,
    ]);
    expect(
      responses.find((response) => response.status === 403)!.body.error.code,
    ).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(gateway.executionCount).toBe(1);
    expect(paidOut()).toBe(amount);
    expect(bill.paid - paidOut()).toBe(amount);
    const states = await Promise.all(ids.map(refundState));
    expect(states.map((row) => row.status).sort()).toEqual([
      "completed",
      "pending",
    ]);
  });

  it("the generic approval inbox refuses Rp1 above the supervisor ceiling without recording approval", async () => {
    const bill = await seedBill([200_001]);
    const id = await request(bill.intentIds[0]!, 200_001);
    const requestId = await openChain(id);
    const response = await approvers
      .get("supervisor")!
      .client.post(`/api/approvals/${requestId}/decisions`)
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ decision: "approved", reason: "Bukti pengembalian sesuai" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    const stored = await owner.query<{
      status: string;
      decided_by: string | null;
    }>("SELECT status, decided_by FROM approval_requests WHERE id = $1", [
      requestId,
    ]);
    expect(stored.rows).toEqual([{ status: "pending", decided_by: null }]);
    expect((await refundState(id)).status).toBe("pending");
    expect(gateway.calls).toHaveLength(0);
  });

  it("a two-level chain refuses its final manager approver above Rp1.000.000", async () => {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    );
    await policy("finance", 1);
    await policy("outlet_manager", 2);
    try {
      const bill = await seedBill([1_000_001]);
      const id = await request(bill.intentIds[0]!, 1_000_001);
      const first = await approve(approvers.get("owner")!.client, id);
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("pending");
      const second = await approve(approvers.get("outlet_manager")!.client, id);
      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect((await refundState(id)).status).toBe("pending");
      const decisions = await owner.query<{ level: number; status: string }>(
        "SELECT level, status FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2 ORDER BY level",
        [tenantId, id],
      );
      expect(decisions.rows).toEqual([
        { level: 1, status: "approved" },
        { level: 2, status: "pending" },
      ]);
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await owner.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
        [tenantId],
      );
      await policy("finance");
    }
  });

  it("a provider-pending approved refund counts before a second refund can be approved", async () => {
    gateway.enqueue("pending");
    const bill = await seedBill([200_001]);
    const first = await request(bill.intentIds[0]!, 100_000);
    expect(
      (await approve(approvers.get("supervisor")!.client, first)).status,
    ).toBe(200);
    expect((await refundState(first)).status).toBe("approved");
    const second = await request(bill.intentIds[0]!, 100_001);
    const refused = await approve(approvers.get("supervisor")!.client, second);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect((await refundState(second)).status).toBe("pending");
    expect(gateway.executionCount).toBe(1);
    expect(paidOut()).toBe(100_000);
    expect(bill.paid - paidOut()).toBe(100_001);
  });

  it("a legacy approved refund above the supervisor ceiling is held before the first payout", async () => {
    const bill = await seedBill([200_001]);
    const id = randomUUID();
    refunds.push(id);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, approved_by, decided_at)
       VALUES ($1, $2, $3, $4, 200001, 'Persetujuan sebelum batas nominal', 'approved', $5, $6, now())`,
      [
        id,
        tenantId,
        outletId,
        bill.intentIds[0],
        requesterId,
        approvers.get("supervisor")!.id,
      ],
    );
    const context = outletContext(
      establishTenantContext({ tenantId, brandId: null, source: "job" }),
      outletId,
    );
    await runRefundPayout(context, id);
    const stored = await owner.query<{
      status: string;
      payout_attempts: number;
      last_payout_error: string | null;
    }>(
      "SELECT status, payout_attempts, last_payout_error FROM payment_refunds WHERE id = $1",
      [id],
    );
    expect(stored.rows).toEqual([
      {
        status: "approved",
        payout_attempts: 0,
        last_payout_error: "PAYOUT_QUARANTINED",
      },
    ]);
    expect(gateway.calls).toHaveLength(0);
    expect(bill.paid - paidOut()).toBe(bill.paid);
  });

  it("a custom role copying refund permissions does not invent monetary approval authority", async () => {
    const actor = await user("Q63 custom approver");
    await grant(actor.id, "finance");
    const customRoleId = randomUUID();
    try {
      await owner.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, $3, false, '["pos.refund.approve","payment.reconcile","approval.inbox.view","approval.request.decide"]', '["outlet"]')`,
        [customRoleId, tenantId, `Q63 custom ${customRoleId}`],
      );
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [tenantId, actor.id, customRoleId, outletId],
      );
      const bill = await seedBill([1]);
      const id = await request(bill.intentIds[0]!, 1);
      const refused = await approve(actor.client, id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect((await refundState(id)).status).toBe("pending");
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await owner.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
        [tenantId, customRoleId],
      );
      await owner.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [
        tenantId,
        customRoleId,
      ]);
    }
  });

  it("refunds on distinct payment links of one order share the supervisor ceiling", async () => {
    const firstBill = await seedBill([150_000]);
    const secondBill = await seedBill([150_000]);
    const orderId = randomUUID();
    orders.push(orderId);
    await owner.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 300000, 0, 0, 0, 0, 300000,
         'completed', '2026-11-11', now())`,
      [orderId, tenantId, outletId, `Q63-${orderId.slice(0, 8)}`],
    );
    await owner.query(
      "UPDATE payment_intents SET order_id = $2 WHERE id = ANY($1::uuid[])",
      [[firstBill.intentIds[0], secondBill.intentIds[0]], orderId],
    );
    const priorId = randomUUID();
    const currentId = randomUUID();
    refunds.push(priorId, currentId);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
         requested_by, approved_by, decided_at, completed_at, provider_ref)
       VALUES ($1, $2, $3, $4, 100000, 'Pengembalian pesanan sebelumnya', 'completed', $5, $6, now(), now(), $7)`,
      [
        priorId,
        tenantId,
        outletId,
        firstBill.intentIds[0],
        requesterId,
        approvers.get("supervisor")!.id,
        `prior-${priorId}`,
      ],
    );
    // Order-owned refunds are created by their owning module, rather than
    // payment-admin creation; these raw rows model its persisted history.
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 100001, 'Pengembalian pesanan yang sama', 'pending', $5)`,
      [currentId, tenantId, outletId, secondBill.intentIds[0], requesterId],
    );
    const requestId = await openChain(currentId);
    const response = await approvers
      .get("supervisor")!
      .client.post(`/api/approvals/${requestId}/decisions`)
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ decision: "approved", reason: "Bukti pengembalian sesuai" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect((await refundState(currentId)).status).toBe("pending");
    const decision = await owner.query<{ status: string }>(
      "SELECT status FROM approval_requests WHERE id = $1",
      [requestId],
    );
    expect(decision.rows).toEqual([{ status: "pending" }]);
    expect(gateway.calls).toHaveLength(0);
    expect(firstBill.paid + secondBill.paid - 100_000 - paidOut()).toBe(
      200_000,
    );
  });

  for (const { level, limit } of LIMITS) {
    it(`the actual default supervisor matrix permits ${level} at Rp${limit} when they also hold its required supervisor role`, async () => {
      const actor = approvers.get(level)!;
      await owner.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
        [tenantId],
      );
      const context = outletContext(
        establishTenantContext({ tenantId, brandId: null, source: "session" }),
        outletId,
      );
      await withTenant(db, context, (tx) =>
        seedTenantRoleTemplates(tx, tenantId),
      );
      if (level !== "supervisor") await grant(actor.id, "supervisor", outletId);
      try {
        const bill = await seedBill([limit]);
        const id = await request(bill.intentIds[0]!, limit);
        const response = await approve(actor.client, id);
        expect(response.status).toBe(200);
        expect(response.body.data.status).toBe("completed");
        expect(gateway.executionCount).toBe(1);
        expect(paidOut()).toBe(limit);
        expect(bill.paid - paidOut()).toBe(0);
      } finally {
        if (level !== "supervisor")
          await owner.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3",
            [tenantId, actor.id, await roleId("supervisor")],
          );
        await owner.query(
          "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
          [tenantId],
        );
        await policy("finance");
      }
    });
  }

  for (const method of ["cash", "edc_card"]) {
    it(`a previous native POS ${method} refund counts toward the next WS-05 approval`, async () => {
      const bill = await seedBill([300_000]);
      const orderId = await seedPosOrder(bill.intentIds, bill.paid);
      await nativeRefund(orderId, 100_000, method);
      const id = await rawRefund(bill.intentIds[0]!, 100_001, "pending");
      const response = await decideInbox(id);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect((await refundState(id)).status).toBe("pending");
      expect(gateway.calls).toHaveLength(0);
      expect(bill.paid - 100_000 - paidOut()).toBe(200_000);
    });
  }

  // Brief 532b P3: the cash a POS void paid out is cash out of the bill, so it
  // uses up the approver's cumulative ceiling like any refund. Total cash out
  // stays within the Rp300.000 paid (150k voided cash + at most 100k refund).
  it("Rp150.000 cash already voided counts toward the next WS-05 approval: a Supervisor cannot approve Rp100.001 more", async () => {
    const bill = await seedBill([300_000]);
    const orderId = await seedPosOrder(bill.intentIds, bill.paid);
    await materializedCashVoid(orderId, 150_000);
    const id = await rawRefund(bill.intentIds[0]!, 100_001, "pending");
    const response = await decideInbox(id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect((await refundState(id)).status).toBe("pending");
    expect(gateway.calls).toHaveLength(0);
  });

  it("Rp150.000 cash already voided leaves exactly Rp50.000 for a Supervisor to approve", async () => {
    const bill = await seedBill([300_000]);
    const orderId = await seedPosOrder(bill.intentIds, bill.paid);
    await materializedCashVoid(orderId, 150_000);
    const id = await rawRefund(bill.intentIds[0]!, 50_000, "pending");
    const response = await decideInbox(id);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("approved");
    expect(150_000 + 50_000).toBeLessThanOrEqual(bill.paid);
  });

  it("a prior native QRIS refund and its completed gateway mirror count only once", async () => {
    const bill = await seedBill([300_000]);
    const orderId = await seedPosOrder(bill.intentIds, bill.paid);
    const nativeId = await nativeRefund(orderId, 50_000, "qris");
    const prior = await rawRefund(
      bill.intentIds[0]!,
      50_000,
      "completed",
      "system:pos",
    );
    await mapNativeGateway(nativeId, bill.intentIds[0]!, prior);
    const current = await rawRefund(bill.intentIds[0]!, 150_000, "pending");
    const response = await decideInbox(current);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("approved");
    expect(gateway.calls).toHaveLength(0);
    expect(bill.paid - 50_000 - 150_000).toBe(100_000);
  });

  it("the current native QRIS origin and its pending WS-05 gateway refund count once at exactly Rp200.000", async () => {
    const bill = await seedBill([300_000]);
    const orderId = await seedPosOrder(bill.intentIds, bill.paid);
    const nativeId = await nativeRefund(orderId, 200_000, "qris");
    const current = await rawRefund(
      bill.intentIds[0]!,
      200_000,
      "pending",
      "system:pos",
    );
    await mapNativeGateway(nativeId, bill.intentIds[0]!, current);
    const response = await decideInbox(current);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("approved");
    expect(gateway.calls).toHaveLength(0);
    expect(bill.paid - 200_000).toBe(100_000);
  });

  it("a legacy mapped gateway payout counts its native origin even when native refundedAt is later than its decision", async () => {
    const bill = await seedBill([400_000]);
    const orderId = await seedPosOrder(bill.intentIds, bill.paid);
    const nativeId = await nativeRefund(orderId, 300_000, "qris", [
      { method: "cash", amountIdr: 200_000, reference: null },
      { method: "qris", amountIdr: 100_000, reference: null },
    ]);
    const current = randomUUID();
    refunds.push(current);
    // A legacy/fact-time decision can predate the source POS refund timestamp.
    // Its gateway share alone is 100k, but it authorizes a 300k native refund.
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
         requested_by, approved_by, decided_at, created_at)
       VALUES ($1, $2, $3, $4, 100000, 'Payout bagian QRIS pengembalian POS', 'approved',
         'system:pos', $5, now() - interval '1 second', now() - interval '2 seconds')`,
      [
        current,
        tenantId,
        outletId,
        bill.intentIds[0],
        approvers.get("supervisor")!.id,
      ],
    );
    await mapNativeGateway(nativeId, bill.intentIds[0]!, current);
    const context = outletContext(
      establishTenantContext({ tenantId, brandId: null, source: "job" }),
      outletId,
    );
    await runRefundPayout(context, current);
    const stored = await owner.query<{
      status: string;
      payout_attempts: number;
      last_payout_error: string | null;
    }>(
      "SELECT status, payout_attempts, last_payout_error FROM payment_refunds WHERE id = $1",
      [current],
    );
    expect(stored.rows).toEqual([
      {
        status: "approved",
        payout_attempts: 0,
        last_payout_error: "PAYOUT_QUARANTINED",
      },
    ]);
    expect(gateway.calls).toHaveLength(0);
    expect(bill.paid - 200_000 - paidOut()).toBe(200_000);
  });

  it("approval clocks across intents preserve an earlier valid supervisor payout after a later owner approval", async () => {
    const bill = await seedBill([300_000, 300_000]);
    const prior = await rawRefund(bill.intentIds[0]!, 10_000, "completed");
    // The existing intent fact clock advances beyond wall time. A later
    // approval on the second intent of this bill must follow it too.
    await owner.query(
      "UPDATE payment_refunds SET completed_at = now() + interval '60 seconds' WHERE id = $1",
      [prior],
    );
    gateway.enqueue("pending");
    const first = await request(bill.intentIds[0]!, 100_000);
    const firstApproval = await approve(
      approvers.get("supervisor")!.client,
      first,
    );
    expect(firstApproval.status).toBe(200);
    expect(firstApproval.body.data.status).toBe("approved");
    const second = await request(bill.intentIds[1]!, 200_000);
    expect((await approve(approvers.get("owner")!.client, second)).status).toBe(
      200,
    );
    const decided = await owner.query<{ id: string; decided_at: Date }>(
      "SELECT id, decided_at FROM payment_refunds WHERE id = ANY($1::uuid[])",
      [[first, second]],
    );
    const firstAt = decided.rows.find((row) => row.id === first)!.decided_at;
    const secondAt = decided.rows.find((row) => row.id === second)!.decided_at;
    expect(secondAt.getTime()).toBeGreaterThan(firstAt.getTime());

    const retry = await approvers
      .get("supervisor")!
      .client.post(`${ADMIN}/refunds/${first}/retry`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(retry.status).toBe(200);
    const stored = await owner.query<{
      status: string;
      last_payout_error: string | null;
    }>("SELECT status, last_payout_error FROM payment_refunds WHERE id = $1", [
      first,
    ]);
    expect(stored.rows).toEqual([
      { status: "approved", last_payout_error: null },
    ]);
    expect(
      gateway.statusCalls.filter(
        (call) => call.idempotencyKey === `refund:${first}`,
      ),
    ).toHaveLength(1);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.executionCount).toBe(2);
    expect(paidOut()).toBe(300_000);
    expect(bill.paid - 10_000 - paidOut()).toBe(290_000);
  });

  it("owner approves above Rp5.000.000 while the captured-money cap still prevents overpayment", async () => {
    const amount = 50_000_000;
    const bill = await seedBill([amount]);
    const id = await request(bill.intentIds[0]!, amount);
    const response = await approve(approvers.get("owner")!.client, id);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("completed");
    expect(gateway.executionCount).toBe(1);
    expect(paidOut()).toBe(amount);
    const excess = await requester
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key(),
        paymentIntentId: bill.intentIds[0],
        amountIdr: 1,
        reason: "Percobaan melebihi dana yang sudah dibayar",
      });
    expect(excess.status).toBe(409);
    expect(gateway.executionCount).toBe(1);
    expect(bill.paid - paidOut()).toBe(0);
  });

  it("a manager role at another outlet cannot increase this outlet's supervisor ceiling", async () => {
    const actor = await user("Q63 manager other outlet");
    await grant(actor.id, "finance");
    await grant(actor.id, "supervisor", outletId);
    await grant(actor.id, "outlet_manager", otherOutletId);
    const bill = await seedBill([200_001]);
    const id = await request(bill.intentIds[0]!, 200_001);
    const refused = await approve(actor.client, id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(gateway.calls).toHaveLength(0);
    expect((await refundState(id)).status).toBe("pending");
  });

  it("an expired owner assignment cannot increase the supervisor ceiling", async () => {
    const actor = await user("Q63 expired owner");
    await grant(actor.id, "finance");
    await grant(actor.id, "supervisor", outletId);
    await grant(actor.id, "owner", null, true);
    const bill = await seedBill([200_001]);
    const id = await request(bill.intentIds[0]!, 200_001);
    const refused = await approve(actor.client, id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(gateway.calls).toHaveLength(0);
    expect((await refundState(id)).status).toBe("pending");
  });
});
