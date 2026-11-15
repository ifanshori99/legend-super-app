// SO-879 (card E): the sweep may void an awaiting_payment guest QR order whose
// link is fully paid ONLY when the money is gone for good and every code is dead.
//
// CTO decision (docs/briefs/so-879-qris-hold-fix.md + task): void only when
// (1) every code of the order is proven dead at the provider or its hold is
//     closed (no pending intent inside the grace, no open/cancelling hold),
// (2) the net money captured is 0: every payment that came in has a COMPLETED
//     refund of at least its amount, and
// (3) no refund is pending, approved-but-unpaid or failed.
// Any doubt keeps the order. The void is idempotent: a second sweep neither
// voids nor refunds again.
//
// Fixture: A is a VA that lapsed locally past the late grace; B is a QR whose
// hold (legend-kf104) freezes the order against a void. A is paid late and
// refunded; B is proven dead by the hold check job.
//
// Assumptions:
// - A "committed" refund here is a raw `completed` payment_refunds row, with
//   the intent moved to `refunded` / `partially_refunded` by hand (as
//   qr-order-fire-refund-cap.test.ts); `pending`/`failed` rows are raw too.
// - The sweep runs 10 minutes after the order was placed, so the late grace has
//   passed and no code is inside it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
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
  fx = await holdFixture("qris-hold-so879-e");
  gw = new ScriptedGateway("doit");
  enableVaBank(gw);
  setPaymentGateway(gw);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

function payWhole(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

/** A (VA) lapsed locally past the grace, then B (QR) opened: B holds the bill. */
async function world() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  const a = await payWhole(guest, order.id, "va");
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const aId = a.body.data.id as string;
  await owner.query(
    `UPDATE payment_intents SET status='expired', expires_at = now() - interval '10 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, aId],
  );
  const b = await payWhole(guest, order.id, "qris");
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const bId = b.body.data.id as string;
  expect((await readHolds(fx, order.id)).map((h) => h.state)).toEqual(["open"]);
  return { guest, orderId: order.id as string, aId, bId };
}

async function payA(aId: string) {
  await confirmPayment(
    fx.context,
    aId,
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
}

async function refundRow(
  intentId: string,
  amountIdr: number,
  status: "pending" | "approved" | "completed" | "failed",
  intentStatus?: "refunded" | "partially_refunded",
) {
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, completed_at)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji sweep', $4::varchar, 'sweep-test',
            CASE WHEN $4::varchar = 'completed' THEN now() END
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, intentId, amountIdr, status],
  );
  if (intentStatus)
    await owner.query(
      "UPDATE payment_intents SET status=$3 WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId, intentStatus],
    );
}

/** A is paid, then `refund` is filed, then the paid event reaches the QR
 * consumer (the hold of B keeps the order awaiting payment). */
async function paidAThen(
  w: Awaited<ReturnType<typeof world>>,
  refund: () => Promise<void>,
) {
  await payA(w.aId);
  await refund();
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, w.aId],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows)
    await withTenant(db, fx.context, (tx) =>
      deliverOrderPaymentEvent(
        fx.context,
        eventEnvelopeSchema.parse(row.event),
        tx,
        new Date(),
      ),
    );
  expect(await orderRow(w.orderId)).toMatchObject({
    status: "awaiting_payment",
  });
}

/** B is proven dead: provider expired, past its life, hold check job ran. */
async function killB(w: Awaited<ReturnType<typeof world>>) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '15 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, w.bId],
  );
  gw.script(w.bId, { rawStatus: "02" });
  await runHoldCheck(fx, new Date());
  expect((await readHolds(fx, w.orderId)).map((h) => h.state)).toEqual([
    "closed",
  ]);
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
    snapshot: unknown;
  }>(
    `SELECT status, void_reason, to_jsonb(o) AS snapshot
       FROM orders o WHERE tenant_id=$1 AND id=$2::uuid`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

const sweep = () =>
  sweepUnpaidQrOrders(fx.context, new Date(Date.now() + 10 * 60_000));

describe("SO-879 sweep voids a fully paid QR order only when the money is refunded and every code is dead", () => {
  it("(a) A paid + fully refunded (completed), B's hold closed on proof: the sweep voids the order once and no money is left captured", async () => {
    const w = await world();
    await paidAThen(w, () =>
      refundRow(w.aId, BILL_IDR, "completed", "refunded"),
    );
    await killB(w);

    await sweep();

    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.void_reason).toBe("payment_refunded_codes_dead");
    // Net captured 0: the one refund returns everything A took; nothing more.
    const refunds = await refundsOfIntent(fx, w.aId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: "completed" });
    expect(await refundsOfIntent(fx, w.bId)).toEqual([]);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT coalesce(sum(amount_idr),0)::text AS n FROM payment_refunds
        WHERE tenant_id=$1 AND payment_intent_id=$2 AND status<>'failed'`,
      [fx.tenant.tenantId, w.aId],
    );
    expect(Number(rows[0]!.n)).toBe(BILL_IDR);
  });

  it("(b) A's refund is still pending (10.000 approved, the system refund of the rest pending): the order is kept; once both are completed it is voided", async () => {
    const w = await world();
    await paidAThen(w, () => refundRow(w.aId, 10_000, "approved"));
    await killB(w);
    const rest = (await refundsOfIntent(fx, w.aId)).filter(
      (row) => row.requestedBy === "system:qr",
    );
    expect(rest).toEqual([
      expect.objectContaining({ status: "pending", amountIdr: 23_000 }),
    ]);

    await sweep();

    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
    expect(await refundsOfIntent(fx, w.aId)).toHaveLength(2);

    await owner.query(
      `UPDATE payment_refunds SET status='completed', completed_at=now()
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, w.aId],
    );
    await owner.query(
      "UPDATE payment_intents SET status='refunded' WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, w.aId],
    );

    await sweep();

    expect((await orderRow(w.orderId)).status).toBe("voided");
    expect(await refundsOfIntent(fx, w.aId)).toHaveLength(2);
  });

  it("(c) A's refund failed: the order is kept; a failed row next to a completed full refund is still kept", async () => {
    const failedOnly = await world();
    await paidAThen(failedOnly, () =>
      refundRow(failedOnly.aId, 10_000, "approved"),
    );
    await owner.query(
      `UPDATE payment_refunds SET status='failed', failure_reason='cap_exceeded'
        WHERE tenant_id=$1 AND payment_intent_id=$2 AND requested_by='system:qr'`,
      [fx.tenant.tenantId, failedOnly.aId],
    );
    await killB(failedOnly);

    const both = await world();
    await paidAThen(both, () =>
      refundRow(both.aId, BILL_IDR, "completed", "refunded"),
    );
    await refundRow(both.aId, BILL_IDR, "failed");
    await killB(both);

    await sweep();

    expect((await orderRow(failedOnly.orderId)).status).toBe(
      "awaiting_payment",
    );
    expect((await orderRow(both.orderId)).status).toBe("awaiting_payment");
  });

  it("(d) B is still alive (hold open, provider says pending): the order is kept even though A is fully refunded", async () => {
    const w = await world();
    await paidAThen(w, () =>
      refundRow(w.aId, BILL_IDR, "completed", "refunded"),
    );
    gw.script(w.bId, { rawStatus: "01" });
    await runHoldCheck(fx, new Date());
    expect((await readHolds(fx, w.orderId)).map((h) => h.state)).toEqual([
      "open",
    ]);

    await sweep();

    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
    expect((await readHolds(fx, w.orderId)).map((h) => h.state)).toEqual([
      "open",
    ]);
  });

  it("(e) replaying the sweep voids and refunds nothing more", async () => {
    const w = await world();
    await paidAThen(w, () =>
      refundRow(w.aId, BILL_IDR, "completed", "refunded"),
    );
    await killB(w);

    await sweep();
    const first = await orderRow(w.orderId);
    expect(first.status).toBe("voided");
    const refundsFirst = await refundsOfIntent(fx, w.aId);

    const again = await sweep();
    await sweep();

    expect(again.voided).toBe(0);
    expect((await orderRow(w.orderId)).snapshot).toEqual(first.snapshot);
    expect(await refundsOfIntent(fx, w.aId)).toEqual(refundsFirst);
    expect(await refundsOfIntent(fx, w.bId)).toEqual([]);
  });

  it("(f) A only partly refunded (10.000 of 33.000): the order is kept, the rest is still the guest's captured money", async () => {
    const w = await world();
    await paidAThen(w, () =>
      refundRow(w.aId, 10_000, "completed", "partially_refunded"),
    );
    await killB(w);

    await sweep();

    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
  });
});
