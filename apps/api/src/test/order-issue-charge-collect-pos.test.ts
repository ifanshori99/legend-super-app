// legend-800h1: the cashier collects a swap charge (`order_issue_charges`) in
// cash at the till: POST /api/order-issue-charges/:chargeId/collect-at-pos.
//
// Real path: HTTP route with a cashier holding `pos.payment.accept` and a
// signed device token, an open shift on that device (seeded, like the POS
// tender tests), and the charge opened by the real swap flow. Cash only; EDC /
// QRIS at the till is a later bead.
//
// Covered: happy path (charge paid by a cash_in movement of the shift, link
// cancelled, `order_issue.charge_paid` with method pos_cash, expected drawer
// cash rises), no open shift, already paid / waived, idempotent replay,
// permission, change, a guest who still pays the cancelled code (refunded, no
// second charge_paid), and the session bill / session close.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";

let w: World;
const DEVICE_ID = randomUUID();
const OTHER_DEVICE_ID = randomUUID();
let cashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = "";
/** cash_in rows the tests have collected so far (one shared drawer). */
let cashIns = 0;

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
  for (const deviceId of [DEVICE_ID, OTHER_DEVICE_ID])
    await registerTestDevice(owner, {
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      deviceId,
    });
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Uji', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      w.tenant.tenantId,
      JSON.stringify(["pos.payment.accept", "order.view"]),
    ],
  );
  const client = agent(w.app);
  await signUp(client, "Kasir Selisih");
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

/** Opens the cashier's one shift (a cashier has one open shift) on first use. */
async function openShift(businessDate: string) {
  if (shiftId) return;
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
      businessDate,
      randomUUID(),
      "a".repeat(64),
    ],
  );
}

async function businessDateOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.d;
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
  const charge = await chargeOf(issueId);
  return { ...order, issueId, charge };
}

type ChargeRow = {
  id: string;
  status: string;
  route: string;
  payment_link_id: string | null;
  payment_intent_id: string | null;
  cash_movement_id: string | null;
  paid_by: string | null;
  paid_at: Date | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, status, route, payment_link_id, payment_intent_id,
            cash_movement_id, paid_by, paid_at
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function collect(
  chargeId: string,
  body: Record<string, unknown>,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
) {
  const request = who.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set("Host", w.tenant.hostname)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request.send(body);
}

const cashBody = (receivedIdr = AMOUNT) => ({
  idempotencyKey: randomUUID(),
  method: "cash",
  receivedIdr,
});

async function movementsOf(shift: string) {
  const { rows } = await owner.query<{
    id: string;
    type: string;
    amount_idr: string;
    recorded_by: string;
    reason_note: string;
  }>(
    `SELECT id, type, amount_idr::text, recorded_by, reason_note
     FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2`,
    [w.tenant.tenantId, shift],
  );
  return rows;
}

async function expectedCash(): Promise<number> {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
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

/**
 * The code lapsed past the 60 s margin and the provider answered final, as the
 * poll records it (`provider_final_at`): it can no longer take money.
 */
async function endCode(intentId: string) {
  await owner.query(
    `UPDATE payment_intents
     SET status = 'expired', expires_at = now() - interval '5 minutes',
         provider_final_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, intentId],
  );
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

async function linkStatus(linkId: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT CASE WHEN expires_at IS NOT NULL AND expires_at <= now()
                 THEN 'cancelled' ELSE 'active' END AS status
     FROM payment_links WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, linkId],
  );
  return rows[0]!.status;
}

describe("legend-800h1 collect a swap charge in cash at the till", () => {
  it("cash: refused while the guest's code may still be paid; once it ended, the charge is paid by a cash_in on the shift, the link is cancelled, the event says pos_cash", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const code = await guestPay(opened.guest, opened.charge.id);
    expect(code.status).toBe(201);
    const intentId = code.body.data.id as string;
    const linkId = (await chargeOf(opened.issueId)).payment_link_id!;
    const before = await expectedCash();

    // legend-f1mmf: while the guest's code may still be paid, no cash.
    const early = await collect(opened.charge.id, cashBody(AMOUNT + 1_915));
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    expect(await expectedCash()).toBe(before);
    await endCode(intentId);

    const res = await collect(opened.charge.id, cashBody(AMOUNT + 1_915));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.charge.status).toBe("paid");
    expect(res.body.data.charge.amountIdr).toBe(AMOUNT);
    expect(res.body.data.changeIdr).toBe(1_915);

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.paid_by).toBe(cashier.userId);
    expect(row.payment_intent_id).toBeNull();
    expect(row.paid_at).not.toBeNull();
    cashIns += 1;
    const movements = await movementsOf(shiftId);
    expect(movements).toHaveLength(cashIns);
    const movement = movements.find((m) => m.id === row.cash_movement_id);
    expect(movement).toMatchObject({
      id: row.cash_movement_id,
      type: "cash_in",
      amount_idr: String(AMOUNT),
      recorded_by: cashier.userId,
    });
    expect(movement!.reason_note).toContain("Selisih swap pesanan");
    expect(await expectedCash()).toBe(before + AMOUNT);

    expect(await linkStatus(linkId)).toBe("cancelled");
    expect(await intentStatus(intentId)).toBe("expired");

    const events = await w.outboxRows(
      "order_issue.charge_paid",
      opened.issueId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      chargeId: opened.charge.id,
      method: "pos_cash",
      cashMovementId: row.cash_movement_id,
      paymentIntentId: null,
      amountIdr: AMOUNT,
    });
    const { rows: audits } = await owner.query(
      `SELECT 1 FROM audit_logs WHERE tenant_id = $1
         AND event->>'action' = 'order_issue.charge_paid'
         AND event->>'actorId' = $2`,
      [w.tenant.tenantId, cashier.userId],
    );
    expect(audits).toHaveLength(1);
  });

  it("idempotent replay: same key returns the same answer, no second movement or event; other key is 409", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const body = cashBody(AMOUNT + 15);
    const first = await collect(opened.charge.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await collect(opened.charge.id, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    cashIns += 1;
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
    expect(
      await w.outboxRows("order_issue.charge_paid", opened.issueId),
    ).toHaveLength(1);
    const other = await collect(opened.charge.id, cashBody(AMOUNT));
    expect(other.status).toBe(409);
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
  });

  it("no open shift on the device: SHIFT_NOT_OPEN and nothing is written", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const res = await collect(
      opened.charge.id,
      cashBody(),
      cashier,
      OTHER_DEVICE_ID,
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("SHIFT_NOT_OPEN");
    const noDevice = await collect(opened.charge.id, cashBody(), cashier, null);
    expect(noDevice.status).toBe(409);
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(row.cash_movement_id).toBeNull();
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
    expect(
      await w.outboxRows("order_issue.charge_paid", opened.issueId),
    ).toHaveLength(0);
  });

  it("already paid by the guest (QR) or waived: 409, no cash written", async () => {
    const waivedCharge = await openCharge();
    await openShift(await businessDateOf(waivedCharge.order.id));
    const waived = await w.staffPost(
      w.supervisor,
      `/api/order-issue-charges/${waivedCharge.charge.id}/waive`,
      { reason: "Tamu komplain lama menunggu" },
    );
    expect(waived.status).toBe(200);
    expect((await collect(waivedCharge.charge.id, cashBody())).status).toBe(
      409,
    );

    const paidCharge = await openCharge();
    await owner.query(
      `UPDATE order_issue_charges SET status = 'paid', paid_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, paidCharge.charge.id],
    );
    expect((await collect(paidCharge.charge.id, cashBody())).status).toBe(409);
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
  });

  it("received below the amount is a 400; unknown charge is 404", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    expect((await collect(opened.charge.id, cashBody(AMOUNT - 1))).status).toBe(
      400,
    );
    expect((await collect(randomUUID(), cashBody())).status).toBe(404);
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
  });

  it("without pos.payment.accept: 403", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const res = await collect(opened.charge.id, cashBody(), w.floorStaff);
    expect(res.status).toBe(403);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
  });

  it("a guest who pays the ended, cancelled code later is refunded; no second charge_paid", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const code = await guestPay(opened.guest, opened.charge.id);
    const intentId = code.body.data.id as string;
    // legend-f1mmf: the code ended (provider final) before the cash is taken;
    // the guest's app still shows it and the money arrives late.
    await endCode(intentId);
    expect((await collect(opened.charge.id, cashBody())).status).toBe(200);
    cashIns += 1;

    const context = contextOf(w.tenant.tenantId);
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: AMOUNT,
      providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
    });
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
         AND event->'payload'->>'intentId' = $2`,
      [w.tenant.tenantId, intentId],
    );
    const paid: EventEnvelope = eventEnvelopeSchema.parse(rows[0]!.event);
    const routed = await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(context, paid, tx),
    );
    expect(routed).toEqual({
      route: "issue_charge",
      outcome: "late_payment_on_closed_charge",
    });
    const refunds = await owner.query(
      `SELECT amount_idr FROM payment_refunds
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
      [w.tenant.tenantId, intentId],
    );
    expect(refunds.rows).toHaveLength(1);
    expect(
      await w.outboxRows("order_issue.charge_paid", opened.issueId),
    ).toHaveLength(1);
    const row = await chargeOf(opened.issueId);
    expect(row.payment_intent_id).toBeNull();
    expect(row.status).toBe("paid");
  });

  it("F1 the guest already paid by QR (intent paid, consumer not run): 409, nothing written, link still active", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const code = await guestPay(opened.guest, opened.charge.id);
    const intentId = code.body.data.id as string;
    const linkId = (await chargeOf(opened.issueId)).payment_link_id!;

    const expectRefused = async () => {
      const res = await collect(opened.charge.id, cashBody());
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain("QRIS sudah dibayar");
      const row = await chargeOf(opened.issueId);
      expect(row.status).toBe("open");
      expect(row.cash_movement_id).toBeNull();
      expect(await movementsOf(shiftId)).toHaveLength(cashIns);
      expect(await linkStatus(linkId)).toBe("active");
      expect(
        await w.outboxRows("order_issue.charge_paid", opened.issueId),
      ).toHaveLength(0);
    };

    // The webhook committed `paid`; the charge consumer has not run yet.
    await confirmPayment(contextOf(w.tenant.tenantId), intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: AMOUNT,
      providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
    });
    expect(await intentStatus(intentId)).toBe("paid");
    await expectRefused();
  });

  it("F2 the order of the charge is voided: 409, nothing written", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    await owner.query(
      `UPDATE orders SET status = 'voided', voided_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, ulidToUuid(opened.order.id)],
    );
    const res = await collect(opened.charge.id, cashBody());
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(row.cash_movement_id).toBeNull();
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
  });

  it("F3 an idempotency key used by another cash movement of the shift: IDEMPOTENCY_KEY_REUSED (409), not a raw 500", async () => {
    const opened = await openCharge();
    await openShift(await businessDateOf(opened.order.id));
    const key = randomUUID();
    await owner.query(
      `INSERT INTO cash_movements
         (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note,
          recorded_by, recorded_at, needs_approval, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 'cash_in', 1000, 'Lain', $5, now(), false, $6, $7)`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        shiftId,
        cashier.userId,
        key,
        "b".repeat(64),
      ],
    );
    cashIns += 1;
    const res = await collect(opened.charge.id, {
      ...cashBody(),
      idempotencyKey: key,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("IDEMPOTENCY_KEY_REUSED");
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    expect(await movementsOf(shiftId)).toHaveLength(cashIns);
  });

  it("legend-44g8n two charges collected at once under one key: one 200, one 409 IDEMPOTENCY_KEY_REUSED, never a 500", async () => {
    await openShift(await businessDateOf((await openCharge()).order.id));
    // Both requests hold the shift FOR SHARE together, so the "key already
    // used" read alone lets both through; the key itself must be serialised.
    for (let round = 0; round < 3; round += 1) {
      const [a, b] = [await openCharge(), await openCharge()];
      const key = randomUUID();
      const results = await Promise.all(
        [a, b].map((c) =>
          collect(c.charge.id, { ...cashBody(), idempotencyKey: key }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([
        200, 409,
      ]);
      const loser = results.find((r) => r.status === 409)!;
      expect(JSON.stringify(loser.body)).toContain("IDEMPOTENCY_KEY_REUSED");
      cashIns += 1;
      const rows = [await chargeOf(a.issueId), await chargeOf(b.issueId)];
      expect(rows.map((r) => r.status).sort()).toEqual(["open", "paid"]);
      expect(await movementsOf(shiftId)).toHaveLength(cashIns);
    }
  });

  it("session bill shows the charge paid and the session closes normally", async () => {
    // Direct insert (a session with a paid order and an open charge), like the
    // open-bill tests: the bill of a really swapped order is out of scope here.
    const paid = await w.paidOrder();
    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    const chargeId = randomUUID();
    await owner.query(
      `INSERT INTO order_issue_charges
         (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
          difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', 7000, 7000, 350, 735, $7)`,
      [
        chargeId,
        w.tenant.tenantId,
        w.tenant.outletId,
        issueId,
        ulidToUuid(paid.order.id),
        paid.guest.sessionId,
        AMOUNT,
      ],
    );
    await openShift(await businessDateOf(paid.order.id));
    const close = () =>
      w.staffPost(
        w.floorStaff,
        `/api/table-sessions/${paid.guest.sessionId}/close`,
        { tableCleaned: true, waiterConfirmedEmpty: false },
      );
    expect((await close()).status).toBe(409);

    expect((await collect(chargeId, cashBody())).status).toBe(200);
    const bill = await agent(w.app)
      .get(`/api/table-sessions/${paid.guest.sessionId}/bill`)
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${paid.guest.token}`)
      .set(originHeader);
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const charge = (
      bill.body.data.charges as { id: string; status: string }[]
    ).find((c) => c.id === chargeId);
    expect(charge?.status).toBe("paid");
    const closed = await close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});
