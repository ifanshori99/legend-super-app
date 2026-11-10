// legend-i83ls (S2, guest payment): the guest pays the dearer-swap difference
// (`order_issue_charges`, route qr_link) through its own payment link
// (services/order-recovery-charge-payment.ts, routes in qr-order.routes.ts) and
// the dispatcher (order-payment-consumers.ts) routes the link's events to
// `handleIssueChargePaid` / `handleIssueChargeClosed`. Contract: scratchpad
// design-B.md. Written before the service exists, so the file starts red.
//
// Money in the standard order (helpers): D = 7.000, charge gross 7.000,
// service 350, PBJT 735, amount 8.085.
//
// Assumptions where the brief is silent:
// - The test gateway offers QRIS only (no VA channels): the VA path is not
//   tested here.
// - A second paid code of the charge link is built by SQL like
//   order-recovery-refund.test.ts does (paid intent, evidence and a
//   `double_payment` unallocated fund); the refund request is read from
//   `payment_refunds`.
// - Request body of the payment endpoint: method, bankCode, idempotencyKey (no
//   target: the charge is in the path).

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
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

const DIFFERENCE = PRICES.kopi - PRICES.roti;
const AMOUNT = 8_085;

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

/** A paid order whose roti was swapped for kopi, with its charge opened. */
async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const events = await w.outboxRows("order_issue.resolved", issueId);
  const event = events[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  return { ...order, issueId, charge: await chargeOf(issueId) };
}

type ChargeRow = {
  id: string;
  order_id: string;
  status: string;
  amount_idr: number;
  payment_link_id: string | null;
  payment_link_token_sealed: string | null;
  payment_intent_id: string | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, order_id, status, amount_idr::int AS amount_idr,
            payment_link_id, payment_link_token_sealed, payment_intent_id
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function guestCall(guest: Guest) {
  const client = agent(w.app);
  const base = `/api/table-sessions/${guest.sessionId}`;
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  return {
    list: () => auth(client.get(`${base}/issue-charges`)),
    pay: (
      chargeId: string,
      body: Record<string, unknown> = {},
      session = guest.sessionId,
    ) =>
      auth(
        client.post(
          `/api/table-sessions/${session}/issue-charges/${chargeId}/payments`,
        ),
      ).send({ method: "qris", idempotencyKey: randomUUID(), ...body }),
    poll: (intentId: string) =>
      auth(client.get(`${base}/payments/${intentId}`)),
  };
}

async function settle(intentId: string, amountIdr: number) {
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  return paidEvent(intentId);
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

async function dispatch(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx),
  );
}

async function refundsOfIntent(intentId: string) {
  const { rows } = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
  return rows;
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId],
  );
  return rows[0]!.status;
}

// ---- GET /issue-charges ------------------------------------------------------

/** As the staff route does (closeIssueCharge): waived with reason and actor. */
async function waive(chargeId: string) {
  await owner.query(
    `UPDATE order_issue_charges
     SET status = 'waived', closed_at = now(), closed_by = $3,
         close_reason = 'Tamu komplain lama menunggu'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId, w.supervisor.userId],
  );
}

describe("legend-i83ls GET /api/table-sessions/:sessionId/issue-charges", () => {
  it("tamu melihat tagihan selisih sesinya; tamu meja lain tidak melihat milik orang", async () => {
    const { guest, charge } = await openCharge();
    const listed = await guestCall(guest).list();
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      id: charge.id,
      status: "open",
      differenceIdr: DIFFERENCE,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
      amountIdr: AMOUNT,
      paidAt: null,
    });

    const other = await w.seat();
    const otherList = await guestCall(other).list();
    expect(otherList.status).toBe(200);
    expect(otherList.body.data).toEqual([]);
    // A foreign session id with this guest's token is a 404, no oracle.
    const foreign = await guestCall(guest).pay(charge.id, {}, other.sessionId);
    expect(foreign.status).toBe(404);
  });
});

// ---- POST /issue-charges/:chargeId/payments -----------------------------------

describe("legend-i83ls POST /api/table-sessions/:sessionId/issue-charges/:chargeId/payments", () => {
  it("membuka link sendiri (oic:<chargeId>) dan satu kode QRIS senilai tagihan; order tidak disentuh", async () => {
    const { guest, charge, issueId } = await openCharge();
    const orderBefore = await owner.query(
      "SELECT payment_link_id, payment_intent_id, status FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, charge.order_id],
    );

    const paid = await guestCall(guest).pay(charge.id);

    expect(paid.status).toBe(201);
    expect(paid.body.data).toMatchObject({
      target: { kind: "issue_charge", chargeId: charge.id },
      method: "qris",
      amountIdr: AMOUNT,
      status: "pending",
    });
    const row = await chargeOf(issueId);
    expect(row.payment_link_id).not.toBeNull();
    expect(row.payment_link_token_sealed).not.toBeNull();
    expect(row.payment_intent_id).toBe(paid.body.data.id);
    const link = await owner.query<{ reference: string; total_idr: number }>(
      "SELECT reference, total_idr::int AS total_idr FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, row.payment_link_id],
    );
    expect(link.rows[0]).toEqual({
      reference: `oic:${charge.id}`,
      total_idr: AMOUNT,
    });
    // The order keeps its own link, intent and status.
    expect(
      (
        await owner.query(
          "SELECT payment_link_id, payment_intent_id, status FROM orders WHERE tenant_id = $1 AND id = $2",
          [w.tenant.tenantId, charge.order_id],
        )
      ).rows,
    ).toEqual(orderBefore.rows);
  });

  it("ulang dengan kunci sama atau kunci lain dan metode sama: kode yang sama, satu link, satu intent", async () => {
    const { guest, charge, issueId } = await openCharge();
    const key = randomUUID();
    const first = await guestCall(guest).pay(charge.id, {
      idempotencyKey: key,
    });
    const replay = await guestCall(guest).pay(charge.id, {
      idempotencyKey: key,
    });
    const again = await guestCall(guest).pay(charge.id);

    expect(first.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM payment_intents i
       JOIN order_issue_charges c ON c.payment_link_id = i.payment_link_id
       WHERE c.tenant_id = $1 AND c.id = $2`,
      [w.tenant.tenantId, charge.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect((await chargeOf(issueId)).payment_intent_id).toBe(
      first.body.data.id,
    );
  });

  it("tagihan yang dibebaskan atau sudah tidak open: 409; id tagihan asing: 404", async () => {
    const { guest, charge } = await openCharge();
    await waive(charge.id);

    expect((await guestCall(guest).pay(charge.id)).status).toBe(409);
    expect((await guestCall(guest).pay(randomUUID())).status).toBe(404);
  });

  it("bank diisi untuk QRIS ditolak 422", async () => {
    const { guest, charge } = await openCharge();
    const response = await guestCall(guest).pay(charge.id, { bankCode: "BCA" });
    expect(response.status).toBe(422);
  });

  it("GET /payments/:id menjawab status kode tagihan dengan target issue_charge", async () => {
    const { guest, charge } = await openCharge();
    const created = await guestCall(guest).pay(charge.id);
    const polled = await guestCall(guest).poll(created.body.data.id);
    expect(polled.status).toBe(200);
    expect(polled.body.data).toMatchObject({
      id: created.body.data.id,
      target: { kind: "issue_charge", chargeId: charge.id },
      status: "pending",
    });
  });
});

// ---- dispatcher ----------------------------------------------------------------

describe("legend-i83ls deliverOrderPaymentEvent: link tagihan selisih", () => {
  it("payment.paid dari link tagihan: tagihan paid, event charge_paid, order tetap sent", async () => {
    const { guest, charge, issueId } = await openCharge();
    const created = await guestCall(guest).pay(charge.id);
    const event = await settle(created.body.data.id, AMOUNT);

    const routed = await dispatch(event);

    expect(routed).toEqual({ route: "issue_charge", outcome: "paid" });
    expect(await chargeOf(issueId)).toMatchObject({
      status: "paid",
      payment_intent_id: created.body.data.id,
    });
    expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
      1,
    );
    expect(await orderStatus(charge.order_id)).toBe("sent");
    // Replay: nothing changes.
    expect(await dispatch(event)).toEqual({
      route: "issue_charge",
      outcome: "unchanged",
    });
    expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
      1,
    );
  });

  it("kode kedua di link tagihan dibayar sesudah tagihan paid: refund pembayaran ganda diminta, sekali", async () => {
    const { guest, charge } = await openCharge();
    const created = await guestCall(guest).pay(charge.id);
    expect(await dispatch(await settle(created.body.data.id, AMOUNT))).toEqual({
      route: "issue_charge",
      outcome: "paid",
    });
    const linkId = (
      await owner.query<{ payment_link_id: string }>(
        "SELECT payment_link_id FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, charge.id],
      )
    ).rows[0]!.payment_link_id;
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
        w.tenant.outletId,
        linkId,
        AMOUNT,
        `oic2-${otherIntentId}`,
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
        w.tenant.outletId,
        otherIntentId,
        `evidence-${otherIntentId}`,
        AMOUNT,
      ],
    );
    await owner.query(
      `INSERT INTO payment_unallocated_funds
         (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        otherIntentId,
        evidenceId,
        AMOUNT,
      ],
    );
    const first = await paidEvent(created.body.data.id);
    const second: EventEnvelope = {
      ...first,
      id: randomUUID(),
      payload: { ...first.payload, intentId: otherIntentId },
    } as EventEnvelope;

    expect(await dispatch(second)).toEqual({
      route: "issue_charge",
      outcome: "double_payment",
    });
    expect(await refundsOfIntent(otherIntentId)).toHaveLength(1);
    await dispatch(second);
    expect(await refundsOfIntent(otherIntentId)).toHaveLength(1);
  });

  it("uang masuk sesudah tagihan dibebaskan: tagihan tetap waived, refund penuh diminta", async () => {
    const { guest, charge, issueId } = await openCharge();
    const created = await guestCall(guest).pay(charge.id);
    await waive(charge.id);
    const event = await settle(created.body.data.id, AMOUNT);

    expect(await dispatch(event)).toEqual({
      route: "issue_charge",
      outcome: "late_payment_on_closed_charge",
    });

    expect((await chargeOf(issueId)).status).toBe("waived");
    expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
      0,
    );
    const refunds = await refundsOfIntent(created.body.data.id);
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amount_idr)).toBe(AMOUNT);
    await dispatch(event);
    expect(await refundsOfIntent(created.body.data.id)).toHaveLength(1);
  });

  it("payment.failed dari kode tagihan open: tagihan tetap open, penunjuk intent dibersihkan", async () => {
    const { guest, charge, issueId } = await openCharge();
    const created = await guestCall(guest).pay(charge.id);
    const paid = await settle(created.body.data.id, AMOUNT);
    const failed = {
      ...paid,
      name: "payment.failed",
      payload: { intentId: created.body.data.id },
    } as never as EventEnvelope;

    const routed = await dispatch(failed);

    expect(routed).toEqual({ route: "issue_charge", outcome: "retry_allowed" });
    expect(await chargeOf(issueId)).toMatchObject({
      status: "open",
      payment_intent_id: null,
    });
  });

  it("link order biasa tetap lewat konsumen order (bukan tagihan)", async () => {
    const order = await w.paidOrder();
    const event = await paidEvent(
      (
        await owner.query<{ id: string }>(
          `SELECT i.id FROM payment_intents i JOIN orders o ON o.payment_link_id = i.payment_link_id
           WHERE o.tenant_id = $1 AND o.table_session_id = $2 LIMIT 1`,
          [w.tenant.tenantId, order.guest.sessionId],
        )
      ).rows[0]!.id,
    );
    const routed = await dispatch(event);
    expect(routed.route).toBe("qr");
  });
});
