// Brief 532 section A (A1 + A3), fail-first: a POS cash void is a refund path.
// Decision (founder-approved, Q63 + Q67): the void's cash is subject to the same
// cumulative approval ceiling as a refund, refused in edge mode, and refused
// when edge refund facts exist that central cannot verify. Whatever happens,
// total cash out of an order must never exceed what was paid.
//
// Expected error codes follow the existing refund path (REFUND_APPROVAL_LIMIT_EXCEEDED,
// REFUND_HISTORY_UNVERIFIED, REFUND_EXCEEDS_PAID). Order of checks in void:
// paid balance (REFUND_EXCEEDS_PAID), then the approver ceiling, then
// unverifiable edge facts (REFUND_HISTORY_UNVERIFIED). Deferred edge facts
// count as already paid out, so 150k deferred + a 300k void on a 300k sale
// trips REFUND_EXCEEDS_PAID (422) first; the invariant is cash out <= paid.
//
// Assumption: a rejected void must leave no pos_order_voids row and spend no
// approval (pos_order_approval_uses stays empty).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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
  idr,
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
import {
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { applyEdgeDeferredEvent } from "../edge/deferred-event-applier.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
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
const intentIds: string[] = [];
const fundIds: string[] = [];
const edgeNodeId = randomUUID();
// A cash void or refund needs the cashier's open shift on a registered device,
// and a void needs the sale's receipt (receipt port double below).
const deviceId = randomUUID();
let businessDate = "";
let cashier: Staff;
let supervisor: Staff;
let ownerApprover: Staff;

type Sale = {
  orderId: string;
  orderUuid: string;
  paid: number;
  intentId: string | null;
};

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const caller = () => ({
  userId: userIdSchema.parse(cashier.userId),
  deviceId,
  expectedVersion: null,
});

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

/** A completed POS sale paid in full with one tender (cash by default). */
async function sale(
  paid: number,
  method: "cash" | "edc_card" = "cash",
  // The tender is built once in its final shape (final-order tenders are
  // immutable), so a payment-ledger link must exist at insert time.
  withLedger = false,
): Promise<Sale> {
  const intentId = withLedger ? randomUUID() : null;
  const linkId = withLedger ? randomUUID() : null;
  if (intentId && linkId) {
    intentIds.push(intentId);
    linkIdsToDrop.push(linkId);
  }
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  orders.push(orderUuid);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', $6::date, now())`,
      [
        orderUuid,
        seededTenantId,
        seededOutletA,
        `VOID-${orderId.slice(-20)}`,
        paid,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    if (intentId && linkId) {
      await client.query(
        `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference,
           subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
        [
          linkId,
          seededTenantId,
          seededOutletA,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `Q67-${linkId}`,
          paid,
          cashier.userId,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
           order_id, method, provider, amount_idr, idempotency_key, status, paid_at,
           instructions, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid', now(),
           '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
        [
          intentId,
          seededTenantId,
          seededOutletA,
          linkId,
          orderUuid,
          paid,
          randomUUID(),
        ],
      );
    }
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at, received_idr,
         change_idr, payment_intent_id, payment_link_id, payment_link_token_sealed)
       VALUES ($1, $2, $3, $4, $5, $6, 'captured', $7, now(), now(), $8, $9, $10, $11, $12)`,
      [
        seededTenantId,
        seededOutletA,
        orderUuid,
        method,
        method === "cash" ? "manual" : "edc",
        paid,
        `REF-${orderId}`,
        method === "cash" ? paid : null,
        method === "cash" ? 0 : null,
        intentId,
        linkId,
        intentId ? "sealed-test-token" : null,
      ],
    );
  });
  return { orderId, orderUuid, paid, intentId };
}

async function approval(
  bill: Sale,
  action: "void" | "refund",
  amountIdr: number,
  approver: Staff,
) {
  const overrideId = createUlid();
  const overrideUuid = ulidToUuid(overrideId);
  overrides.push(overrideUuid);
  const reason = "Pelanggan salah pesan";
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
         requested_by, approved_by, reason, value_idr, object_type, object_id,
         request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'supervisor_pin', 'approved', $5, $6, $7, $8,
         'order', $9, $10, now(), now())`,
      [
        overrideUuid,
        seededTenantId,
        seededOutletA,
        action,
        cashier.userId,
        approver.userId,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: seededOutletA,
          action,
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: bill.orderId,
          approverUserId: approver.userId,
        }),
      ],
    ),
  );
  return { overrideId, overrideUuid, approvedBy: approver.userId };
}

async function voidOrder(bill: Sale, approver: Staff) {
  const verified = await approval(bill, "void", bill.paid, approver);
  return {
    verified,
    run: voidPosOrderCorrection(
      scope,
      caller(),
      outletIdSchema.parse(seededOutletA),
      bill.orderId,
      {
        reason: "customer_cancelled",
        reasonNote: "Pelanggan salah pesan",
        idempotencyKey: randomUUID(),
        overrideId: verified.overrideId,
        approvedBy: verified.approvedBy,
      } as Parameters<typeof voidPosOrderCorrection>[4],
    ),
  };
}

async function refund(bill: Sale, amountIdr: number, approver: Staff) {
  const verified = await approval(bill, "refund", amountIdr, approver);
  return refundPosOrder(
    scope,
    caller(),
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pemeriksaan riwayat edge",
      idempotencyKey: randomUUID(),
      overrideId: verified.overrideId,
      approvedBy: verified.approvedBy,
    } as Parameters<typeof refundPosOrder>[4],
  );
}

/** Legacy refund fact accepted from an edge node (central cannot verify it). */
function refundEvent(
  bill: Sale,
  amountIdr: number,
  envelopeAggregateId: string = bill.orderId,
) {
  const at = new Date(Date.now() - 1_000).toISOString();
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: seededTenantId,
    outletId: seededOutletA,
    name: "order.refunded",
    version: 1,
    // eventEnvelopeSchema ties the envelope's aggregateType to the event name.
    aggregateType: "order",
    aggregateId: envelopeAggregateId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "user", id: cashier.userId },
    deviceId: null,
    idempotencyKey: randomUUID(),
    payloadSchemaRef: "order.refunded.v1",
    payload: orderRefundedPayloadSchema.parse({
      orderId: bill.orderId,
      outletId: seededOutletA,
      businessDate,
      refundId: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Refund edge lama sudah dikembalikan ke tamu",
      approvedBy: supervisor.userId,
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: amountIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: amountIdr,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr }],
      refundedAt: at,
    }),
  });
}

async function deferredCashRefund(bill: Sale, amountIdr: number) {
  const event = refundEvent(bill, amountIdr);
  await withTenant(db, scope, (tx) =>
    applyEdgeDeferredEvent(tx, event, {
      context: scope,
      edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
    }),
  );
}

/**
 * An accepted legacy row whose indexed columns (aggregate_type/aggregate_id)
 * disagree with the envelope and payload, written exactly as stored. The
 * envelope itself stays valid (aggregateType 'order'); only the columns lie.
 * `bill` is the order named in the payload; the envelope and the row's
 * aggregate columns are set independently.
 */
async function rawDeferredRow(input: {
  bill: Sale;
  amountIdr: number;
  rowType: string;
  rowAggregateId: string;
  envelopeAggregateId: string;
}) {
  const event = refundEvent(
    input.bill,
    input.amountIdr,
    input.envelopeAggregateId,
  );
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id,
         aggregate_type, aggregate_id, aggregate_sequence, event_name, envelope,
         parked_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'order.refunded', $7::jsonb, 'deferred')`,
      [
        seededTenantId,
        seededOutletA,
        edgeNodeId,
        ulidToUuid(event.id),
        input.rowType,
        input.rowAggregateId,
        JSON.stringify(event),
      ],
    ),
  );
}

/**
 * Legacy void fact accepted from an edge node: an old edge voided a completed
 * sale offline and refunded the cash (central cannot verify the drawer).
 * `voidedFinalOrder` true means a completed sale was corrected (cash left).
 */
function voidEvent(bill: Sale, amountIdr: number, voidedFinalOrder = true) {
  const at = new Date(Date.now() - 1_000).toISOString();
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: seededTenantId,
    outletId: seededOutletA,
    name: "order.voided",
    version: 1,
    aggregateType: "order",
    aggregateId: bill.orderId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "user", id: cashier.userId },
    deviceId: null,
    idempotencyKey: randomUUID(),
    payloadSchemaRef: "order.voided.v1",
    payload: orderVoidedPayloadSchema.parse({
      orderId: bill.orderId,
      outletId: seededOutletA,
      businessDate,
      amountIdr,
      reason: "customer_cancelled",
      reasonNote: "Void edge lama, tunai sudah dikembalikan ke tamu",
      approvedBy: supervisor.userId,
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder,
      voidId: voidedFinalOrder ? randomUUID() : null,
      receiptNumber: voidedFinalOrder ? "Q67-EDGE01" : null,
      voidedAt: at,
    }),
  });
}

/** An edge `order.voided` of a final sale that central parks (cannot verify). */
async function deferredCashVoid(bill: Sale, amountIdr: number) {
  await withTenant(db, scope, (tx) =>
    applyEdgeDeferredEvent(tx, voidEvent(bill, amountIdr), {
      context: scope,
      edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
    }),
  );
}

async function parkedVoidCount(bill: Sale) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM edge_deferred_events
      WHERE tenant_id = $1 AND edge_node_id = $2 AND event_name = 'order.voided'
        AND envelope->'payload'->>'orderId' = $3`,
    [seededTenantId, edgeNodeId, bill.orderId],
  );
  return rows[0]!.n;
}

/**
 * The payer sent more than the bill: the surplus sat in an unallocated fund and
 * was already refunded to the payer (fund refund, not a refund of the sale).
 * The sale must have been created with withLedger = true.
 */
async function overpaymentRefunded(bill: Sale, amountIdr: number) {
  const fundId = randomUUID();
  fundIds.push(fundId);
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, 'overpayment')`,
    [fundId, seededTenantId, seededOutletA, bill.intentId, amountIdr],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
       amount_idr, reason, status, requested_by, approved_by, decided_at,
       completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Kembalikan kelebihan bayar', 'completed',
       'system:test', $6, now(), now(), $7)`,
    [
      randomUUID(),
      seededTenantId,
      seededOutletA,
      bill.intentId,
      amountIdr,
      ownerApprover.userId,
      fundId,
    ],
  );
}

async function adminRefund(bill: Sale, amountIdr: number) {
  // A completed admin refund on the payment ledger of this order's tender
  // (the sale must have been created with withLedger = true).
  await asOwner((client) =>
    client.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
         amount_idr, reason, status, requested_by, approved_by, decided_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'Riwayat refund admin', 'completed', 'q67-admin',
         $6, now(), now())`,
      [
        randomUUID(),
        seededTenantId,
        seededOutletA,
        bill.intentId,
        amountIdr,
        ownerApprover.userId,
      ],
    ),
  );
}
const linkIdsToDrop: string[] = [];

async function voidRows(bill: Sale) {
  const { rows } = await owner.query<{ voids: number; uses: number }>(
    `SELECT
       (SELECT count(*)::int FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2) AS voids,
       (SELECT count(*)::int FROM pos_order_approval_uses WHERE tenant_id = $1 AND order_id = $2) AS uses`,
    [seededTenantId, bill.orderUuid],
  );
  return rows[0]!;
}

async function nativeRefundTotal(bill: Sale) {
  const { rows } = await owner.query<{ total: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, bill.orderUuid],
  );
  return Number(rows[0]!.total);
}

/** Issues a receipt for any order on demand, like the real allocator would have at sale time. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  const issue = (orderId: string, outletId: string, at: Date) => {
    const existing = byOrder.get(orderId);
    if (existing) return existing;
    sequence += 1;
    const receipt = {
      id: randomUUID(),
      tenantId: seededTenantId,
      outletId,
      orderId,
      deviceId,
      number: `Q67-${String(sequence).padStart(6, "0")}`,
      sequenceNumber: sequence,
      status: "issued",
      issuedAt: at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    byOrder.set(orderId, receipt);
    return receipt;
  };
  return {
    async issueForSale(_tx, _context, input) {
      return issue(input.orderId, input.outletId, input.at);
    },
    async findForOrder(_tx, _context, orderId) {
      return issue(orderId, seededOutletA, new Date());
    },
    async voidForOrder(_tx, _context, input) {
      const found = issue(input.orderId, seededOutletA, input.at);
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

beforeAll(async () => {
  const app = createApp();
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Q67 Void Cashier",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    label: "Q67 Void Supervisor",
  });
  ownerApprover = await staffWithRole(app, {
    template: "owner",
    label: "Q67 Void Owner",
  });
  users.push(cashier.userId, supervisor.userId, ownerApprover.userId);
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    tenantId === seededTenantId && id === deviceId ? seededOutletA : null,
  );
  // A real open drawer with plenty of cash, so only the ceiling rules decide.
  const shift = await openPosShift(
    scope,
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletIdSchema.parse(seededOutletA),
    { openingFloatIdr: idr(10_000_000), idempotencyKey: randomUUID() },
  );
  const { rows } = await owner.query<{ business_date: string }>(
    "SELECT business_date::text AS business_date FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, shift.id],
  );
  businessDate = rows[0]!.business_date;
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label,
         credential_hash, revoked_at)
       VALUES ($1, $2, $3, 'standby', 'revoked', 'Void ceiling fixture', $4, now())`,
      [edgeNodeId, seededTenantId, seededOutletA, "b".repeat(64)],
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
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_unallocated_funds WHERE id = ANY($1::uuid[])",
      [fundIds],
    );
    await client.query(
      "DELETE FROM edge_deferred_events WHERE edge_node_id = $1",
      [edgeNodeId],
    );
    await client.query("DELETE FROM edge_nodes WHERE id = $1", [edgeNodeId]);
    await client.query(
      "DELETE FROM pos_shifts WHERE tenant_id = $1 AND device_id = $2",
      [seededTenantId, deviceId],
    );
    for (const table of [
      "pos_order_voids",
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
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIdsToDrop,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
  }, true);
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("POS-04 A1: a cash void obeys the refund ceilings (brief 532)", () => {
  it("a Supervisor cannot void a Rp200001 cash sale; nothing is voided or spent", async () => {
    const bill = await sale(200_001);
    const { run } = await voidOrder(bill, supervisor);
    await expect(run).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });

  it("void is refused in edge mode (no central refund history to prove the balance)", async () => {
    const bill = await sale(100_000);
    setEdgeRuntimeStateForTests({
      edgeMode: true,
      identity: null,
      link: {
        cloudLink: "connected",
        refused: false,
        lastConnectedAt: new Date(),
      },
    });
    const { run } = await voidOrder(bill, supervisor);
    await expect(run).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });

  it("void is refused during the edge boot window (EDGE_MODE=true) too", async () => {
    const bill = await sale(100_000);
    vi.stubEnv("EDGE_MODE", "true");
    const { run } = await voidOrder(bill, supervisor);
    await expect(run).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });

  it("a deferred edge refund of Rp150000 then an owner void of Rp300000 is refused; cash out stays within paid", async () => {
    const bill = await sale(300_000);
    await deferredCashRefund(bill, 150_000);
    const { run } = await voidOrder(bill, ownerApprover);
    await expect(run).rejects.toMatchObject({
      status: 422,
      code: "REFUND_EXCEEDS_PAID",
    });
    // Cash out = deferred 150k + any void/native refund: must be <= paid.
    const rows = await voidRows(bill);
    expect(rows).toEqual({ voids: 0, uses: 0 });
    expect(150_000 + (await nativeRefundTotal(bill))).toBeLessThanOrEqual(
      bill.paid,
    );
  });

  it("a central refund already completed plus a full void would pay out more than paid and is refused", async () => {
    const bill = await sale(300_000, "cash", true);
    await adminRefund(bill, 100_000);
    const { run } = await voidOrder(bill, ownerApprover);
    await expect(run).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });
});

describe("POS-04 A3: edge refund history is scoped to the order (brief 532)", () => {
  it("a deferred edge refund on order A does not block a normal refund on order B", async () => {
    const other = await sale(300_000);
    await deferredCashRefund(other, 150_000);
    const mine = await sale(100_000, "edc_card");
    const result = await refund(mine, 100_000, supervisor);
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeRefundTotal(mine)).toBe(100_000);
  });

  it("the deferred refund still counts for its own order (150k already out, 200k more exceeds the 300k paid)", async () => {
    const bill = await sale(300_000);
    await deferredCashRefund(bill, 150_000);
    await expect(refund(bill, 200_000, ownerApprover)).rejects.toBeDefined();
    expect(await nativeRefundTotal(bill)).toBe(0);
  });

  it("a row typed outside 'order' that names another order's id but whose payload is for X still fails X closed (void)", async () => {
    const other = await sale(100_000);
    const bill = await sale(300_000);
    await rawDeferredRow({
      bill,
      amountIdr: 150_000,
      rowType: "pos_order",
      rowAggregateId: other.orderId,
      envelopeAggregateId: other.orderId,
    });
    const { run } = await voidOrder(bill, ownerApprover);
    await expect(run).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });

  it("the same mismatched row still fails X closed for a refund", async () => {
    const other = await sale(100_000, "edc_card");
    const bill = await sale(300_000, "edc_card");
    await rawDeferredRow({
      bill,
      amountIdr: 150_000,
      rowType: "pos_order",
      rowAggregateId: other.orderId,
      envelopeAggregateId: other.orderId,
    });
    await expect(refund(bill, 100_000, ownerApprover)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await nativeRefundTotal(bill)).toBe(0);
  });

  it("a row typed outside 'order' whose aggregate_id is A but whose envelope and payload belong to B does not block A", async () => {
    const mine = await sale(100_000, "edc_card");
    const theirs = await sale(300_000, "edc_card");
    await rawDeferredRow({
      bill: theirs,
      amountIdr: 150_000,
      rowType: "pos_order",
      rowAggregateId: mine.orderId,
      envelopeAggregateId: theirs.orderId,
    });
    const result = await refund(mine, 100_000, supervisor);
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeRefundTotal(mine)).toBe(100_000);
  });
});

describe("POS-04 P1: a parked edge void counts as unverified cash out (brief 532b)", () => {
  // Assumption: an edge `order.voided` with voidedFinalOrder=true paid cash back
  // to the guest, and central cannot verify the drawer, so a later cloud void or
  // refund of the same order fails closed with REFUND_HISTORY_UNVERIFIED (409)
  // (the brief's decision) instead of paying the same Rp300000 out twice.
  it("a parked edge void of Rp300000 cash then a cloud void is refused; no second void or approval spent", async () => {
    const bill = await sale(300_000);
    await deferredCashVoid(bill, 300_000);
    // The fact is really parked (not applied): the order has no void row.
    expect(await parkedVoidCount(bill)).toBe(1);
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
    const { run } = await voidOrder(bill, ownerApprover);
    await expect(run).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await voidRows(bill)).toEqual({ voids: 0, uses: 0 });
  });

  it("a parked edge void of Rp300000 cash then a cloud refund is refused; no refund is written", async () => {
    const bill = await sale(300_000);
    await deferredCashVoid(bill, 300_000);
    expect(await parkedVoidCount(bill)).toBe(1);
    await expect(refund(bill, 100_000, ownerApprover)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_HISTORY_UNVERIFIED",
    });
    expect(await nativeRefundTotal(bill)).toBe(0);
  });

  it("a parked edge void for another order does not block a cloud void here", async () => {
    const other = await sale(300_000);
    await deferredCashVoid(other, 300_000);
    expect(await parkedVoidCount(other)).toBe(1);
    const mine = await sale(100_000);
    const { run } = await voidOrder(mine, supervisor);
    await run;
    expect((await voidRows(mine)).voids).toBe(1);
  });

  it("a parked edge void for another order does not block a cloud refund here", async () => {
    const other = await sale(300_000);
    await deferredCashVoid(other, 300_000);
    const mine = await sale(100_000, "edc_card");
    const result = await refund(mine, 100_000, supervisor);
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeRefundTotal(mine)).toBe(100_000);
  });

  it("an already materialized void (pos_order_voids row) is not treated as unverified history; a second void is refused as before", async () => {
    const bill = await sale(300_000);
    const first = await voidOrder(bill, ownerApprover);
    await first.run;
    expect((await voidRows(bill)).voids).toBe(1);
    const second = await voidOrder(bill, ownerApprover);
    const error = await second.run.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    // Refused for what it is (already voided / nothing left to pay), never as
    // an unverifiable edge fact: central knows this void.
    expect(error).not.toMatchObject({ code: "REFUND_HISTORY_UNVERIFIED" });
    expect((await voidRows(bill)).voids).toBe(1);
  });

  it("an already materialized void then a cloud refund is refused as exceeding paid, never as unverified history", async () => {
    const bill = await sale(300_000);
    await (
      await voidOrder(bill, ownerApprover)
    ).run;
    const error = await refund(bill, 100_000, ownerApprover).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(error).not.toMatchObject({ code: "REFUND_HISTORY_UNVERIFIED" });
    expect(await nativeRefundTotal(bill)).toBe(0);
  });
});

describe("POS-04 P2: overpayment refunds count toward the approver ceiling, not the paid cap (brief 532b)", () => {
  // The Supervisor ceiling is Rp200000 cumulative (brief 530 / Q63). Money
  // already returned for an overpayment is cash out to the guest, so it uses up
  // the approver's authority even though it never reduces what the sale paid.
  it("Rp150000 overpayment already refunded: a Supervisor POS refund of Rp200000 is refused (150k + 200k > 200k)", async () => {
    const bill = await sale(300_000, "cash", true);
    await overpaymentRefunded(bill, 150_000);
    await expect(refund(bill, 200_000, supervisor)).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeRefundTotal(bill)).toBe(0);
  });

  it("the Supervisor can still refund up to the ceiling left (Rp50000), but Rp50001 is refused", async () => {
    const bill = await sale(300_000, "cash", true);
    await overpaymentRefunded(bill, 150_000);
    await expect(refund(bill, 50_001, supervisor)).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeRefundTotal(bill)).toBe(0);
    const result = await refund(bill, 50_000, supervisor);
    expect(Number(result.amountIdr)).toBe(50_000);
    expect(await nativeRefundTotal(bill)).toBe(50_000);
  });

  it("the overpayment still does not count toward the paid cap: an owner refunds the full Rp300000 paid", async () => {
    const bill = await sale(300_000, "cash", true);
    await overpaymentRefunded(bill, 150_000);
    const result = await refund(bill, 300_000, ownerApprover);
    expect(Number(result.amountIdr)).toBe(300_000);
    expect(await nativeRefundTotal(bill)).toBe(300_000);
  });
});

// P3 (void cash counts toward the cumulative approver authority) is asserted on
// the admin refund path in payment-refund-role-limits.test.ts: a POS refund after
// a recorded void is refused outright (the sale is already voided), so only the
// admin/gateway refund can spend the remaining authority.
