// so-879 P1 (architect finding): a backfilled hold must end when ITS code is
// paid, whatever its tender is. The cutover (migration 0379) gives a hold to
// every provider code that may still be collectible, also codes of a tender
// voided locally and sibling codes with no tender. When such a code is paid:
//  - the payment.paid consumer refunds that money (the tender cannot take it)
//    and must still end the hold of the paid intent; left `open` it freezes the
//    bill (the 0380 trigger refuses every later tender change), the next QR is
//    paid but never captured, and the consumer retries for ever;
//  - the hold check job, when the provider says paid and the money is recorded,
//    ends a hold whose tender is none / not authorized.
// Another QR of the bill keeps its own hold: its code may still be collected.
//
// Money rule: nobody is paid more than the bill. Each paid code is either
// captured once or refunded once; never both, never twice.
//
// State is built as the cutover leaves it: no holds in m1, tender A voided
// locally while the code A is alive, QR B issued, then the backfilled holds.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so879-c-backfill-paid.test.ts" heavy pnpm test
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  readBill,
  readHolds,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-c-backfill");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** Owner transaction with the tenant set and triggers off (the m1 / cutover shape). */
async function asCutover(work: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The hold row the cutover writes for a QRIS tender (migration 0379). */
async function backfillTenderHold(client: PoolClient, tenderId: string) {
  await client.query(
    `INSERT INTO pos_qris_holds
       (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
        amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
     SELECT t.tenant_id, gen_random_uuid(), t.outlet_id, t.order_id, t.id,
            t.payment_intent_id, t.amount_idr, true, 'open', t.requested_at,
            coalesce(po.cashier_id, t.captured_by), now()
       FROM pos_order_tenders t
       JOIN pos_orders po ON po.tenant_id = t.tenant_id AND po.order_id = t.order_id
      WHERE t.tenant_id = $1 AND t.id = $2`,
    [fx.tenant.tenantId, tenderId],
  );
}

/**
 * A bill as the cutover finds it: code A alive at the provider but its tender
 * voided locally (m1: the cashier replaced it), QR B issued afterwards. Both
 * get a backfilled open hold.
 */
async function billWithOldCodeA() {
  const order = await newSubmittedOrder(fx, 0);
  const orderUuid = ulidToUuid(order.id);
  const a = await issueQris(fx, order.id);
  await asCutover(async (client) => {
    await client.query(
      "DELETE FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2",
      [fx.tenant.tenantId, orderUuid],
    );
    await client.query(
      `UPDATE pos_order_tenders SET status='voided', resolved_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, a.tenderId],
    );
  });
  const b = await issueQris(fx, order.id);
  await asCutover(async (client) => {
    await client.query(
      "UPDATE pos_qris_holds SET backfilled=true WHERE tenant_id=$1 AND order_id=$2",
      [fx.tenant.tenantId, orderUuid],
    );
    await backfillTenderHold(client, a.tenderId);
  });
  const holds = await readHolds(fx, order.id);
  expect(holds.map((h) => [h.paymentIntentId, h.state])).toEqual(
    expect.arrayContaining([
      [a.intentId, "open"],
      [b.intentId, "open"],
    ]),
  );
  return { order, a, b };
}

/** Deliver the payment.paid events of an intent that is already recorded. */
async function deliverPaid(intentId: string, deliveries = 2) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  expect(rows.length, "the intent has a payment.paid event").toBeGreaterThan(0);
  for (const row of rows)
    for (let i = 0; i < deliveries; i += 1)
      await handlePosPaymentPaid(
        fx.context,
        eventEnvelopeSchema.parse(row.event),
      );
}

async function holdOf(orderId: string, intentId: string) {
  const hold = (await readHolds(fx, orderId)).find(
    (h) => h.paymentIntentId === intentId,
  );
  expect(hold, `hold of intent ${intentId}`).toBeDefined();
  return hold!;
}

describe("so-879 P1 backfilled hold ends when its own code is paid", () => {
  it("(a) old code A (tender voided) paid, then B: A refunded once and its hold ends, B captured once, the bill is settled", async () => {
    const { order, a, b } = await billWithOldCodeA();

    await payNotice(fx, a.intentId, a.amountIdr, new Date(), a.providerRef!);

    // A is money the bill cannot take: refunded in full, once. Its hold ends;
    // B keeps its own (its code may still be paid).
    expect((await holdOf(order.id, a.intentId)).state).toBe("paid");
    expect((await holdOf(order.id, a.intentId)).closeReason).toBe(
      "provider_paid",
    );
    expect((await holdOf(order.id, b.intentId)).state).toBe("open");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(await refundsOfIntent(fx, a.intentId)).toEqual([
      expect.objectContaining({ amountIdr: a.amountIdr }),
    ]);

    // Then B is paid: captured once. Before the fix the hold of A stayed open
    // and the trigger refused this capture on every retry.
    await payNotice(fx, b.intentId, b.amountIdr, new Date(), b.providerRef!);

    expect(await capturedIdr(fx, order.id)).toBe(b.amountIdr);
    // The bill is paid in full, once: captured = total, nothing over.
    expect(await capturedIdr(fx, order.id)).toBe(
      (await readBill(fx, order.id)).totalIdr,
    );
    expect((await holdOf(order.id, b.intentId)).state).toBe("paid");
    expect(await refundsOfIntent(fx, b.intentId)).toEqual([]);
    expect(await refundsOfIntent(fx, a.intentId)).toHaveLength(1);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
      "captured",
    ]);
    expect(
      (await readHolds(fx, order.id)).filter(
        (h) => h.state === "open" || h.state === "cancelling",
      ),
    ).toEqual([]);
  });

  it("(a2) provider says A is paid (job, no webhook yet): the hold of A ends, the refund still comes once", async () => {
    const { order, a, b } = await billWithOldCodeA();
    fx.gateway.script(a.intentId, { rawStatus: "00", amountIdr: a.amountIdr });

    await runHoldCheck(fx, new Date());

    expect((await holdOf(order.id, a.intentId)).state).toBe("paid");
    expect((await holdOf(order.id, b.intentId)).state).toBe("open");

    // The payment.paid event of A arrives later: refund once, nothing captured.
    await deliverPaid(a.intentId);
    expect(await refundsOfIntent(fx, a.intentId)).toHaveLength(1);
    expect(await capturedIdr(fx, order.id)).toBe(0);
  });

  it("(b) B paid while old code A may still be paid: B is not captured until A is proven dead, then captured once", async () => {
    const { order, a, b } = await billWithOldCodeA();

    // The capture is refused (hold of A active): the event is retried by the
    // consumer; nothing is captured, nothing refunded, no hold is lost.
    const refused = await payNotice(
      fx,
      b.intentId,
      b.amountIdr,
      new Date(),
      b.providerRef!,
      { deliveries: 1 },
    ).then(
      () => "",
      (error: unknown) => {
        const cause = (error as { cause?: { message?: string } }).cause;
        return `${String(error)} ${cause?.message ?? ""}`;
      },
    );
    expect(refused).toContain("QRIS_HOLD_ACTIVE");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await holdOf(order.id, a.intentId)).state).toBe("open");
    expect((await holdOf(order.id, b.intentId)).state).toBe("open");
    expect(await refundsOfIntent(fx, b.intentId)).toEqual([]);

    // The provider proves A dead (expired, past the 60 s margin).
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, a.intentId],
    );
    fx.gateway.script(a.intentId, { rawStatus: "02" });
    await runHoldCheck(fx, new Date());
    expect((await holdOf(order.id, a.intentId)).state).toBe("closed");

    // The consumer retries: B is captured exactly once.
    await deliverPaid(b.intentId);
    expect(await capturedIdr(fx, order.id)).toBe(b.amountIdr);
    expect((await holdOf(order.id, b.intentId)).state).toBe("paid");
    expect(await refundsOfIntent(fx, b.intentId)).toEqual([]);
    expect(await refundsOfIntent(fx, a.intentId)).toEqual([]);
  });
});

describe("so-879 P1 sibling code with no tender", () => {
  /** A POS QR (tender T, intent I1) and a sibling code S on the same link that
   * has no tender: the cutover gives S its own backfilled hold. */
  async function billWithSiblingCode() {
    const order = await newSubmittedOrder(fx, 0);
    const first = await issueQris(fx, order.id);
    let siblingId = "";
    await asCutover(async (client) => {
      const cols = (
        await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name='payment_intents' AND table_schema='public'
              AND is_generated='NEVER' ORDER BY ordinal_position`,
        )
      ).rows.map((r) => r.column_name);
      const copy = (name: string) =>
        name === "id"
          ? "gen_random_uuid()"
          : name === "idempotency_key"
            ? "'so879-sibling-' || gen_random_uuid()::text"
            : name === "provider_ref"
              ? "'so879-sibling-ref-' || gen_random_uuid()::text"
              : `"${name}"`;
      const cloned = await client.query<{ id: string }>(
        `INSERT INTO payment_intents (${cols.map((n) => `"${n}"`).join(",")})
         SELECT ${cols.map(copy).join(",")}
           FROM payment_intents WHERE tenant_id=$1 AND id=$2
         RETURNING id::text AS id`,
        [fx.tenant.tenantId, first.intentId],
      );
      siblingId = cloned.rows[0]!.id;
      await client.query(
        `INSERT INTO pos_qris_holds
           (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
            amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
         SELECT i.tenant_id, gen_random_uuid(), i.outlet_id, t.order_id, NULL, i.id,
                i.amount_idr, true, 'open', i.created_at, NULL, now()
           FROM payment_intents i
           JOIN pos_order_tenders t
             ON t.tenant_id = i.tenant_id AND t.id = $3
          WHERE i.tenant_id = $1 AND i.id = $2`,
        [fx.tenant.tenantId, siblingId, first.tenderId],
      );
    });
    return { order, first, siblingId };
  }

  it("(c) the sibling code is paid (event): its hold ends and the tender is captured once", async () => {
    const { order, first, siblingId } = await billWithSiblingCode();
    const sibling = await holdOf(order.id, siblingId);
    expect(sibling.state).toBe("open");
    expect(sibling.tenderId).toBeNull();

    await payNotice(fx, siblingId, first.amountIdr, new Date(), "TX-SIBLING");

    expect((await holdOf(order.id, siblingId)).state).toBe("paid");
    expect((await holdOf(order.id, first.intentId)).state).toBe("paid");
    expect(await capturedIdr(fx, order.id)).toBe(first.amountIdr);
    expect(await refundsOfIntent(fx, siblingId)).toEqual([]);
  });

  it("(c2) provider says the sibling code is paid (job): its hold ends; the bill's own QR keeps its hold", async () => {
    const { order, first, siblingId } = await billWithSiblingCode();
    fx.gateway.script(siblingId, {
      rawStatus: "00",
      amountIdr: first.amountIdr,
    });

    await runHoldCheck(fx, new Date());

    expect((await holdOf(order.id, siblingId)).state).toBe("paid");
    expect((await holdOf(order.id, siblingId)).closeReason).toBe(
      "provider_paid",
    );
    // The tender's own code is still collectible: its hold stays, the payment
    // of the sibling is captured only by the payment.paid consumer.
    expect((await holdOf(order.id, first.intentId)).state).toBe("open");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await deliverPaid(siblingId);
    expect(await capturedIdr(fx, order.id)).toBe(first.amountIdr);
  });
});
