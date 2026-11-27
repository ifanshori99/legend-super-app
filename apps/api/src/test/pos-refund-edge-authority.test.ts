// Q63 / brief 530: an edge has no authoritative history of refunds committed
// centrally. A connected link only transports deferred POS envelopes, so it
// cannot authorize a new payout either. Exercise the real refund service and
// verify that refusal leaves the money ledger and approval unspent.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { orderRefundedPayloadSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import { applyEdgeDeferredEvent } from "../edge/deferred-event-applier.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { refundApprovalWithinLimit } from "../services/payment-refund-approval-limits.ts";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const originalRuntime = getEdgeRuntimeState();
const orders: string[] = [];
const overrides: string[] = [];
const users: string[] = [];
const edgeNodeId = randomUUID();
const paymentLinks: string[] = [];
const paymentIntents: string[] = [];
const mirrorKeys: string[] = [];
let requester: Staff;
let supervisor: Staff;
let ownerApprover: Staff;

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
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

async function saleAndApproval(
  amountIdr: number,
  approver: Staff,
  paid = amountIdr,
  pointsIdr = 0,
) {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const overrideId = createUlid();
  const overrideUuid = ulidToUuid(overrideId);
  orders.push(orderUuid);
  overrides.push(overrideUuid);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr,
         tax_idr, rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', '2031-03-18', now())`,
      [
        orderUuid,
        seededTenantId,
        seededOutletA,
        `EDGE-${orderId.slice(-20)}`,
        paid,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         reference, amount_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'edc_card', 'edc', $4, $5, 'captured', now(), now())`,
      [
        seededTenantId,
        seededOutletA,
        orderUuid,
        `edc-${orderUuid}`,
        paid - pointsIdr,
      ],
    );
    if (pointsIdr > 0)
      await client.query(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method,
           provider, amount_idr, points_used, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'points', 'manual', $4, $5, 'captured', now(), now())`,
        [seededTenantId, seededOutletA, orderUuid, pointsIdr, pointsIdr],
      );
    const reason = "Pelanggan salah pesan";
    await client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method,
         status, requested_by, approved_by, reason, value_idr, object_type,
         object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5,
         $6, $7, 'order', $8, $9, now(), now())`,
      [
        overrideUuid,
        seededTenantId,
        seededOutletA,
        requester.userId,
        approver.userId,
        reason,
        amountIdr,
        orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: requester.userId,
          outletId: seededOutletA,
          action: "refund",
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: orderId,
          approverUserId: approver.userId,
        }),
      ],
    );
  });
  return { orderId, orderUuid, overrideId, overrideUuid };
}

async function deferredRefund(
  sale: Awaited<ReturnType<typeof saleAndApproval>>,
  amountIdr: number,
  refundId: string = randomUUID(),
  malformed = false,
  options: {
    refundedAt?: string;
    gatewayIdr?: number;
    pointsIdr?: number;
  } = {},
) {
  const at = options.refundedAt ?? new Date(Date.now() - 1_000).toISOString();
  const gatewayIdr = options.gatewayIdr ?? 0;
  const pointsIdr = options.pointsIdr ?? 0;
  const edcIdr = amountIdr - gatewayIdr - pointsIdr;
  const event = eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: seededTenantId,
    outletId: seededOutletA,
    name: "order.refunded",
    version: 1,
    aggregateType: "order",
    aggregateId: sale.orderId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "user", id: requester.userId },
    deviceId: null,
    idempotencyKey: randomUUID(),
    payloadSchemaRef: "order.refunded.v1",
    payload: orderRefundedPayloadSchema.parse({
      orderId: sale.orderId,
      outletId: seededOutletA,
      businessDate: "2031-03-18",
      refundId,
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Legacy edge refund already returned to the guest",
      approvedBy: supervisor.userId,
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: amountIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: 0,
      refundGatewayIdr: gatewayIdr,
      refundEdcIdr: edcIdr,
      refundPointsIdr: pointsIdr,
      lines: [
        ...(edcIdr > 0 ? [{ method: "edc_card", amountIdr: edcIdr }] : []),
        ...(gatewayIdr > 0 ? [{ method: "qris", amountIdr: gatewayIdr }] : []),
        ...(pointsIdr > 0 ? [{ method: "points", amountIdr: pointsIdr }] : []),
      ],
      refundedAt: at,
    }),
  });
  // The historical deferred applier validates scope, but deliberately does
  // not interpret the domain payload. Old accepted rows can be unreadable.
  if (malformed) event.payload.amountIdr = "unverified";
  await withTenant(db, scope, (tx) =>
    applyEdgeDeferredEvent(tx, event, {
      context: scope,
      edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
    }),
  );
  return event;
}

function refund(
  sale: Awaited<ReturnType<typeof saleAndApproval>>,
  amountIdr: number,
  approver = supervisor,
) {
  return refundPosOrder(
    scope,
    {
      userId: userIdSchema.parse(requester.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    sale.orderId,
    {
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Central refund after edge history",
      approvedBy: approver.userId,
      overrideId: sale.overrideId,
      idempotencyKey: randomUUID(),
    } as Parameters<typeof refundPosOrder>[4],
  );
}

beforeAll(async () => {
  const app = createApp();
  requester = await staffWithRole(app, {
    template: "cashier",
    label: "Edge Refund Cashier",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    label: "Edge Refund Supervisor",
  });
  ownerApprover = await staffWithRole(app, {
    template: "owner",
    label: "Edge Refund Owner",
  });
  users.push(requester.userId, supervisor.userId, ownerApprover.userId);
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label,
         credential_hash, revoked_at)
       VALUES ($1, $2, $3, 'standby', 'revoked', 'Legacy refund fixture', $4, now())`,
      [edgeNodeId, seededTenantId, seededOutletA, "a".repeat(64)],
    ),
  );
});

afterEach(() => {
  setEdgeRuntimeStateForTests(originalRuntime);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [paymentIntents],
    );
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = ANY($2::text[])",
      [seededTenantId, mirrorKeys],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [paymentIntents],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      paymentLinks,
    ]);
    await client.query(
      "DELETE FROM edge_deferred_events WHERE edge_node_id = $1",
      [edgeNodeId],
    );
    await client.query("DELETE FROM edge_nodes WHERE id = $1", [edgeNodeId]);
    for (const table of [
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_order_approval_uses",
      "order_events",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
        [orders],
      );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrides,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
    await client.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [users],
    );
  }, true);
  await owner.end();
});

describe("Q63 edge refunds require authoritative cross-channel history", () => {
  it("Refuses an unmaterialized edge refund before a second payout can over-return one tender", async () => {
    // 1272 V1 P3 (27ed51038): the points tender no longer counts as paid, so
    // the card part is 200.000 here; the deferred points refund plus this
    // request still fit it, and only the unverified history refuses.
    const sale = await saleAndApproval(100_000, supervisor, 300_000, 100_000);
    await deferredRefund(sale, 100_000, randomUUID(), false, {
      pointsIdr: 100_000,
    });
    await expect(refund(sale, 100_000)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    const { rows } = await owner.query(
      `SELECT
         (SELECT count(*)::int FROM pos_order_refunds WHERE order_id = $1) AS refunds,
         (SELECT count(*)::int FROM pos_order_approval_uses WHERE override_id = $2) AS approval_uses`,
      [sale.orderUuid, sale.overrideUuid],
    );
    expect(rows[0]).toEqual({ refunds: 0, approval_uses: 0 });
  });

  it("Revalidates a gateway mirror against its full deferred POS refund despite a later source clock", async () => {
    const decisionAt = new Date();
    const sale = await saleAndApproval(100_000, supervisor, 500_000);
    const sourceId = randomUUID();
    await deferredRefund(sale, 300_000, sourceId, false, {
      refundedAt: new Date(decisionAt.getTime() + 3_600_000).toISOString(),
      gatewayIdr: 100_000,
    });
    const linkId = randomUUID();
    const intentId = randomUUID();
    const mirrorId = randomUUID();
    const mirrorKey = `pos-refund-gateway:${sourceId}:${intentId}`;
    paymentLinks.push(linkId);
    paymentIntents.push(intentId);
    mirrorKeys.push(mirrorKey);
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash,
           reference, subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, $6)`,
        [
          linkId,
          seededTenantId,
          seededOutletA,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `mirror-${linkId.slice(0, 30)}`,
          requester.userId,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
           order_id, method, provider, amount_idr, idempotency_key, status,
           paid_at, instructions, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 100000, $6, 'paid', now(),
           '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
        [
          intentId,
          seededTenantId,
          seededOutletA,
          linkId,
          sale.orderUuid,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
           amount_idr, reason, status, requested_by, approved_by, decided_at)
         VALUES ($1, $2, $3, $4, 100000, 'Legacy POS gateway mirror',
           'approved', 'system:pos', $5, $6)`,
        [
          mirrorId,
          seededTenantId,
          seededOutletA,
          intentId,
          supervisor.userId,
          decisionAt,
        ],
      );
      await client.query(
        `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          seededTenantId,
          mirrorKey,
          "b".repeat(64),
          JSON.stringify({ refundId: mirrorId }),
        ],
      );
    });
    const allowed = await withTenant(db, scope, async (tx) => {
      const [mirror] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, mirrorId));
      if (!mirror) throw new Error("Missing mirror fixture");
      return refundApprovalWithinLimit(
        tx,
        scope,
        supervisor.userId,
        mirror,
        decisionAt,
        {
          approvedBefore: decisionAt,
          historical: true,
        },
      );
    });
    expect(allowed).toBe(false);
  });

  it("Includes a trusted deferred edge Rp150k before a central POS Rp100k refund", async () => {
    const sale = await saleAndApproval(100_000, supervisor, 300_000);
    await deferredRefund(sale, 150_000);
    await expect(refund(sale, 100_000)).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    const { rows } = await owner.query(
      "SELECT coalesce(sum(amount_idr),0)::int AS amount FROM pos_order_refunds WHERE order_id = $1",
      [sale.orderUuid],
    );
    expect(rows[0]!.amount).toBe(0);
  });

  it("Counts an edge refund once when several deferred events and a native row share its refundId", async () => {
    const sale = await saleAndApproval(50_000, supervisor, 300_000);
    const first = await deferredRefund(sale, 150_000);
    await deferredRefund(sale, 150_000, first.payload.refundId as string);
    await asOwner((client) =>
      client.query(
        `INSERT INTO pos_order_refunds (id, tenant_id, outlet_id, order_id,
           amount_idr, reason, reason_note, lines, items, requested_by, approved_by, override_id, refunded_at)
         VALUES ($1, $2, $3, $4, 150000, 'quality_complaint', 'Previously imported edge refund',
           '[{"method":"edc_card","amountIdr":150000}]', '[]', $5, $6, $7, now() - interval '1 minute')`,
        [
          first.payload.refundId,
          seededTenantId,
          seededOutletA,
          sale.orderUuid,
          requester.userId,
          supervisor.userId,
          sale.overrideUuid,
        ],
      ),
    );
    const result = await refund(sale, 50_000);
    expect(result.amountIdr).toBe(50_000);
    const { rows } = await owner.query(
      "SELECT sum(amount_idr)::int AS amount FROM pos_order_refunds WHERE order_id = $1",
      [sale.orderUuid],
    );
    expect(rows[0]!.amount).toBe(200_000);
  });

  it("Refuses unreadable accepted legacy edge money facts even for an owner", async () => {
    const sale = await saleAndApproval(100_000, ownerApprover, 300_000);
    await deferredRefund(sale, 150_000, randomUUID(), true);
    await expect(refund(sale, 100_000, ownerApprover)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
  });

  it("Refuses conflicting amounts for one legacy refund identity", async () => {
    const sale = await saleAndApproval(100_000, ownerApprover, 300_000);
    const first = await deferredRefund(sale, 150_000);
    await deferredRefund(sale, 160_000, first.payload.refundId as string);
    await expect(refund(sale, 100_000, ownerApprover)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
  });

  it.each([
    {
      label: "Offline even below the lowest ceiling",
      amount: 100_000,
      role: "supervisor",
      edgeMode: true,
      connected: false,
      boot: false,
    },
    {
      label: "Offline above the lowest ceiling",
      amount: 200_001,
      role: "supervisor",
      edgeMode: true,
      connected: false,
      boot: false,
    },
    {
      label: "Offline owner cannot bypass unknown paid/refunded balance",
      amount: 5_000_001,
      role: "owner",
      edgeMode: true,
      connected: false,
      boot: false,
    },
    {
      label: "Connected link without history proof is insufficient",
      amount: 100_000,
      role: "supervisor",
      edgeMode: true,
      connected: true,
      boot: false,
    },
    {
      label: "Edge boot window is also closed",
      amount: 100_000,
      role: "supervisor",
      edgeMode: false,
      connected: false,
      boot: true,
    },
  ])("$label", async ({ amount, role, edgeMode, connected, boot }) => {
    const approver = role === "owner" ? ownerApprover : supervisor;
    const sale = await saleAndApproval(amount, approver);
    setEdgeRuntimeStateForTests({
      edgeMode,
      identity: null,
      link: {
        cloudLink: connected ? "connected" : "disconnected",
        refused: false,
        lastConnectedAt: connected ? new Date() : null,
      },
    });
    vi.stubEnv("EDGE_MODE", boot ? "true" : "false");
    await expect(
      refundPosOrder(
        scope,
        {
          userId: userIdSchema.parse(requester.userId),
          deviceId: null,
          expectedVersion: null,
        },
        outletIdSchema.parse(seededOutletA),
        sale.orderId,
        {
          amountIdr: amount,
          reason: "quality_complaint",
          reasonNote: "Edge cannot prove previous central refunds",
          approvedBy: approver.userId,
          overrideId: sale.overrideId,
          idempotencyKey: randomUUID(),
        } as Parameters<typeof refundPosOrder>[4],
      ),
    ).rejects.toMatchObject({ status: 409, code: "REFUND_HISTORY_UNVERIFIED" });

    const { rows } = await owner.query(
      `SELECT
        (SELECT count(*)::int FROM pos_order_refunds WHERE order_id = $1) AS refunds,
        (SELECT count(*)::int FROM pos_order_approval_uses WHERE override_id = $2) AS approval_uses,
        (SELECT count(*)::int FROM order_events WHERE order_id = $1 AND type = 'order.refunded') AS refund_events,
        (SELECT count(*)::int FROM domain_event_outbox WHERE event->>'aggregateId' = $3 AND event->>'name' = 'order.refunded') AS payout_events`,
      [sale.orderUuid, sale.overrideUuid, sale.orderId],
    );
    expect(rows[0]).toEqual({
      refunds: 0,
      approval_uses: 0,
      refund_events: 0,
      payout_events: 0,
    });
  });
});
