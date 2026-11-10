// legend-i83ls (S1, consumer): `deliverIssueChargeEvent`, `handleIssueChargePaid`
// and `handleIssueChargeClosed` (services/order-recovery-charge.ts). Contract: scratchpad design-B.md.
// Written before the service exists, so the file starts red (missing module).
//
// The resolve step (staff) writes the outbox event; the worker is not running
// in tests, so each test delivers that real event by hand inside a tenant
// transaction, as worker-main.ts does: swap kitchen first, then the charge.
//
// Money in the standard order (helpers): subtotal 78.000, service 3.900, PBJT
// 8.190. Dearer swap roti 18.000 -> kopi 25.000: D = 7.000, charge gross 7.000,
// service 350, PBJT 735, amount 8.085.
//
// Assumptions where the brief is silent:
// - The charge's own payment link is made here with `createPaymentLink` and
//   tied to the charge by SQL (the guest-payment slice does it lazily); its
//   total is the charge amount. The intent is a real QRIS intent confirmed by
//   a verified webhook, and its real `payment.paid` outbox event is delivered.
// - The POS route: a `pos_orders` row is inserted for the QR order.
// - Not tested: an open-bill order (reporting a failed item on an unpaid open
//   bill answers 422, order-recovery.test.ts) and the `order_amounts_mismatch`
//   block (`orders_total_check` refuses an order that fails its identity).
// - Audit rows are found by action name and the issue id in audit_logs.event.
// - `handleIssueChargeClosed` is fed a copy of the `payment.paid` envelope with
//   another name and payload; it reads only name, tenant and payload.

import { randomBytes, randomUUID } from "node:crypto";
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { orderIssueChargePaidPayloadSchema } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverIssueChargeEvent,
  handleIssueChargeClosed,
  handleIssueChargePaid,
} from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  confirmPayment,
  createIntent,
  createPaymentLink,
} from "../services/payment.service.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

/** As the worker does: swap kitchen, then the charge, in one transaction. */
async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
}

/** Only the swap kitchen consumer (the replacement line, no charge yet). */
async function deliverSwapOnly(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

/** Only the charge consumer, without the swap kitchen one before it. */
async function deliverChargeOnly(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverIssueChargeEvent(context, event, tx),
  );
}

async function resolvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

/** A paid order whose roti failed and was swapped by the supervisor. */
async function swap(replacementItemId: string) {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId =
    replacementItemId === w.ids.kopi
      ? await w.insertApproval({
          actionType: "price_correction",
          objectType: "order_issue",
          objectId: issueId,
          amountIdr: DIFFERENCE,
          status: "approved",
          requestedBy: w.floorStaff.userId,
        })
      : undefined;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId,
      ...(approvalId === undefined ? {} : { approvalRequestId: approvalId }),
    },
  );
  expect(resolved.status).toBe(200);
  return { ...order, issueId, event: await resolvedEvent(issueId) };
}

type ChargeRow = {
  id: string;
  order_issue_id: string;
  order_id: string;
  table_session_id: string | null;
  route: string;
  status: string;
  difference_idr: number;
  gross_sales_idr: number;
  service_charge_idr: number;
  pbjt_idr: number;
  amount_idr: number;
  payment_link_id: string | null;
  payment_intent_id: string | null;
  paid_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason: string | null;
};

async function chargesOf(issueId: string): Promise<ChargeRow[]> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, order_issue_id, order_id, table_session_id, route, status,
            difference_idr::int AS difference_idr,
            gross_sales_idr::int AS gross_sales_idr,
            service_charge_idr::int AS service_charge_idr,
            pbjt_idr::int AS pbjt_idr, amount_idr::int AS amount_idr,
            payment_link_id, payment_intent_id, paid_at, closed_at, closed_by,
            close_reason
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function onlyCharge(issueId: string): Promise<ChargeRow> {
  const rows = await chargesOf(issueId);
  expect(rows, "one order_issue_charges row").toHaveLength(1);
  return rows[0]!;
}

async function auditCount(issueId: string, action: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event::text LIKE $2 AND event::text LIKE $3`,
    [w.tenant.tenantId, `%${action}%`, `%${issueId}%`],
  );
  return Number(rows[0]!.n);
}

async function orderMoney(orderId: string) {
  const { rows } = await owner.query<Record<string, unknown>>(
    `SELECT status, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
            rounding_idr, total_idr, payment_link_id, payment_intent_id
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!;
}

async function intentCount() {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_intents WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

/** A dearer swap with its charge opened by the consumer pair. */
async function openCharge() {
  const swapped = await swap(w.ids.kopi);
  await deliver(swapped.event);
  return { ...swapped, charge: await onlyCharge(swapped.issueId) };
}

/**
 * Ties a payment link of `totalIdr` to the charge and pays it through a real
 * QRIS intent; returns the `payment.paid` event and the ids.
 */
async function payCharge(chargeId: string, totalIdr: number) {
  const context = contextOf(w.tenant.tenantId);
  const opened = await createPaymentLink(
    context,
    {
      outletId: w.tenant.outletId,
      reference: `oic-${randomBytes(4).toString("hex")}`,
      tableLabel: "T-uji",
      pax: 2,
      subtotalIdr: totalIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr,
      returnPath: null,
    },
    "system:qr-order",
  );
  await owner.query(
    `UPDATE order_issue_charges
     SET payment_link_id = $3, payment_link_token_sealed = 'test-sealed'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId, opened.linkId],
  );
  const intent = await createIntent(context, opened.token, {
    method: "qris",
    channelCode: null,
    idempotencyKey: randomUUID(),
  });
  await confirmPayment(context, intent.id, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: totalIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intent.id],
  );
  return {
    linkId: opened.linkId,
    intentId: intent.id,
    event: eventEnvelopeSchema.parse(rows[0]!.event),
  };
}

async function handlePaid(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    handleIssueChargePaid(context, event, tx),
  );
}

async function handleClosed(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    handleIssueChargeClosed(context, event, tx),
  );
}

async function chargePaidEvents(issueId: string) {
  return w.outboxRows("order_issue.charge_paid", issueId);
}

/** Pins the intent of the guest's current attempt on the charge. */
async function pinIntent(chargeId: string, intentId: string) {
  await owner.query(
    `UPDATE order_issue_charges SET payment_intent_id = $3
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId, intentId],
  );
}

// ---- deliverIssueChargeEvent -----------------------------------------------

describe("legend-i83ls deliverIssueChargeEvent: tagihan selisih swap", () => {
  it("swap staf ke menu lebih mahal pada order QR: satu tagihan open lewat link, jumlah selisih + service + PBJT", async () => {
    const swapped = await swap(w.ids.kopi);
    const before = await orderMoney(swapped.order.id);
    const intentsBefore = await intentCount();

    await deliver(swapped.event);

    expect(await onlyCharge(swapped.issueId)).toMatchObject({
      route: "qr_link",
      status: "open",
      order_id: toUuid(swapped.order.id),
      table_session_id: swapped.guest.sessionId,
      difference_idr: DIFFERENCE,
      gross_sales_idr: DIFFERENCE,
      service_charge_idr: 350,
      pbjt_idr: 735,
      amount_idr: AMOUNT,
      payment_link_id: null,
      payment_intent_id: null,
      paid_at: null,
      closed_at: null,
    });
    // The order, its link and its intent are not touched; no payment is made.
    expect(await orderMoney(swapped.order.id)).toEqual(before);
    expect(await intentCount()).toBe(intentsBefore);
    expect(await auditCount(swapped.issueId, "order_issue.charge_opened")).toBe(
      1,
    );
  });

  it("event dobel berurutan dan serentak tetap satu tagihan dan satu audit", async () => {
    const swapped = await swap(w.ids.kopi);

    await deliver(swapped.event);
    await deliver(swapped.event);
    await Promise.all([deliver(swapped.event), deliver(swapped.event)]);

    expect(await chargesOf(swapped.issueId)).toHaveLength(1);
    expect(await auditCount(swapped.issueId, "order_issue.charge_opened")).toBe(
      1,
    );
  });

  it("swap ke menu lebih murah atau sama harga: tanpa tagihan", async () => {
    const cheaper = await swap(w.ids.teh);
    await deliver(cheaper.event);
    expect(await chargesOf(cheaper.issueId)).toHaveLength(0);

    const same = await swap(w.ids.rotiLain);
    await deliver(same.event);
    expect(await chargesOf(same.issueId)).toHaveLength(0);
  });

  it("tanpa lini pengganti (swap kitchen belum jalan): tanpa tagihan; sesudah swap kitchen, tagihan dibuat", async () => {
    const swapped = await swap(w.ids.kopi);

    await deliverChargeOnly(swapped.event);
    expect(await chargesOf(swapped.issueId)).toHaveLength(0);

    await deliver(swapped.event);
    expect((await onlyCharge(swapped.issueId)).amount_idr).toBe(AMOUNT);
  });

  it("order sudah void: tanpa tagihan", async () => {
    const swapped = await swap(w.ids.kopi);
    await deliverSwapOnly(swapped.event);
    await owner.query(
      `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'Batal di kasir'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, toUuid(swapped.order.id)],
    );

    await deliverChargeOnly(swapped.event);

    expect(await chargesOf(swapped.issueId)).toHaveLength(0);
  });

  it("event tenant lain, outlet lain, resolusi bukan swap, atau nama lain: diabaikan tanpa error", async () => {
    const swapped = await swap(w.ids.kopi);
    await deliverSwapOnly(swapped.event);

    await deliverChargeOnly({
      ...swapped.event,
      tenantId: randomUUID(),
    } as never);
    await deliverChargeOnly({
      ...swapped.event,
      outletId: randomUUID(),
    } as never);
    await deliverChargeOnly({
      ...swapped.event,
      payload: { ...swapped.event.payload, resolution: "voucher" },
    });
    await deliverChargeOnly({
      ...swapped.event,
      name: "order.placed",
    } as never);

    expect(await chargesOf(swapped.issueId)).toHaveLength(0);
  });

  it("order di bill kasir (pos_orders): tagihan routed_pos tanpa link, audit sekali", async () => {
    const swapped = await swap(w.ids.kopi);
    await owner.query(
      "UPDATE orders SET channel = 'pos' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(swapped.order.id)],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [toUuid(swapped.order.id), w.tenant.tenantId, w.tenant.outletId],
    );

    await deliver(swapped.event);
    await deliver(swapped.event);

    expect(await onlyCharge(swapped.issueId)).toMatchObject({
      route: "pos",
      status: "routed_pos",
      table_session_id: null,
      payment_link_id: null,
      amount_idr: AMOUNT,
    });
    expect(
      await auditCount(swapped.issueId, "order_issue.charge_routed_pos"),
    ).toBe(1);
    expect(await auditCount(swapped.issueId, "order_issue.charge_opened")).toBe(
      0,
    );
  });
});

// ---- handleIssueChargePaid / handleIssueChargeClosed -----------------------

describe("legend-i83ls handleIssueChargePaid: uang masuk", () => {
  it("link tagihan lunas: tagihan paid, event order_issue.charge_paid sah sekali, replay tidak mengubah apa pun", async () => {
    const { charge, issueId, order } = await openCharge();
    const moneyBefore = await orderMoney(order.id);
    const paid = await payCharge(charge.id, charge.amount_idr);

    expect(await handlePaid(paid.event)).toBe("paid");

    const after = await onlyCharge(issueId);
    expect(after).toMatchObject({
      status: "paid",
      payment_link_id: paid.linkId,
      payment_intent_id: paid.intentId,
    });
    expect(after.paid_at).not.toBeNull();
    const events = await chargePaidEvents(issueId);
    expect(events).toHaveLength(1);
    expect(
      orderIssueChargePaidPayloadSchema.parse(events[0]!.event.payload),
    ).toMatchObject({
      orderId: order.id,
      orderIssueId: issueId,
      chargeId: charge.id,
      paymentIntentId: paid.intentId,
      differenceIdr: DIFFERENCE,
      grossSalesIdr: DIFFERENCE,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
      amountIdr: AMOUNT,
    });
    expect(await auditCount(issueId, "order_issue.charge_paid")).toBe(1);
    // The order itself is never touched by the charge payment.
    expect(await orderMoney(order.id)).toEqual(moneyBefore);

    // Replay, also concurrently: nothing changes, no second event or audit.
    expect(await handlePaid(paid.event)).toBe("unchanged");
    await Promise.all([handlePaid(paid.event), handlePaid(paid.event)]);
    expect(await chargePaidEvents(issueId)).toHaveLength(1);
    expect(await auditCount(issueId, "order_issue.charge_paid")).toBe(1);
    expect(await onlyCharge(issueId)).toEqual(after);
  });

  it("total link berbeda dari jumlah tagihan: amount_mismatch, tagihan tetap open", async () => {
    const { charge, issueId } = await openCharge();
    const paid = await payCharge(charge.id, charge.amount_idr + 1_000);

    expect(await handlePaid(paid.event)).toBe("amount_mismatch");

    expect((await onlyCharge(issueId)).status).toBe("open");
    expect(await chargePaidEvents(issueId)).toHaveLength(0);
  });

  it("link bukan milik tagihan, event bukan payment.paid, atau tenant lain: diabaikan", async () => {
    const { charge } = await openCharge();
    const { event } = await payCharge(charge.id, charge.amount_idr);

    expect(
      await handlePaid({
        ...event,
        payload: { ...event.payload, paymentLinkId: randomUUID() },
      }),
    ).toBe("ignored");
    expect(
      await handlePaid({ ...event, name: "payment.expired" } as never),
    ).toBe("ignored");
    expect(
      await handlePaid({ ...event, tenantId: randomUUID() } as never),
    ).toBe("ignored");
  });

  it("uang masuk sesudah tagihan dibebaskan: late_payment_on_closed_charge, tagihan tetap waived", async () => {
    const { charge, issueId } = await openCharge();
    // As the staff route does (closeIssueCharge): waived with reason and actor.
    await owner.query(
      `UPDATE order_issue_charges
       SET status = 'waived', closed_at = now(), closed_by = $3,
           close_reason = 'Tamu komplain lama menunggu'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, charge.id, w.supervisor.userId],
    );
    const paid = await payCharge(charge.id, charge.amount_idr);

    expect(await handlePaid(paid.event)).toBe("late_payment_on_closed_charge");

    expect((await onlyCharge(issueId)).status).toBe("waived");
    expect(await chargePaidEvents(issueId)).toHaveLength(0);
  });

  it("intent lain dari link yang sama membayar sesudah tagihan paid: double_payment, tanpa event kedua", async () => {
    const { charge, issueId } = await openCharge();
    const first = await payCharge(charge.id, charge.amount_idr);
    expect(await handlePaid(first.event)).toBe("paid");
    const second = {
      ...first.event,
      payload: { ...first.event.payload, intentId: randomUUID() },
    };

    expect(await handlePaid(second)).toBe("double_payment");

    expect(await chargePaidEvents(issueId)).toHaveLength(1);
    expect((await onlyCharge(issueId)).payment_intent_id).toBe(first.intentId);
  });
});

describe("legend-i83ls handleIssueChargeClosed: kode kedaluwarsa atau gagal", () => {
  it("kode yang dipakai tagihan open gagal: tagihan tetap open, penunjuk intent dibersihkan", async () => {
    const { charge, issueId } = await openCharge();
    const paid = await payCharge(charge.id, charge.amount_idr);
    await pinIntent(charge.id, paid.intentId);
    const closed = {
      ...paid.event,
      name: "payment.failed",
      payload: { intentId: paid.intentId },
    } as never as EventEnvelope;

    expect(await handleClosed(closed)).toBe("retry_allowed");

    expect(await onlyCharge(issueId)).toMatchObject({
      status: "open",
      payment_intent_id: null,
    });
    expect(await handleClosed(closed)).toBe("unchanged");
  });

  it("kode yang digantikan (superseded) bukan pembayaran yang tutup: diabaikan", async () => {
    const { charge, issueId } = await openCharge();
    const paid = await payCharge(charge.id, charge.amount_idr);
    await pinIntent(charge.id, paid.intentId);

    expect(
      await handleClosed({
        ...paid.event,
        name: "payment.expired",
        payload: { intentId: paid.intentId, reason: "superseded" },
      } as never),
    ).toBe("ignored");

    expect((await onlyCharge(issueId)).payment_intent_id).toBe(paid.intentId);
  });
});
