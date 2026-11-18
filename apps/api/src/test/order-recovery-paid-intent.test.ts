// legend-mz15j: an open-bill order counts as paid for failed-item recovery only
// when its payment intent is settled (paid / partially_refunded / refunded).
// An intent that is pending, failed or expired is not money in the till, so the
// report, swap and voucher paths must answer 422 (ORD-08). pay_first and
// completed orders are unchanged.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CART_TOTAL,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { ulidToUuid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

async function issueCount() {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

/**
 * An open-bill order (sent, not completed) holding an intent in `status`.
 * The guest cannot pay an unsettled open bill through the API (409), so the
 * link and intent rows are inserted directly, as the cashier flow leaves them.
 */
async function openBillWithIntent(status: string) {
  const made = await w.openBillOrder();
  const orderId = ulidToUuid(made.order.id);
  const { rows: orderRows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId],
  );
  const outletId = orderRows[0]!.outlet_id;
  const linkId = randomUUID();
  const intentId = randomUUID();
  const settled = ["paid", "partially_refunded", "refunded"].includes(status);
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'mz15j-test')`,
    [
      linkId,
      w.tenant.tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `MZ-${linkId.slice(0, 8)}`,
      CART_TOTAL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7,
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '1 hour', ${settled ? "now()" : "NULL"})`,
    [
      intentId,
      w.tenant.tenantId,
      outletId,
      linkId,
      CART_TOTAL,
      `mz15j-${intentId}`,
      status,
    ],
  );
  // legend-1116: real intents never carry orders.id; the order points at its payment
  // link, and a settled intent has evidence of the money received.
  await owner.query(
    `UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'sealed-test',
            payment_intent_id = $4
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, orderId, linkId, intentId],
  );
  if (settled)
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method,
          source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        w.tenant.tenantId,
        outletId,
        intentId,
        `EV-${randomUUID().slice(0, 12)}`,
        CART_TOTAL,
      ],
    );
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId],
  );
  // The order stays an unsettled sent open-bill order.
  expect(rows[0]!.status).toBe("sent");
  return { ...made, intentId };
}

async function setIntentStatus(intentId: string, status: string) {
  const settled = ["paid", "partially_refunded", "refunded"].includes(status);
  await owner.query(
    `UPDATE payment_intents
        SET status = $3, paid_at = ${settled ? "now()" : "NULL"}
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, intentId, status],
  );
}

describe("legend-mz15j open bill: intent status decides paid", () => {
  for (const status of ["pending", "failed", "expired"]) {
    it(`laporan item pada open bill dengan intent ${status}: 422 dan tidak ada issue`, async () => {
      const { roti } = await openBillWithIntent(status);
      const before = await issueCount();
      const reported = await w.report(roti.id);
      expect(reported.status).toBe(422);
      expect(await issueCount()).toBe(before);
    });

    it(`swap dan voucher pada issue open bill yang intent-nya jadi ${status}: 422, issue tetap open`, async () => {
      const { roti, intentId } = await openBillWithIntent("paid");
      const reported = await w.report(roti.id);
      expect(reported.status).toBe(201);
      const issueId = reported.body.data.id as string;
      await setIntentStatus(intentId, status);

      const swap = await w.staffPost(
        w.supervisor,
        `/api/order-issues/${issueId}/resolve`,
        { resolution: "swap", replacementItemId: w.ids.teh },
      );
      expect(swap.status).toBe(422);

      const voucher = await w.staffPost(
        w.supervisor,
        `/api/order-issues/${issueId}/resolve`,
        { resolution: "voucher", voucherId: randomUUID() },
      );
      expect([404, 422]).toContain(voucher.status);

      const { rows } = await owner.query<{ status: string }>(
        "SELECT status FROM order_issues WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, issueId],
      );
      expect(rows[0]!.status).toBe("open");
    });
  }

  for (const status of ["paid", "partially_refunded", "refunded"]) {
    it(`intent ${status} dianggap lunas: laporan 201 dan swap 200`, async () => {
      const { roti } = await openBillWithIntent(status);
      const reported = await w.report(roti.id);
      expect(reported.status).toBe(201);
      const swap = await w.staffPost(
        w.supervisor,
        `/api/order-issues/${reported.body.data.id}/resolve`,
        { resolution: "swap", replacementItemId: w.ids.teh },
      );
      expect(swap.status).toBe(200);
    });
  }

  it("pay_first terbayar dan open bill completed tidak berubah", async () => {
    const paid = await w.paidOrder();
    expect((await w.report(paid.roti.id)).status).toBe(201);

    const { roti, order } = await openBillWithIntent("pending");
    await owner.query(
      "UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect((await w.report(roti.id)).status).toBe(201);
  });
});
