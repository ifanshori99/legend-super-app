// legend-i83ls gap 1: an open bill is paid at the cashier by POS tenders while
// a dearer-swap charge (`order_issue_charges`, status `open`) is still on the
// session. Money taken at the till must not be taken a second time through the
// guest's QR payment link for the same charge.
//
// The fix is `closeChargesCoveredAtPos` (order-recovery-charge.ts), run in its
// own transaction right after a POS tender is captured (addPosTender and the
// QRIS capture of handlePosPaymentPaid). These tests call it directly:
// - The POS refuses a tender above the order's balance (`remainingIdr`), so a
//   real tender can never reach the charge by itself; the money that covers a
//   charge (an earlier overpaying tender, a deposit) is seeded as rows. A full
//   cashier fixture (device, shift, receipt port) is not needed for the rule.
// - Tenders are captured rows on the session's orders, like ws03-open-bill.
// - The guest never reads the settlement first: the charge must already be
//   closed when the guest tries to pay it (409, no payment opened).
// - A POS refund is its own row (the tender stays `captured`): it takes money
//   back out of the bill's cover. Doubt means the charge stays open.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { closeChargesCoveredAtPos } from "../services/order-recovery-charge.ts";
import { loadSettlement } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  asOwnerTenant,
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

const DIFFERENCE = 6_000;
const SERVICE = 300;
const PBJT = 630;
const AMOUNT = DIFFERENCE + SERVICE + PBJT;

function scopedContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Places one more kopi order in a session whose cart was used before. */
async function placeSecondOrder(guest: Guest) {
  const call = (path: string) =>
    agent(w.app)
      .post(`/api/table-sessions/${guest.sessionId}${path}`)
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const view = await agent(w.app)
    .get(`/api/table-sessions/${guest.sessionId}`)
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader);
  const added = await call("/cart/lines").send({
    idempotencyKey: randomUUID(),
    modifierIds: [],
    menuItemId: w.ids.kopi,
    quantity: 1,
    expectedCartVersion: view.body.data.cart.version,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await call("/orders").send({
    expectedCartVersion: added.body.data.cart.version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.data.order as { id: string };
}

/**
 * A session whose first order is paid and carries an open charge, plus a
 * second order the guest has placed but not paid (the cashier will take it).
 * Assumption: an unpaid open-bill item cannot be reported (422), so the charge
 * sits on the session of a paid order and the till settles the second order.
 */
async function sessionWithChargeAndSecondOrder() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const chargeId = randomUUID();
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', $7, $7, $8, $9, $10)`,
    [
      chargeId,
      w.tenant.tenantId,
      w.tenant.outletId,
      issueId,
      ulidToUuid(paid.order.id),
      paid.guest.sessionId,
      DIFFERENCE,
      SERVICE,
      PBJT,
      AMOUNT,
    ],
  );
  const second = await placeSecondOrder(paid.guest);
  const { rows } = await owner.query<{ total: string }>(
    "SELECT total_idr::text AS total FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(second.id)],
  );
  return {
    guest: paid.guest,
    issueId,
    chargeId,
    second,
    secondTotal: Number(rows[0]!.total),
  };
}

/** The cashier takes the order over and records captured tenders on it. */
async function ringAtCashier(orderId: string, amounts: number[]) {
  const id = ulidToUuid(orderId);
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE orders SET channel = 'captain' WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, id],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'captain')`,
      [id, w.tenant.tenantId, w.tenant.outletId],
    );
    for (const amountIdr of amounts)
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
            change_idr, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
        [w.tenant.tenantId, w.tenant.outletId, id, amountIdr],
      );
    // The cashier completes the order, as the POS does once it is paid.
    await client.query(
      `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, id],
    );
  });
}

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_at: Date | null;
    paid_at: Date | null;
    close_reason: string | null;
    closed_by: string | null;
  }>(
    `SELECT status, closed_at, paid_at, close_reason, closed_by
     FROM order_issue_charges WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

function guestPaysCharge(guest: Guest, chargeId: string) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

/** Runs the rule the way the POS hook does: its own transaction. */
function closeCovered(sessionId: string, actorUserId: string | null) {
  const context = scopedContext();
  return withTenant(db, context, (tx) =>
    closeChargesCoveredAtPos(
      tx,
      context,
      sessionId,
      new Date(),
      actorUserId,
      () => loadSettlement(tx, context, sessionId),
    ),
  );
}

/** A POS refund row on an order, as POS-04 leaves it (the tender stays). */
async function refundAtCashier(orderId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO pos_order_refunds
       (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
        requested_by, approved_by, approval_request_id, refunded_at)
     VALUES ($1, $2, $3, $4, 'quality_complaint', 'Uji', $5::jsonb, 'kasir', 'penyelia', $6, now())`,
    [
      w.tenant.tenantId,
      w.tenant.outletId,
      ulidToUuid(orderId),
      amountIdr,
      JSON.stringify([{ method: "cash", amountIdr }]),
      randomUUID(),
    ],
  );
}

describe("open bill paid by POS tender with a charge open", () => {
  it("tenders covering only the order leave the charge owed and payable once", async () => {
    const { guest, second, secondTotal, chargeId } =
      await sessionWithChargeAndSecondOrder();
    await ringAtCashier(second.id, [secondTotal]);

    expect(await closeCovered(guest.sessionId, w.supervisor.userId)).toBe(0);
    expect((await chargeRow(chargeId)).status).toBe("open");

    const paying = await guestPaysCharge(guest, chargeId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
  });

  it("tenders settling the whole bill, charge included, close the charge with a reason, an audit row and no payment link for the guest", async () => {
    const { guest, second, secondTotal, chargeId, issueId } =
      await sessionWithChargeAndSecondOrder();
    // One tender for the order and one for the swap difference: the till
    // took the whole outstanding bill in cash.
    await ringAtCashier(second.id, [secondTotal, AMOUNT]);

    expect(await closeCovered(guest.sessionId, w.supervisor.userId)).toBe(1);

    const row = await chargeRow(chargeId);
    expect(row.status).toBe("expired");
    expect(row.close_reason).toBe("paid_at_pos");
    expect(row.closed_at).not.toBeNull();
    expect(row.paid_at).toBeNull();
    expect(row.closed_by).toBe(w.supervisor.userId);

    const { rows: audits } = await owner.query<{ actor_id: string | null }>(
      `SELECT event->>'actorId' AS actor_id FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectId' = $2
         AND event->>'action' = 'order_issue.charge_paid_at_pos'`,
      [w.tenant.tenantId, issueId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBe(w.supervisor.userId);

    // The guest never read the settlement: the charge is closed already.
    const paying = await guestPaysCharge(guest, chargeId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(409);

    // Replay changes nothing.
    expect(await closeCovered(guest.sessionId, w.supervisor.userId)).toBe(0);
  });

  it("a POS refund of the tendered money keeps the charge open", async () => {
    const { guest, second, secondTotal, chargeId } =
      await sessionWithChargeAndSecondOrder();
    await ringAtCashier(second.id, [secondTotal, AMOUNT]);
    await refundAtCashier(second.id, AMOUNT);

    expect(await closeCovered(guest.sessionId, w.supervisor.userId)).toBe(0);
    expect((await chargeRow(chargeId)).status).toBe("open");

    const paying = await guestPaysCharge(guest, chargeId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
  });
});
