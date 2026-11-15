// SO-896 (legend-o6q8i, review architect P2-2): a card (ECR) sale may not
// START while the bill still has guest money parked open. After a manager
// force release the QR hold is closed, so `assertNoActiveQrisHoldForEdcSale`
// sees a free bill; a late verified payment is parked, and a card sale started
// now would charge the guest twice (the card tender is exempt at booking, Q7).
// The write-ahead refuses with 409 FUNDS_UNRESOLVED before the terminal is
// asked. The points tender is guarded by the same check.
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
  holdFixture,
  payNotice,
  readBill,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { BILL_IDR, releaseKit } from "./qris-hold-so885-d-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
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
  fx = await holdFixture("qris-hold-so896-edc-open-funds");
  kit = releaseKit(fx);
  await asOwnerTenant((c) =>
    c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-SO896', 'MID-SO896', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
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
});

async function numberOf(orderId: string) {
  const res = await fx.get(`${fx.base}/${orderId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.number as string;
}

const startCardSale = (reference: string) =>
  edcAgent
    .requestPayment(ctx, fx.staff.userId, {
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      outletId: outletIdSchema.parse(fx.tenant.outletId),
      terminalId,
      reference,
      idempotencyKey: randomUUID(),
      amountIdr: idr(BILL_IDR),
      method: "card",
    } as EdcPaymentRequest)
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

async function ledgerOf(reference: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM edc_transactions
      WHERE tenant_id=$1 AND reference=$2`,
    [fx.tenant.tenantId, reference],
  );
  return rows;
}

async function parkLateMoney() {
  const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
  await payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!).catch(
    () => null,
  );
  const parked = await unallocatedFunds(fx, qr.intentId);
  expect(parked.map((p) => [p.amountIdr, p.resolution])).toEqual([
    [BILL_IDR, null],
  ]);
  return { orderId, qr };
}

const resolveFunds = (intentId: string) =>
  owner.query(
    `UPDATE payment_unallocated_funds
        SET resolution='refund', resolved_by='test', resolved_at=now()
      WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );

describe("SO-896 card sale start with the guest's released QR money parked open", () => {
  it("force release, late paid parked: the card sale is refused 409 FUNDS_UNRESOLVED, terminal never asked; once resolved it starts", async () => {
    const { orderId, qr } = await parkLateMoney();
    const number = await numberOf(orderId);

    const refused = await startCardSale(number);
    expect(refused.ok, "card sale accepted with open funds").toBe(false);
    const error = (refused as { error: { status?: number; code?: string } })
      .error;
    expect(error.status).toBe(409);
    expect(error.code).toBe("FUNDS_UNRESOLVED");
    expect(await ledgerOf(number), "terminal must never be asked").toEqual([]);

    await resolveFunds(qr.intentId);
    const started = await startCardSale(number);
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(await ledgerOf(number)).toHaveLength(1);
  });

  it("control: a force released bill with no parked money still starts a card sale", async () => {
    const { orderId } = await kit.forceRelease({ rawStatus: "01" });
    const started = await startCardSale(await numberOf(orderId));
    expect(started.ok, JSON.stringify(started)).toBe(true);
  });
});

describe("SO-896 points tender with the guest's released QR money parked open", () => {
  it("is refused 409 FUNDS_UNRESOLVED while the money is parked", async () => {
    const { orderId } = await parkLateMoney();
    const bill = await readBill(fx, orderId);
    const res = await fx.post(`${fx.base}/${orderId}/tenders`, {
      expectedStatus: bill.status,
      method: "points",
      pointsUsed: 330,
      idempotencyKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("FUNDS_UNRESOLVED");
  });
});
