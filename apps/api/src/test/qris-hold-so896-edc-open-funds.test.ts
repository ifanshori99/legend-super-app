// SO-896 (legend-o6q8i, review architect P2-2): a card (ECR) sale may not
// START while the bill still has guest money parked open. After a manager
// force release the QR hold is closed, so `assertNoActiveQrisHoldForEdcSale`
// sees a free bill; a late verified payment is parked, and a card sale started
// now would charge the guest twice (the card tender is exempt at booking, Q7).
// The write-ahead refuses with 409 FUNDS_UNRESOLVED before the terminal is
// asked. The points tender is guarded by the same check.
//
// SO-896 P1-1 (903): the standalone EDC tender (supervisor PIN override plus
// bank reference, `edc_card` / `edc_qris`) is guarded the same way. It is
// refused 409 FUNDS_UNRESOLVED BEFORE the override is spent: no tender, no
// standalone ledger row, no approval use. Once the parked money is resolved
// the same override settles the bill. (Q7 exempts only an ECR request that is
// already running; a standalone entry is a new payment.)
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
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
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
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
const supervisorRoleId = randomUUID();
const SUPERVISOR_PIN = "582914";
let supervisorUserId: string;

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
  // A supervisor with a PIN, for the standalone EDC override (P1-1).
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'EDC Supervisor Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      supervisorRoleId,
      fx.tenant.tenantId,
      JSON.stringify(["order.view", "pos.edc_standalone.approve"]),
    ],
  );
  const supervisorClient = agent(fx.app);
  await signUp(supervisorClient, "SO896 EDC Supervisor");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, supervisorUserId, supervisorRoleId],
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisorUserId,
    { outletId: fx.tenant.outletId, userId: supervisorUserId },
    { pin: SUPERVISOR_PIN },
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

// ---- P1-1: standalone EDC tender with the guest's released QR money parked ---

/** The supervisor's own PIN approval, worth exactly the remaining bill. */
async function standaloneOverride(orderId: string, valueIdr: number) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: "edc_standalone",
      valueIdr,
      reason: "Agen EDC mati, kunci manual",
      objectType: "pos_order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisorUserId),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return override.id;
}

async function payStandalone(
  orderId: string,
  method: "edc_card" | "edc_qris",
  overrideId: string,
  bankRef: string,
) {
  const bill = await readBill(fx, orderId);
  return fx.post(`${fx.base}/${orderId}/tenders`, {
    expectedStatus: bill.status,
    method,
    standalone: { terminalId, bankRef, overrideId },
    idempotencyKey: randomUUID(),
  });
}

async function approvalUses(overrideId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return rows.length;
}

async function tenderCount(orderId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2
        AND status <> 'voided'`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.length;
}

describe("SO-896 P1-1 standalone EDC tender with the guest's released QR money parked open", () => {
  for (const [method, bankRef] of [
    ["edc_card", "123456789012"],
    ["edc_qris", "210987654321"],
  ] as const) {
    it(`${method} standalone is refused 409 FUNDS_UNRESOLVED with no tender, ledger row or approval use; once resolved the same override settles`, async () => {
      const { orderId, qr } = await parkLateMoney();
      const number = await numberOf(orderId);
      const bill = await readBill(fx, orderId);
      const overrideId = await standaloneOverride(orderId, bill.totalIdr);
      const baseline = await tenderCount(orderId);

      const refused = await payStandalone(orderId, method, overrideId, bankRef);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(JSON.stringify(refused.body)).toContain("FUNDS_UNRESOLVED");
      expect(await tenderCount(orderId), "no tender added").toBe(baseline);
      expect(await ledgerOf(number), "no standalone ledger row").toEqual([]);
      expect(await approvalUses(overrideId), "override not spent").toBe(0);

      // The money is refunded / credited: the bill can be paid again.
      await resolveFunds(qr.intentId);
      const paid = await payStandalone(orderId, method, overrideId, bankRef);
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(await tenderCount(orderId)).toBe(baseline + 1);
      expect(await ledgerOf(number)).toHaveLength(1);
      expect(await approvalUses(overrideId)).toBe(1);
    });
  }

  it("control: a force released bill with no parked money still takes a standalone EDC tender", async () => {
    const { orderId } = await kit.forceRelease({ rawStatus: "01" });
    const bill = await readBill(fx, orderId);
    const overrideId = await standaloneOverride(orderId, bill.totalIdr);
    const paid = await payStandalone(
      orderId,
      "edc_card",
      overrideId,
      "555566667777",
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  });
});
