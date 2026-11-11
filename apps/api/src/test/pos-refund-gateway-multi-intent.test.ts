// Two QRIS tenders on two intents of one POS order, partial POS refund (bead
// legend-ghgei, F2 check): does the whole QRIS method stay held (cap 0, nothing
// filed, only the shortfall audit)? Scaffolding copied from
// pos-refund-gateway-autofile.test.ts.

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
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { refundPosOrder } from "../services/pos-order-corrections";
import { agent, signUp, verifySessionMfa } from "./helpers";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

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
const approverUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderUuids: string[] = [];
const overrideUuids: string[] = [];

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

type Part = { linkId: string; intentId: string; amountIdr: number };
type Sale = { orderId: string; parts: Part[]; amountIdr: number };

/** A completed POS order paid by one captured QRIS tender per amount, each on its own paid intent. */
async function multiQrisSale(amounts: number[]): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const total = amounts.reduce((a, b) => a + b, 0);
  orderUuids.push(orderUuid);
  const parts: Part[] = amounts.map((amountIdr) => ({
    linkId: randomUUID(),
    intentId: randomUUID(),
    amountIdr,
  }));
  for (const p of parts) {
    linkIds.push(p.linkId);
    intentIds.push(p.intentId);
  }
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
        total,
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    let minutes = parts.length + 1;
    for (const { linkId, intentId, amountIdr } of parts) {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'gateway-multi-test')`,
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
          `gw-pay-${intentId}`,
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
      await client.query(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
            payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
            status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
                 'captured', now() - ($7 || ' minutes')::interval, now())`,
        [
          seededTenantId,
          seededOutletA,
          orderUuid,
          linkId,
          intentId,
          amountIdr,
          String(minutes--),
        ],
      );
    }
  });
  return { orderId, parts, amountIdr: total };
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
  const client = agent(app);
  const email = await signUp(client, "Gateway Autofile Finance");
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
  await owner.end();
});

describe("legend-ghgei F2 partial POS refund of a multi-QRIS order", () => {
  it("partial refund inside the first tender files for the first intent only", async () => {
    const sale = await multiQrisSale([60_000, 40_000]);
    const [a, b] = sale.parts as [Part, Part];

    const refund = await posRefund(sale, await refundInput(sale, 30_000));
    expect(refund.amountIdr).toBe(30_000);

    const rowsA = await refundRows(a.intentId);
    expect(rowsA.map((r) => [r.status, r.amount, r.requested_by])).toEqual([
      ["pending", "30000", "system:pos"],
    ]);
    expect(await refundRows(b.intentId)).toHaveLength(0);
    expect(
      await auditCount("pos_order.refund_gateway_shortfall", a.intentId),
    ).toBe(0);
  });

  it("refund spanning both tenders files each intent its own part", async () => {
    const sale = await multiQrisSale([60_000, 40_000]);
    const [a, b] = sale.parts as [Part, Part];

    await posRefund(sale, await refundInput(sale, 70_000));

    expect((await refundRows(a.intentId)).map((r) => r.amount)).toEqual([
      "60000",
    ]);
    expect((await refundRows(b.intentId)).map((r) => r.amount)).toEqual([
      "10000",
    ]);
  });

  it("second partial refund continues on the second tender", async () => {
    const sale = await multiQrisSale([60_000, 40_000]);
    const [a, b] = sale.parts as [Part, Part];

    await posRefund(sale, await refundInput(sale, 50_000));
    await posRefund(sale, await refundInput(sale, 30_000));

    expect((await refundRows(a.intentId)).map((r) => r.amount)).toEqual([
      "50000",
      "10000",
    ]);
    expect((await refundRows(b.intentId)).map((r) => r.amount)).toEqual([
      "20000",
    ]);
  });
});
