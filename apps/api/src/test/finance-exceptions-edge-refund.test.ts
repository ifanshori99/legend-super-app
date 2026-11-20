// Brief 1244 r2 (bead legend-ecr16): a refund an old edge already paid out
// from its drawer arrives as a parked `order.refunded` fact. The central money
// guards already hold later refunds for that order (REFUND_HISTORY_UNVERIFIED);
// finance exception `edge_refund_unreconciled` makes the parked fact visible
// until its native `pos_order_refunds` row exists. Written fail-first against
// listFinanceExceptions with the real database; fixtures follow
// pos-refund-edge-authority.test.ts.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import type { FinanceExceptionKind } from "@starter/shared/validators/finance-exceptions";
import { createApp } from "../app.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { db } from "../db/index.ts";
import { paymentIntents as paymentIntentsTable } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { applyEdgeDeferredEvent } from "../edge/deferred-event-applier.ts";
import {
  createRefund,
  refundableBalance,
} from "../services/payment-admin.service.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const KIND = "edge_refund_unreconciled" as FinanceExceptionKind;
const WINDOW = { from: "2026-03-01", to: "2026-03-02" };

const orders: string[] = [];
const refundIds: string[] = [];
const paymentLinks: string[] = [];
const paymentIntents: string[] = [];
const overrides: string[] = [];
const users: string[] = [];
const edgeNodeId = randomUUID();
let cashier: Staff;
let supervisor: Staff;
let ownerStaff: Staff;
let other: IsolatedTenant;

const tenantScope = (tenantId = seededTenantId) =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
const wide = establishScopedTenantContext(tenantScope(), { kind: "tenant" });

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // Replica role lets cleanup delete append-only rows (as the edge suites do).
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

async function sale(paidIdr: number, outletId: string = seededOutletA) {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  orders.push(orderUuid);
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
        outletId,
        `E1244-${orderId.slice(-18)}`,
        paidIdr,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderUuid, seededTenantId, outletId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         reference, amount_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'edc_card', 'edc', $4, $5, 'captured', now(), now())`,
      [seededTenantId, outletId, orderUuid, `edc-${orderUuid}`, paidIdr],
    );
  });
  return { orderId, orderUuid };
}

/** A refund the central already holds as a native row. */
async function nativeRefund(
  orderUuid: string,
  amountIdr: number,
  id: string = randomUUID(),
) {
  refundIds.push(id);
  const orderUlid = uuidToUlid(orderUuid);
  const overrideId = createUlid();
  const overrideUuid = ulidToUuid(overrideId);
  overrides.push(overrideUuid);
  const reason = "Pelanggan salah pesan";
  await asOwner(async (client) => {
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
        cashier.userId,
        supervisor.userId,
        reason,
        amountIdr,
        orderUlid,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: seededOutletA,
          action: "refund",
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: orderUlid,
          approverUserId: supervisor.userId,
        }),
      ],
    );
    await client.query(
      `INSERT INTO pos_order_refunds (id, tenant_id, outlet_id, order_id,
         amount_idr, reason, reason_note, lines, items, requested_by, approved_by,
         override_id, refunded_at)
       VALUES ($1, $2, $3, $4, $5, 'quality_complaint', 'Central refund',
         $6::jsonb, '[]', $7, $8, $9, now() - interval '1 minute')`,
      [
        id,
        seededTenantId,
        seededOutletA,
        orderUuid,
        amountIdr,
        JSON.stringify([{ method: "edc_card", amountIdr }]),
        cashier.userId,
        supervisor.userId,
        overrideUuid,
      ],
    );
  });
  return id;
}

/** A legacy edge `order.refunded` parked by the deferred applier. */
async function edgeRefund(
  orderId: string,
  amountIdr: number,
  refundId: string = randomUUID(),
  outletId: string = seededOutletA,
) {
  const at = new Date(Date.now() - 1_000).toISOString();
  const event = eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: seededTenantId,
    outletId,
    name: "order.refunded",
    version: 1,
    aggregateType: "order",
    aggregateId: orderId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "user", id: cashier.userId },
    deviceId: null,
    idempotencyKey: randomUUID(),
    payloadSchemaRef: "order.refunded.v1",
    payload: orderRefundedPayloadSchema.parse({
      orderId,
      outletId,
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
      refundGatewayIdr: 0,
      refundEdcIdr: amountIdr,
      refundPointsIdr: 0,
      lines: [{ method: "edc_card", amountIdr }],
      refundedAt: at,
    }),
  });
  await withTenant(db, wide, (tx) =>
    applyEdgeDeferredEvent(tx, event, {
      context: wide,
      edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
    }),
  );
  return refundId;
}

async function list(
  context = wide,
  extra: { kind?: FinanceExceptionKind; outletId?: string } = {},
) {
  return listFinanceExceptions(context, { ...WINDOW, kind: KIND, ...extra });
}

const itemOf = (result: Awaited<ReturnType<typeof list>>, refId: string) =>
  result.items.filter((item) => item.refId === refId);

/** Its own dead-letter row (append-only), so no test leans on another one. */
async function seedDeadLetter() {
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_link_dead_letters
         (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq,
          aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event, created_at)
       VALUES ($1, $2, $3, 'edge_to_cloud', $4, 1, 'order', $5, 1, 2000000,
         'frame_too_large', '{}'::jsonb, '2026-03-01T05:09:00Z'::timestamptz)`,
      [seededTenantId, seededOutletA, edgeNodeId, randomUUID(), randomUUID()],
    ),
  );
}

/** A paid QRIS intent of the order with its evidence (nothing else holds it). */
async function paidIntent(
  orderUuid: string | null,
  amountIdr: number,
  outletId: string = seededOutletA,
) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  paymentLinks.push(linkId);
  paymentIntents.push(intentId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash,
         reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
      [
        linkId,
        seededTenantId,
        outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `bal-${linkId.slice(0, 30)}`,
        amountIdr,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
         order_id, method, provider, amount_idr, idempotency_key, status,
         paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid', now(),
         '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
      [
        intentId,
        seededTenantId,
        outletId,
        linkId,
        orderUuid,
        amountIdr,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider,
         provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [seededTenantId, outletId, intentId, `ev-${intentId}`, amountIdr],
    );
  });
  return intentId;
}

async function capOf(intentId: string) {
  return withTenant(db, wide, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntentsTable)
      .where(eq(paymentIntentsTable.id, intentId));
    return refundableBalance(tx, intent!);
  });
}

beforeAll(async () => {
  const app = createApp();
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Exc Edge Refund Cashier",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    label: "Exc Edge Refund Supervisor",
  });
  ownerStaff = await staffWithRole(app, {
    template: "owner",
    label: "Exc Edge Refund Owner",
  });
  users.push(cashier.userId, supervisor.userId, ownerStaff.userId);
  other = await createIsolatedTenant("e1244");
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label,
         credential_hash, revoked_at)
       VALUES ($1, $2, $3, 'standby', 'revoked', 'Legacy refund exception', $4, now())`,
      [edgeNodeId, seededTenantId, seededOutletA, "c".repeat(64)],
    ),
  );
});

afterAll(async () => {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM edge_deferred_events WHERE edge_node_id = $1",
      [edgeNodeId],
    );
    // The edge node stays: T5 leaves an append-only dead-letter row on it.
    await client.query(
      "DELETE FROM pos_order_refunds WHERE id = ANY($1::uuid[])",
      [refundIds],
    );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrides,
    ]);
    for (const table of ["pos_order_tenders", "pos_orders"])
      await client.query(
        `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
        [orders],
      );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
    await client.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [users],
    );
  }, true);
  await dropIsolatedTenant(other);
  await owner.end();
});

describe("finance exception edge_refund_unreconciled (1244 r2)", () => {
  it("T1: central Rp100k plus parked edge Rp100k on a Rp150k sale exceeds what was paid", async () => {
    const s = await sale(150_000);
    await nativeRefund(s.orderUuid, 100_000);
    await edgeRefund(s.orderId, 100_000);
    const items = itemOf(await list(), s.orderUuid);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: KIND,
      refType: "order",
      outletId: seededOutletA,
      amountIdr: 100_000,
      detail: "exceeds_paid",
    });
  });

  it("T2: a lone parked edge refund of Rp50k within the paid amount is listed as within_paid", async () => {
    const s = await sale(150_000);
    await edgeRefund(s.orderId, 50_000);
    const items = itemOf(await list(), s.orderUuid);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      amountIdr: 50_000,
      detail: "within_paid",
    });
  });

  it("T3: one refundId parked twice is one item and counts once", async () => {
    const s = await sale(150_000);
    const id = await edgeRefund(s.orderId, 60_000);
    await edgeRefund(s.orderId, 60_000, id);
    const result = await list();
    const items = itemOf(result, s.orderUuid);
    expect(items).toHaveLength(1);
    expect(items[0]!.amountIdr).toBe(60_000);
  });

  it("T4: a refund with a native row of the same id is not listed", async () => {
    const s = await sale(150_000);
    const id = await edgeRefund(s.orderId, 70_000);
    await nativeRefund(s.orderUuid, 70_000, id);
    expect(itemOf(await list(), s.orderUuid)).toEqual([]);
  });

  it("T5: an unreadable envelope is listed as unreadable with no amount and does not break other kinds", async () => {
    const bogusAggregate = `bogus-${randomUUID().slice(0, 12)}`;
    await asOwner((client) =>
      client.query(
        `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id,
           event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name,
           envelope, parked_reason)
         VALUES ($1, $2, $3, $4, 'order', $5, 1, 'order.refunded',
           '{"broken":true}'::jsonb, 'deferred')`,
        [
          seededTenantId,
          seededOutletA,
          edgeNodeId,
          randomUUID(),
          bogusAggregate,
        ],
      ),
    );
    const items = itemOf(await list(), bogusAggregate);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: KIND,
      amountIdr: null,
      detail: "unreadable",
    });
    // The savepoint keeps the list alive: another kind still answers.
    await asOwner((client) =>
      client.query(
        `INSERT INTO edge_link_dead_letters
           (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq,
            aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event, created_at)
         VALUES ($1, $2, $3, 'edge_to_cloud', $4, 1, 'order', $5, 1, 2000000,
           'frame_too_large', '{}'::jsonb, '2026-03-01T05:07:00Z'::timestamptz)`,
        [seededTenantId, seededOutletA, edgeNodeId, randomUUID(), randomUUID()],
      ),
    );
    const both = await listFinanceExceptions(wide, {
      ...WINDOW,
      outletId: seededOutletA,
    });
    expect(both.items.some((item) => item.kind === KIND)).toBe(true);
    expect(
      both.items.some((item) => item.kind === "edge_link_dead_letter"),
    ).toBe(true);
  });

  it("T6: standing outside the date window; other outlet and other tenant do not see it", async () => {
    const s = await sale(150_000);
    await edgeRefund(s.orderId, 40_000);
    // Received today, the window is March 2026: still listed.
    expect(itemOf(await list(), s.orderUuid)).toHaveLength(1);
    const outletB = establishScopedTenantContext(tenantScope(), {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(seededOutletB)],
    });
    expect(itemOf(await list(outletB), s.orderUuid)).toEqual([]);
    const outletA = establishScopedTenantContext(tenantScope(), {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(seededOutletA)],
    });
    expect(itemOf(await list(outletA), s.orderUuid)).toHaveLength(1);
    const foreign = establishScopedTenantContext(tenantScope(other.tenantId), {
      kind: "tenant",
    });
    expect(itemOf(await list(foreign), s.orderUuid)).toEqual([]);
    const summary = (await list()).summary.find((row) => row.kind === KIND);
    expect(summary?.count).toBeGreaterThanOrEqual(1);
  });

  it("T7: a final void parked for an order with an edge refund makes the history unverifiable: unreadable, no amount, other kinds still listed", async () => {
    const s = await sale(150_000);
    await edgeRefund(s.orderId, 50_000);
    const at = new Date(Date.now() - 500).toISOString();
    const voided = eventEnvelopeSchema.parse({
      id: createUlid(),
      tenantId: seededTenantId,
      outletId: seededOutletA,
      name: "order.voided",
      version: 1,
      aggregateType: "order",
      aggregateId: s.orderId,
      sequence: 2,
      occurredAt: at,
      actor: { type: "user", id: cashier.userId },
      deviceId: null,
      idempotencyKey: randomUUID(),
      payloadSchemaRef: "order.voided.v1",
      payload: orderVoidedPayloadSchema.parse({
        orderId: s.orderId,
        outletId: seededOutletA,
        businessDate: "2031-03-18",
        amountIdr: 150_000,
        reason: "customer_cancelled",
        reasonNote: "Pelanggan batal",
        requestedBy: cashier.userId,
        approvedBy: supervisor.userId,
        overrideId: createUlid(),
        approvalRequestId: null,
        voidedFinalOrder: true,
        voidId: randomUUID(),
        receiptNumber: `POS1-${randomUUID().slice(0, 6)}`,
        voidedAt: at,
      }),
    });
    await withTenant(db, wide, (tx) =>
      applyEdgeDeferredEvent(tx, voided, {
        context: wide,
        edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
      }),
    );
    await seedDeadLetter();
    const result = await listFinanceExceptions(wide, {
      ...WINDOW,
      outletId: seededOutletA,
    });
    const items = itemOf(result, s.orderUuid);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: KIND,
      amountIdr: null,
      detail: "unreadable",
    });
    expect(
      result.items.some((item) => item.kind === "edge_link_dead_letter"),
    ).toBe(true);
  });

  it("native row with the same id but another order or amount does not hide the parked fact", async () => {
    const s = await sale(150_000);
    const other = await sale(150_000);
    const id = await edgeRefund(s.orderId, 70_000);
    await nativeRefund(other.orderUuid, 70_000, id);
    expect(itemOf(await list(), s.orderUuid)).toHaveLength(1);
    const t = await sale(150_000);
    const id2 = await edgeRefund(t.orderId, 70_000);
    await nativeRefund(t.orderUuid, 60_000, id2);
    expect(itemOf(await list(), t.orderUuid)).toHaveLength(1);
  });

  it("a tender of another outlet does not prove the order: order_unknown", async () => {
    const s = await sale(150_000);
    await asOwner(
      (client) =>
        client.query(
          "UPDATE pos_order_tenders SET outlet_id = $1 WHERE order_id = $2",
          [seededOutletB, s.orderUuid],
        ),
      true,
    );
    await edgeRefund(s.orderId, 50_000);
    const items = itemOf(await list(), s.orderUuid);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ detail: "order_unknown" });
  });

  it("admin refund cap: a parked edge refund lowers it by its value; an unreadable one holds all; none changes nothing", async () => {
    const clean = await sale(150_000);
    const cleanIntent = await paidIntent(clean.orderUuid, 150_000);
    expect((await capOf(cleanIntent)).cap).toBe(150_000n);
    // A cloud QR order of an outlet with an edge has no ingest row, yet its
    // parked edge refund (Rp50k) lowers the cap.
    const central = await sale(150_000);
    const centralIntent = await paidIntent(central.orderUuid, 150_000);
    await edgeRefund(central.orderId, 50_000);
    expect((await capOf(centralIntent)).cap).toBe(100_000n);

    const parked = await sale(150_000);
    const parkedIntent = await paidIntent(parked.orderUuid, 150_000);
    await edgeRefund(parked.orderId, 50_000);
    expect((await capOf(parkedIntent)).cap).toBe(100_000n);

    // An outlet without any edge node can hold no parked event (composite FK
    // to edge_nodes) and is never scanned: even a stray fact naming its order
    // leaves the cap unchanged.
    const noEdge = await sale(150_000, seededOutletB);
    const noEdgeIntent = await paidIntent(
      noEdge.orderUuid,
      150_000,
      seededOutletB,
    );
    await edgeRefund(noEdge.orderId, 50_000);
    expect((await capOf(noEdgeIntent)).cap).toBe(150_000n);

    const blind = await sale(150_000);
    const blindIntent = await paidIntent(blind.orderUuid, 150_000);
    await asOwner((client) =>
      client.query(
        `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id,
           event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name,
           envelope, parked_reason)
         VALUES ($1, $2, $3, $4, 'order', $5, 1, 'order.refunded',
           '{"broken":true}'::jsonb, 'deferred')`,
        [
          seededTenantId,
          seededOutletA,
          edgeNodeId,
          randomUUID(),
          blind.orderId,
        ],
      ),
    );
    expect((await capOf(blindIntent)).cap).toBe(0n);
  });

  it("e2e: createRefund of the full Rp150k is refused for an order with a recorded edge void and a parked edge refund of Rp50k", async () => {
    const s = await sale(150_000);
    // An admin-refundable intent has no sales document: the POS tender names it.
    const intentId = await paidIntent(null, 150_000);
    await asOwner(
      (client) =>
        client.query(
          `UPDATE pos_order_tenders
              SET method = 'qris', provider = 'doit', payment_intent_id = $1
            WHERE order_id = $2`,
          [intentId, s.orderUuid],
        ),
      true,
    );
    await asOwner((client) =>
      client.query(
        `INSERT INTO pos_order_voids
           (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason,
            reason_note, requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, $4, $5, 150000, 'wrong_order', 'Pesanan salah',
                 'requester', 'approver', $6, now())`,
        [
          randomUUID(),
          seededTenantId,
          seededOutletA,
          s.orderUuid,
          `V1244-${randomUUID().slice(0, 8)}`,
          randomUUID(),
        ],
      ),
    );
    await edgeRefund(s.orderId, 50_000);
    const key = randomUUID();
    await expect(
      createRefund(
        wide,
        ownerStaff.userId,
        {
          idempotencyKey: key,
          paymentIntentId: intentId,
          amountIdr: idr(150_000),
          reason: "1244 r2 refund penuh setelah void edge",
        },
        key,
      ),
    ).rejects.toThrow(/exceeds available paid/);
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM payment_refunds WHERE payment_intent_id = $1",
      [intentId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
