// 1269 E3 cloud write gate over HTTP: an outlet with an active edge node
// (primary or standby only) sells, runs its drawers and seats walk-ins on that
// edge, so the cloud answers 409 POS_WRITE_ON_EDGE. An outlet without one, or
// whose node is revoked, is unchanged (the request reaches its handler), and
// the edge process itself is never refused. The gate runs after the
// permission guard: a caller without the permission still gets 403.
import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const roleId = randomUUID();
const viewerRoleId = randomUUID();
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: ReturnType<typeof agent>;
let stranger: ReturnType<typeof agent>;
let viewer: ReturnType<typeof agent>;
// Rows of the outlet the order-, facility- and session-scoped routes resolve.
const orderUlid = createUlid();
const facilityId = randomUUID();
const sessionId = randomUUID();

const base = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;
const order = () => `/api/pos/orders/${encodeURIComponent(orderUlid)}`;
const session = (action: string) =>
  `/api/table-sessions/${encodeURIComponent(sessionId)}/${action}`;
const key = () => ({ idempotencyKey: randomUUID() });

type Write = [name: string, path: () => string, body: () => object];

/**
 * Every gated cloud write (R2: a route that loses its gate fails here), with a
 * body the route parses before the gate; its handler would refuse the rest.
 */
const writes: Write[] = [
  ["create order", () => `${base()}/pos/orders`, key],
  ["park order", () => `${base()}/pos/parked-orders`, key],
  ["open shift", () => `${base()}/pos/shifts`, key],
  [
    "cash movement",
    () => `${base()}/pos/shifts/${randomUUID()}/cash-movements`,
    key,
  ],
  [
    "walk-in seating",
    () => `${base()}/tables/${randomUUID()}/staff-session`,
    key,
  ],
  ["points quote", () => `${order()}/points/quote`, () => ({ points: 10 })],
  ["points redeem", () => `${order()}/points/redeem`, key],
  [
    "ticket sale",
    () => "/api/facility/tickets/pos",
    () => ({
      facilityId,
      areaId: randomUUID(),
      productId: randomUUID(),
      customerProfileId: randomUUID(),
      timing: { kind: "now" },
      ...key(),
    }),
  ],
  [
    "ticket credential",
    () => `${order()}/tickets/${randomUUID()}/credential`,
    key,
  ],
  ["session confirm", () => session("confirm"), () => ({})],
  ["session close", () => session("close"), key],
  ["session move", () => session("move"), key],
  ["session merge", () => session("merge"), key],
  ["session move items", () => session("move-items"), key],
];

function post(write: Write, client = cashier) {
  return client
    .post(write[1]())
    .set(headers)
    .set(originHeader)
    .send(write[2]());
}

async function seedOutletRows(): Promise<void> {
  const t = tenant.tenantId;
  const o = tenant.outletId;
  const orderId = ulidToUuid(orderUlid);
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at, deposit_applied_idr)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 10000, 0, 0, 0, 0, 10000,
             'draft', '2026-11-20', now(), 0)`,
    [orderId, t, o, `GATE-${orderUlid.slice(-6)}`],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
     VALUES ($1, $2, $3, 'pos', now())`,
    [orderId, t, o],
  );
  await owner.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Shower Gerbang', 'shower', 20, 10, 10, $4, $5, $6)`,
    [
      facilityId,
      t,
      o,
      JSON.stringify([
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "00:00",
          closesAt: "23:59",
        },
      ]),
      JSON.stringify({
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      }),
      JSON.stringify({
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      }),
    ],
  );
  const zoneId = randomUUID();
  const tableId = randomUUID();
  await owner.query(
    `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
     VALUES ($1, $2, $3, 'Zona Gerbang', 'pay_first', '[]')`,
    [zoneId, t, o],
  );
  await owner.query(
    `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
     VALUES ($1, $2, $3, $4, 'G1', 4, 'regular', '{}')`,
    [tableId, t, o, zoneId],
  );
  await owner.query(
    `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
       session_token_hash, session_token_sealed)
     VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
    [sessionId, t, o, tableId, randomBytes(32).toString("hex")],
  );
}

async function addEdge(role: "primary" | "standby") {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, 'active', 'Server lokal', $5, now())`,
    [id, tenant.tenantId, tenant.outletId, role, "c".repeat(64)],
  );
  return id;
}

async function revoke(id: string) {
  await owner.query(
    "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
    [id],
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`gate-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Gerbang', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "pos.sale.create",
        "shift.cash.operate",
        "floor.table.operate",
        "pos.payment.accept",
      ]),
    ],
  );
  cashier = agent(app);
  await signUp(cashier, "Kasir Gerbang");
  const session = await cashier.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  stranger = agent(app);
  await signUp(stranger, "Tanpa Izin");
  // R1: a member of the tenant without the POS or floor permission.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Lihat Saja', false, NULL, '["order.view"]', false, '["tenant"]')`,
    [viewerRoleId, tenant.tenantId],
  );
  viewer = agent(app);
  await signUp(viewer, "Lihat Saja");
  const viewerSession = await viewer.get("/api/auth/get-session");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, viewerSession.body.user.id as string, viewerRoleId],
  );
  await seedOutletRows();
}, 120_000);

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("1269 E3 POS_WRITE_ON_EDGE over HTTP", () => {
  it("an outlet without an edge node: every write reaches its handler", async () => {
    for (const write of writes) {
      const name = write[0];
      const response = await post(write);
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("an active primary edge: every write is 409 POS_WRITE_ON_EDGE", async () => {
    const id = await addEdge("primary");
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.status, name).toBe(409);
        expect(response.body.error.code, name).toBe("POS_WRITE_ON_EDGE");
        expect(response.body.error.message, name).toMatch(/server lokal/i);
      }
    } finally {
      await revoke(id);
    }
  });

  it("a standby-only edge (no primary) is refused too: in doubt the cloud does not sell", async () => {
    const id = await addEdge("standby");
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.status, name).toBe(409);
        expect(response.body.error.code, name).toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      await revoke(id);
    }
  });

  it("a revoked edge node leaves the outlet to the cloud again", async () => {
    for (const write of writes) {
      const name = write[0];
      const response = await post(write);
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("R1 a caller without the permission (stranger or tenant member) never learns of the edge: no 409", async () => {
    const id = await addEdge("primary");
    try {
      for (const write of writes) {
        for (const client of [stranger, viewer]) {
          const response = await post(write, client);
          expect([401, 403, 404], write[0]).toContain(response.status);
          expect(response.body.error?.code, write[0]).not.toBe(
            "POS_WRITE_ON_EDGE",
          );
        }
      }
    } finally {
      await revoke(id);
    }
  });

  it("the edge process itself is never refused", async () => {
    const id = await addEdge("primary");
    const before = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...before, edgeMode: true });
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      setEdgeRuntimeStateForTests(before);
      await revoke(id);
    }
  });
});
