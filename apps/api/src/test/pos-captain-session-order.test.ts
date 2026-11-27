// legend-dysef G5: staff add to an existing QR session through the canonical
// captain order contract. The shared bill must include it exactly once.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
beforeAll(async () => {
  fixture = await cashierFixture("captain-qr");
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
});
afterAll(async () => {
  setQrOrderDepositCreditLookup(null);
  setTableSessionSettlementLookup(null);
  await owner.end();
});

async function staffOrder(sessionId: string) {
  const created = await fixture.create({
    channel: "captain",
    serviceType: "dine_in",
    tableSessionId: sessionId,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await fixture.post(
    `${fixture.base}/${created.body.data.id}/submit`,
    { expectedStatus: created.body.data.status, idempotencyKey: randomUUID() },
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return submitted.body.data as {
    id: string;
    totalIdr: number;
    depositAppliedIdr: number;
  };
}

async function tender(
  orderId: string,
  amountIdr: number,
  status: "captured" | "authorized",
) {
  // Isolate the bill projection from payment processing. The existing POS
  // payment suites prove capture; this seed is a valid stored cash tender.
  await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
       (id, tenant_id, outlet_id, order_id, method, provider, amount_idr,
        received_idr, change_idr, status, requested_at, resolved_at, captured_by)
     VALUES ($1, $2, $3, $4, 'cash', 'manual', $5, $5, 0, $6, now(), $7, $8)`,
      [
        randomUUID(),
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        ulidToUuid(orderId),
        amountIdr,
        status,
        status === "captured" ? new Date() : null,
        fixture.staff.userId,
      ],
    ),
  );
}

/** Seed WS-05's verified paid snapshot; gateway/webhook behavior has its own suites. */
async function paidLink(orderId: string, amountIdr: number) {
  return asCashierTenant(fixture.tenant.tenantId, async (client) => {
    const orderUuid = ulidToUuid(orderId);
    const { rows } = await client.query<{ payment_link_id: string | null }>(
      "SELECT payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [fixture.tenant.tenantId, orderUuid],
    );
    let linkId = rows[0]!.payment_link_id;
    if (linkId === null) {
      linkId = randomUUID();
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
        [
          linkId,
          fixture.tenant.tenantId,
          fixture.tenant.outletId,
          randomBytes(32).toString("hex"),
          `CAP-${linkId}`,
          amountIdr,
          fixture.staff.userId,
        ],
      );
      await client.query(
        "UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'settlement-test-token' WHERE tenant_id = $1 AND id = $2",
        [fixture.tenant.tenantId, orderUuid, linkId],
      );
    } else {
      await client.query(
        "UPDATE payment_links SET paid_idr = $3 WHERE tenant_id = $1 AND id = $2",
        [fixture.tenant.tenantId, linkId, amountIdr],
      );
    }
    const intentId = randomUUID();
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
          amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid', now(),
               '{"method":"qris","qrPayload":"00020101021226CAPTAIN","issuer":null}',
               now() + interval '1 hour')`,
      [
        intentId,
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        linkId,
        orderUuid,
        amountIdr,
        randomUUID(),
      ],
    );
    // 1273: settlement counts a link's money net of provider refunds from the
    // intent's verified evidence, so a paid intent carries its evidence row.
    await client.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        intentId,
        `cap-ref-${intentId}`,
        amountIdr,
      ],
    );
    return { linkId, intentId };
  });
}

async function realSettlement(sessionId: string) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fixture.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    qrOrderSettlementLookup({
      tx,
      tenantId: context.tenant.tenantId,
      sessionId,
    }),
  );
}

async function gatewayTender(
  orderId: string,
  amountIdr: number,
  linked: { linkId: string; intentId: string },
) {
  await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
          payment_link_token_sealed, payment_intent_id, amount_idr, status,
          requested_at, resolved_at, captured_by)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 'settlement-test-token', $5,
               $6, 'captured', now(), now(), $7)`,
      [
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        ulidToUuid(orderId),
        linked.linkId,
        linked.intentId,
        amountIdr,
        fixture.staff.userId,
      ],
    ),
  );
}

describe("legend-dysef captain additions to QR session", () => {
  it("G5 staff appends a server-priced order to the live session once across retries", async () => {
    const guest = await fixture.newGuest();
    const body = {
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: guest.sessionId,
      items: [fixture.line({ quantity: 2 })],
      idempotencyKey: randomUUID(),
    };
    const first = await fixture.create(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await fixture.create(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(first.body.data).toMatchObject({
      tableSessionId: guest.sessionId,
      channel: "captain",
      subtotalIdr: 60_000,
    });
    const submitted = await fixture.post(
      `${fixture.base}/${first.body.data.id}/submit`,
      { expectedStatus: first.body.data.status, idempotencyKey: randomUUID() },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals.totalIdr).toBe(first.body.data.totalIdr);
    expect(bill.body.data.totals.outstandingIdr).toBe(first.body.data.totalIdr);
    const { rows } = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM orders WHERE tenant_id = $1 AND table_session_id = $2 AND id = $3",
      [
        fixture.tenant.tenantId,
        guest.sessionId,
        ulidToUuid(first.body.data.id),
      ],
    );
    expect(rows[0]?.count).toBe(1);
    const view = await fixture.guestGet(guest, "");
    expect(view.body.data.session.id).toBe(guest.sessionId);
  });

  it("G5-MONEY-01 excludes an unsubmitted staff draft from the guest's payable invoice", async () => {
    const guest = await fixture.newGuest();
    const created = await fixture.create({
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: guest.sessionId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe("draft");
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: 0,
      paidIdr: 0,
      outstandingIdr: 0,
    });
  });

  it("G5-MONEY-02 counts captured POS money exactly once while preserving the QR session", async () => {
    const guest = await fixture.newGuest();
    const order = await staffOrder(guest.sessionId);
    await tender(order.id, order.totalIdr, "captured");
    for (let read = 0; read < 2; read++) {
      const bill = await fixture.guestGet(guest, "/bill");
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totals).toMatchObject({
        totalIdr: order.totalIdr,
        paidIdr: order.totalIdr,
        outstandingIdr: 0,
      });
    }
    const view = await fixture.guestGet(guest, "");
    expect(view.body.data.session.id).toBe(guest.sessionId);
  });

  it("G5-MONEY-03 an authorized POS tender cannot reduce the amount still owed to the outlet", async () => {
    const guest = await fixture.newGuest();
    const order = await staffOrder(guest.sessionId);
    await tender(order.id, order.totalIdr, "authorized");
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: order.totalIdr,
      paidIdr: 0,
      outstandingIdr: order.totalIdr,
    });
  });

  it("G5-MONEY-04 sibling staff orders share one DP and captured money covers only their remaining value", async () => {
    setQrOrderDepositCreditLookup(async () => 20_000);
    try {
      const guest = await fixture.newGuest();
      const first = await staffOrder(guest.sessionId);
      const second = await staffOrder(guest.sessionId);
      const deposit = first.depositAppliedIdr + second.depositAppliedIdr;
      expect(deposit).toBe(20_000);
      const gross = first.totalIdr + second.totalIdr;
      const captured = gross - deposit;
      await tender(
        first.id,
        first.totalIdr - first.depositAppliedIdr,
        "captured",
      );
      await tender(
        second.id,
        second.totalIdr - second.depositAppliedIdr,
        "captured",
      );
      const bill = await fixture.guestGet(guest, "/bill");
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totals).toMatchObject({
        totalIdr: gross,
        paidIdr: deposit + captured,
        outstandingIdr: 0,
      });
      expect(deposit + captured).toBe(gross);
    } finally {
      setQrOrderDepositCreditLookup(null);
    }
  });

  it("G5-MONEY-05 mixed QR/POS funding counts each gateway source once and closes only after the real remaining amount is captured", async () => {
    const guest = await fixture.newGuest();
    const guestPost = (suffix: string, body: Record<string, unknown>) =>
      agent(fixture.app)
        .post(`/api/table-sessions/${guest.sessionId}${suffix}`)
        .set(fixture.headers)
        .set(originHeader)
        .set("Authorization", `Bearer ${guest.token}`)
        .send(body);
    const added = await guestPost("/cart/lines", {
      menuItemId: fixture.ids.meal,
      modifierIds: [],
      quantity: 1,
      expectedCartVersion: 0,
      idempotencyKey: randomUUID(),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const placed = await guestPost("/orders", {
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const qrOrder = placed.body.data.order as { id: string; totalIdr: number };
    const captain = await staffOrder(guest.sessionId);
    await paidLink(qrOrder.id, qrOrder.totalIdr);
    const gatewayPartIdr = 11_000;
    const linked = await paidLink(captain.id, gatewayPartIdr);
    // This tender and its order's paid link are the same WS-05 payment.
    // Counting both would invent Rp11.000 and allow an underpaid table to close.
    await gatewayTender(captain.id, gatewayPartIdr, linked);
    const gross = qrOrder.totalIdr + captain.totalIdr;
    const paidBeforeCash = qrOrder.totalIdr + gatewayPartIdr;
    expect(await realSettlement(guest.sessionId)).toEqual({
      billTotalIdr: gross,
      paidIdr: paidBeforeCash,
    });
    const refused = await fixture.post(
      `/api/table-sessions/${guest.sessionId}/close`,
      { tableCleaned: true },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.message).toMatch(/ORD-10/);
    expect((await fixture.guestGet(guest, "")).status).toBe(200);
    await tender(captain.id, captain.totalIdr - gatewayPartIdr, "captured");
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: gross,
      paidIdr: gross,
      outstandingIdr: 0,
    });
    expect(await realSettlement(guest.sessionId)).toEqual({
      billTotalIdr: gross,
      paidIdr: gross,
    });
    const closed = await fixture.post(
      `/api/table-sessions/${guest.sessionId}/close`,
      { tableCleaned: true },
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      closedReason: "paid_and_cleaned",
    });
    expect((await fixture.guestGet(guest, "")).status).toBe(401);
  });

  it("G5-MONEY-06 an unpaid configured link cannot hide actual captured POS money", async () => {
    const guest = await fixture.newGuest();
    const captain = await staffOrder(guest.sessionId);
    const linked = await paidLink(captain.id, captain.totalIdr);
    // A link's paid counter can lag behind a captured POS tender. The valid
    // association alone is not proof that this money was already counted.
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        "UPDATE payment_links SET paid_idr = 0 WHERE tenant_id = $1 AND id = $2",
        [fixture.tenant.tenantId, linked.linkId],
      ),
    );
    expect(await realSettlement(guest.sessionId)).toEqual({
      billTotalIdr: captain.totalIdr,
      paidIdr: 0,
    });
    await gatewayTender(captain.id, captain.totalIdr, linked);
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: captain.totalIdr,
      paidIdr: captain.totalIdr,
      outstandingIdr: 0,
    });
    expect(await realSettlement(guest.sessionId)).toEqual({
      billTotalIdr: captain.totalIdr,
      paidIdr: captain.totalIdr,
    });
  });
});
