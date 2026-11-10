// legend-i83ls (gap 2): a payment link that was cancelled is still paid.
//
// `cancelPaymentLinkInTx` turns the link's pending intent `expired` and moves
// the link's expiry; the gateway has no cancel call. A guest who already holds
// the old QRIS code can still pay it: the money arrives (webhook / poller) for
// an intent whose status is `expired`. The existing late-payment test in
// order-recovery-charge-payment.test.ts only waives by SQL while the intent is
// still `pending`; it does not cover an intent that the real close path expired.
//
// Here the charge is closed by the real paths:
//   (a) staff waive route (`closeIssueCharge`), POST /api/order-issue-charges/:id/waive
//   (b) forced close of the table session (`expireOpenChargesOfSession`)
// and then the old code is paid. Expected: the charge stays closed, no
// `order_issue.charge_paid` event, no charge journal key, exactly one full
// refund request for the intent, and a replay does not double it (c).
//
// Assumptions where the spec/design is silent:
// - The late payment is routed as outcome `late_payment_on_closed_charge`
//   (the outcome name used by the existing charge payment test).
// - "No journal" is asserted as: no journal entry carrying the key
//   `aj:order-charge:<chargeId>` (revenue is only recognised by the
//   `order_issue.charge_paid` event, which must not exist).

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
const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)

// ---- helpers (same pattern as order-recovery-charge-payment.test.ts) ---------

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
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
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
  closed_by: string | null;
  close_reason: string | null;
  payment_link_id: string | null;
  payment_intent_id: string | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, order_id, status, closed_by, close_reason, payment_link_id, payment_intent_id
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function guestPay(guest: Guest, chargeId: string) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The gateway reports money for `intentId`, as the webhook / poller does. */
async function payOldCode(intentId: string) {
  await confirmPayment(contextOf(w.tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: AMOUNT,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  return paidEvent(intentId);
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

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

async function chargeJournalEntries(chargeId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries j
     WHERE j.tenant_id = $1 AND to_jsonb(j)::text LIKE $2`,
    [w.tenant.tenantId, `%aj:order-charge:${chargeId}%`],
  );
  return Number(rows[0]!.n);
}

/** Pre-conditions: the guest holds a live code, then the real close path runs. */
async function guestHoldsCode() {
  const opened = await openCharge();
  const created = await guestPay(opened.guest, opened.charge.id);
  expect(created.status).toBe(201);
  const intentId = created.body.data.id as string;
  expect(await intentStatus(intentId)).toBe("pending");
  return { ...opened, intentId };
}

/** What must hold after the old code is paid on a closed charge. */
async function expectLateMoneyRefundedOnce(
  opened: Awaited<ReturnType<typeof guestHoldsCode>>,
  closedStatus: "waived" | "expired",
) {
  const { intentId, issueId, charge } = opened;
  // The close path itself expired the code (the cancel is not a gateway call).
  expect(await intentStatus(intentId)).toBe("expired");

  const event = await payOldCode(intentId);
  const routed = await dispatch(event);

  expect(routed).toEqual({
    route: "issue_charge",
    outcome: "late_payment_on_closed_charge",
  });
  expect((await chargeOf(issueId)).status).toBe(closedStatus);
  expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
    0,
  );
  expect(await chargeJournalEntries(charge.id)).toBe(0);
  const refunds = await refundsOfIntent(intentId);
  expect(refunds).toHaveLength(1);
  expect(Number(refunds[0]!.amount_idr)).toBe(AMOUNT);
  return event;
}

// ---- (a) waived through the staff route ---------------------------------------

describe("legend-i83ls link batal: tagihan dibebaskan lewat route staf", () => {
  it("kode lama dibayar sesudah waive: refund penuh sekali, tagihan tetap waived, tanpa charge_paid dan jurnal", async () => {
    const opened = await guestHoldsCode();
    const waived = await w.staffPost(
      w.supervisor,
      `/api/order-issue-charges/${opened.charge.id}/waive`,
      { reason: "Tamu komplain lama menunggu" },
    );
    expect(waived.status).toBe(200);
    expect(waived.body.data.status).toBe("waived");

    await expectLateMoneyRefundedOnce(opened, "waived");
    const row = await chargeOf(opened.issueId);
    expect(row.closed_by).toBe(w.supervisor.userId);
    expect(row.close_reason).toBe("Tamu komplain lama menunggu");
  });
});

// ---- (b) expired by the forced close of the session ---------------------------

describe("legend-i83ls link batal: tagihan kedaluwarsa karena sesi ditutup paksa", () => {
  it("kode lama dibayar sesudah tutup paksa: refund penuh sekali, tagihan tetap expired, tanpa charge_paid dan jurnal", async () => {
    const opened = await guestHoldsCode();
    const closed = await w.staffPost(
      w.floorStaff,
      `/api/table-sessions/${opened.guest.sessionId}/close`,
      { tableCleaned: false, waiterConfirmedEmpty: true },
    );
    expect(closed.status).toBe(200);
    expect((await chargeOf(opened.issueId)).close_reason).toBe(
      "session_closed",
    );

    await expectLateMoneyRefundedOnce(opened, "expired");
  });

  it("tagihan expired lewat route staf (expire): hasil sama", async () => {
    const opened = await guestHoldsCode();
    const expired = await w.staffPost(
      w.supervisor,
      `/api/order-issue-charges/${opened.charge.id}/expire`,
      { reason: "Tamu sudah pulang" },
    );
    expect(expired.status).toBe(200);

    await expectLateMoneyRefundedOnce(opened, "expired");
  });
});

// ---- (c) replay ----------------------------------------------------------------

describe("legend-i83ls link batal: event diputar ulang", () => {
  it("event yang sama dua kali dan envelope baru untuk intent yang sama: tetap satu refund", async () => {
    const opened = await guestHoldsCode();
    const waived = await w.staffPost(
      w.supervisor,
      `/api/order-issue-charges/${opened.charge.id}/waive`,
      { reason: "Tamu komplain lama menunggu" },
    );
    expect(waived.status).toBe(200);
    const event = await expectLateMoneyRefundedOnce(opened, "waived");

    await dispatch(event);
    await dispatch(event);
    await dispatch({ ...event, id: randomUUID() } as EventEnvelope);

    expect(await refundsOfIntent(opened.intentId)).toHaveLength(1);
    expect((await chargeOf(opened.issueId)).status).toBe("waived");
    expect(
      await w.outboxRows("order_issue.charge_paid", opened.issueId),
    ).toHaveLength(0);
    expect(await chargeJournalEntries(opened.charge.id)).toBe(0);
  });
});
