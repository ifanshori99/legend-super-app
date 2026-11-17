// POS late-payment refund amount vs a refund still pending (bead legend-leqj6).
//
// The late-payment refund key `pos-late-payment-refund:<intentId>` is used
// once. Before the fix the amount was cap - reserved, and `reserved` counted
// refunds still `pending`; if that pending refund was later rejected or failed,
// its amount was never filed again (the guest paid 100000 and got 80000 back).
// Now a pending refund does not reduce the late refund: its approval fails
// `cap_exceeded` instead, because the reserved total then exceeds the cap.
//
// Scaffolding follows pos-qris-capture-refund-race.test.ts (C1): raw paid
// intent, link, evidence, open POS order, authorized QRIS tender; the paid
// webhook is `handlePosPaymentPaid` called directly.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  handlePosPaymentPaid,
  type DomainEvent,
} from "../services/pos-order-payment";
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
// A business day no other test closes for outlet A.
const BUSINESS_DATE = "2031-03-15";

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

const key = (prefix = "race") => `${prefix}-${randomUUID()}`;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

type Bill = {
  orderId: string;
  linkId: string;
  intentId: string;
  amountIdr: number;
};

/**
 * An open POS order of `amountIdr` and a QRIS link + intent the guest has
 * paid in full (evidence written, intent `paid`), as the WS-05 webhook leaves
 * them before the POS consumer runs. The tender is added by `addTender`.
 */
async function paidBill(amountIdr: number): Promise<Bill> {
  const orderId = randomUUID();
  const linkId = randomUUID();
  const intentId = randomUUID();
  orderIds.push(orderId);
  linkIds.push(linkId);
  intentIds.push(intentId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'awaiting_payment', $6, now())`,
      [
        orderId,
        seededTenantId,
        seededOutletA,
        `CR-${randomUUID().slice(0, 8)}`,
        amountIdr,
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderId, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'capture-race-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `CR-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $7)`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        amountIdr,
        `cr-pay-${intentId}`,
        `ref-${intentId.slice(0, 8)}`,
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
  return { orderId, linkId, intentId, amountIdr };
}

/** The bill's authorized QRIS tender (link + paid intent); returns its id. */
async function addTender(
  bill: Bill,
  { replica = false }: { replica?: boolean } = {},
): Promise<string> {
  return asOwner(
    async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
            payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
            status, requested_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
                 'authorized', now())
         RETURNING id`,
        [
          seededTenantId,
          seededOutletA,
          bill.orderId,
          bill.linkId,
          bill.intentId,
          bill.amountIdr,
        ],
      );
      return rows[0]!.id;
    },
    { replica },
  );
}

/**
 * A refund of the intent filed by `staff`, still `pending` or (`approved`)
 * already approved by the finance approver.
 */
async function pendingRefund(
  intentId: string,
  amountIdr: number,
  {
    replica = false,
    approved = false,
  }: { replica?: boolean; approved?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await asOwner(
    (client) =>
      client.query(
        `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            requested_by, approved_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'Refund uji balapan capture', $6, $7, $8, $9)`,
        [
          id,
          seededTenantId,
          seededOutletA,
          intentId,
          amountIdr,
          approved ? "approved" : "pending",
          staff.userId,
          approved ? approverUserIds[0] : null,
          approved ? new Date() : null,
        ],
      ),
    { replica },
  );
  return id;
}

/** Sends the approve call at once (a supertest request is lazy until then). */
const approveRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") })
    .then((response) => response);

/** The verified `payment.paid` of the bill, as the outbox consumer hands it. */
const deliverPaid = (bill: Bill) =>
  handlePosPaymentPaid(scope(), {
    name: "payment.paid",
    payload: { paymentLinkId: bill.linkId, intentId: bill.intentId },
  } as unknown as DomainEvent);

async function tenderOf(tenderId: string) {
  const { rows } = await owner.query<{
    status: string;
    payment_intent_id: string | null;
  }>(
    "SELECT status, payment_intent_id FROM pos_order_tenders WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, tenderId],
  );
  return rows[0];
}

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
  }>(
    "SELECT id, status, amount_idr::text AS amount, requested_by FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [seededTenantId, intentId],
  );
  return rows;
}

/** Sum of every refund of the intent that is not `failed`. */
const reservedOf = async (intentId: string) =>
  (await refundRows(intentId))
    .filter((row) => row.status !== "failed")
    .reduce((sum, row) => sum + Number(row.amount), 0);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Capture Race Owner",
  });
  await verifySessionMfa(staff.email);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const makeApprover = async (label: string) => {
    const client = agent(app);
    const email = await signUp(client, label);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    approverUserIds.push(userId);
    await verifySessionMfa(email);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [seededTenantId, userId, await roleId("finance")],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [seededTenantId, userId, await roleId("supervisor"), seededOutletA],
    );
    return client;
  };
  approver = await makeApprover("Late Refund Finance");
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
  // Refund, tender and order rows may be immutable once final: skip user
  // triggers in a dedicated transaction.
  await asOwner(
    async (client) => {
      await client.query(
        "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      for (const table of ["pos_order_tenders", "pos_orders"])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
          [seededTenantId, orderIds],
        );
      await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
        orderIds,
      ]);
      await client.query(
        "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, intentIds],
      );
      await client.query(
        "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, linkIds],
      );
    },
    { replica: true },
  );
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

describe("legend-leqj6 the POS late-payment refund ignores refunds still pending", () => {
  it("legend-leqj6 an approved 10000 and a pending 20000: the late refund is 90000, and approving the pending one fails cap_exceeded", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);
    await pendingRefund(bill.intentId, 10_000, { approved: true });
    const pendingId = await pendingRefund(bill.intentId, 20_000);

    await deliverPaid(bill);

    // The approved refund takes money the tender needs: the capture is refused.
    expect(await tenderOf(tenderId)).toMatchObject({ status: "voided" });
    const rows = await refundRows(bill.intentId);
    const late = rows.find((row) => row.requested_by === "system:pos");
    expect(late).toMatchObject({ status: "pending", amount: "90000" });

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approveRefund(pendingId);
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThan(
        399,
      );
      const { rows: after } = await owner.query<{
        status: string;
        failure_reason: string | null;
      }>(
        "SELECT status, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, pendingId],
      );
      expect(after[0]).toEqual({
        status: "failed",
        failure_reason: "cap_exceeded",
      });
      expect(fake.calls).toHaveLength(0);
    } finally {
      setPaymentRefundGateway(null);
    }
    // The guest gets exactly what was paid: 10000 approved + 90000 late.
    expect(await reservedOf(bill.intentId)).toBe(bill.amountIdr);
  });

  it("legend-leqj6 approving the late refund first succeeds; the old pending 20000 then fails cap_exceeded", async () => {
    const bill = await paidBill(100_000);
    await addTender(bill);
    await pendingRefund(bill.intentId, 10_000, { approved: true });
    const pendingId = await pendingRefund(bill.intentId, 20_000);

    await deliverPaid(bill);

    const late = (await refundRows(bill.intentId)).find(
      (row) => row.requested_by === "system:pos",
    )!;
    expect(late).toMatchObject({ status: "pending", amount: "90000" });

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      // A system refund opens its approval chain at creation (legend-2dnh):
      // one supervisor decides.
      const lateResponse = await approveRefund(late.id);
      expect(lateResponse.status, JSON.stringify(lateResponse.body)).toBe(200);
      expect(["approved", "completed"]).toContain(
        lateResponse.body.data.status,
      );

      await approveRefund(pendingId);
      const { rows: after } = await owner.query<{
        status: string;
        failure_reason: string | null;
      }>(
        "SELECT status, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, pendingId],
      );
      expect(after[0]).toEqual({
        status: "failed",
        failure_reason: "cap_exceeded",
      });
    } finally {
      setPaymentRefundGateway(null);
    }
    // Guest total: 10000 approved + 90000 late, whichever approval came first.
    expect(await reservedOf(bill.intentId)).toBe(bill.amountIdr);
  });

  it("legend-leqj6 race: the late refund and the old pending 20000 are approved at the same moment; together they never exceed what was paid", async () => {
    const bill = await paidBill(100_000);
    await addTender(bill);
    await pendingRefund(bill.intentId, 10_000, { approved: true });
    const pendingId = await pendingRefund(bill.intentId, 20_000);
    await deliverPaid(bill);
    const late = (await refundRows(bill.intentId)).find(
      (row) => row.requested_by === "system:pos",
    )!;
    expect(late).toMatchObject({ status: "pending", amount: "90000" });

    // The provider call is slowed so both approvals are in flight together.
    const fake = new FakeRefundGateway();
    fake.delayMs = 150;
    setPaymentRefundGateway(fake);
    try {
      const responses = await Promise.all([
        approveRefund(late.id),
        approveRefund(pendingId),
      ]);
      for (const response of responses)
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(
          500,
        );
    } finally {
      setPaymentRefundGateway(null);
    }

    const after = await refundRows(bill.intentId);
    // Money cap: whichever approval wins, nothing live exceeds what was paid.
    expect(await reservedOf(bill.intentId)).toBeLessThanOrEqual(bill.amountIdr);
    // 10000 approved + 90000 late + 20000 old cannot all be paid out.
    const decided = (id: string) => {
      const status = after.find((row) => row.id === id)!.status;
      return status !== "pending" && status !== "failed";
    };
    expect(decided(late.id) && decided(pendingId)).toBe(false);
    // The provider is asked once per refund at most, and never for more than
    // the 90000 the approved refund leaves free.
    const asked = new Map<string, number>(
      fake.calls.map((call): [string, number] => [
        call.idempotencyKey,
        call.amountIdr,
      ]),
    );
    const askedTotal = [...asked.values()].reduce((sum, v) => sum + v, 0);
    expect(askedTotal).toBeLessThanOrEqual(90_000);
  });

  it("legend-leqj6 regression: no pending refund, an approved 40000 leaves a late refund of 60000", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);
    await pendingRefund(bill.intentId, 40_000, { approved: true });

    await deliverPaid(bill);

    expect(await tenderOf(tenderId)).toMatchObject({ status: "voided" });
    const rows = await refundRows(bill.intentId);
    expect(rows).toHaveLength(2);
    // Found by who filed it, not by position: created_at can tie or step back.
    expect(rows.find((row) => row.requested_by === "system:pos")).toMatchObject(
      {
        amount: "60000",
        requested_by: "system:pos",
      },
    );
    expect(await reservedOf(bill.intentId)).toBe(bill.amountIdr);
  });
});
