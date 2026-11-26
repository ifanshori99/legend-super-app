// legend-f1mmf (d): a cash or card attempt of a dearer-swap charge whose
// answer never reached the till, settled by a supervisor's PIN:
// POST /api/order-issue-charges/:chargeId/attempts/resolve. A recorded attempt
// is read back, an approved card sale is recorded once, an unknown one needs
// the supervisor's statement (failed, or paid with the slip), and anything
// unrecorded is closed for good. Setup copied from
// order-issue-charge-pos-edc-f1mmf.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
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
import { setStaffPin } from "../services/device-pin.service.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { confirmPayment } from "../services/payment.service.ts";

let w: World;
const DEVICE_ID = randomUUID();
const OTHER_OUTLET_DEVICE_ID = randomUUID();
let cashier: { client: ReturnType<typeof agent>; userId: string };
let otherOutletCashier: { client: ReturnType<typeof agent>; userId: string };
let approver: { client: ReturnType<typeof agent>; userId: string };
let approverNoReconcile: { client: ReturnType<typeof agent>; userId: string };
const PIN = "582914";
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
  permissions: readonly string[] = ["pos.payment.accept", "order.view"],
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, `Kasir ${label}`, JSON.stringify(permissions)],
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
  approver = await cashierWithRole("Supervisor Selisih", w.tenant.outletId, [
    "order.view",
    "pos.void.approve",
    "pos.edc_standalone.approve",
    "payment.reconcile",
  ]);
  approverNoReconcile = await cashierWithRole(
    "Supervisor Tanpa Rekon",
    w.tenant.outletId,
    ["order.view", "pos.void.approve", "pos.edc_standalone.approve"],
  );
  for (const who of [approver, approverNoReconcile])
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      who.userId,
      { outletId: w.tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
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

async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status: string;
  idempotencyKey?: string;
  needsReconciliation?: boolean;
  /** Minutes ago the sale was sent to the terminal (null: never sent). */
  dispatchedMinutesAgo?: number | null;
  wireOpen?: boolean;
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
          approval_code, rrn, completed_at, needs_reconciliation, dispatched_at,
          sale_wire_open_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               NULL, NULL, $10, $11,
               CASE WHEN $12::int IS NULL THEN NULL ELSE now() - make_interval(mins => $12::int) END,
               CASE WHEN $13::boolean THEN now() ELSE NULL END)`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.outletId,
        terminalId,
        input.reference,
        input.idempotencyKey ?? randomUUID(),
        input.amountIdr,
        input.status,
        randomUUID().replace(/-/g, "").slice(0, 12),
        final ? new Date() : null,
        input.needsReconciliation ?? false,
        input.dispatchedMinutesAgo === undefined
          ? 30
          : input.dispatchedMinutesAgo,
        input.wireOpen ?? false,
      ],
    ),
  );
  return id;
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

function resolve(
  chargeId: string,
  body: Record<string, unknown>,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string = DEVICE_ID,
) {
  return who.client
    .post(`/api/order-issue-charges/${chargeId}/attempts/resolve`)
    .set("Host", w.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId))
    .send({
      reason: "Jawaban kasir hilang, sudah dicek",
      approverUserId: approver.userId,
      pin: PIN,
      ...body,
    });
}

async function failedPinAttempts(userId: string): Promise<number> {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [w.tenant.tenantId, w.tenant.outletId, userId],
  );
  return rows[0]?.failed_attempts ?? 0;
}

async function closedAttempts(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pos_order_idempotency
     WHERE tenant_id = $1 AND operation = 'issue_charge_attempt.resolve'`,
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function chargePaidEvents(issueId: string): Promise<number> {
  return (await w.outboxRows("order_issue.charge_paid", issueId)).length;
}

async function saleOf(id: string) {
  const { rows } = await owner.query<{
    status: string;
    needs_reconciliation: boolean;
  }>(
    "SELECT status, needs_reconciliation FROM edc_transactions WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, id],
  );
  return rows[0]!;
}

async function cashMovementsOfShift(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [w.tenant.tenantId, shiftId],
  );
  return Number(rows[0]!.n);
}

const cashBody = (idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  method: "cash",
  receivedIdr: AMOUNT,
});

const slip = (chargedAmountIdr = AMOUNT) => ({
  rrn: "RRN123456789",
  approvalCode: "APP123",
  chargedAmountIdr,
});

describe("legend-f1mmf (d) a supervisor settles a charge attempt without an answer", () => {
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

  it("the approver may not be the caller (403); a wrong PIN is counted; another outlet's cashier gets 404", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    const self = await resolve(opened.charge.id, {
      method: "cash",
      idempotencyKey: key,
      approverUserId: cashier.userId,
    });
    expect(self.status, JSON.stringify(self.body)).toBe(403);

    const before = await failedPinAttempts(approver.userId);
    const wrong = await resolve(opened.charge.id, {
      method: "cash",
      idempotencyKey: key,
      pin: "000000",
    });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(401);
    expect(await failedPinAttempts(approver.userId)).toBe(before + 1);

    const closedBefore = await closedAttempts();
    const other = await resolve(
      opened.charge.id,
      { method: "cash", idempotencyKey: key },
      otherOutletCashier,
      OTHER_OUTLET_DEVICE_ID,
    );
    expect(other.status, JSON.stringify(other.body)).toBe(404);
    const otherEdc = await resolve(
      opened.charge.id,
      { method: "edc", idempotencyKey: randomUUID(), edc: "failed" },
      otherOutletCashier,
      OTHER_OUTLET_DEVICE_ID,
    );
    expect(otherEdc.status, JSON.stringify(otherEdc.body)).toBe(404);
    expect(await failedPinAttempts(approver.userId)).toBe(before + 1);
    expect(await closedAttempts()).toBe(closedBefore);
    // Nothing was closed: the cash attempt still pays.
    expectAccepted(await collect(opened.charge.id, cashBody(key)));
  });

  it("cash: a recorded attempt reads back; an unrecorded one is closed and its late arrival refused", async () => {
    const paid = await openCharge();
    const paidKey = randomUUID();
    expectAccepted(await collect(paid.charge.id, cashBody(paidKey)));
    const recorded = await resolve(paid.charge.id, {
      method: "cash",
      idempotencyKey: paidKey,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.data.outcome).toBe("recorded");
    expect(recorded.body.data.charge.status).toBe("paid");

    const opened = await openCharge();
    const lost = randomUUID();
    const closed = await resolve(opened.charge.id, {
      method: "cash",
      idempotencyKey: lost,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.outcome).toBe("closed");
    const moves = await cashMovementsOfShift();
    const late = await collect(opened.charge.id, cashBody(lost));
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(await cashMovementsOfShift()).toBe(moves);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    // Settling again answers the same; a new attempt takes the cash once.
    const again = await resolve(opened.charge.id, {
      method: "cash",
      idempotencyKey: lost,
    });
    expect(again.body.data.outcome).toBe("closed");
    expectAccepted(await collect(opened.charge.id, cashBody()));
    expect(await chargePaidEvents(opened.issueId)).toBe(1);
  });

  it("card without a sale under the key: closed; the late start is refused without asking the terminal", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const opened = await openCharge();
    const key = randomUUID();
    const closed = await resolve(opened.charge.id, {
      method: "edc",
      idempotencyKey: key,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.outcome).toBe("closed");
    const before = sim.calls.sale;
    const late = await startEdc(opened.charge.id, key);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    // The agent's own write-ahead refuses the key too (a start already past
    // the route when the supervisor closed it).
    await expect(
      simAgent.requestPayment(ctx, cashier.userId, {
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        outletId: outletIdSchema.parse(w.tenant.outletId),
        terminalId,
        reference: opened.charge.id,
        idempotencyKey: key,
        amountIdr: idr(AMOUNT),
        method: "card",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(sim.calls.sale).toBe(before);
    expect(await salesOf(opened.charge.id)).toBe(0);
  });

  it("an unknown sale: no statement, paid without a slip, inside the late-answer window, still on the wire, or pending are 409", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    const id = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "unknown",
      idempotencyKey: key,
    });
    const body = { method: "edc", idempotencyKey: key };
    const none = await resolve(opened.charge.id, body);
    expect(none.status, JSON.stringify(none.body)).toBe(409);
    expect(none.body.error.code).toBe("ISSUE_CHARGE_EDC_STATEMENT_REQUIRED");
    const noSlip = await resolve(opened.charge.id, { ...body, edc: "paid" });
    expect(noSlip.status, JSON.stringify(noSlip.body)).toBe(409);
    expect(noSlip.body.error.code).toBe("ISSUE_CHARGE_SLIP_REQUIRED");
    expect((await saleOf(id)).status).toBe("unknown");

    for (const sale of [
      { status: "unknown", dispatchedMinutesAgo: 1 },
      { status: "unknown", wireOpen: true },
      { status: "pending" },
    ]) {
      const charge = await openCharge();
      const saleKey = randomUUID();
      const saleId = await ledgerSale({
        reference: charge.charge.id,
        amountIdr: AMOUNT,
        idempotencyKey: saleKey,
        ...sale,
      });
      for (const edc of ["failed", "paid"]) {
        const res = await resolve(charge.charge.id, {
          method: "edc",
          idempotencyKey: saleKey,
          edc,
          ...(edc === "paid" ? { slip: slip() } : {}),
        });
        expect(res.status, JSON.stringify({ sale, body: res.body })).toBe(409);
      }
      expect((await saleOf(saleId)).status).toBe(sale.status);
      expect((await chargeOf(charge.issueId)).status).toBe("open");
    }
  });

  it("a slip of another amount is 409; the sale stays unknown and the charge open", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    const id = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "unknown",
      idempotencyKey: key,
    });
    const res = await resolve(opened.charge.id, {
      method: "edc",
      idempotencyKey: key,
      edc: "paid",
      slip: slip(AMOUNT + 1_000),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await saleOf(id)).status).toBe("unknown");
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    // The outlet is told, after the refused resolve rolled back.
    const { rows: alerts } = await owner.query<{
      payload: Record<string, unknown>;
    }>(
      `SELECT payload FROM notification_outbox
       WHERE tenant_id = $1 AND event_type = 'edc_transaction.reconciliation_mismatch'
         AND payload->>'edcTransactionId' = $2`,
      [w.tenant.tenantId, id],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({
      kind: "amount",
      amountIdr: String(AMOUNT),
      chargedAmountIdr: String(AMOUNT + 1_000),
    });
  });

  it("an approved sale of another amount is 409; the charge stays open and unpaid", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT + 1_000,
      status: "approved",
      idempotencyKey: key,
    });
    const res = await resolve(opened.charge.id, {
      method: "edc",
      idempotencyKey: key,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(await chargePaidEvents(opened.issueId)).toBe(0);
  });

  it("an approved sale whose answer never reached the till is recorded once; again stays once", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    const id = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
      idempotencyKey: key,
    });
    const body = { method: "edc", idempotencyKey: key };
    const first = await resolve(opened.charge.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.outcome).toBe("recorded");
    expect(first.body.data.charge.status).toBe("paid");
    expect(await saleOf(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: false,
    });
    const again = await resolve(opened.charge.id, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.outcome).toBe("recorded");
    expect(await chargePaidEvents(opened.issueId)).toBe(1);
  });

  it("a valid slip pays the charge once; paid from a slip needs payment.reconcile", async () => {
    const opened = await openCharge();
    const key = randomUUID();
    const id = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "unknown",
      idempotencyKey: key,
    });
    const body = {
      method: "edc",
      idempotencyKey: key,
      edc: "paid",
      slip: slip(),
    };
    const denied = await resolve(opened.charge.id, {
      ...body,
      approverUserId: approverNoReconcile.userId,
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect((await saleOf(id)).status).toBe("unknown");

    const paid = await resolve(opened.charge.id, body);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.outcome).toBe("recorded");
    expect(paid.body.data.charge.status).toBe("paid");
    expect(await saleOf(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: false,
    });
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.cash_movement_id).toBeNull();
    expect(row.payment_intent_id).toBeNull();
    expect(await chargePaidEvents(opened.issueId)).toBe(1);

    // Again, and the cashier's own record of the same sale: no second payment.
    const again = await resolve(opened.charge.id, body);
    expect(again.body.data.outcome).toBe("recorded");
    const replay = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "edc_card",
      edcTransactionId: id,
    });
    expectAccepted(replay);
    expect((await collect(opened.charge.id, cashBody())).status).toBe(409);
    expect(await chargePaidEvents(opened.issueId)).toBe(1);
  });

  it("declared failed: QRIS may follow; a late approval after that is flagged and locks every path; the charge is paid once", async () => {
    setEdgeEdcAgentForTests(simAgent);
    const opened = await openCharge();
    const key = randomUUID();
    const id = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "unknown",
      idempotencyKey: key,
    });
    const failed = await resolve(opened.charge.id, {
      method: "edc",
      idempotencyKey: key,
      edc: "failed",
      approverUserId: approverNoReconcile.userId,
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.data.outcome).toBe("closed");
    expect((await saleOf(id)).status).toBe("declined");

    const qris = await collect(opened.charge.id, qrisBody());
    expectAccepted(qris);
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    expect(intentId).not.toBeNull();

    // The terminal answers approved after all: the agent keeps the final
    // status and flags the row (edge/edc/agent.ts, "approved late").
    await owner.query(
      `UPDATE edc_transactions SET needs_reconciliation = true,
         message = 'approved after declined: void + reconcile'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, id],
    );
    const before = sim.calls.sale;
    expect((await collect(opened.charge.id, cashBody())).status).toBe(409);
    expect((await startEdc(opened.charge.id)).status).toBe(409);
    expect((await collect(opened.charge.id, qrisBody())).status).toBe(409);
    expect(
      (
        await collect(opened.charge.id, {
          idempotencyKey: randomUUID(),
          method: "edc_card",
          edcTransactionId: id,
        })
      ).status,
    ).toBe(409);
    const flagged = await resolve(opened.charge.id, {
      method: "edc",
      idempotencyKey: key,
      edc: "paid",
      slip: slip(),
    });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(409);
    expect(sim.calls.sale).toBe(before);

    // The guest's QRIS money arrives: recorded once, never on top of a card.
    const context = contextOf(w.tenant.tenantId);
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: AMOUNT,
      providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
    });
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
         AND event->'payload'->>'intentId' = $2`,
      [w.tenant.tenantId, intentId],
    );
    await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(
        context,
        eventEnvelopeSchema.parse(rows[0]!.event),
        tx,
      ),
    );
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.cash_movement_id).toBeNull();
    expect(await chargePaidEvents(opened.issueId)).toBe(1);
    const { rows: received } = await owner.query<{ total: string }>(
      `SELECT (
         coalesce((SELECT sum(amount_idr) FROM payment_intents
                   WHERE tenant_id = $1 AND payment_link_id = (
                     SELECT payment_link_id FROM order_issue_charges WHERE tenant_id = $1 AND id = $2)
                   AND status = 'paid'), 0)
         + coalesce((SELECT sum(amount_idr) FROM edc_transactions
                     WHERE tenant_id = $1 AND reference = $2::text AND status = 'approved'), 0)
         + coalesce((SELECT sum(m.amount_idr) FROM cash_movements m
                     JOIN order_issue_charges c ON c.tenant_id = m.tenant_id AND c.cash_movement_id = m.id
                     WHERE c.tenant_id = $1 AND c.id = $2), 0)
       )::text AS total`,
      [w.tenant.tenantId, opened.charge.id],
    );
    expect(Number(received[0]!.total)).toBeLessThanOrEqual(AMOUNT);
  });
});
