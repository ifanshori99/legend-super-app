// legend-982 architect fix A: handleIssueChargePaid.
//  (1) A charge already `paid` at the till by card/EDC (no payment intent, no
//      cash movement) must treat a QRIS that lands afterwards as a late payment
//      on a closed charge (refunded in full), not a `double_payment`, which
//      leaves the money unrefunded.
//  (2) A `routed_pos` charge paid by the QRIS the cashier asked for (intent ==
//      charge.paymentIntentId) is accepted and marked `paid`, not late.
//  (3) N3: that cashier QRIS on a `routed_pos` charge of an order that was
//      voided meanwhile is a late payment on a closed charge: full refund, no
//      `charge_paid`, no charge journal.
// Scaffolding modelled on order-charge-refund-982-pos-nontunai-gt98h.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  deliverIssueChargeEvent,
  handleIssueChargePaid,
  type IssueChargePaidOutcome,
} from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const DEVICE_ID = randomUUID();
let cashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = "";

const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)
const DIFFERENCE = PRICES.kopi - PRICES.roti;

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

const deviceHeader = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

beforeAll(async () => {
  w = await createWorld();
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: DEVICE_ID,
  });
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Fix A', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      w.tenant.tenantId,
      JSON.stringify(["pos.payment.accept", "order.view"]),
    ],
  );
  const client = agent(w.app);
  await signUp(client, "Kasir Fix A");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, userId, roleId, w.tenant.outletId],
  );
  cashier = { client, userId };
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

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
  if (!shiftId) {
    const { rows } = await owner.query<{ d: string }>(
      "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(order.order.id)],
    );
    shiftId = randomUUID();
    await owner.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
      [
        shiftId,
        w.tenant.tenantId,
        w.tenant.outletId,
        DEVICE_ID,
        cashier.userId,
        rows[0]!.d,
        randomUUID(),
        "a".repeat(64),
      ],
    );
  }
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return { issueId, chargeId: rows[0]!.id };
}

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    payment_intent_id: string | null;
    cash_movement_id: string | null;
    paid_at: Date | null;
  }>(
    `SELECT status, payment_intent_id, cash_movement_id, paid_at
     FROM order_issue_charges WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

/** The cashier asks for a QRIS code: the charge gets a link and a pending intent. */
async function askQris(chargeId: string): Promise<string> {
  const res = await cashier.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set("Host", w.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(DEVICE_ID))
    .send({ idempotencyKey: randomUUID(), method: "qris" });
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
  const intentId = (await chargeRow(chargeId)).payment_intent_id;
  expect(intentId).not.toBeNull();
  return intentId!;
}

async function paidEventOf(intentId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The verified webhook settles the intent; returns what the charge handler says. */
async function paidOutcome(intentId: string): Promise<IssueChargePaidOutcome> {
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: AMOUNT,
    providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
  });
  const paid = await paidEventOf(intentId);
  return withTenant(db, context, (tx) =>
    handleIssueChargePaid(context, paid, tx),
  );
}

describe("legend-982 fix A: charge paid event vs closed / routed charges", () => {
  it("A1: a charge paid by card/EDC (no intent, no cash) then a late QRIS is a late payment on a closed charge, not double_payment", async () => {
    const { chargeId } = await openCharge();
    const intentId = await askQris(chargeId);
    // The cashier then took the money by EDC: paid, no intent, no cash movement.
    await owner.query(
      `UPDATE order_issue_charges
       SET status = 'paid', paid_at = now(), payment_intent_id = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, chargeId],
    );

    expect(await paidOutcome(intentId)).toBe("late_payment_on_closed_charge");

    const row = await chargeRow(chargeId);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBeNull();
  });

  it("A2: a routed_pos charge paid by the QRIS the cashier asked for is accepted and marked paid", async () => {
    const { chargeId, issueId } = await openCharge();
    const intentId = await askQris(chargeId);
    await owner.query(
      `UPDATE order_issue_charges SET status = 'routed_pos', route = 'pos'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, chargeId],
    );

    expect(await paidOutcome(intentId)).toBe("paid");

    const row = await chargeRow(chargeId);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBe(intentId);
    expect(row.paid_at).not.toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
      1,
    );
  });

  it("A3 control: an open charge paid by its own intent is paid, a replay is unchanged", async () => {
    const { chargeId } = await openCharge();
    const intentId = await askQris(chargeId);
    expect(await paidOutcome(intentId)).toBe("paid");
    const context = contextOf(w.tenant.tenantId);
    const paid = await paidEventOf(intentId);
    expect(
      await withTenant(db, context, (tx) =>
        handleIssueChargePaid(context, paid, tx),
      ),
    ).toBe("unchanged");
  });

  it("A4 (N3): a routed_pos cashier QRIS paid after the order was voided is refunded in full, charge not paid", async () => {
    const { chargeId, issueId } = await openCharge();
    const intentId = await askQris(chargeId);
    await owner.query(
      `UPDATE order_issue_charges SET status = 'routed_pos', route = 'pos'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, chargeId],
    );
    // The void only handles `paid` charges: it leaves the charge and the live
    // QRIS intent alone, the order ends up `voided`.
    await owner.query(
      `UPDATE orders SET status = 'voided'
       WHERE tenant_id = $1
         AND id = (SELECT order_id FROM order_issue_charges
                   WHERE tenant_id = $1 AND id = $2)`,
      [w.tenant.tenantId, chargeId],
    );
    const context = contextOf(w.tenant.tenantId);
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: AMOUNT,
      providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
    });
    const paid = await paidEventOf(intentId);

    const routed = await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(context, paid, tx),
    );

    expect(routed).toEqual({
      route: "issue_charge",
      outcome: "late_payment_on_closed_charge",
    });
    const row = await chargeRow(chargeId);
    expect(row.status).toBe("routed_pos");
    expect(row.paid_at).toBeNull();
    expect(await w.outboxRows("order_issue.charge_paid", issueId)).toHaveLength(
      0,
    );
    const { rows: refunds } = await owner.query<{ amount_idr: string }>(
      `SELECT amount_idr FROM payment_refunds
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
      [w.tenant.tenantId, intentId],
    );
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amount_idr)).toBe(AMOUNT);
    const { rows: journals } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries j
       WHERE j.tenant_id = $1 AND to_jsonb(j)::text LIKE $2`,
      [w.tenant.tenantId, `%aj:order-charge:${chargeId}%`],
    );
    expect(Number(journals[0]!.n)).toBe(0);
  });
});
