// HTTP route of the held cash out decision (legend-3l4q, tier K: money). Written
// from docs/briefs/sub-held-cash-out-approval.md, "Putaran 2" > "Kontrak route",
// not from the implementation.
//
//   POST /api/outlets/:outletId/pos/shifts/:shiftId/cash-movements/:movementId/decision
//   body (strict) { decision: "approved" | "rejected" }
//   200 { data: { movementId, outcome, decidedBy, decidedAt } }
//   403 FORBIDDEN (no shift.cash.approve_close / the recorder), 409 CONFLICT
//   (already decided otherwise, closed shift, over the drawer), 404 NOT_FOUND.
//
// Fail-first note: the route and service were committed (952841eb4) before
// these tests were run, so this file is a contract guard, not red-first. A case
// fails only if the route misses a listed rule (status, error mapping, strict
// body, origin, tenant/outlet/shift scoping). Every 404/403/400/origin case ends
// with a control approve that must be 200, so none passes by accident.
//
// Assumptions (the brief leaves them open):
//  - An unauthenticated request is 401.
//  - A body that is not strictly { decision } (unknown decision, extra key,
//    missing key) is 400 or 422 (the project's validation answer); nothing is stored.
//  - An untrusted Origin on the cookie-authenticated POST is 403, as for the
//    other mutations (requireTrustedOrigin).
//  - A malformed movementId in the path is not tested (the brief does not say).
//  - A supervisor scoped to the tenant can decide without a device token.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const FLOAT_IDR = 100_000;
const HELD_IDR = 150_000;

const roleIds = {
  cashier: randomUUID(),
  /** Records AND may approve: the self-decision case. */
  operator: randomUUID(),
  supervisor: randomUUID(),
  otherTenantSupervisor: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let headers: { Host: string };
let otherHeaders: { Host: string };
let otherOutletId: string;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;
let otherTenantSupervisor: Member;

const registeredDevices = new Map<string, string>();

// ---- Fixtures (trimmed from pos-shift-cash-approval.test.ts) ---------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function memberOf(
  tenantId: string,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return { client, userId };
}

async function newCashier(
  label = "Kasir",
  roleId = roleIds.cashier,
): Promise<Cashier> {
  const base = await memberOf(tenant.tenantId, roleId, label);
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  return { ...base, deviceId };
}

function deviceHeader(deviceId: string): string {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const SHIFTS = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`;

async function openShift(
  cashier: Cashier,
): Promise<{ id: string; businessDate: string }> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; businessDate: string };
}

function move(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader)
    .send({
      type: "cash_out",
      amountIdr: HELD_IDR,
      reasonNote: "Beli gas elpiji",
      idempotencyKey: randomUUID(),
      ...body,
    });
}

/** A completed sale paid in cash on the shift (cash lands in the drawer). */
async function seedCashSale(
  shift: { id: string; businessDate: string },
  cashier: Cashier,
  totalIdr: number,
): Promise<void> {
  const orderId = randomUUID();
  const tax = Math.round(totalIdr / 11);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', $8, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `SH-${orderId.slice(0, 8)}`,
        totalIdr - tax,
        tax,
        totalIdr,
        shift.businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', $4, $5, $6, now(), now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        shift.id,
        cashier.deviceId,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now(), $5, $6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        totalIdr,
        cashier.userId,
        shift.id,
      ],
    );
  });
}

type Held = {
  cashier: Cashier;
  shift: { id: string; businessDate: string };
  movementId: string;
};

/**
 * A Rp150.000 cash out held on a fresh shift (Rp100.000 float), then a Rp100.000
 * cash sale so the drawer (Rp200.000) can cover it: approvable.
 */
async function heldApprovable(label = "Kasir", roleId = roleIds.cashier) {
  const cashier = await newCashier(label, roleId);
  const shift = await openShift(cashier);
  const recorded = await move(cashier, shift.id, {});
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
  await seedCashSale(shift, cashier, 100_000);
  const { rows } = await owner.query<{ id: string; needs_approval: boolean }>(
    "SELECT id, needs_approval FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [tenant.tenantId, shift.id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.needs_approval).toBe(true);
  return { cashier, shift, movementId: rows[0]!.id } satisfies Held;
}

function decisionPath(
  shiftId: string,
  movementId: string,
  outletId = tenant.outletId,
) {
  return `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts/${encodeURIComponent(shiftId)}/cash-movements/${encodeURIComponent(movementId)}/decision`;
}

function decide(
  who: Member,
  held: { shift: { id: string }; movementId: string },
  body: unknown,
) {
  return who.client
    .post(decisionPath(held.shift.id, held.movementId))
    .set(headers)
    .set(originHeader)
    .send(body as object);
}

async function outcomesOf(
  movementId: string,
): Promise<{ outcome: string; decided_by: string }[]> {
  const { rows } = await owner.query<{ outcome: string; decided_by: string }>(
    `SELECT outcome, decided_by FROM cash_movement_outcomes
      WHERE tenant_id = $1 AND movement_id = $2`,
    [tenant.tenantId, movementId],
  );
  return rows;
}

async function approvedEvents(movementId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'cash_movement.approved'
        AND event->'payload'->>'movementId' = $2`,
    [tenant.tenantId, movementId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `cash-appr-route-${randomUUID().slice(0, 6)}`,
  );
  otherTenant = await createIsolatedTenant(
    `cash-appr-other-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  otherHeaders = { Host: otherTenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );

  // A second outlet of the same tenant.
  otherOutletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Kedua', 'Jl. Uji 2', 'Asia/Jakarta', '{}', 'active')`,
    [
      otherOutletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `O2-${randomUUID().slice(0, 6)}`.toUpperCase(),
    ],
  );

  const roles: [string, string, string, string[]][] = [
    [roleIds.cashier, tenant.tenantId, "Kasir Route", ["shift.cash.operate"]],
    [
      roleIds.operator,
      tenant.tenantId,
      "Penyelia Kas Route",
      ["shift.cash.operate", "shift.cash.approve_close"],
    ],
    [
      roleIds.supervisor,
      tenant.tenantId,
      "Supervisor Route",
      ["shift.cash.approve_close"],
    ],
    [
      roleIds.otherTenantSupervisor,
      otherTenant.tenantId,
      "Supervisor Tenant Lain",
      ["shift.cash.approve_close", "shift.cash.operate"],
    ],
  ];
  for (const [id, tenantId, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await memberOf(tenant.tenantId, roleIds.supervisor, "Supervisor");
  otherTenantSupervisor = await memberOf(
    otherTenant.tenantId,
    roleIds.otherTenantSupervisor,
    "Supervisor Lain",
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  for (const t of [tenant, otherTenant])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Approve / reject ----------------------------------------------------------------

describe("legend-3l4q POST .../cash-movements/:movementId/decision", () => {
  it("legend-3l4q: a supervisor approves a held cash out: 200 { data: { movementId, outcome: 'approved', decidedBy, decidedAt } }, one outcome, one approved event", async () => {
    const held = await heldApprovable();

    const response = await decide(supervisor, held, { decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      movementId: held.movementId,
      outcome: "approved",
      decidedBy: supervisor.userId,
    });
    expect(Number.isNaN(Date.parse(response.body.data.decidedAt))).toBe(false);
    expect(await outcomesOf(held.movementId)).toEqual([
      { outcome: "approved", decided_by: supervisor.userId },
    ]);
    expect(await approvedEvents(held.movementId)).toBe(1);
  });

  it("legend-3l4q: a supervisor rejects a held cash out: 200 with outcome 'rejected' and no approved event", async () => {
    const held = await heldApprovable();

    const response = await decide(supervisor, held, { decision: "rejected" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      movementId: held.movementId,
      outcome: "rejected",
      decidedBy: supervisor.userId,
    });
    expect(await outcomesOf(held.movementId)).toEqual([
      { outcome: "rejected", decided_by: supervisor.userId },
    ]);
    expect(await approvedEvents(held.movementId)).toBe(0);
  });

  it("legend-3l4q: repeating the same decision is 200 with the same answer and no second effect", async () => {
    const held = await heldApprovable();
    const first = await decide(supervisor, held, { decision: "approved" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await decide(supervisor, held, { decision: "approved" });

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(await outcomesOf(held.movementId)).toHaveLength(1);
    expect(await approvedEvents(held.movementId)).toBe(1);
  });

  it("legend-3l4q: a different decision the second time is 409 and the first outcome stays", async () => {
    const held = await heldApprovable();
    const first = await decide(supervisor, held, { decision: "approved" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await decide(supervisor, held, { decision: "rejected" });

    expect(second.status).toBe(409);
    expect(await outcomesOf(held.movementId)).toEqual([
      { outcome: "approved", decided_by: supervisor.userId },
    ]);
  });

  it("legend-3l4q: approve when the amount exceeds the drawer's cash now is 409 with no outcome; the message differs from the already-decided 409", async () => {
    // Drawer holds only the Rp100.000 float; the held cash out is Rp150.000.
    const cashier = await newCashier("Kasir Kosong");
    const shift = await openShift(cashier);
    expect((await move(cashier, shift.id, {})).status).toBe(201);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    const overDrawer = { shift, movementId: rows[0]!.id };

    const refused = await decide(supervisor, overDrawer, {
      decision: "approved",
    });

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await outcomesOf(overDrawer.movementId)).toEqual([]);
    expect(await approvedEvents(overDrawer.movementId)).toBe(0);

    // Brief: the three 409 causes carry different messages.
    const decidedHeld = await heldApprovable();
    await decide(supervisor, decidedHeld, { decision: "approved" });
    const alreadyDecided = await decide(supervisor, decidedHeld, {
      decision: "rejected",
    });
    expect(alreadyDecided.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toBe(
      JSON.stringify(alreadyDecided.body),
    );
  });
});

// ---- Who may decide ------------------------------------------------------------------

describe("legend-3l4q who may call the decision route", () => {
  it("legend-3l4q: a cashier without shift.cash.approve_close gets 403 and nothing is stored", async () => {
    const held = await heldApprovable();
    const plainCashier = await newCashier("Kasir Lain");

    const response = await decide(plainCashier, held, {
      decision: "approved",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect(await approvedEvents(held.movementId)).toBe(0);
    // Control: the supervisor is allowed on the same movement.
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: the person who recorded the cash out gets 403 even holding the approve permission", async () => {
    const held = await heldApprovable("Penyelia", roleIds.operator);

    const response = await decide(held.cashier, held, {
      decision: "approved",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect(await approvedEvents(held.movementId)).toBe(0);
    // Control: someone else may.
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: an unauthenticated request is 401", async () => {
    const held = await heldApprovable();

    const response = await request(app)
      .post(decisionPath(held.shift.id, held.movementId))
      .set(headers)
      .set(originHeader)
      .send({ decision: "approved" });

    expect(response.status).toBe(401);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });
});

// ---- Not found: other shift / outlet / tenant ----------------------------------------

describe("legend-3l4q the decision route finds only its own movement", () => {
  it("legend-3l4q: a movement of another shift in the same outlet is 404 and stays held", async () => {
    const held = await heldApprovable();
    const otherShiftOwner = await newCashier("Kasir Shift Lain");
    const otherShift = await openShift(otherShiftOwner);

    const response = await supervisor.client
      .post(decisionPath(otherShift.id, held.movementId))
      .set(headers)
      .set(originHeader)
      .send({ decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    // Control: the right shift answers 200.
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: the movement under another outlet of the tenant is 404 and stays held", async () => {
    const held = await heldApprovable();

    const response = await supervisor.client
      .post(decisionPath(held.shift.id, held.movementId, otherOutletId))
      .set(headers)
      .set(originHeader)
      .send({ decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: another tenant's supervisor, on their own host and outlet, gets 404 for this tenant's shift and movement", async () => {
    const held = await heldApprovable();

    const response = await otherTenantSupervisor.client
      .post(decisionPath(held.shift.id, held.movementId, otherTenant.outletId))
      .set(otherHeaders)
      .set(originHeader)
      .send({ decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: an unknown movement id (valid UUID) is 404", async () => {
    const held = await heldApprovable();

    const response = await supervisor.client
      .post(decisionPath(held.shift.id, randomUUID()))
      .set(headers)
      .set(originHeader)
      .send({ decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });
});

// ---- Body validation and origin ------------------------------------------------------

describe("legend-3l4q the decision route validates and trusts only its own origin", () => {
  it("legend-3l4q: an invalid body (unknown decision, extra key, missing key, wrong type, no body) is 400 or 422 and stores nothing", async () => {
    const held = await heldApprovable();

    for (const body of [
      { decision: "maybe" },
      { decision: "approved", extra: true },
      {},
      { decision: 1 },
      { decision: "expired" },
    ]) {
      const response = await decide(supervisor, held, body);
      expect(
        [400, 422],
        `${JSON.stringify(body)} -> ${response.status} ${JSON.stringify(response.body)}`,
      ).toContain(response.status);
    }
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect(await approvedEvents(held.movementId)).toBe(0);
    // Control: a valid body on the same movement is accepted.
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });

  it("legend-3l4q: an untrusted Origin is 403 and stores nothing", async () => {
    const held = await heldApprovable();

    const response = await supervisor.client
      .post(decisionPath(held.shift.id, held.movementId))
      .set(headers)
      .set("Origin", "https://evil.example")
      .send({ decision: "approved" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(WEB_ORIGIN).not.toBe("https://evil.example");
    expect(await outcomesOf(held.movementId)).toEqual([]);
    expect(await approvedEvents(held.movementId)).toBe(0);
    // Control: the trusted origin works.
    expect((await decide(supervisor, held, { decision: "approved" })).status).toBe(
      200,
    );
  });
});
