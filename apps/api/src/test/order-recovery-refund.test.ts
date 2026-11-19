// legend-94q2l (T1, consumer): `deliverOrderRecoveryRefundEvent`
// (services/order-recovery-refund.ts), the payment-side consumer of
// `order_issue.manual_refund_approved` (ORD-09). Contract: docs/briefs/94q2l-impl-brief.md.
// Written from the contract before the service exists, so the file starts red.
//
// The resolve step (staff, with an approved ORD-09 request) writes the outbox
// event; the worker is not running in tests, so each test delivers that real
// event by hand inside a tenant transaction, as worker-main.ts does.
//
// Money in the standard order (helpers): kopi 2 x (25.000 + shot 5.000) = 60.000,
// roti 18.000; subtotal 78.000, service 5% = 3.900, PBJT 10% of 81.900 = 8.190,
// total 90.090. Pro-rata wanted: roti 18.000 + 900 + 1.890 = 20.790, kopi
// 60.000 + 3.000 + 6.300 = 69.300 (the two add up to the total).
//
// Assumptions where the brief is silent:
// - Audit rows are found by `event->>'action'` and `event->>'objectId'` (the
//   issue id); `payment.refund_requested` is found by the refund id in the text.
//   `blockedReason` is read from the audit row text (its field path is free).
// - A "released" refund of another issue is inserted directly as a
//   `payment_refunds` row with that issue's `order_issue_id` (status pending, or
//   failed + failure_reason cap_exceeded): the brief counts every status.
// - POS branch: a `pos_orders` row (channel 'pos') is inserted for the QR order.
// - Split bill: both brief variants are covered, an intent with `bill_split_id`
//   and an order with two paid intents.
// - Unsettled intent: pending, failed, expired and refunded all give
//   `intent_not_settled` (paid and partially_refunded are the settled ones).
// - No-intent: `orders.payment_intent_id` is cleared after the resolve.
// - A new refund is not `failed` (the exact status after `openRefundChainSafely`
//   is not asserted).
// - "Event kedua" = another envelope (new id and sequence) for the same issue.
// - Open bill: the intent is inserted as paid with `payment_evidence`, so the
//   refundable cap is its amount; a normal refund (no issue) reserves part of it.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { orderRefundedPayloadSchema } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import {
  CART_TOTAL,
  PRICES,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const KOPI_LINE = 60_000;
const ROTI_WANTED = 20_790;
const KOPI_WANTED = 69_300;

// ---- helpers ---------------------------------------------------------------

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** API ids may be ULIDs; the database stores uuids. */
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(
  event: EventEnvelope,
  tenantId: string = w.tenant.tenantId,
) {
  const context = contextOf(tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

type Approved = { issueId: string; approvalId: string; event: EventEnvelope };

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(
  itemId: string,
  lineTotalIdr: number,
): Promise<Approved> {
  const reported = await w.report(itemId);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: lineTotalIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    },
  );
  expect(resolved.status).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows, "manual_refund_approved event in the outbox").toHaveLength(1);
  return { issueId, approvalId, event: rows[0]!.event };
}

/** A paid pay-first order whose roti failed and was refund-approved. */
async function paidRotiRefund() {
  const paid = await w.paidOrder();
  const approved = await approvedRefund(paid.roti.id, PRICES.roti);
  return { ...paid, ...approved };
}

/** Report + approved refund approval + the resolve call, whatever its answer. */
async function refusedRefund(itemId: string, lineTotalIdr: number) {
  const reported = await w.report(itemId);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: lineTotalIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    },
  );
  return { issueId, approvalId, resolved };
}

function expectRoomRefusal(resolved: { status: number; body: unknown }) {
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(422);
  expect(
    (resolved.body as { error?: { code?: string } }).error?.code,
    JSON.stringify(resolved.body),
  ).toBe("REFUND_OVER_ORDER_ROOM");
}

async function expectIssueNotResolved(issueId: string) {
  const { rows } = await owner.query<{
    status: string;
    resolution: string | null;
  }>(
    "SELECT status, resolution FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows[0], "issue is not resolved").toMatchObject({
    status: "open",
    resolution: null,
  });
  expect(
    await w.outboxRows("order_issue.manual_refund_approved", issueId),
  ).toHaveLength(0);
}

async function intentIdOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_intent_id: string | null }>(
    "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows[0]!.payment_intent_id, "order has an intent").not.toBeNull();
  return rows[0]!.payment_intent_id!;
}

type RefundRow = {
  id: string;
  payment_intent_id: string;
  order_issue_id: string;
  amount_idr: number;
  status: string;
  requested_by: string;
  reason: string;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, payment_intent_id, order_issue_id, amount_idr::int AS amount_idr,
            status, requested_by, reason
     FROM payment_refunds WHERE tenant_id = $1 AND order_issue_id = $2
     ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function intentRefundCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [w.tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

/** Audit rows of one action about one issue (objectType order_issue). */
async function auditRows(issueId: string, action: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, issueId],
  );
  return rows.map((row) => row.event);
}

async function auditCount(issueId: string, action: string) {
  return (await auditRows(issueId, action)).length;
}

/** The single audit row of an order_issue.* action, checked for its object. */
async function onlyAudit(issueId: string, action: string) {
  const rows = await auditRows(issueId, action);
  expect(rows, `${action} audit row`).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action,
    objectType: "order_issue",
    objectId: issueId,
    actorType: "system",
  });
  return JSON.stringify(rows[0]);
}

async function paymentRefundAuditCount(refundId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = 'payment.refund_requested'
       AND event::text LIKE $2`,
    [w.tenant.tenantId, `%${refundId}%`],
  );
  return Number(rows[0]!.n);
}

/** `order.refunded` events of one order; refundId is the issue id. */
async function orderRefundedEvents(orderId: string) {
  return w.outboxRows("order.refunded", orderId);
}

async function idempotencyRow(issueId: string) {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
     WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return rows;
}

/** Refundable cap and reserved amount of an intent, as the admin module sees them. */
async function holdOf(intentId: string) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    const balance = await refundableBalance(tx, intent!, {
      lockDeposit: false,
    });
    return { cap: Number(balance.cap), reserved: Number(balance.reserved) };
  });
}

/** A refund row of `amountIdr` for `intentId`, as an earlier issue or refund left it. */
async function insertRefund(input: {
  intentId: string;
  amountIdr: number;
  status: "pending" | "failed";
  orderIssueId: string | null;
}) {
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, order_issue_id, amount_idr,
        reason, status, requested_by, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'Refund uji T1', $7, 'user-uji', $8)`,
    [
      randomUUID(),
      w.tenant.tenantId,
      w.tenant.outletId,
      input.intentId,
      input.orderIssueId,
      input.amountIdr,
      input.status,
      input.status === "failed" ? "cap_exceeded" : null,
    ],
  );
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    outlet_id: string;
    business_date: string;
    table_session_id: string | null;
  }>(
    `SELECT outlet_id, business_date::text AS business_date, table_session_id
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!;
}

/** Nothing was refunded: no refund row, no order.refunded, no idempotency row. */
async function expectNoRefund(
  issueId: string,
  orderId: string,
  intentId: string | null,
) {
  expect(await issueRefunds(issueId)).toHaveLength(0);
  expect(await orderRefundedEvents(orderId)).toHaveLength(0);
  expect(await idempotencyRow(issueId)).toHaveLength(0);
  expect(await auditCount(issueId, "order_issue.refund_requested")).toBe(0);
  if (intentId !== null) expect(await intentRefundCount(intentId)).toBe(0);
}

// ---- branch 5: QR pay-first (the main flow) --------------------------------

describe("legend-94q2l cabang 5: QR pay_first, refund dibuka dari approval item gagal", () => {
  it("membuka satu refund pembayaran dengan aktor system:recovery, jumlah pro-rata, kunci idempotensi dan audit", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);

    await deliver(event);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      payment_intent_id: intentId,
      order_issue_id: issueId,
      amount_idr: ROTI_WANTED,
      requested_by: "system:recovery",
      reason: "Refund item gagal (ORD-09)",
    });
    expect(refunds[0]!.status).not.toBe("failed");

    // Idempotency row, keyed by the issue; the response names the refund and both people.
    const keyRows = await idempotencyRow(issueId);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!.response).toMatchObject({
      refundId: refunds[0]!.id,
      resolvedBy: w.supervisor.userId,
      approvedBy: w.approverUserId,
    });

    // Audit: the issue side and the payment side, once each, no blocked or shortfall row.
    await onlyAudit(issueId, "order_issue.refund_requested");
    expect(await paymentRefundAuditCount(refunds[0]!.id)).toBe(1);
    expect(await auditCount(issueId, "order_issue.refund_blocked")).toBe(0);
    expect(await auditCount(issueId, "order_issue.refund_shortfall")).toBe(0);
    expect(await auditCount(issueId, "order_issue.refund_routed_pos")).toBe(0);

    // payment.refund_requested domain event for the new refund.
    expect(
      await w.outboxRows("payment.refund_requested", refunds[0]!.id),
    ).toHaveLength(1);
  });

  it("menulis event order.refunded di outbox yang membalik pendapatan baris itu", async () => {
    const { order, issueId, approvalId, event } = await paidRotiRefund();
    const row = await orderRow(order.id);

    await deliver(event);

    const events = await orderRefundedEvents(order.id);
    expect(events).toHaveLength(1);
    const payload = events[0]!.event.payload as Record<string, unknown>;
    // The envelope payload is a valid order.refunded payload (split identity holds).
    expect(() => orderRefundedPayloadSchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      orderId: order.id,
      outletId: w.tenant.outletId,
      businessDate: row.business_date,
      refundId: issueId,
      amountIdr: ROTI_WANTED,
      reason: "other",
      reasonNote: REASON,
      approvedBy: w.approverUserId,
      overrideId: null,
      approvalRequestId: approvalId,
      grossSalesIdr: PRICES.roti,
      discountIdr: 0,
      serviceChargeIdr: 900,
      pbjtIdr: 1_890,
      refundCashIdr: 0,
      refundGatewayIdr: ROTI_WANTED,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
    });
    const lines = payload.lines as { method: string; amountIdr: number }[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amountIdr).toBe(ROTI_WANTED);
    expect(payload.refundedAt).toEqual(expect.any(String));
  });

  it("hold dilepas: cap refund intent naik sebesar jumlah refund (dari 0)", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);

    // Fired pay-first sale: the whole total is held, nothing refundable.
    expect(await holdOf(intentId)).toEqual({ cap: 0, reserved: 0 });

    await deliver(event);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await holdOf(intentId)).toEqual({
      cap: ROTI_WANTED,
      reserved: ROTI_WANTED,
    });
  });

  it("dua issue pada order yang sama: hold dilepas per issue, total refund = total order, tanpa selisih", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    const kopi = await approvedRefund(paid.kopi.id, KOPI_LINE);
    const roti = await approvedRefund(paid.roti.id, PRICES.roti);

    await deliver(kopi.event);
    expect(await holdOf(intentId)).toMatchObject({ cap: KOPI_WANTED });
    await deliver(roti.event);

    expect((await issueRefunds(kopi.issueId))[0]!.amount_idr).toBe(KOPI_WANTED);
    expect((await issueRefunds(roti.issueId))[0]!.amount_idr).toBe(ROTI_WANTED);
    expect(KOPI_WANTED + ROTI_WANTED).toBe(CART_TOTAL);
    expect(await holdOf(intentId)).toMatchObject({ cap: CART_TOTAL });
    expect(await orderRefundedEvents(paid.order.id)).toHaveLength(2);
    expect(await auditCount(roti.issueId, "order_issue.refund_shortfall")).toBe(
      0,
    );
  });

  it("partially_refunded dianggap settled: refund tetap dibuka", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    await owner.query(
      "UPDATE payment_intents SET status = 'partially_refunded' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, intentId],
    );

    await deliver(event);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
  });
});

// ---- idempotency -----------------------------------------------------------

describe("legend-94q2l idempotensi: tidak ada refund ganda", () => {
  it("event yang sama dikirim ulang: satu refund, satu order.refunded, satu audit", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);

    await deliver(event);
    await deliver(event);
    await deliver(event);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await intentRefundCount(intentId)).toBe(1);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    expect(await idempotencyRow(issueId)).toHaveLength(1);
    expect(await auditCount(issueId, "order_issue.refund_requested")).toBe(1);
    expect(await holdOf(intentId)).toMatchObject({ cap: ROTI_WANTED });
  });

  it("event kedua (envelope lain) untuk issue yang sama: tidak ada refund kedua", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    await deliver(event);

    const second: EventEnvelope = {
      ...event,
      id: createUlid(),
      sequence: event.sequence + 1,
      idempotencyKey: `${event.idempotencyKey}-kedua`.slice(0, 100),
    };
    await deliver(second);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await intentRefundCount(intentId)).toBe(1);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    expect(await holdOf(intentId)).toMatchObject({ cap: ROTI_WANTED });
  });

  it("dua pengiriman bersamaan: tepat satu refund", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);

    await Promise.all([deliver(event), deliver(event)]);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await intentRefundCount(intentId)).toBe(1);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
  });
});

// ---- ignored events --------------------------------------------------------

describe("legend-94q2l event yang diabaikan: tidak melempar, tidak mengubah apa pun", () => {
  it("event lain, tenant lain, outlet lain, payload tidak valid, dan issue yang bukan manual_refund", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);

    // A swap-resolved issue: its resolution is not manual_refund.
    const swapPaid = await w.paidOrder();
    const swapIssue = (await w.report(swapPaid.roti.id)).body.data.id as string;
    const swapped = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${swapIssue}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.teh },
    );
    expect(swapped.status).toBe(200);

    const ignored: [string, unknown][] = [
      ["event lain", { ...event, name: "order_issue.resolved" }],
      ["tenant lain", { ...event, tenantId: randomUUID() }],
      ["outlet lain", { ...event, outletId: w.ids.otherOutlet }],
      [
        "payload tidak valid",
        { ...event, payload: { orderIssueId: issueId, amountIdr: -5 } },
      ],
      [
        "issue yang bukan manual_refund",
        { ...event, payload: { ...event.payload, orderIssueId: swapIssue } },
      ],
    ];
    for (const [label, envelope] of ignored) {
      // A business "not for me" answer must not throw (it would retry for ever).
      await deliver(envelope as EventEnvelope).catch((error: unknown) => {
        throw new Error(`${label}: delivery threw: ${String(error)}`);
      });
    }

    expect(await issueRefunds(issueId)).toHaveLength(0);
    expect(await issueRefunds(swapIssue)).toHaveLength(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);
    expect(await orderRefundedEvents(swapPaid.order.id)).toHaveLength(0);
    expect(await intentRefundCount(intentId)).toBe(0);
    expect(await idempotencyRow(issueId)).toHaveLength(0);
    expect(await idempotencyRow(swapIssue)).toHaveLength(0);

    // The real event is still consumed afterwards: nothing above used it up.
    await deliver(event);
    expect(await issueRefunds(issueId)).toHaveLength(1);
  });
});

// ---- branch 1: POS order ---------------------------------------------------

describe("legend-94q2l cabang 1: order punya baris pos_orders", () => {
  it("tidak membuka refund; audit refund_routed_pos (kasir memakai refundPosOrder)", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    const row = await orderRow(order.id);
    // The database requires a pos_orders row to share its order's channel
    // ('qr' is not allowed there), so the order becomes a POS-channel order.
    await owner.query(
      "UPDATE orders SET channel = 'pos' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(order.id)],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [toUuid(order.id), w.tenant.tenantId, row.outlet_id],
    );

    await deliver(event);

    await expectNoRefund(issueId, order.id, intentId);
    await onlyAudit(issueId, "order_issue.refund_routed_pos");
    expect(await auditCount(issueId, "order_issue.refund_blocked")).toBe(0);
  });
});

// ---- branch 2: split bill --------------------------------------------------

describe("legend-94q2l cabang 2: split bill ditolak", () => {
  it("intent dengan bill_split_id: refund_blocked split_bill, tidak ada refund", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    const row = await orderRow(order.id);
    const splitId = randomUUID();
    await owner.query(
      `INSERT INTO bill_splits
         (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id,
          method, share_index, amount_idr, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'equal', 0, $7, 'paid', now())`,
      [
        splitId,
        w.tenant.tenantId,
        row.outlet_id,
        row.table_session_id,
        toUuid(order.id),
        randomUUID(),
        CART_TOTAL,
      ],
    );
    await owner.query(
      "UPDATE payment_intents SET bill_split_id = $3 WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, intentId, splitId],
    );

    await deliver(event);

    await expectNoRefund(issueId, order.id, intentId);
    expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
      /"blockedReason":\s*"split_bill"/,
    );
  });

  it("order dengan dua intent dibayar: refund_blocked split_bill, tidak ada refund", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    const row = await orderRow(order.id);
    // Both intents name the order (as split-part intents do), two settled ones.
    await owner.query(
      "UPDATE payment_intents SET order_id = $3 WHERE tenant_id = $1 AND id = $2 AND order_id IS NULL",
      [w.tenant.tenantId, intentId, toUuid(order.id)],
    );
    const linkId = randomUUID();
    const otherIntentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 1000, 1000, '94q2l-test')`,
      [
        linkId,
        w.tenant.tenantId,
        row.outlet_id,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `Q2-${linkId.slice(0, 8)}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 1000, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now())`,
      [
        otherIntentId,
        w.tenant.tenantId,
        row.outlet_id,
        linkId,
        toUuid(order.id),
        `q2-${otherIntentId}`,
      ],
    );

    // The other intent holds real money (evidence 1.000, none unallocated).
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 1000, now())`,
      [
        w.tenant.tenantId,
        row.outlet_id,
        otherIntentId,
        `evidence-${otherIntentId}`,
      ],
    );

    await deliver(event);

    await expectNoRefund(issueId, order.id, intentId);
    expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
      /"blockedReason":\s*"split_bill"/,
    );
  });
  /**
   * A second code (intent) on the order's own payment link, with no order_id,
   * as a QR refresh or a second payer leaves it: settled, `evidenceIdr` of
   * evidence, and `unallocatedIdr` of that booked as unallocated funds.
   */
  async function secondCodeOnLink(
    orderId: string,
    evidenceIdr: number,
    unallocatedIdr: number,
  ) {
    const { rows } = await owner.query<{
      payment_link_id: string;
      outlet_id: string;
    }>(
      "SELECT payment_link_id, outlet_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(orderId)],
    );
    const linkId = rows[0]!.payment_link_id;
    expect(linkId, "order has a payment link").not.toBeNull();
    const otherIntentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, NULL, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now())`,
      [
        otherIntentId,
        w.tenant.tenantId,
        rows[0]!.outlet_id,
        linkId,
        evidenceIdr,
        `q2-link-${otherIntentId}`,
      ],
    );
    const evidenceId = randomUUID();
    await owner.query(
      `INSERT INTO payment_evidence
         (id, tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, $4, 'doit', $5, 'qris', 'verified_webhook', $6, now())`,
      [
        evidenceId,
        w.tenant.tenantId,
        rows[0]!.outlet_id,
        otherIntentId,
        `evidence-${otherIntentId}`,
        evidenceIdr,
      ],
    );
    if (unallocatedIdr > 0)
      await owner.query(
        `INSERT INTO payment_unallocated_funds
           (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
        [
          randomUUID(),
          w.tenant.tenantId,
          rows[0]!.outlet_id,
          otherIntentId,
          evidenceId,
          unallocatedIdr,
        ],
      );
  }

  it("kode kedua di payment link yang sama tanpa order_id dengan evidence > 0: split_bill, tidak ada refund", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    await secondCodeOnLink(order.id, 1_000, 0);

    await deliver(event);

    await expectNoRefund(issueId, order.id, intentId);
    expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
      /"blockedReason":\s*"split_bill"/,
    );
  });

  it("kode kedua di link yang sama yang uangnya seluruhnya unallocated (pembayaran ganda): bukan split, refund dibuka", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    await secondCodeOnLink(order.id, 1_000, 1_000);

    await deliver(event);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      payment_intent_id: intentId,
      amount_idr: ROTI_WANTED,
    });
    expect(await auditCount(issueId, "order_issue.refund_blocked")).toBe(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
  });
});

describe("legend-i83ls cabang 2: intent tagihan selisih swap bukan pembayar bill", () => {
  /**
   * The paid intent of a swap-difference charge of the order: its own payment
   * link (never the order's), named after the order, real evidence, and an
   * `order_issue_charges` row that points at link and intent. Issue foreign
   * keys are skipped (the refund check reads only the charge's link and intent).
   */
  async function paidChargeIntent(orderId: string) {
    const row = await orderRow(orderId);
    const linkId = randomUUID();
    const chargeIntentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 2420, 2420, 2420, 'i83ls-test')`,
      [
        linkId,
        w.tenant.tenantId,
        row.outlet_id,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `OC-${linkId.slice(0, 8)}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 2420, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now())`,
      [
        chargeIntentId,
        w.tenant.tenantId,
        row.outlet_id,
        linkId,
        toUuid(orderId),
        `i83ls-${chargeIntentId}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 2420, now())`,
      [
        w.tenant.tenantId,
        row.outlet_id,
        chargeIntentId,
        `evidence-${chargeIntentId}`,
      ],
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO order_issue_charges
           (tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id,
            payment_link_token_sealed, payment_intent_id, paid_at)
         VALUES ($1, $2, $3, $4, 'qr_link', 'paid', 2000, 2000, 200, 220, 2420, $5, 'sealed', $6, now())`,
        [
          w.tenant.tenantId,
          row.outlet_id,
          randomUUID(),
          toUuid(orderId),
          linkId,
          chargeIntentId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return chargeIntentId;
  }

  it("intent tagihan selisih yang dibayar (order_id = order): bukan split, refund dibuka", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    const intentId = await intentIdOf(order.id);
    await paidChargeIntent(order.id);

    await deliver(event);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      payment_intent_id: intentId,
      amount_idr: ROTI_WANTED,
    });
    expect(await auditCount(issueId, "order_issue.refund_blocked")).toBe(0);
  });
});

// ---- branch 3: no intent ---------------------------------------------------

describe("legend-94q2l cabang 3: order tanpa intent", () => {
  it("refund_blocked no_intent, tidak ada refund, tidak melempar", async () => {
    const { order, issueId, event } = await paidRotiRefund();
    await owner.query(
      "UPDATE orders SET payment_intent_id = NULL WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(order.id)],
    );

    await deliver(event);

    await expectNoRefund(issueId, order.id, null);
    expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
      /"blockedReason":\s*"no_intent"/,
    );
  });
});

// ---- branch 4: intent not settled ------------------------------------------

describe("legend-94q2l cabang 4: intent belum settled", () => {
  for (const status of ["pending", "failed", "expired", "refunded"]) {
    it(`intent ${status}: refund_blocked intent_not_settled, tidak ada refund`, async () => {
      const { order, issueId, event } = await paidRotiRefund();
      const intentId = await intentIdOf(order.id);
      // pending / failed / expired never carry paid_at; refunded keeps it.
      await owner.query(
        `UPDATE payment_intents
            SET status = $3${status === "refunded" ? "" : ", paid_at = NULL"}
          WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, intentId, status],
      );

      await deliver(event);

      await expectNoRefund(issueId, order.id, intentId);
      expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
        /"blockedReason":\s*"intent_not_settled"/,
      );
    });
  }
});

// ---- shortfall and nothing left --------------------------------------------

describe("legend-94q2l selisih dan sisa habis (cabang 5)", () => {
  // 1131 (CTO rule "422, never clamped"): an ORD-09 refund that does not fit the order's
  // room is refused when it is resolved; it is never cut to the room.
  it("room lebih kecil dari wanted: resolve ditolak 422 REFUND_OVER_ORDER_ROOM, issue tidak selesai, tanpa refund dan tanpa order.refunded", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    // Another issue of this order already released 75.000: room = 90.090 - 75.000 = 15.090.
    const kopiIssue = (await w.report(paid.kopi.id)).body.data.id as string;
    await insertRefund({
      intentId,
      amountIdr: 75_000,
      status: "pending",
      orderIssueId: kopiIssue,
    });
    const refused = await refusedRefund(paid.roti.id, PRICES.roti);

    expectRoomRefusal(refused.resolved);
    await expectIssueNotResolved(refused.issueId);
    expect(await issueRefunds(refused.issueId)).toHaveLength(0);
    expect(await orderRefundedEvents(paid.order.id)).toHaveLength(0);
    expect(await idempotencyRow(refused.issueId)).toHaveLength(0);
    // The money that already left stays the only refund of the order.
    expect(await issueRefunds(kopiIssue)).toHaveLength(1);
  });

  it("hanya jumlah terbesar per issue yang dihitung sebagai dilepas (refund gagal + refund baru untuk issue yang sama)", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    const kopiIssue = (await w.report(paid.kopi.id)).body.data.id as string;
    // Same issue: a failed refund of 40.000 and a pending one of 40.000.
    // Released = 40.000 (max per issue), not 80.000 (sum): room 50.090 >= 20.790.
    await insertRefund({
      intentId,
      amountIdr: 40_000,
      status: "failed",
      orderIssueId: kopiIssue,
    });
    await insertRefund({
      intentId,
      amountIdr: 40_000,
      status: "pending",
      orderIssueId: kopiIssue,
    });
    const roti = await approvedRefund(paid.roti.id, PRICES.roti);

    await deliver(roti.event);

    expect((await issueRefunds(roti.issueId))[0]!.amount_idr).toBe(ROTI_WANTED);
    expect(await auditCount(roti.issueId, "order_issue.refund_shortfall")).toBe(
      0,
    );
  });

  it("tidak ada sisa (room 0): resolve ditolak 422 REFUND_OVER_ORDER_ROOM, issue tidak selesai, tanpa refund dan tanpa order.refunded", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    const kopiIssue = (await w.report(paid.kopi.id)).body.data.id as string;
    await insertRefund({
      intentId,
      amountIdr: CART_TOTAL,
      status: "pending",
      orderIssueId: kopiIssue,
    });
    const refused = await refusedRefund(paid.roti.id, PRICES.roti);

    expectRoomRefusal(refused.resolved);
    await expectIssueNotResolved(refused.issueId);
    expect(await issueRefunds(refused.issueId)).toHaveLength(0);
    expect(await orderRefundedEvents(paid.order.id)).toHaveLength(0);
    expect(await idempotencyRow(refused.issueId)).toHaveLength(0);
  });

  it("refund issue lain yang gagal (status failed, alasan apa pun) tidak dihitung dilepas: penjualan menahan uangnya lagi (legend-iu91r)", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    const kopiIssue = (await w.report(paid.kopi.id)).body.data.id as string;
    await insertRefund({
      intentId,
      amountIdr: CART_TOTAL,
      status: "failed",
      orderIssueId: kopiIssue,
    });
    const roti = await approvedRefund(paid.roti.id, PRICES.roti);

    await deliver(roti.event);

    expect((await issueRefunds(roti.issueId))[0]!.amount_idr).toBe(ROTI_WANTED);
    expect(await auditCount(roti.issueId, "order_issue.refund_blocked")).toBe(
      0,
    );
  });
});

// ---- branch 6: open bill ---------------------------------------------------

describe("legend-94q2l cabang 6: open_bill tanpa pos_orders, intent settled", () => {
  /**
   * An open-bill order (sent) paid through a settled intent with evidence, as
   * the cashier flow leaves it. Rows are inserted directly because the guest
   * cannot pay an unsettled open bill through the API (409).
   */
  async function paidOpenBill() {
    const made = await w.openBillOrder();
    const orderId = toUuid(made.order.id);
    const row = await orderRow(made.order.id);
    const linkId = randomUUID();
    const intentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, '94q2l-test')`,
      [
        linkId,
        w.tenant.tenantId,
        row.outlet_id,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `OB-${linkId.slice(0, 8)}`,
        CART_TOTAL,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now())`,
      [
        intentId,
        w.tenant.tenantId,
        row.outlet_id,
        linkId,
        orderId,
        CART_TOTAL,
        `ob-${intentId}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        w.tenant.tenantId,
        row.outlet_id,
        intentId,
        `evidence-${intentId}`,
        CART_TOTAL,
      ],
    );
    await owner.query(
      "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, orderId, intentId],
    );
    const approved = await approvedRefund(made.roti.id, PRICES.roti);
    return { ...made, intentId, ...approved };
  }

  it("membuka refund biasa tanpa order.refunded; kunci idempotensi dan audit sama", async () => {
    const { order, intentId, issueId, event } = await paidOpenBill();

    await deliver(event);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      payment_intent_id: intentId,
      amount_idr: ROTI_WANTED,
      requested_by: "system:recovery",
      reason: "Refund item gagal (ORD-09)",
    });
    expect(refunds[0]!.status).not.toBe("failed");
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);
    const keyRows = await idempotencyRow(issueId);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!.response).toMatchObject({
      refundId: refunds[0]!.id,
      resolvedBy: w.supervisor.userId,
      approvedBy: w.approverUserId,
    });
    await onlyAudit(issueId, "order_issue.refund_requested");
    expect(await paymentRefundAuditCount(refunds[0]!.id)).toBe(1);
    expect(await auditCount(issueId, "order_issue.refund_shortfall")).toBe(0);
  });

  it("event diulang: tetap satu refund", async () => {
    const { intentId, issueId, event } = await paidOpenBill();

    await deliver(event);
    await deliver(event);

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await intentRefundCount(intentId)).toBe(1);
    expect(await idempotencyRow(issueId)).toHaveLength(1);
  });

  it("sisa cap - reserved lebih kecil dari wanted: refund dipotong, selisih diaudit", async () => {
    const { order, intentId, issueId, event } = await paidOpenBill();
    // A normal refund (no issue) already reserves 80.000: 90.090 - 80.000 = 10.090.
    await insertRefund({
      intentId,
      amountIdr: 80_000,
      status: "pending",
      orderIssueId: null,
    });

    await deliver(event);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(10_090);
    await onlyAudit(issueId, "order_issue.refund_shortfall");
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);
  });

  it("intent open bill belum settled: refund_blocked intent_not_settled", async () => {
    const { order, intentId, issueId, event } = await paidOpenBill();
    await owner.query(
      "UPDATE payment_intents SET status = 'pending', paid_at = NULL WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, intentId],
    );

    await deliver(event);

    await expectNoRefund(issueId, order.id, intentId);
    expect(await onlyAudit(issueId, "order_issue.refund_blocked")).toMatch(
      /"blockedReason":\s*"intent_not_settled"/,
    );
  });
});

async function idempotencyByKey(key: string) {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, key],
  );
  return rows;
}

// ---- Putaran 2 (R1): re-file of a recovery refund that failed -------------------

describe("legend-94q2l T3 refund system:recovery yang gagal dibuka ulang (R1)", () => {
  // Assumptions (brief "Putaran 2", R1):
  // - Failure is produced the way production does it: the approval request of the
  //   refund's chain is marked expired (approval_expired) or rejected, then
  //   `settleRefundFromChain` ends the refund `failed` through `failRefund`,
  //   which calls `refileRecoveryRefundAfterFailure`.
  // - Four-eyes of the new refund is read from its idempotency row (key
  //   `order-recovery-refund:<issueId>:<failedRefundId>`, response copied from the
  //   original row) and its own pending approval chain; the payout approval over
  //   HTTP is covered by order-recovery-refund-four-eyes.test.ts.
  // - A refund that was rejected is not re-filed (CTO decision follows): audit
  //   `order_issue.refund_rejected`, no `order_issue.refund_refiled`.

  // The refund chain only opens when the tenant has a refund approval policy:
  // one level for every amount, decided by the supervisor role (never the
  // consumer, which only files the refund).
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', 0, $2, 1)`,
      [w.tenant.tenantId, w.ids.supervisorRole],
    );
  });

  /** Ends the refund `failed` as an expired or rejected approval chain does. */
  async function failChain(
    refundId: string,
    how: "approval_expired" | "rejected",
  ) {
    if (how === "approval_expired")
      await owner.query(
        "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
        [w.tenant.tenantId, refundId],
      );
    else
      await owner.query(
        `UPDATE approval_requests
            SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak uji T3'
          WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
        [w.tenant.tenantId, refundId, w.approverUserId],
      );
    const settled = await settleRefundFromChain(
      contextOf(w.tenant.tenantId),
      refundId,
    );
    expect(settled.status).toBe("failed");
    expect(settled.failureReason).toBe(how);
  }

  async function pendingChains(refundId: string) {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM approval_requests
        WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2
          AND status = 'pending'`,
      [w.tenant.tenantId, refundId],
    );
    return Number(rows[0]!.n);
  }

  /** A delivered recovery refund (pending, chain open) of a failed roti. */
  async function deliveredRefund() {
    const made = await paidRotiRefund();
    const intentId = await intentIdOf(made.order.id);
    await deliver(made.event);
    const refunds = await issueRefunds(made.issueId);
    expect(refunds).toHaveLength(1);
    return { ...made, intentId, first: refunds[0]! };
  }

  it("approval_expired: refund baru pending dengan nominal sama, satu order.refunded, hold tidak berubah, jejak four-eyes tersalin", async () => {
    const { order, issueId, intentId, first } = await deliveredRefund();
    const holdBefore = await holdOf(intentId);
    expect(holdBefore).toEqual({ cap: ROTI_WANTED, reserved: ROTI_WANTED });

    await failChain(first.id, "approval_expired");

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(2);
    expect(refunds.find((row) => row.id === first.id)!.status).toBe("failed");
    const live = refunds.find((row) => row.status !== "failed")!;
    expect(live).toMatchObject({
      status: "pending",
      amount_idr: ROTI_WANTED,
      requested_by: "system:recovery",
      payment_intent_id: intentId,
      order_issue_id: issueId,
      reason: "Refund item gagal (ORD-09)",
    });
    expect(live.id).not.toBe(first.id);

    // Revenue was reversed once; the re-file books no second order.refunded.
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    // The failed refund released its reservation, the new one took it: no change.
    expect(await holdOf(intentId)).toEqual(holdBefore);

    // Key per failed refund; response copied from the original row.
    const original = await idempotencyByKey(`order-recovery-refund:${issueId}`);
    expect(original).toHaveLength(1);
    const refiled = await idempotencyByKey(
      `order-recovery-refund:${issueId}:${first.id}`,
    );
    expect(refiled).toHaveLength(1);
    expect(refiled[0]!.response).toMatchObject({
      refundId: live.id,
      resolvedBy: w.supervisor.userId,
      approvedBy: w.approverUserId,
    });

    // Audit and events of the new refund; an approval chain is open for it.
    await onlyAudit(issueId, "order_issue.refund_refiled");
    expect(await paymentRefundAuditCount(live.id)).toBe(1);
    expect(
      await w.outboxRows("payment.refund_requested", live.id),
    ).toHaveLength(1);
    expect(await pendingChains(live.id)).toBeGreaterThan(0);
    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      0,
    );
  });

  it("rejected: tidak dibuka ulang; audit order_issue.refund_rejected", async () => {
    const { order, issueId, intentId, first } = await deliveredRefund();

    await failChain(first.id, "rejected");

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: first.id, status: "failed" });
    await onlyAudit(issueId, "order_issue.refund_rejected");
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
    expect(
      await idempotencyByKey(`order-recovery-refund:${issueId}:${first.id}`),
    ).toHaveLength(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    // Rejection is final (CTO 10 Nov): the sale holds the money again, so
    // nothing is refundable and nothing is reserved.
    expect(await holdOf(intentId)).toEqual({ cap: 0, reserved: 0 });
  });

  it("gagal kedua kali: dibuka ulang lagi dengan kunci berbeda, tetap satu refund hidup dan satu order.refunded", async () => {
    const { order, issueId, intentId, first } = await deliveredRefund();
    await failChain(first.id, "approval_expired");
    const second = (await issueRefunds(issueId)).find(
      (row) => row.status !== "failed",
    )!;

    await failChain(second.id, "approval_expired");

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(3);
    const live = refunds.filter((row) => row.status !== "failed");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      status: "pending",
      amount_idr: ROTI_WANTED,
      requested_by: "system:recovery",
    });
    expect([first.id, second.id]).not.toContain(live[0]!.id);

    const keyFirst = `order-recovery-refund:${issueId}:${first.id}`;
    const keySecond = `order-recovery-refund:${issueId}:${second.id}`;
    expect(keyFirst).not.toBe(keySecond);
    expect(await idempotencyByKey(keyFirst)).toHaveLength(1);
    const refiledAgain = await idempotencyByKey(keySecond);
    expect(refiledAgain).toHaveLength(1);
    expect(refiledAgain[0]!.response).toMatchObject({
      refundId: live[0]!.id,
      resolvedBy: w.supervisor.userId,
      approvedBy: w.approverUserId,
    });
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(2);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    expect(await holdOf(intentId)).toEqual({
      cap: ROTI_WANTED,
      reserved: ROTI_WANTED,
    });
  });

  it("baris idempotensi asli tidak ada: tidak dibuka ulang; audit order_issue.refund_refile_blocked", async () => {
    const { issueId, first } = await deliveredRefund();
    await owner.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = $2",
      [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
    );

    await failChain(first.id, "approval_expired");

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe("failed");
    await onlyAudit(issueId, "order_issue.refund_refile_blocked");
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
  });
});

// ---- Putaran 3 (R5, R6): which failures are re-filed, and how often ---------------

describe("legend-94q2l T4 re-file hanya untuk kegagalan yang aman, dengan batas", () => {
  // Assumptions (brief "Putaran 3"):
  // - `provider_declined`, `cap_exceeded` and `source_document` cannot be produced
  //   through the chain in a test, so a delivered refund is set `failed` with that
  //   reason by SQL and `refileRecoveryRefundAfterFailure` is called as `failRefund`
  //   does (same transaction shape). `approver_unauthorized` the same way.
  // - The limit: after the third refund of the issue ended `failed` there is no
  //   fourth; the audit row is `order_issue.refund_refile_blocked` with
  //   `blockedReason` `refile_limit`. The needs-a-person row names the
  //   `failureReason` in its text.
  // - The refund approval policy of the T3 describe above stays in place.

  async function deliveredRefund() {
    const made = await paidRotiRefund();
    await deliver(made.event);
    const refunds = await issueRefunds(made.issueId);
    expect(refunds).toHaveLength(1);
    return { ...made, first: refunds[0]! };
  }

  /** Sets the refund `failed` for `reason` and runs the re-file hook on it. */
  async function failAndRefile(refundId: string, reason: string) {
    await owner.query(
      `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, refundId, reason],
    );
    const context = contextOf(w.tenant.tenantId);
    await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, context.tenant.tenantId),
            eq(paymentRefunds.id, refundId),
          ),
        );
      await refileRecoveryRefundAfterFailure(tx, context, row!, new Date());
    });
  }

  async function expireAndSettle(refundId: string) {
    await owner.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [w.tenant.tenantId, refundId],
    );
    const settled = await settleRefundFromChain(
      contextOf(w.tenant.tenantId),
      refundId,
    );
    expect(settled.status).toBe("failed");
    const live = (await issueRefunds(settled.orderIssueId!)).filter(
      (row) => row.status !== "failed",
    );
    return live[0] ?? null;
  }

  for (const reason of [
    "provider_declined",
    "cap_exceeded",
    "source_document",
  ]) {
    it(`${reason}: tidak dibuka ulang, audit refund_refile_blocked failure_needs_person`, async () => {
      const { issueId, first } = await deliveredRefund();

      await failAndRefile(first.id, reason);

      const refunds = await issueRefunds(issueId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ id: first.id, status: "failed" });
      const audit = await onlyAudit(
        issueId,
        "order_issue.refund_refile_blocked",
      );
      expect(audit).toMatch(/"blockedReason":\s*"failure_needs_person"/);
      expect(audit).toContain(reason);
      expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
      expect(
        await idempotencyByKey(`order-recovery-refund:${issueId}:${first.id}`),
      ).toHaveLength(0);
    });
  }

  it("approver_unauthorized: dibuka ulang seperti approval_expired", async () => {
    const { issueId, first } = await deliveredRefund();

    await failAndRefile(first.id, "approver_unauthorized");

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(2);
    const live = refunds.find((row) => row.status !== "failed")!;
    expect(live).toMatchObject({
      status: "pending",
      amount_idr: ROTI_WANTED,
      requested_by: "system:recovery",
    });
    await onlyAudit(issueId, "order_issue.refund_refiled");
    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      0,
    );
  });

  it("tiga kali gagal: refund keempat tidak dibuka, audit refund_refile_blocked refile_limit", async () => {
    const { order, issueId, first } = await deliveredRefund();

    const second = await expireAndSettle(first.id);
    expect(second, "refile after the 1st failure").not.toBeNull();
    const third = await expireAndSettle(second!.id);
    expect(third, "refile after the 2nd failure").not.toBeNull();
    const fourth = await expireAndSettle(third!.id);
    expect(fourth, "no refile after the 3rd failure").toBeNull();

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(3);
    expect(refunds.every((row) => row.status === "failed")).toBe(true);
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(2);
    expect(
      await onlyAudit(issueId, "order_issue.refund_refile_blocked"),
    ).toMatch(/"blockedReason":\s*"refile_limit"/);
    expect(
      await idempotencyByKey(`order-recovery-refund:${issueId}:${third!.id}`),
    ).toHaveLength(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
  });
});
