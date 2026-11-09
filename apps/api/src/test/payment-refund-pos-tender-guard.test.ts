// POS tender guard for gateway refunds (bead legend-riqu, tier K / money):
// a paid payment intent I that a captured POS tender already uses (QRIS paid at
// the till) must not also be refunded to the guest through PAY-04 - the guest
// would get the money back while the POS order stays paid.
//
// Real Express app, Better Auth, services and PostgreSQL. Same seeding and
// request style as reservation-deposit-refund-guard.test.ts.
//
// Assumptions where the brief is not exact:
// - The intent is paid at the till: a payment_intents row without order_id,
//   status 'paid', plus evidence; a captured pos_order_tenders row carries
//   payment_intent_id = I (no payment_link_id: the guard only reads the intent).
// - Refundable = intent amount - (captured tender amount using the intent,
//   minus the gateway part already returned through POS refunds). Only
//   'captured' tenders hold the intent (authorized/voided/failed do not).
// - A POS refund line returns the gateway part when its method matches the
//   tender method ('qris') and every tender of that method on the order uses
//   the same intent (R3 has exactly one).
// - pos_order_refunds is append-only; rows are inserted raw, removed in cleanup
//   with triggers skipped (same technique as the DP guard test).
// - Refund requests over HTTP answer 409 { error: { code } }; the guard code is
//   REFUND_INTENT_IN_POS_SALE for request and approve alike. At approve time the
//   refund row ends 'failed' with failure_reason 'cap_exceeded' and the gateway
//   is never called.
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
const GUARD_CODE = "REFUND_INTENT_IN_POS_SALE";

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

const key = (prefix = "tender") => `${prefix}-${randomUUID()}`;

/** A paid intent (with evidence) that belongs to no order or reservation. */
async function paidIntent(amountIdr: number): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'tender-guard-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `TG-${linkId.slice(0, 8)}`,
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
        `tg-pay-${intentId}`,
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

/** A completed POS order of `totalIdr` (orders + pos_orders). */
async function posOrder(
  totalIdr: number,
  status: "completed" | "awaiting_payment" = "completed",
): Promise<string> {
  const id = randomUUID();
  orderIds.push(id);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         $6, '2026-11-09', now())`,
      [
        id,
        seededTenantId,
        seededOutletA,
        `TG-${randomUUID().slice(0, 8)}`,
        totalIdr,
        status,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [id, seededTenantId, seededOutletA],
    );
  });
  return id;
}

/**
 * An earlier intent of the payment link of `paidIntentId` (legend-060xt): a
 * QR refresh opens a new intent on the same link, the first one expires.
 */
async function supersededIntentOf(paidIntentId: string): Promise<string> {
  const intentId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at)
       SELECT $1, tenant_id, outlet_id, payment_link_id, 'qris', 'doit', amount_idr,
              $2, 'expired', instructions, now()
         FROM payment_intents WHERE tenant_id = $3 AND id = $4`,
      [intentId, `tg-old-${intentId}`, seededTenantId, paidIntentId],
    );
  });
  intentIds.push(intentId);
  return intentId;
}

async function linkOf(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ link: string }>(
    "SELECT payment_link_id AS link FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, intentId],
  );
  return rows[0]!.link;
}

/** A QRIS tender of `amountIdr` on the order that uses `intentId`. */
async function qrisTender(
  orderId: string,
  intentId: string,
  amountIdr: number,
  status: "captured" | "voided" | "authorized" = "captured",
  paymentLinkId: string | null = null,
) {
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
        payment_intent_id, amount_idr, status, requested_at, resolved_at, payment_link_id,
        payment_link_token_sealed)
     VALUES ($1, $2, $3, 'qris', 'doit', $4, $5, $6, now(), $7, $8,
             CASE WHEN $8::uuid IS NULL THEN NULL ELSE 'sealed-test' END)`,
    [
      seededTenantId,
      seededOutletA,
      orderId,
      intentId,
      amountIdr,
      status,
      status === "authorized" ? null : new Date(),
      paymentLinkId,
    ],
  );
}

/** A POS refund (PAY-04 sibling, POS-03) that returned `amountIdr` over QRIS. */
async function posQrisRefund(orderId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
        lines, requested_by, approved_by, approval_request_id, refunded_at)
     VALUES ($1, $2, $3, $4, 'customer_cancelled', 'Uji', $5::jsonb,
             'kasir-uji', 'supervisor-uji', $6, now())`,
    [
      seededTenantId,
      seededOutletA,
      orderId,
      amountIdr,
      JSON.stringify([{ method: "qris", amountIdr, reference: null }]),
      randomUUID(),
    ],
  );
}

/** A POS void (POS-04) of the completed order; the tenders stay captured. */
async function posVoid(orderId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO pos_order_voids (tenant_id, outlet_id, order_id, receipt_number, amount_idr,
        reason, reason_note, requested_by, approved_by, approval_request_id, voided_at)
     VALUES ($1, $2, $3, $4, $5, 'wrong_order', 'Uji', 'kasir-uji', 'supervisor-uji', $6, now())`,
    [
      seededTenantId,
      seededOutletA,
      orderId,
      `TG-V-${randomUUID().slice(0, 8)}`,
      amountIdr,
      randomUUID(),
    ],
  );
}

const requestRefund = (intentId: string, amountIdr: number) =>
  staff.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian uji tender POS",
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
    label: "Tender Guard Owner",
  });
  await verifySessionMfa(staff.email);
  approver = agent(app);
  const approverEmail = await signUp(approver, "Tender Guard Finance");
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
  // POS refunds and final orders are immutable: skip user triggers in a
  // dedicated transaction so the rest of the cleanup keeps FK checks.
  await asOwner(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
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

describe("PAY-04 POS-03 an intent a captured POS tender uses cannot be refunded", () => {
  it("PAY-04 R1 a 100000 intent fully used by a captured QRIS tender: refunding 100000 is refused with REFUND_INTENT_IN_POS_SALE and stores nothing", async () => {
    const intentId = await paidIntent(100_000);
    await qrisTender(await posOrder(100_000), intentId, 100_000);

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);
  });

  it("PAY-04 R1 a tender that uses only 60000 of the intent leaves 40000: 40001 is refused, 40000 is created", async () => {
    const intentId = await paidIntent(100_000);
    await qrisTender(await posOrder(60_000), intentId, 60_000);

    const over = await requestRefund(intentId, 40_001);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(over.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);

    const ok = await requestRefund(intentId, 40_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe("pending");
  });

  it("PAY-04 R2 a pending refund filed before the tender cannot be paid out: approve answers 409 REFUND_INTENT_IN_POS_SALE, the refund ends failed with cap_exceeded and no payout is made", async () => {
    const intentId = await paidIntent(100_000);
    const refundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 100000, 'Diajukan sebelum tender', 'pending', $5)`,
      [refundId, seededTenantId, seededOutletA, intentId, staff.userId],
    );
    await qrisTender(await posOrder(100_000), intentId, 100_000);

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

  it("PAY-04 R3 after a POS refund returned 30000 over QRIS, only 30000 of the intent is refundable: 30001 is refused, 30000 is created", async () => {
    const intentId = await paidIntent(100_000);
    const orderId = await posOrder(100_000);
    await qrisTender(orderId, intentId, 100_000);
    await posQrisRefund(orderId, 30_000);

    const over = await requestRefund(intentId, 30_001);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(over.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);

    const ok = await requestRefund(intentId, 30_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe("pending");
  });

  it("PAY-04 R4 an intent no POS tender uses can be refunded in full as before", async () => {
    const intentId = await paidIntent(100_000);

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe("pending");
    expect(await refundRows(intentId)).toHaveLength(1);
  });

  it("PAY-04 R4 a voided tender, or a tender on another intent, does not hold this intent", async () => {
    const intentId = await paidIntent(100_000);
    const other = await paidIntent(100_000);
    const orderId = await posOrder(100_000);
    await qrisTender(orderId, intentId, 100_000, "voided");
    await qrisTender(orderId, other, 100_000);

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});

describe("PAY-04 review fixes: voided sales and fully returned methods hold nothing", () => {
  it("PAY-04 R6 a voided POS sale holds nothing: the QRIS intent is refundable in full", async () => {
    const intentId = await paidIntent(100_000);
    const orderId = await posOrder(100_000);
    await qrisTender(orderId, intentId, 100_000);
    await posVoid(orderId, 100_000);

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe("pending");
  });

  it("PAY-04 R7 two QRIS intents on one order: a partial POS refund keeps both held, a full one frees both", async () => {
    const first = await paidIntent(60_000);
    const second = await paidIntent(40_000);
    const orderId = await posOrder(100_000);
    await qrisTender(orderId, first, 60_000);
    await qrisTender(orderId, second, 40_000);
    await posQrisRefund(orderId, 30_000);

    const held = await requestRefund(first, 1);
    expect(held.status, JSON.stringify(held.body)).toBe(409);
    expect(held.body.error.code).toBe(GUARD_CODE);

    await posQrisRefund(orderId, 70_000);

    const one = await requestRefund(first, 60_000);
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await requestRefund(second, 40_000);
    expect(two.status, JSON.stringify(two.body)).toBe(201);
  });
});

describe("PAY-04 an authorized tender of an open order holds the intent too", () => {
  it("PAY-04 R8 the paid webhook has not captured the tender yet: refunding the intent is refused with REFUND_INTENT_IN_POS_SALE", async () => {
    const intentId = await paidIntent(100_000);
    const orderId = await posOrder(100_000, "awaiting_payment");
    await qrisTender(orderId, intentId, 100_000, "authorized");

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(intentId)).toHaveLength(0);
  });

  it("PAY-04 R8 an authorized tender of a completed order is never captured (late payment): the intent is refundable in full", async () => {
    const intentId = await paidIntent(100_000);
    const orderId = await posOrder(100_000);
    await qrisTender(orderId, intentId, 100_000, "authorized");

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});

describe("PAY-04 an authorized tender holds every intent of its payment link (legend-060xt)", () => {
  it("PAY-04 R9 the tender still names intent A, the refreshed QR intent B on the same link is paid: refunding B is refused with REFUND_INTENT_IN_POS_SALE", async () => {
    const paidB = await paidIntent(100_000);
    const intentA = await supersededIntentOf(paidB);
    const orderId = await posOrder(100_000, "awaiting_payment");
    await qrisTender(
      orderId,
      intentA,
      100_000,
      "authorized",
      await linkOf(paidB),
    );

    const response = await requestRefund(paidB, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(paidB)).toHaveLength(0);
  });

  it("PAY-04 R9 an authorized tender on another payment link does not hold the intent", async () => {
    const intentId = await paidIntent(100_000);
    const other = await paidIntent(100_000);
    const orderId = await posOrder(100_000, "awaiting_payment");
    await qrisTender(
      orderId,
      other,
      100_000,
      "authorized",
      await linkOf(other),
    );

    const response = await requestRefund(intentId, 100_000);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});

describe("PAY-04 the refundable list is net of POS tenders", () => {
  it("PAY-04 R5 refundableAmountIdr excludes the part a captured tender uses; paid = refunded + refundable", async () => {
    const intentId = await paidIntent(100_000);
    await qrisTender(await posOrder(60_000), intentId, 60_000);

    const listed = await refundablePayment(intentId);

    expect(listed).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 40_000,
    });
    expect(listed!.refundedAmountIdr + listed!.refundableAmountIdr).toBe(
      listed!.paidAmountIdr,
    );
  });

  it("PAY-04 R5 an intent fully used by a tender shows nothing refundable, one with no tender shows the full amount", async () => {
    const used = await paidIntent(100_000);
    await qrisTender(await posOrder(100_000), used, 100_000);
    const free = await paidIntent(80_000);

    // Assumption: a fully used intent is either listed with 0 refundable or
    // not listed at all; both mean the user cannot refund it.
    expect((await refundablePayment(used))?.refundableAmountIdr ?? 0).toBe(0);
    expect(await refundablePayment(free)).toMatchObject({
      refundableAmountIdr: 80_000,
    });
  });
});
