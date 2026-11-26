// legend-f1mmf: the cashier starts the card sale of a dearer-swap charge on
// the outlet's terminal: POST /api/order-issue-charges/:chargeId/edc. The
// amount is the charge's and the reference the charge id. One money path at
// a time: no EDC sale while a QRIS code is live, no QRIS code and no cash
// while an EDC sale is unresolved or approved. Off the edge: 503. Setup
// copied from order-issue-charge-pos-read-f1mmf.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { posIssueChargeDetailSchema } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { createEdcAgent, type EdcAgent } from "../edge/edc/agent.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { setEdgeEdcAgentForTests } from "../edge/edc/runtime.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { registerTestDevice } from "./device-seed.ts";
import { installScriptedGateway } from "./payment-link-cancel-provider-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  PRICES,
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const DEVICE_ID = randomUUID();
const OTHER_OUTLET_DEVICE_ID = randomUUID();
let cashier: { client: ReturnType<typeof agent>; userId: string };
let otherOutletCashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = "";
let terminalId = "";

const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)
const DIFFERENCE = PRICES.kopi - PRICES.roti;

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

const deviceHeader = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function cashierWithRole(
  label: string,
  scopeOutletId: string,
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [
      roleId,
      w.tenant.tenantId,
      `Kasir ${label}`,
      JSON.stringify(["pos.payment.accept", "order.view"]),
    ],
  );
  const client = agent(w.app);
  await signUp(client, `Kasir ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, userId, roleId, scopeOutletId],
  );
  return { client, userId };
}

beforeAll(async () => {
  w = await createWorld();
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: DEVICE_ID,
  });
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.ids.otherOutlet,
    deviceId: OTHER_OUTLET_DEVICE_ID,
  });
  cashier = await cashierWithRole("Selisih Nontunai", w.tenant.outletId);
  otherOutletCashier = await cashierWithRole("Outlet Lain", w.ids.otherOutlet);
  terminalId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-GT98H', 'MID-GT98H', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [terminalId, w.tenant.tenantId, w.tenant.outletId],
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

async function openShiftFor(
  cashierId: string,
  deviceId: string,
  outletId: string,
  businessDate: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
    [
      id,
      w.tenant.tenantId,
      outletId,
      deviceId,
      cashierId,
      businessDate,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

async function businessDateOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.d;
}

/** A swap charge opened by the real flow, with the cashier's shift ready. */
async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const charge = await chargeOf(issueId);
  if (!shiftId)
    shiftId = await openShiftFor(
      cashier.userId,
      DEVICE_ID,
      w.tenant.outletId,
      await businessDateOf(order.order.id),
    );
  return { ...order, issueId, charge };
}

type ChargeRow = {
  id: string;
  status: string;
  payment_intent_id: string | null;
  cash_movement_id: string | null;
  paid_at: Date | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, status, payment_intent_id, cash_movement_id, paid_at
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function collect(
  chargeId: string,
  body: Record<string, unknown>,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
  host: string = w.tenant.hostname,
) {
  const request = who.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set("Host", host)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request.send(body);
}

const qrisBody = (idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  method: "qris",
});
function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
}

async function intentCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status: string;
  needsReconciliation?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    input.status,
  );
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at, needs_reconciliation)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               'APP123', $10, $11, $12)`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.outletId,
        terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
        final ? new Date() : null,
        input.needsReconciliation ?? false,
      ],
    ),
  );
  return id;
}

function read(
  chargeId: string,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
  host: string = w.tenant.hostname,
) {
  const request = who.client
    .get(`/api/order-issue-charges/${chargeId}`)
    .set("Host", host)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request;
}

async function detailOf(chargeId: string) {
  const res = await read(chargeId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return posIssueChargeDetailSchema.parse(res.body.data);
}

function startEdc(
  chargeId: string,
  idempotencyKey: string = randomUUID(),
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
) {
  const request = who.client
    .post(`/api/order-issue-charges/${chargeId}/edc`)
    .set("Host", w.tenant.hostname)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request.send({ terminalId, idempotencyKey });
}

async function salesOf(chargeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM edc_transactions WHERE tenant_id = $1 AND reference = $2",
    [w.tenant.tenantId, chargeId],
  );
  return Number(rows[0]!.n);
}

describe("legend-f1mmf the cashier starts the card sale of a swap charge", () => {
  let sim: EcrSimulator;
  let simAgent: EdcAgent;
  let ctx: ScopedTenantContext;
  beforeAll(async () => {
    installScriptedGateway();
    ctx = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      {
        kind: "outlets",
        outletIds: [outletIdSchema.parse(w.tenant.outletId)],
      },
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
    await simAgent.stop(ctx).catch(() => undefined);
  });

  it("off the edge the sale is refused before anything is written", async () => {
    const opened = await openCharge();
    const res = await startEdc(opened.charge.id);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(await salesOf(opened.charge.id)).toBe(0);
  });

  it("asks the terminal for the charge's own amount once; the key replays it and the sale pays the charge", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const opened = await openCharge();
    const key = randomUUID();
    const before = sim.calls.sale;
    const first = await startEdc(opened.charge.id, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({
      status: "approved",
      amountIdr: AMOUNT,
      reference: opened.charge.id,
      method: "card",
    });
    const again = await startEdc(opened.charge.id, key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(sim.calls.sale - before).toBe(1);

    const listed = await detailOf(opened.charge.id);
    expect(listed.edcSales.map((sale) => sale.id)).toEqual([
      first.body.data.id,
    ]);

    // An approved sale is waiting to be recorded: no QRIS code, no cash.
    const qris = await collect(opened.charge.id, qrisBody());
    expect(qris.status, JSON.stringify(qris.body)).toBe(409);
    const cash = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: AMOUNT,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    const fresh = await startEdc(opened.charge.id);
    expect(fresh.status).toBe(409);
    expect(sim.calls.sale - before).toBe(1);

    const paid = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "edc_card",
      edcTransactionId: first.body.data.id,
    });
    expectAccepted(paid);
    expect((await chargeOf(opened.issueId)).status).toBe("paid");
    const late = await startEdc(opened.charge.id);
    expect(late.status).toBe(409);
    expect(sim.calls.sale - before).toBe(1);
  });

  it("an unresolved EDC sale of the charge refuses a QRIS code and cash", async () => {
    const opened = await openCharge();
    await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "unknown",
    });
    const intents = await intentCount();
    const qris = await collect(opened.charge.id, qrisBody());
    expect(qris.status, JSON.stringify(qris.body)).toBe(409);
    expect(await intentCount()).toBe(intents);
    const cash = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: AMOUNT,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
  });

  it("a live QRIS code refuses the card sale; the terminal is never asked", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const before = sim.calls.sale;
    const res = await startEdc(opened.charge.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(sim.calls.sale).toBe(before);
    expect(await salesOf(opened.charge.id)).toBe(0);
  });

  it("another outlet's cashier and an unknown charge get 404; the terminal is never asked", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const opened = await openCharge();
    const before = sim.calls.sale;
    const other = await startEdc(
      opened.charge.id,
      randomUUID(),
      otherOutletCashier,
      OTHER_OUTLET_DEVICE_ID,
    );
    expect(other.status, JSON.stringify(other.body)).toBe(404);
    expect((await startEdc(randomUUID())).status).toBe(404);
    expect(sim.calls.sale).toBe(before);
    expect(await salesOf(opened.charge.id)).toBe(0);
  });
});
