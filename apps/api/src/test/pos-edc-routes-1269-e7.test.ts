// 1269 E7 (legend-osqou.28): the POS ECR routes on the edge node. Test B of
// docs/briefs/1269-scope-tambahan.md, at the HTTP hop the cashier sees:
// - a lost reply (same idempotency key again) = at most one sale;
// - another tender cannot overtake an open (unknown) sale;
// - the amount is the bill's remainder, never a client figure;
// - no PAN in the answer;
// - no agent, or production without a bank adapter = ECR locked, nothing
//   written; a simulator never runs in production.
// Restart = `unknown`, late/duplicate events and late-command cases live in
// the agent and ledger tests (edc-agent-*.test.ts, edge-edc-ledger-applier).
// Bill of the fixture: Rp 33.000.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { createEdcAgent, type EdcAgent } from "../edge/edc/agent.ts";
import {
  createDefaultEdcRegistry,
  EdcProviderRegistry,
} from "../edge/edc/registry.ts";
import {
  createProductionEdcRegistry,
  setEdgeEdcAgentForTests,
} from "../edge/edc/runtime.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL = 33_000;

let fx: HoldFixture;
let ctx: ScopedTenantContext;
let sim: EcrSimulator;
let simAgent: EdcAgent;
let prodAgent: EdcAgent | null = null;
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
  fx = await holdFixture("pos-edc-routes-e7");
  await asOwnerTenant((c) =>
    c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-E7', 'MID-E7', 'Test EDC', 'lan',
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
  sim = new EcrSimulator("bca");
  simAgent = createEdcAgent({
    db,
    registry: new EdcProviderRegistry().register(sim),
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  await simAgent.start(ctx);
});
afterEach(() => setEdgeEdcAgentForTests(null));
afterAll(async () => {
  setEdgeEdcAgentForTests(null);
  await simAgent?.stop(ctx).catch(() => undefined);
  await prodAgent?.stop(ctx).catch(() => undefined);
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------ helpers

const outletBase = () => `/api/outlets/${fx.tenant.outletId}/pos`;

const startSale = (
  orderId: string,
  idempotencyKey: string = randomUUID(),
  extra: Record<string, unknown> = {},
) =>
  fx.post(`${fx.base}/${orderId}/edc`, {
    terminalId,
    method: "card",
    idempotencyKey,
    ...extra,
  });

async function numberOf(orderId: string) {
  const res = await fx.get(`${fx.base}/${orderId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.number as string;
}

async function ledgerOf(reference: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: number;
  }>(
    `SELECT id::text AS id, status, amount_idr::int AS amount FROM edc_transactions
      WHERE tenant_id=$1 AND reference=$2 AND type='sale' ORDER BY created_at`,
    [fx.tenant.tenantId, reference],
  );
  return rows;
}

async function ecrEnabled() {
  const res = await fx.get(`${outletBase()}/payment-options`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.edc.ecrEnabled as boolean;
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

// -------------------------------------------------------------------- tests

describe("1269 E7 ECR locked", () => {
  it("e7-1 no agent in this process: 503, nothing written, ECR off", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(await ledgerOf(await numberOf(order.id))).toEqual([]);
    const read = await fx.get(`${outletBase()}/edc/${randomUUID()}`);
    expect(read.status).toBe(503);
    expect(await ecrEnabled()).toBe(false);
  });

  it("e7-2 production without a bank adapter: 503, terminal never asked, ECR off; no simulator in production", async () => {
    expect(createProductionEdcRegistry().banks()).toEqual([]);
    expect(() =>
      createDefaultEdcRegistry({ simulator: true, production: true }),
    ).toThrow(/not allowed in production/);
    // The production agent of another process would hold the outlet lock;
    // swap ownership to an agent built on the production registry.
    await simAgent.stop(ctx);
    try {
      prodAgent = createEdcAgent({
        db,
        registry: createProductionEdcRegistry(),
        saleTimeoutMs: 50,
      });
      await prodAgent.start(ctx);
      setEdgeEdcAgentForTests(prodAgent);
      const order = await newSubmittedOrder(fx, 0);
      const before = sim.calls.sale;
      const res = await startSale(order.id);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(JSON.stringify(res.body)).toContain("belum didukung");
      expect(await ledgerOf(await numberOf(order.id))).toEqual([]);
      expect(sim.calls.sale).toBe(before);
      expect(await ecrEnabled()).toBe(false);
    } finally {
      setEdgeEdcAgentForTests(null);
      await prodAgent?.stop(ctx);
      prodAgent = null;
      await simAgent.start(ctx);
    }
  });
});

describe("1269 E7 ECR sale through the edge route", () => {
  it("e7-3 approved once; a lost reply replayed by key is the same sale, before and after booking", async () => {
    setEdgeEdcAgentForTests(simAgent);
    expect(await ecrEnabled()).toBe(true);
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const key = randomUUID();
    const before = sim.calls.sale;

    const first = await startSale(order.id, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({
      status: "approved",
      amountIdr: BILL,
      reference: number,
    });
    const again = await startSale(order.id, key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);

    const booked = await bookCard(order.id, first.body.data.id as string);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const late = await startSale(order.id, key);
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(late.body.data.id).toBe(first.body.data.id);

    expect(sim.calls.sale - before).toBe(1);
    expect(await ledgerOf(number)).toHaveLength(1);
    expect(await capturedIdr(fx, order.id)).toBe(BILL);
    // Bill paid: a new key cannot start another sale.
    const fresh = await startSale(order.id);
    expect(fresh.status).toBeGreaterThanOrEqual(400);
    expect(sim.calls.sale - before).toBe(1);
  });

  it("e7-4 unknown sale locks the bill: no cash, no second sale; inquiry resolves it, booked once", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const before = sim.calls.sale;
    sim.next(terminalId, "timeout_after_charge");

    const lost = await startSale(order.id);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.data.status).toBe("unknown");

    const cash = await fx.tender(order.id, order.status, "cash", BILL);
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    const second = await startSale(order.id);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(sim.calls.sale - before).toBe(1);

    const id = lost.body.data.id as string;
    const inquired = await fx.post(`${outletBase()}/edc/${id}/inquire`, {});
    expect(inquired.status, JSON.stringify(inquired.body)).toBe(200);
    expect(inquired.body.data.status).toBe("approved");
    const read = await fx.get(`${outletBase()}/edc/${id}`);
    expect(read.body.data.status).toBe("approved");

    expect((await bookCard(order.id, id)).status).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL);
    expect(await ledgerOf(number)).toHaveLength(1);
  });

  it("e7-5 the client cannot name the amount; a stale version is refused before the terminal", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const before = sim.calls.sale;
    const priced = await startSale(order.id, randomUUID(), { amountIdr: 1 });
    expect(priced.status, JSON.stringify(priced.body)).toBe(422);
    const stale = await startSale(order.id, randomUUID(), {
      expectedVersion: 999_999,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(412);
    expect(await ledgerOf(number)).toEqual([]);
    expect(sim.calls.sale).toBe(before);
  });

  it("e7-6 a terminal message with a card number never reaches the answer; unknown ids are 404", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    sim.next(terminalId, "pan_in_message");
    const res = await startSale(order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/\d{13,19}/);
    const missing = await fx.get(`${outletBase()}/edc/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

describe("1269 E7 route guards and races", () => {
  it("e7-7 without pos.payment.accept every ECR route is 403 and no ledger row exists", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const before = sim.calls.sale;
    const { rows } = await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE id = $1",
      [fx.tenant.roleId],
    );
    const full = rows[0]!.permissions;
    const setRole = (permissions: string[]) =>
      owner.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
        fx.tenant.roleId,
        JSON.stringify(permissions),
      ]);
    await setRole(full.filter((name) => name !== "pos.payment.accept"));
    try {
      const some = randomUUID();
      const sale = await startSale(order.id);
      const read = await fx.get(`${outletBase()}/edc/${some}`);
      const inquire = await fx.post(`${outletBase()}/edc/${some}/inquire`, {});
      const cancel = await fx.post(`${outletBase()}/edc/${some}/cancel`, {});
      expect(sale.status, JSON.stringify(sale.body)).toBe(403);
      expect(read.status, JSON.stringify(read.body)).toBe(403);
      expect(inquire.status, JSON.stringify(inquire.body)).toBe(403);
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(403);
    } finally {
      await setRole(full);
    }
    expect(await ledgerOf(number)).toEqual([]);
    expect(sim.calls.sale).toBe(before);
  });

  it("e7-8 a transaction of outlet A through the path of outlet B is 404 on read, inquire and cancel", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const outletB = randomUUID();
    await asOwnerTenant((c) =>
      c.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B E7', 'Jl. B', timezone, opening_hours, 'active'
           FROM outlets WHERE id = $3`,
        [outletB, `B-${outletB.slice(0, 8)}`.toUpperCase(), fx.tenant.outletId],
      ),
    );
    // The agent of this node owns outlet B too, so the refusal is the
    // outlet check of the ledger read, not "agent not ready".
    const ctxB = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletB)] },
    );
    await simAgent.start(ctxB);
    const order = await newSubmittedOrder(fx, 0);
    const sale = await startSale(order.id);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const id = sale.body.data.id as string;
    const viaB = `/api/outlets/${outletB}/pos/edc/${id}`;
    const read = await fx.get(viaB);
    expect(read.status, JSON.stringify(read.body)).toBe(404);
    const inquire = await fx.post(`${viaB}/inquire`, {});
    expect(inquire.status, JSON.stringify(inquire.body)).toBe(404);
    const cancel = await fx.post(`${viaB}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(404);
    const own = await fx.get(`${outletBase()}/edc/${id}`);
    expect(own.body.data.status).toBe("approved");
    await simAgent.stop(ctxB);
  });

  it("e7-9 cancel route: a finished sale is refused, an unknown id is 404", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    const sale = await startSale(order.id);
    expect(sale.body.data.status).toBe("approved");
    const done = await fx.post(
      `${outletBase()}/edc/${sale.body.data.id}/cancel`,
      {},
    );
    expect(done.status, JSON.stringify(done.body)).toBe(409);
    const read = await fx.get(`${outletBase()}/edc/${sale.body.data.id}`);
    expect(read.body.data.status).toBe("approved");
    const missing = await fx.post(
      `${outletBase()}/edc/${randomUUID()}/cancel`,
      {},
    );
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
  });

  it("e7-10 two keys for one bill at once: one sale, the other 409, one terminal call", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const order = await newSubmittedOrder(fx, 0);
    const number = await numberOf(order.id);
    const before = sim.calls.sale;
    const [a, b] = await Promise.all([
      startSale(order.id),
      startSale(order.id),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([200, 409]);
    expect(sim.calls.sale - before).toBe(1);
    const rows = await ledgerOf(number);
    expect(rows).toHaveLength(1);
    const winner = a.status === 200 ? a : b;
    expect(winner.body.data.status).toBe("approved");
    expect(
      (await bookCard(order.id, winner.body.data.id as string)).status,
    ).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL);
  });
});
