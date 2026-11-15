// SO-885 (card E, legend-05pjx): a refund that FAILED on an awaiting_payment
// guest QR order keeps holding the order (never hidden by a void), but
//   (1) it is visible to staff: the refund list (status=failed, escalated=true)
//       and an alert (payment.refund_escalated, reason `failed_holds_order`);
//   (2) it is re-filed ONCE automatically as a new pending system:qr refund
//       with the usual approval (key `qr-late-payment-refund:<intent>:<failedId>`),
//       a replay of the failure or the escalation files nothing more;
//   (3) once a COMPLETED refund covers everything that came in, the old failed
//       row is superseded: it no longer holds the order, the sweep voids it and
//       refunds nothing more.
//
// Fixture and world as qris-hold-so879-e-sweep-refunded-void.test.ts: A (VA)
// paid and refunded 10.000 (raw `approved` row R1), B (QR) holds the bill.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { listRefunds } from "../services/payment-admin.service.ts";
import {
  applyRefundProviderUpdate,
  escalateStaleRefunds,
} from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { sweepUnpaidQrOrders } from "../services/qr-order-consumers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  ScriptedGateway,
  holdFixture,
  readHolds,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL_IDR = 33_000;

let fx: HoldFixture;
let gw: ScriptedGateway;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-e");
  gw = new ScriptedGateway("doit");
  enableVaBank(gw);
  setPaymentGateway(gw);
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["payment.transaction.view"])],
  );
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function world() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  const pay = (method: "qris" | "va") =>
    fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method,
      ...(method === "va" ? { bankCode: "bmri" } : {}),
      idempotencyKey: randomUUID(),
    });
  const a = await pay("va");
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const aId = a.body.data.id as string;
  await owner.query(
    `UPDATE payment_intents SET status='expired', expires_at = now() - interval '10 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, aId],
  );
  const b = await pay("qris");
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const bId = b.body.data.id as string;
  expect((await readHolds(fx, order.id)).map((h) => h.state)).toEqual(["open"]);
  return { orderId: order.id as string, aId, bId };
}

/** A paid; R1 (10.000, approved, raw) committed; the paid event reaches the
 * consumer: the hold of B keeps the order, the rest is filed as system:qr R2. */
async function committedWorld() {
  const w = await world();
  await confirmPayment(
    fx.context,
    w.aId,
    {
      source: "verified_webhook",
      method: "va",
      amountIdr: BILL_IDR,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    },
    { type: "system" },
    new Date(),
  );
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, 10000, 'Refund uji 885', 'approved', $3
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, w.aId, fx.staff.userId],
  );
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, w.aId],
  );
  for (const row of rows)
    await withTenant(db, fx.context, (tx) =>
      deliverOrderPaymentEvent(
        fx.context,
        eventEnvelopeSchema.parse(row.event),
        tx,
        new Date(),
      ),
    );
  expect(await orderStatus(w.orderId)).toBe("awaiting_payment");
  const r1 = (await refundRows(w.aId)).find(
    (row) => row.requested_by === fx.staff.userId,
  )!;
  const r2 = (await refundRows(w.aId)).find(
    (row) => row.requested_by === "system:qr",
  )!;
  expect(r2).toMatchObject({ status: "pending", amount: 23_000 });
  return { ...w, r1: r1.id, r2: r2.id };
}

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: number;
    requested_by: string;
  }>(
    `SELECT id, status, amount_idr::int AS amount, requested_by
       FROM payment_refunds WHERE tenant_id=$1 AND payment_intent_id=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2::uuid",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

async function killB(bId: string, orderId: string) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '15 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, bId],
  );
  gw.script(bId, { rawStatus: "02" });
  await runHoldCheck(fx, new Date());
  expect((await readHolds(fx, orderId)).map((h) => h.state)).toEqual([
    "closed",
  ]);
}

const failProvider = (refundId: string) =>
  applyRefundProviderUpdate(fx.context, {
    idempotencyKey: `refund:${refundId}`,
    status: "failed",
  });
const sweep = () =>
  sweepUnpaidQrOrders(fx.context, new Date(Date.now() + 20 * 60_000));
const failedList = () =>
  listRefunds(fx.context, fx.staff.userId, {
    status: "failed",
    escalated: "true",
    limit: 50,
  });

describe("SO-885 E: a failed refund on an awaiting_payment QR order", () => {
  it("(a) keeps holding the order and shows in the staff list and alert", async () => {
    const w = await committedWorld();
    await killB(w.bId, w.orderId);

    await failProvider(w.r1);
    await escalateStaleRefunds(fx.context, new Date());
    await sweep();

    expect(await orderStatus(w.orderId)).toBe("awaiting_payment");
    const listed = await failedList();
    expect(listed.data.map((row) => row.id)).toContain(w.r1);
    const { rows } = await owner.query<{ reason: string }>(
      `SELECT event->'payload'->>'reason' AS reason FROM domain_event_outbox
        WHERE tenant_id=$1 AND event->>'name'='payment.refund_escalated'
          AND event->'payload'->>'refundId'=$2`,
      [fx.tenant.tenantId, w.r1],
    );
    expect(rows).toEqual([{ reason: "failed_holds_order" }]);
  });

  it("(b) is re-filed once as a new pending system:qr refund; replays add nothing", async () => {
    const w = await committedWorld();
    await killB(w.bId, w.orderId);

    await failProvider(w.r1);
    const after = await refundRows(w.aId);
    const refiled = after.filter(
      (row) => row.requested_by === "system:qr" && row.id !== w.r2,
    );
    expect(refiled).toEqual([expect.objectContaining({ status: "pending" })]);

    await failProvider(w.r1);
    await failProvider(w.r1);
    await escalateStaleRefunds(fx.context, new Date());
    await escalateStaleRefunds(fx.context, new Date());
    await sweep();
    await sweep();

    expect(await refundRows(w.aId)).toEqual(after);
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_event_outbox
        WHERE tenant_id=$1 AND event->>'name'='payment.refund_escalated'
          AND event->'payload'->>'refundId'=$2`,
      [fx.tenant.tenantId, w.r1],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("(c) a failed row replaced by a completed full refund no longer holds the order: the sweep voids it once", async () => {
    const w = await committedWorld();
    await killB(w.bId, w.orderId);
    await failProvider(w.r1);
    const [r3] = (await refundRows(w.aId)).filter(
      (row) => row.requested_by === "system:qr" && row.id !== w.r2,
    );
    // The re-filed refund is paid out; the older request fails its approval.
    await owner.query(
      `UPDATE payment_refunds SET status='completed', completed_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, r3!.id],
    );
    await owner.query(
      `UPDATE payment_refunds SET status='failed', failure_reason='cap_exceeded'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, w.r2],
    );
    await owner.query(
      "UPDATE payment_intents SET status='refunded' WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, w.aId],
    );
    expect(await orderStatus(w.orderId)).toBe("awaiting_payment");

    await sweep();

    expect(await orderStatus(w.orderId)).toBe("voided");
    const refunds = await refundRows(w.aId);
    await sweep();
    await sweep();
    expect(await refundRows(w.aId)).toEqual(refunds);
    expect(await refundsOfIntent(fx, w.bId)).toEqual([]);
    // The superseded failed rows are no longer an open case for staff.
    expect((await failedList()).data.map((row) => row.id)).not.toContain(w.r1);
  });

  it("(d) a completed refund that does not cover what came in leaves the failed row holding the order", async () => {
    const w = await committedWorld();
    await killB(w.bId, w.orderId);
    await failProvider(w.r1);
    await owner.query(
      `UPDATE payment_refunds SET status='failed', failure_reason='cap_exceeded'
        WHERE tenant_id=$1 AND payment_intent_id=$2 AND status='pending'`,
      [fx.tenant.tenantId, w.aId],
    );
    await owner.query(
      `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, completed_at)
       SELECT tenant_id, outlet_id, id, 10000, 'Refund uji 885', 'completed', $3, now()
         FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, w.aId, fx.staff.userId],
    );
    await owner.query(
      "UPDATE payment_intents SET status='partially_refunded' WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, w.aId],
    );

    await sweep();

    expect(await orderStatus(w.orderId)).toBe("awaiting_payment");
  });
});
