// 1268 W3 (legend-9yw78.7): a non-cash tender of a captain order (submitted by
// a waiter, so the order carries no shift) books on the receiving cashier's
// open shift, so the shift report counts it. No shift: no tender, no QR.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import { formatReceiptNumber } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { getReceiptDocument } from "../services/pos-receipt-delivery.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner } from "./floor-test-helpers.ts";
import { originHeader } from "./helpers.ts";
import {
  captainPaymentFixture,
  resetCaptainPaymentPorts,
  type CaptainPaymentFixture,
} from "./pos-captain-payment-test-helpers.ts";

let fixture: CaptainPaymentFixture;
beforeAll(async () => {
  fixture = await captainPaymentFixture("captain-shift-tender");
});
afterAll(async () => {
  resetCaptainPaymentPorts();
  await owner.end();
});

/** A captain order as the waiter leaves it: submitted, no shift on the order. */
async function waiterOrder() {
  const guest = await fixture.newGuest();
  const draft = await fixture.createDraft(guest.sessionId);
  const submitted = await fixture.submit(draft.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  await owner.query(
    "UPDATE pos_orders SET shift_id = NULL WHERE tenant_id = $1 AND order_id = $2",
    [fixture.tenant.tenantId, ulidToUuid(draft.id)],
  );
  return submitted.body.data as { id: string; status: string };
}

const shiftOfTenders = async (orderId: string) =>
  (
    await owner.query<{ method: string; shift_id: string | null }>(
      "SELECT method, shift_id FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2",
      [fixture.tenant.tenantId, ulidToUuid(orderId)],
    )
  ).rows;

describe("1268 W3 captain order non-cash tender shift", () => {
  it("books the QRIS tender on the receiving cashier's open shift", async () => {
    const order = await waiterOrder();
    const { rows: shifts } = await owner.query<{ id: string }>(
      "SELECT id FROM pos_shifts WHERE tenant_id = $1 AND cashier_id = $2 AND status = 'open'",
      [fixture.tenant.tenantId, fixture.staff.userId],
    );
    expect(shifts).toHaveLength(1);
    const paid = await fixture.tender(order.id, order.status, "qris");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await shiftOfTenders(order.id)).toEqual([
      { method: "qris", shift_id: shifts[0]!.id },
    ]);
  });

  it("refuses a non-cash tender when the cashier has no open shift, before any QR", async () => {
    const order = await waiterOrder();
    const otherDevice = randomUUID();
    await registerTestDevice(owner, {
      tenantId: fixture.tenant.tenantId,
      outletId: fixture.tenant.outletId,
      deviceId: otherDevice,
    });
    setDeviceOutletResolver(async (input) =>
      input.tenantId === fixture.tenant.tenantId
        ? fixture.tenant.outletId
        : null,
    );
    const token = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: fixture.tenant.tenantId,
      brandId: null,
      deviceId: otherDevice,
    });
    const before = await fixture.counts();
    const refused = await fixture.staff.client
      .post(`${fixture.base}/${order.id}/tenders`)
      .set(fixture.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .send({
        expectedStatus: order.status,
        method: "qris",
        idempotencyKey: randomUUID(),
      });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("SHIFT_NOT_OPEN");
    expect(await fixture.counts()).toEqual(before);
    expect(await shiftOfTenders(order.id)).toEqual([]);
  });

  it("prints the receiving cashier on the receipt, not the waiter who submitted", async () => {
    const order = await waiterOrder();
    const orderUuid = ulidToUuid(order.id);
    const { rows: waiters } = await owner.query<{ id: string; name: string }>(
      'SELECT id, name FROM "user" WHERE id <> $1 LIMIT 1',
      [fixture.staff.userId],
    );
    const { rows: cashiers } = await owner.query<{ name: string }>(
      'SELECT name FROM "user" WHERE id = $1',
      [fixture.staff.userId],
    );
    expect(waiters[0]!.name.trim()).not.toBe(cashiers[0]!.name.trim());
    await owner.query(
      "UPDATE pos_orders SET cashier_id = $3 WHERE tenant_id = $1 AND order_id = $2",
      [fixture.tenant.tenantId, orderUuid, waiters[0]!.id],
    );
    const paid = await fixture.tender(order.id, order.status, "cash", 33_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const sequenceId = randomUUID();
    const deviceId = randomUUID();
    const prefix = `S${randomUUID().slice(0, 4).toUpperCase()}`;
    await owner.query(
      `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [
        sequenceId,
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        deviceId,
        prefix,
      ],
    );
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO pos_receipts
         (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number,
          status, issued_at, outlet_snapshot)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, 1, 'issued', now(), $7::jsonb)
       RETURNING id`,
      [
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        orderUuid,
        sequenceId,
        deviceId,
        formatReceiptNumber(prefix, 1),
        JSON.stringify({
          outletName: "Cafe Uji",
          outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
          legalName: null,
          npwpLast4: null,
        }),
      ],
    );
    const document = await getReceiptDocument(
      fixture.context,
      outletIdSchema.parse(fixture.tenant.outletId),
      rows[0]!.id,
    );
    expect(document.cashierName).toBe(cashiers[0]!.name.trim());
  });
});
