// legend-i83ls gap 1: an open bill is paid at the cashier by POS tenders while
// a dearer-swap charge (`order_issue_charges`, status `open`) is still on the
// session. The POS must never decide that a swap charge was paid at the till.
//
// Why: `remainingIdr` caps every POS tender at the order's total minus what is
// applied or captured, so a cashier tender never contains charge money. The
// session settlement counts the whole reservation deposit credit as paid
// (`depositCreditFor`), so leftover deposit credit plus tenders can reach
// "bill incl. charge" without anyone paying the charge. Closing the charge
// then (`expired` / `paid_at_pos`) booked no journal and lost revenue and
// PBJT. The guest keeps paying the charge through the QR link, whose
// payment path writes the journal.
//
// Real path: `addPosTender` (the service behind POST .../pos/orders/:orderId/
// tenders), cash method, on a QR order the cashier took over. The HTTP route is
// not used: it only adds device auth in front of the same call, so the caller
// (user, device, open shift) is seeded here. The reservation deposit is not
// seeded through the reservation flow; the deposit credit port
// (`setQrOrderDepositCreditLookup`) stands in for it, like
// pos-order-deposit-lock.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { addPosTender } from "../services/pos-order-payment.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  asOwnerTenant,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
/** Reservation deposit credit per table session (stands in for the DP flow). */
const depositCredit = new Map<string, number>();

beforeAll(async () => {
  w = await createWorld();
  setQrOrderDepositCreditLookup(
    async (_tx, _tenantId, sessionId) => depositCredit.get(sessionId) ?? 0,
  );
}, 120_000);

afterAll(async () => {
  setQrOrderDepositCreditLookup(null);
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

const DEVICE_ID = randomUUID();

/**
 * The cashier takes the order over (a POS extension row, status `sent`) and
 * has an open shift on a device, so a cash tender can be recorded.
 */
async function takeOverAtCashier(orderId: string) {
  const id = ulidToUuid(orderId);
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE orders SET channel = 'captain', status = 'sent' WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, id],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'captain')`,
      [id, w.tenant.tenantId, w.tenant.outletId],
    );
    await client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       SELECT $1, $2, $3, $4, $5, o.business_date, 'open', now() - interval '1 hour', 0, $6, $7
       FROM orders o WHERE o.tenant_id = $2 AND o.id = $8
         AND NOT EXISTS (
           SELECT 1 FROM pos_shifts s
           WHERE s.tenant_id = $2 AND s.device_id = $4 AND s.status = 'open')`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        DEVICE_ID,
        w.supervisor.userId,
        randomUUID(),
        "a".repeat(64),
        id,
      ],
    );
  });
}

/** One cash tender through the POS service, as the cashier's payment panel does. */
function cashTender(orderId: string, receivedIdr: number) {
  return addPosTender(
    scopedContext(),
    {
      userId: userIdSchema.parse(w.supervisor.userId),
      deviceId: DEVICE_ID,
      expectedVersion: null,
    },
    outletIdSchema.parse(w.tenant.outletId),
    orderId,
    {
      method: "cash",
      receivedIdr,
      expectedStatus: "sent",
      idempotencyKey: randomUUID(),
    },
  );
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

async function chargeAuditCount(issueId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
       AND event->>'action' = 'order_issue.charge_paid_at_pos'`,
    [w.tenant.tenantId, issueId],
  );
  return Number(rows[0]!.n);
}

describe("open bill paid by POS tender with a charge open", () => {
  it("a cash tender is capped at the order's remaining and never carries charge money", async () => {
    const { second, secondTotal } = await sessionWithChargeAndSecondOrder();
    await takeOverAtCashier(second.id);

    // The customer hands over the order AND the swap difference in cash.
    const result = await cashTender(second.id, secondTotal + AMOUNT);
    expect(result.tender.amountIdr).toBe(secondTotal);
    expect(result.tender.changeIdr).toBe(AMOUNT);
    expect(result.remainingIdr).toBe(0);

    // The order is paid in full: another tender has nothing to apply to.
    await expect(cashTender(second.id, AMOUNT)).rejects.toMatchObject({
      code: "ORDER_NOT_PAYABLE",
    });
  });

  it("leftover deposit credit plus a tender for the whole order leave the charge open", async () => {
    const { guest, second, secondTotal, chargeId, issueId } =
      await sessionWithChargeAndSecondOrder();
    // The session holds a reservation deposit credit that covers the charge.
    depositCredit.set(guest.sessionId, AMOUNT * 2);
    await takeOverAtCashier(second.id);

    await cashTender(second.id, secondTotal);

    const row = await chargeRow(chargeId);
    expect(row.status).toBe("open");
    expect(row.closed_at).toBeNull();
    expect(row.close_reason).toBeNull();
    expect(row.paid_at).toBeNull();
    expect(await chargeAuditCount(issueId)).toBe(0);
  });

  it("the guest still pays the charge through the QR link after the cashier tender", async () => {
    const { guest, second, secondTotal, chargeId } =
      await sessionWithChargeAndSecondOrder();
    depositCredit.set(guest.sessionId, AMOUNT * 2);
    await takeOverAtCashier(second.id);
    await cashTender(second.id, secondTotal);

    const paying = await guestPaysCharge(guest, chargeId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
    expect((await chargeRow(chargeId)).status).toBe("open");
  });
});
