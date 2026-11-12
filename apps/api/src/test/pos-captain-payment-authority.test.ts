// legend-dysef G5-PAY: a staff bill has one payment authority. Guest whole or
// split checkout cannot charge staff orders already controlled by the POS.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  confirmPayment,
  createIntent,
  createPaymentLink,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  captainPaymentFixture,
  resetCaptainPaymentPorts,
  type CaptainPaymentFixture,
} from "./pos-captain-payment-test-helpers.ts";

let fixture: CaptainPaymentFixture;
beforeAll(async () => {
  fixture = await captainPaymentFixture("payment-authority");
});
afterAll(async () => {
  resetCaptainPaymentPorts();
  await owner.end();
});

async function staffOrder(sessionId: string) {
  const draft = await fixture.createDraft(sessionId);
  const submitted = await fixture.submit(draft.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(
    submitted.body.data.items.every(
      (item: { fireStatus: string }) => item.fireStatus === "held",
    ),
  ).toBe(true);
  return submitted.body.data as {
    id: string;
    status: string;
    totalIdr: number;
  };
}

async function legacySplit(
  sessionId: string,
  orderId: string,
  totalIdr: number,
) {
  const ids = [randomUUID(), randomUUID()];
  const splitSetId = randomUUID();
  const firstAmount = Math.floor(totalIdr / 2);
  await asCashierTenant(fixture.tenant.tenantId, async (client) => {
    for (const [index, id] of ids.entries())
      await client.query(
        `INSERT INTO bill_splits
         (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id, method, share_index, amount_idr)
       VALUES ($1,$2,$3,$4,$5,$6,'equal',$7,$8)`,
        [
          id,
          fixture.tenant.tenantId,
          fixture.tenant.outletId,
          sessionId,
          ulidToUuid(orderId),
          splitSetId,
          index,
          index === 0 ? firstAmount : totalIdr - firstAmount,
        ],
      );
  });
  return ids[0]!;
}

async function legacyGuestSource(
  orderId: string,
  totalIdr: number,
  state: "pending" | "paid" | "expired",
) {
  const source = await createPaymentLink(
    fixture.context,
    {
      outletId: outletIdSchema.parse(fixture.tenant.outletId),
      reference: `LEGACY-${randomUUID().slice(0, 16)}`,
      tableLabel: "Captain",
      pax: 2,
      subtotalIdr: totalIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr,
      returnPath: "/t/v1.captain",
    },
    fixture.staff.userId,
  );
  const intent = await createIntent(
    fixture.context,
    source.token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: randomUUID(),
    }),
  );
  if (state === "paid")
    await confirmPayment(fixture.context, intent.id, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: totalIdr,
      providerRef: `LEGACY-PAID-${randomUUID()}`,
      at: new Date().toISOString(),
    });
  await asCashierTenant(fixture.tenant.tenantId, async (client) => {
    await client.query(
      "UPDATE orders SET payment_link_id=$3, payment_link_token_sealed='legacy-test-token', payment_intent_id=$4 WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant.tenantId, ulidToUuid(orderId), source.linkId, intent.id],
    );
    if (state === "expired") {
      await client.query(
        "UPDATE payment_links SET expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant.tenantId, source.linkId],
      );
      await client.query(
        "UPDATE payment_intents SET status='expired', expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant.tenantId, intent.id],
      );
    }
  });
}

describe("legend-dysef staff and guest payment authorities", () => {
  it("G5-PAY-01 a held staff order refuses guest order payment before or after real cash capture", async () => {
    const guest = await fixture.newGuest();
    const order = await staffOrder(guest.sessionId);
    const payBody = () => ({
      target: { kind: "order", orderId: order.id },
      method: "qris",
      idempotencyKey: randomUUID(),
    });
    const before = await fixture.counts();
    const refused = await fixture.guestPost(guest, "/payments", payBody());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(await fixture.counts()).toEqual(before);
    const cash = await fixture.tender(
      order.id,
      order.status,
      "cash",
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);
    const afterCash = await fixture.counts();
    const refusedAgain = await fixture.guestPost(guest, "/payments", payBody());
    expect(refusedAgain.status, JSON.stringify(refusedAgain.body)).toBe(409);
    expect(await fixture.counts()).toEqual(afterCash);
  });

  it("G5-PAY-02 staff split creation is refused before any split or payment-source write", async () => {
    const guest = await fixture.newGuest();
    await staffOrder(guest.sessionId);
    const before = await fixture.counts();
    const refused = await fixture.guestPost(guest, "/splits", {
      method: "equal",
      parts: 2,
      idempotencyKey: randomUUID(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(await fixture.counts()).toEqual(before);
  });

  it("G5-PAY-03 an old staff split cannot charge again after a real POS cash payment", async () => {
    const guest = await fixture.newGuest();
    const order = await staffOrder(guest.sessionId);
    const partId = await legacySplit(guest.sessionId, order.id, order.totalIdr);
    const cash = await fixture.tender(
      order.id,
      order.status,
      "cash",
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);
    const before = await fixture.counts();
    const refused = await fixture.guestPost(guest, "/payments", {
      target: { kind: "split", billSplitId: partId },
      payerSecret: secretFor(partId),
      method: "qris",
      idempotencyKey: randomUUID(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(await fixture.counts()).toEqual(before);
  });

  it.each([
    ["pending", "cash"],
    ["paid", "cash"],
    ["expired", "cash"],
    ["pending", "qris"],
    ["paid", "qris"],
    ["expired", "qris"],
  ] as const)(
    "G5-PAY-04 a legacy %s guest source blocks a second POS %s source without new writes",
    async (state, method) => {
      const guest = await fixture.newGuest();
      const order = await staffOrder(guest.sessionId);
      await legacyGuestSource(order.id, order.totalIdr, state);
      const before = await fixture.counts();
      const refused = await fixture.tender(
        order.id,
        order.status,
        method,
        order.totalIdr,
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe("CONFLICT");
      expect(await fixture.counts()).toEqual(before);
      const unchanged = await fixture.get(`${fixture.base}/${order.id}`);
      expect(unchanged.body.data.tenders).toEqual([]);
    },
  );

  it("G5-PAY-05 native QR pay-first whole and split payments remain available, while POS refuses the QR order", async () => {
    const wholeGuest = await fixture.newGuest();
    const whole = await fixture.qrOrder(wholeGuest);
    const wholePayment = await fixture.guestPost(wholeGuest, "/payments", {
      target: { kind: "order", orderId: whole.id },
      method: "qris",
      idempotencyKey: randomUUID(),
    });
    expect(wholePayment.status, JSON.stringify(wholePayment.body)).toBe(201);
    expect(wholePayment.body.data.amountIdr).toBe(whole.totalIdr);
    const refusedPos = await fixture.tender(
      whole.id,
      whole.status,
      "cash",
      whole.totalIdr,
    );
    expect(refusedPos.status, JSON.stringify(refusedPos.body)).toBe(404);
    const splitGuest = await fixture.newGuest();
    const splitOrder = await fixture.qrOrder(splitGuest);
    const split = await fixture.guestPost(splitGuest, "/splits", {
      method: "equal",
      parts: 2,
      idempotencyKey: randomUUID(),
    });
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as { id: string; amountIdr: number }[];
    expect(parts.reduce((sum, part) => sum + part.amountIdr, 0)).toBe(
      splitOrder.totalIdr,
    );
    const first = parts[0]!;
    const splitPayment = await fixture.guestPost(splitGuest, "/payments", {
      target: { kind: "split", billSplitId: first.id },
      payerSecret: secretFor(first.id),
      method: "qris",
      idempotencyKey: randomUUID(),
    });
    expect(splitPayment.status, JSON.stringify(splitPayment.body)).toBe(201);
    expect(splitPayment.body.data.amountIdr).toBe(first.amountIdr);
  });
});
