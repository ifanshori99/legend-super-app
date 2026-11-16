// legend-w0ows (docs/briefs/so-879-qris-hold-fix.md, docs/qa/second-opinion-qris-hold.md):
// a card (EDC/ECR) sale and a collectible QRIS must never both take the
// customer's money for one bill. Founder Q7: when both happen, the card wins
// and the QR is refunded in full.
//
// Old behavior (before the fix): the EDC agent's write-ahead did not look at
// the hold, so the terminal could take the card while the QR was still
// payable; the card tender was then refused (hold active) and the money sat
// on the terminal.
//
// Assumptions (the brief does not pin them):
// - The agent refusal is any rejection of `requestPayment`; what is judged is
//   the ledger (no `edc_transactions` row) and the money afterwards.
// - A QR issued while a card sale is open may be refused (409) or issued; both
//   are accepted as long as the customer never ends up charged twice: if it is
//   issued and paid, it is refunded in full ("system:pos").
// - "Card sale sent" is a raw `edc_transactions` ECR row of the bill (the
//   bill's number is the reference), as pos-qris-edc-lock.test.ts seeds it.
// - Bill of the fixture: Rp 33.000.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EdcPaymentRequest } from "@starter/shared/edc";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  readHold,
  refundsOfIntent,
  requestQris,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL = 33_000;

let fx: HoldFixture;
let ctx: ScopedTenantContext;
let edcAgent: ReturnType<typeof createEdcAgent>;
const terminalId = randomUUID();

async function asOwnerTenant<T>(run: (c: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-edc");
  await asOwnerTenant((c) =>
    c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-SO879', 'MID-SO879', 'Test EDC', 'lan',
               '10.0.0.7', ARRAY['card','qris'], 'active')`,
      [terminalId, fx.tenant.tenantId, fx.tenant.outletId],
    ),
  );
  ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(fx.tenant.outletId)] },
  );
  const registry = new EdcProviderRegistry();
  registry.register(new EcrSimulator("bca"));
  edcAgent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  await edcAgent.start(ctx);
});
afterAll(async () => {
  await edcAgent?.stop(ctx).catch(() => undefined);
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------ helpers

async function numberOf(orderId: string) {
  const res = await fx.get(`${fx.base}/${orderId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.number as string;
}

function saleRequest(reference: string): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    outletId: outletIdSchema.parse(fx.tenant.outletId),
    terminalId,
    reference,
    idempotencyKey: randomUUID(),
    amountIdr: idr(BILL),
    method: "card",
  } as EdcPaymentRequest;
}

/** Runs the card write-ahead and reports instead of throwing. */
const startCardSale = (reference: string) =>
  edcAgent.requestPayment(ctx, fx.staff.userId, saleRequest(reference)).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

async function ledgerOf(reference: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM edc_transactions
      WHERE tenant_id=$1 AND reference=$2 AND type='sale' ORDER BY created_at`,
    [fx.tenant.tenantId, reference],
  );
  return rows;
}

/** A card sale of the bill in the EDC ledger (the terminal was asked). */
async function ledgerSale(reference: string, status: string) {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    status,
  );
  await asOwnerTenant((c) =>
    c.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr',
               $9, 'APP123', $10, $11)`,
      [
        id,
        fx.tenant.tenantId,
        fx.tenant.outletId,
        terminalId,
        reference,
        randomUUID(),
        BILL,
        status,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
        final ? new Date() : null,
      ],
    ),
  );
  return id;
}

async function setSaleStatus(id: string, status: string) {
  await asOwnerTenant((c) =>
    c.query(
      `UPDATE edc_transactions SET status=$3, completed_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, id, status],
    ),
  );
}

async function bookCard(orderId: string, edcTransactionId: string) {
  const read = await fx.get(`${fx.base}/${orderId}`);
  return fx.post(`${fx.base}/${orderId}/tenders`, {
    method: "edc_card",
    expectedStatus: read.body.data.status as string,
    edcTransactionId,
    idempotencyKey: randomUUID(),
  });
}

async function capturedMethods(orderId: string) {
  return (await tenderStatuses(fx, orderId))
    .filter((t) => t.status === "captured")
    .map((t) => [t.method, t.amount]);
}

async function refundedTotal(intentId: string) {
  return (await refundsOfIntent(fx, intentId)).reduce(
    (sum, r) => sum + r.amountIdr,
    0,
  );
}

function expectNoDeadlock(...results: unknown[]) {
  for (const r of results)
    expect(
      String((r as { error?: unknown })?.error ?? ""),
      "lock cycle",
    ).not.toMatch(/deadlock|40P01/i);
}

// -------------------------------------------------------------------- tests

describe("legend-w0ows card sale vs collectible QR", () => {
  it("w0ows-1 the agent refuses to start a card sale while the bill's QR is collectible; the QR is then captured once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const number = await numberOf(order.id);

    const started = await startCardSale(number);

    expect(started.ok, "card sale accepted while a QR hold is active").toBe(
      false,
    );
    expect(await ledgerOf(number), "terminal must never be asked").toEqual([]);
    expect((await readHold(fx, order.id))?.state).toBe("open");

    await payNotice(fx, qr.intentId, BILL);
    expect(await capturedMethods(order.id)).toEqual([["qris", BILL]]);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("w0ows-2 the route refuses an EDC tender that has no sale of its own while the QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const read = await fx.get(`${fx.base}/${order.id}`);

    const res = await fx.post(`${fx.base}/${order.id}/tenders`, {
      method: "edc_card",
      expectedStatus: read.body.data.status as string,
      idempotencyKey: randomUUID(),
    });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await readHold(fx, order.id))?.state).toBe("open");
  });

  it("w0ows-3 Q7 card sale open first, QR paid after: QR refunded in full, card books the bill once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const sale = await ledgerSale(number, "pending");
    const read = await requestQris(fx, order.id);

    if (read.status === 201) {
      const intentId = read.body.data.tender.paymentIntentId as string;
      await payNotice(fx, intentId, BILL);
      expect(
        await capturedIdr(fx, order.id),
        "QR captured with card open",
      ).toBe(0);
      expect(await refundedTotal(intentId), "QR refunded in full").toBe(BILL);
      expect((await readHold(fx, order.id))?.state).not.toBe("open");
    } else {
      expect(read.status, JSON.stringify(read.body)).toBe(409);
    }

    await setSaleStatus(sale, "approved");
    const booked = await bookCard(order.id, sale);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await capturedMethods(order.id)).toEqual([["edc_card", BILL]]);
    await assertInvariants(fx, order.id);
  });

  it("w0ows-4 Q7 card sale declined: QR refunded in full, nothing stuck, the bill can still be paid in cash", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const sale = await ledgerSale(number, "pending");
    const read = await requestQris(fx, order.id);
    if (read.status === 201) {
      const intentId = read.body.data.tender.paymentIntentId as string;
      await payNotice(fx, intentId, BILL);
      expect(await refundedTotal(intentId)).toBe(BILL);
    } else {
      expect(read.status, JSON.stringify(read.body)).toBe(409);
    }

    await setSaleStatus(sale, "declined");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    const cash = await fx.tender(order.id, order.status, "cash", BILL);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(await capturedMethods(order.id)).toEqual([["cash", BILL]]);
    await assertInvariants(fx, order.id);
  });

  it("w0ows-5 card sale already sent while a QR is collectible: the card tender books, the late QR payment is refunded in full", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const number = await numberOf(order.id);
    const sale = await ledgerSale(number, "approved");

    const booked = await bookCard(order.id, sale);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await capturedMethods(order.id)).toEqual([["edc_card", BILL]]);

    await payNotice(fx, qr.intentId, BILL);

    expect(await capturedMethods(order.id)).toEqual([["edc_card", BILL]]);
    const refunded = await refundedTotal(qr.intentId);
    const parked = (await unallocatedFunds(fx, qr.intentId)).reduce(
      (sum, p) => sum + p.amountIdr,
      0,
    );
    // The customer's second payment must come back (refund asked), never stay
    // silently with the outlet.
    expect(refunded + parked, "QR money is owed back in full").toBe(BILL);
    expect(refunded, "refund must be requested, not only parked").toBe(BILL);
    expect((await readHold(fx, order.id))?.state).not.toBe("open");
    await assertInvariants(fx, order.id);
  });

  it("w0ows-6 card booked after the hold ended: the QR is dead, the card books once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const number = await numberOf(order.id);
    // QR paid first and captured: the bill is settled; a later card write-ahead
    // is refused and records nothing.
    await payNotice(fx, qr.intentId, BILL);
    expect(await capturedMethods(order.id)).toEqual([["qris", BILL]]);
    expect((await startCardSale(number)).ok).toBe(false);
    expect(await ledgerOf(number)).toEqual([]);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("w0ows-7 races: card write-ahead against QR payment and QR issue never deadlock and never charge twice", async () => {
    // A: QR collectible, QR paid while the agent tries to start a card sale.
    for (let round = 0; round < 3; round += 1) {
      const order = await newSubmittedOrder(fx, 0);
      const qr = await issueQris(fx, order.id);
      const number = await numberOf(order.id);
      const [card, paid] = await Promise.all([
        startCardSale(number),
        payNotice(fx, qr.intentId, BILL).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      expectNoDeadlock(card, paid);
      expect(paid.ok, JSON.stringify((paid as { error?: unknown }).error)).toBe(
        true,
      );
      expect(card.ok, "card accepted next to a collectible/paid QR").toBe(
        false,
      );
      expect(await ledgerOf(number)).toEqual([]);
      expect(await capturedMethods(order.id)).toEqual([["qris", BILL]]);
      expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
      await assertInvariants(fx, order.id);
    }
    // B: nothing yet; the agent and the QR issue start together.
    for (let round = 0; round < 3; round += 1) {
      const order = await newSubmittedOrder(fx, 0);
      const number = await numberOf(order.id);
      const [card, qr] = await Promise.all([
        startCardSale(number),
        requestQris(fx, order.id),
      ]);
      expectNoDeadlock(card);
      expect(qr.status, JSON.stringify(qr.body)).toBeLessThan(500);
      const ledger = await ledgerOf(number);
      if (qr.status === 201 && ledger.length > 0) {
        // Both got in: Q7, the card wins and the QR is refunded in full.
        const intentId = qr.body.data.tender.paymentIntentId as string;
        await payNotice(fx, intentId, BILL);
        expect(await refundedTotal(intentId)).toBe(BILL);
        expect(
          (await capturedMethods(order.id)).filter(([m]) => m === "qris"),
        ).toEqual([]);
      } else {
        // Exactly one source of money is open.
        expect(
          (qr.status === 201 ? 1 : 0) + (ledger.length > 0 ? 1 : 0),
        ).toBeLessThanOrEqual(1);
      }
      expect(await capturedIdr(fx, order.id)).toBeLessThanOrEqual(BILL);
    }
  });
});
