// POS refund of a QRIS sale files the gateway part (bead legend-ghgei, P3).
//
// A POS refund (`refundPosOrder`) records refund lines that name the QRIS
// tender and its payment intent, but before this fix nothing filed the payment
// refund: the gateway money only went back if an admin filed an intent refund
// by hand. Now the same transaction files a `system:pos` payment refund
// REQUEST for each such line (key `pos-refund-gateway:<posRefundId>:<intentId>`).
// Nothing pays out there: the approval and the payout stay with WS-05.
//
// Scaffolding follows pos-late-payment-pending-refund.test.ts (raw paid intent,
// link, evidence) with a completed POS order, a captured QRIS tender and a raw
// approved PIN override; the POS refund is `refundPosOrder` called directly.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  handleRefundApprovalResolved,
  PAYOUT_QUARANTINED,
  runRefundPayout,
} from "../services/payment-refund.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { refundPosOrder } from "../services/pos-order-corrections";
import { requestPosRefundGatewayPart } from "../services/pos-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const ADMIN = "/api/payments/admin";
const BUSINESS_DATE = "2031-03-16";

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
let staff: Staff; // the cashier: requester of the POS refund and of manual refunds
let approver: ReturnType<typeof agent>; // finance + outlet supervisor; the POS refund's approver
let thirdApprover: ReturnType<typeof agent>; // finance + outlet supervisor; took no part in the POS refund
const approverUserIds: string[] = [];
let staffFinanceRoleId = "";
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderUuids: string[] = [];
const overrideUuids: string[] = [];

const key = (prefix = "gw") => `${prefix}-${randomUUID()}`;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

type Sale = {
  orderId: string; // ULID, as the service takes it
  linkId: string;
  intentId: string;
  amountIdr: number;
};

/**
 * A completed POS order of `amountIdr`, paid by one captured QRIS tender whose
 * intent is paid in full (evidence written), as the POS leaves them.
 */
async function qrisSale(
  amountIdr: number,
  { edc = false }: { edc?: boolean } = {},
): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const linkId = randomUUID();
  const intentId = randomUUID();
  orderUuids.push(orderUuid);
  linkIds.push(linkId);
  intentIds.push(intentId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', $6, now())`,
      [
        orderUuid,
        seededTenantId,
        seededOutletA,
        `GW-${randomUUID().slice(0, 8)}`,
        amountIdr,
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'gateway-autofile-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `GW-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref,
          edc_transaction_id)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $7, $8)`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        amountIdr,
        `gw-pay-${intentId}`,
        `ref-${intentId.slice(0, 8)}`,
        edc ? randomUUID() : null,
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
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
          status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
               'captured', now() - interval '1 minute', now())`,
      [seededTenantId, seededOutletA, orderUuid, linkId, intentId, amountIdr],
    );
  });
  return { orderId, linkId, intentId, amountIdr };
}

/** An approved supervisor-PIN override of the refund (requester `staff`). */
async function approval(orderId: string, valueIdr: number) {
  const overrideId = createUlid();
  overrideUuids.push(ulidToUuid(overrideId));
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5,
               'Pelanggan salah pesan', $6, 'order', $7, $8, now(), now())`,
      [
        ulidToUuid(overrideId),
        seededTenantId,
        seededOutletA,
        staff.userId,
        approverUserIds[0],
        valueIdr,
        orderId,
        // The POS order consumer re-derives the fingerprint from the stored row
        // (legend-fjwxo), so a raw fixture row needs a real one.
        pinOverrideFixtureFingerprint({
          requestedBy: staff.userId,
          outletId: seededOutletA,
          action: "refund",
          valueIdr,
          reason: "Pelanggan salah pesan",
          objectType: "order",
          objectId: orderId,
          approverUserId: approverUserIds[0]!,
        }),
      ],
    ),
  );
  return { approvedBy: approverUserIds[0]!, overrideId };
}

/** The POS refund input of `amountIdr`; reuse one input to replay the request. */
async function refundInput(sale: Sale, amountIdr: number) {
  return {
    reason: "quality_complaint",
    reasonNote: "Gateway part uji",
    amountIdr,
    idempotencyKey: randomUUID(),
    ...(await approval(sale.orderId, amountIdr)),
  } as Parameters<typeof refundPosOrder>[4];
}

const posRefund = (sale: Sale, input: Parameters<typeof refundPosOrder>[4]) =>
  refundPosOrder(
    scope(),
    {
      userId: userIdSchema.parse(staff.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    sale.orderId,
    input,
  );

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
  }>(
    "SELECT id, status, amount_idr::text AS amount, requested_by FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at, id",
    [seededTenantId, intentId],
  );
  return rows;
}

async function auditCount(action: string, objectId: string) {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3",
    [seededTenantId, action, objectId],
  );
  return rows[0]!.count;
}

async function gatewayKeys(posRefundId: string, intentId: string) {
  const { rows } = await owner.query<{ key: string }>(
    "SELECT key FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = $2",
    [seededTenantId, `pos-refund-gateway:${posRefundId}:${intentId}`],
  );
  return rows;
}

/** Approve through the WS-05 route as a user who took no part in the POS refund. */
const approveRefund = (
  refundId: string,
  as: ReturnType<typeof agent> = thirdApprover,
) =>
  as
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") })
    .then((response) => response);

const manualRefund = (intentId: string, amountIdr: number) =>
  staff.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian manual uji",
    })
    .then((response) => response);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Gateway Autofile Owner",
  });
  await verifySessionMfa(staff.email);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const financeUser = async (label: string) => {
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
  // The cashier also holds Finance and outlet supervisor, so only four-eyes
  // (never a missing role) can stop them approving their own POS refund.
  staffFinanceRoleId = await roleId("finance");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [seededTenantId, staff.userId, staffFinanceRoleId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [seededTenantId, staff.userId, await roleId("supervisor"), seededOutletA],
  );
  approver = await financeUser("Gateway Autofile Finance");
  thirdApprover = await financeUser("Gateway Autofile Third Finance");
  await financeUser("Gateway Autofile Fourth Finance");
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
  await asOwner(
    async (client) => {
      await client.query(
        "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      for (const table of [
        "pos_order_refunds",
        "pos_order_tenders",
        "pos_order_approval_uses",
        "order_events",
        "pos_orders",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
          [seededTenantId, orderUuids],
        );
      await client.query(
        "DELETE FROM pos_overrides WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, overrideUuids],
      );
      await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
        orderUuids,
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
  await owner.query(
    `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2
       AND ((scope_type = 'tenant' AND role_id = $3) OR (scope_type = 'outlet' AND scope_id = $4))
       AND assigned_by = $2`,
    [seededTenantId, staff.userId, staffFinanceRoleId, seededOutletA],
  );
  await owner.end();
});

describe("legend-ghgei P3 a POS refund of a QRIS sale files the gateway refund request", () => {
  it("a full POS refund files one pending system:pos refund of the whole intent", async () => {
    const sale = await qrisSale(100_000);

    const refund = await posRefund(sale, await refundInput(sale, 100_000));
    expect(refund.amountIdr).toBe(100_000);

    const rows = await refundRows(sale.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      amount: "100000",
      requested_by: "system:pos",
    });
    expect(await gatewayKeys(refund.id, sale.intentId)).toHaveLength(1);
  });

  it("a partial POS refund files that amount; a second one files its own", async () => {
    const sale = await qrisSale(100_000);

    const first = await posRefund(sale, await refundInput(sale, 40_000));
    expect(first.amountIdr).toBe(40_000);
    expect((await refundRows(sale.intentId)).map((r) => r.amount)).toEqual([
      "40000",
    ]);

    const second = await posRefund(sale, await refundInput(sale, 30_000));
    expect(second.amountIdr).toBe(30_000);
    const rows = await refundRows(sale.intentId);
    // Sorted: created_at can tie or step back, the set of refunds is the point.
    expect(
      rows.map((r) => [r.status, r.amount, r.requested_by]).sort(),
    ).toEqual([
      ["pending", "30000", "system:pos"],
      ["pending", "40000", "system:pos"],
    ]);
  });

  it("a replay of the POS refund request files no second payment refund", async () => {
    const sale = await qrisSale(100_000);
    const input = await refundInput(sale, 40_000);

    const first = await posRefund(sale, input);
    const replay = await posRefund(sale, input);

    expect(replay.id).toBe(first.id);
    expect(await refundRows(sale.intentId)).toHaveLength(1);
    expect(await gatewayKeys(first.id, sale.intentId)).toHaveLength(1);
  });

  it("approving the filed refund pays the guest once", async () => {
    const sale = await qrisSale(100_000);
    const refund = await posRefund(sale, await refundInput(sale, 40_000));
    const [filed] = await refundRows(sale.intentId);
    expect(filed).toMatchObject({ status: "pending", amount: "40000" });

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approveRefund(filed!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(["approved", "completed"]).toContain(response.body.data.status);
      // A second approval never pays a second time.
      await approveRefund(filed!.id);
    } finally {
      setPaymentRefundGateway(null);
    }
    expect(fake.executionCount).toBe(1);
    expect(fake.calls.every((call) => call.amountIdr === 40_000)).toBe(true);
    expect(await refundRows(sale.intentId)).toHaveLength(1);
    expect(refund.amountIdr).toBe(40_000);
  });

  it("a manual admin refund of more than remains is refused: no double payout", async () => {
    const sale = await qrisSale(100_000);
    await posRefund(sale, await refundInput(sale, 40_000));

    // 100000 paid, 40000 is already filed for the guest: 60000 is still held
    // by the sale, so no intent refund may take it.
    const refused = await manualRefund(sale.intentId, 70_000);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThan(399);
    const tooMuchForSale = await manualRefund(sale.intentId, 1);
    expect(tooMuchForSale.status).toBeGreaterThan(399);

    const rows = await refundRows(sale.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: "40000",
      requested_by: "system:pos",
    });
  });

  it("an intent that holds a terminal (EDC) transaction gets no payment refund", async () => {
    const sale = await qrisSale(100_000, { edc: true });

    const refund = await posRefund(sale, await refundInput(sale, 40_000));
    expect(refund.amountIdr).toBe(40_000);

    expect(await refundRows(sale.intentId)).toHaveLength(0);
    expect(await gatewayKeys(refund.id, sale.intentId)).toHaveLength(0);
  });

  it("a pending admin refund reserves the paid balance before a POS refund can commit", async () => {
    const sale = await qrisSale(100_000);
    // An earlier refund (pending, filed by hand) already reserves 70000.
    await owner.query(
      `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, 70000, 'Refund manual uji', 'pending', $4)`,
      [seededTenantId, seededOutletA, sale.intentId, staff.userId],
    );

    await expect(
      posRefund(sale, await refundInput(sale, 40_000)),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID" });

    // Rp70000 is already reserved from Rp100000 paid: another Rp40000
    // cannot become a refund or gateway request, leaving Rp30000 intact.
    const rows = await refundRows(sale.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      amount: "70000",
      requested_by: staff.userId,
    });
    const native = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
      [seededTenantId, ulidToUuid(sale.orderId)],
    );
    expect(native.rows[0]!.count).toBe(0);
    const mirrors = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [seededTenantId, `pos-refund-gateway:%:${sale.intentId}`],
    );
    expect(mirrors.rows[0]!.count).toBe(0);
    expect(
      await auditCount("pos_order.refund_gateway_shortfall", sale.intentId),
    ).toBe(0);
  });

  it("four-eyes: the POS refund's requester cannot approve its gateway payout", async () => {
    const sale = await qrisSale(100_000);
    await posRefund(sale, await refundInput(sale, 40_000));
    const [filed] = await refundRows(sale.intentId);

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approveRefund(filed!.id, staff.client);
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThan(
        399,
      );
      expect(JSON.stringify(response.body)).toContain("APPROVER_IS_REQUESTER");
    } finally {
      setPaymentRefundGateway(null);
    }
    expect(fake.executionCount).toBe(0);
    expect((await refundRows(sale.intentId))[0]?.status).toBe("pending");
  });

  it("four-eyes: the POS refund's approver cannot approve its gateway payout", async () => {
    const sale = await qrisSale(100_000);
    await posRefund(sale, await refundInput(sale, 40_000));
    const [filed] = await refundRows(sale.intentId);

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approveRefund(filed!.id, approver);
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThan(
        399,
      );
      expect(JSON.stringify(response.body)).toContain("APPROVER_IS_REQUESTER");
    } finally {
      setPaymentRefundGateway(null);
    }
    expect(fake.executionCount).toBe(0);
    expect((await refundRows(sale.intentId))[0]?.status).toBe("pending");

    // A third user then approves it, and the guest is paid once.
    setPaymentRefundGateway(fake);
    try {
      const ok = await approveRefund(filed!.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      await approveRefund(filed!.id);
    } finally {
      setPaymentRefundGateway(null);
    }
    expect(fake.executionCount).toBe(1);
  });
});

describe("legend-ghgei F3 four-eyes holds through the approvals inbox and the chain settle", () => {
  // approverUserIds: [0] approves the POS refund; [1] and [2] took no part.
  const posApproverId = () => approverUserIds[0]!;
  const thirdId = () => approverUserIds[1]!;
  const fourthId = () => approverUserIds[2]!;
  const sessionTenant = () =>
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    });
  const workerContext = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source: "job",
      }),
      { kind: "tenant" },
    );

  const setLevels = async (levels: number) => {
    const financeRole = staffFinanceRoleId;
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    );
    for (let level = 1; level <= levels; level += 1)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, 'refund', NULL, $2, $3, true)`,
        [seededTenantId, financeRole, level],
      );
  };
  // Two Finance levels for these tests; the one-level policy of the file after.
  beforeAll(() => setLevels(2));
  afterAll(() => setLevels(1));

  async function requestsOf(refundId: string) {
    const { rows } = await owner.query<{
      id: string;
      level: number;
      status: string;
    }>(
      `SELECT id, level, status FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2
       ORDER BY level`,
      [seededTenantId, refundId],
    );
    return rows;
  }

  const decide = (actorId: string, requestId: string) =>
    decideApprovalRequest(
      sessionTenant(),
      actorId,
      requestId,
      { decision: "approved", reason: "Sesuai bukti pengembalian." },
      { mfaVerified: true, idempotencyKey: null },
    );

  async function refundState(refundId: string) {
    const { rows } = await owner.query<{
      status: string;
      failure_reason: string | null;
      approval_chain_id: string | null;
      last_payout_error: string | null;
    }>(
      "SELECT status, failure_reason, approval_chain_id, last_payout_error FROM payment_refunds WHERE id = $1",
      [refundId],
    );
    return rows[0]!;
  }

  /** The one approval.resolved event of the refund's chain, as the worker gets it. */
  async function resolvedEvent(refundId: string) {
    const chainId = (await refundState(refundId)).approval_chain_id;
    expect(chainId).not.toBeNull();
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND destination = 'cloud-sync'
         AND event->>'name' = 'approval.resolved'
         AND event->'payload'->>'chainId' = $2`,
      [seededTenantId, chainId],
    );
    expect(rows).toHaveLength(1);
    return eventEnvelopeSchema.parse(rows[0]!.event);
  }

  /** A POS refund of a QRIS sale whose filed gateway refund waits on a two-level chain. */
  async function filedTwoLevel() {
    const sale = await qrisSale(100_000);
    await posRefund(sale, await refundInput(sale, 40_000));
    const [filed] = await refundRows(sale.intentId);
    expect(filed).toMatchObject({ status: "pending", amount: "40000" });
    const [first] = await requestsOf(filed!.id);
    expect(first).toMatchObject({ level: 1, status: "pending" });
    return { sale, refundId: filed!.id, firstId: first!.id };
  }

  /** Level 2 opens once level 1 is approved. */
  async function secondLevelId(refundId: string) {
    const second = (await requestsOf(refundId))[1];
    expect(second).toMatchObject({ level: 2, status: "pending" });
    return second!.id;
  }

  async function settleAndPay(refundId: string, fake: FakeRefundGateway) {
    await handleRefundApprovalResolved(
      workerContext(),
      await resolvedEvent(refundId),
    );
    setPaymentRefundGateway(fake);
    try {
      await runRefundPayout(scope(), refundId);
    } finally {
      setPaymentRefundGateway(null);
    }
  }

  it("a POS refund party approving level 1 in the inbox fails the refund: never paid", async () => {
    const { refundId, firstId } = await filedTwoLevel();
    await decide(posApproverId(), firstId);
    await decide(thirdId(), await secondLevelId(refundId));

    const fake = new FakeRefundGateway();
    await settleAndPay(refundId, fake);

    expect(await refundState(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "approver_unauthorized",
    });
    expect(fake.executionCount).toBe(0);
  });

  it("the POS refund's cashier approving the last level fails the refund; redelivery does not throw", async () => {
    const { refundId, firstId } = await filedTwoLevel();
    await decide(thirdId(), firstId);
    await decide(staff.userId, await secondLevelId(refundId));
    const event = await resolvedEvent(refundId);

    await expect(
      handleRefundApprovalResolved(workerContext(), event),
    ).resolves.toBeUndefined();
    expect(await refundState(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "approver_unauthorized",
    });
    // Redelivery: settled already, nothing throws, nothing moves.
    await expect(
      handleRefundApprovalResolved(workerContext(), event),
    ).resolves.toBeUndefined();
    expect((await refundState(refundId)).status).toBe("failed");
  });

  it("a clean chain of two users outside the POS refund is paid once", async () => {
    const { refundId, firstId } = await filedTwoLevel();
    await decide(thirdId(), firstId);
    await decide(fourthId(), await secondLevelId(refundId));

    const fake = new FakeRefundGateway();
    await settleAndPay(refundId, fake);
    setPaymentRefundGateway(fake);
    try {
      await runRefundPayout(scope(), refundId);
    } finally {
      setPaymentRefundGateway(null);
    }

    expect(["approved", "completed"]).toContain(
      (await refundState(refundId)).status,
    );
    expect(fake.executionCount).toBe(1);
    expect(fake.calls.every((call) => call.amountIdr === 40_000)).toBe(true);
  });

  it("an approval that already holds a POS refund party on its chain is quarantined before payout", async () => {
    const { refundId, firstId } = await filedTwoLevel();
    await decide(thirdId(), firstId);
    await decide(fourthId(), await secondLevelId(refundId));
    await handleRefundApprovalResolved(
      workerContext(),
      await resolvedEvent(refundId),
    );
    expect((await refundState(refundId)).status).toBe("approved");
    // As if level 1 had been decided by the POS refund's approver before the fix.
    await asOwner(
      (client) =>
        client.query(
          "UPDATE approval_requests SET decided_by = $2 WHERE tenant_id = $1 AND id = $3",
          [seededTenantId, posApproverId(), firstId],
        ),
      { replica: true },
    );

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      await runRefundPayout(scope(), refundId);
    } finally {
      setPaymentRefundGateway(null);
    }

    expect(fake.executionCount).toBe(0);
    expect(await refundState(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
  });
});

// legend-fpy9s: a gateway line and a deposit part of ONE POS refund on the SAME
// intent share one gateway idempotency key and one refund amount, so the
// pin bound could not tell a short-filed line from a covered one. The filer
// refuses that mix outright (DP_REFUND_SOURCE_UNVERIFIED) before any write.
// Assumptions: `posRefundId` is a fresh ULID with no pos_order_refunds row (the
// refusal must not depend on one); the control files one pending refund of the
// deposit amount under the shared key.
describe("legend-fpy9s the gateway filer refuses a deposit part plus a line on one intent", () => {
  type FilerInput = Parameters<typeof requestPosRefundGatewayPart>[2];
  type FilerTx = Parameters<typeof requestPosRefundGatewayPart>[0];

  const filePart = (
    sale: Sale,
    posRefundId: string,
    parts: Pick<FilerInput, "lines" | "depositParts">,
  ) =>
    withTenant(db, scope(), (tx) =>
      requestPosRefundGatewayPart(tx as FilerTx, scope(), {
        order: {
          id: sale.orderId,
          outletId: outletIdSchema.parse(seededOutletA),
        } as FilerInput["order"],
        caller: {
          userId: userIdSchema.parse(staff.userId),
          deviceId: null,
        },
        posRefundId,
        now: new Date(),
        ...parts,
      }),
    );

  it("a gateway line plus a deposit part on the same intent is refused 409 DP_REFUND_SOURCE_UNVERIFIED and writes nothing", async () => {
    const sale = await qrisSale(50_000);
    const posRefundId = createUlid();
    const error = await filePart(sale, posRefundId, {
      lines: [
        { method: "qris", amountIdr: 10_000, paymentIntentId: sale.intentId },
      ],
      depositParts: [{ paymentIntentId: sale.intentId, amountIdr: 20_000 }],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).code).toBe("DP_REFUND_SOURCE_UNVERIFIED");
    expect(await refundRows(sale.intentId)).toEqual([]);
    expect(await gatewayKeys(posRefundId, sale.intentId)).toEqual([]);
  });

  // The QRIS sale still holds its money here, so the refund cap leaves no
  // room and nothing is filed; the control only proves the guard does not
  // fire for a deposit part alone.
  it("control: a deposit part alone on the intent is not refused by the guard", async () => {
    const sale = await qrisSale(50_000);
    const posRefundId = createUlid();
    await expect(
      filePart(sale, posRefundId, {
        lines: [],
        depositParts: [{ paymentIntentId: sale.intentId, amountIdr: 20_000 }],
      }),
    ).resolves.toBeUndefined();
  });
});
