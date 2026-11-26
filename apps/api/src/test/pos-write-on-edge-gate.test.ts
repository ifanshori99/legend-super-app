// 1269 E3 cloud write gate over HTTP: an outlet with an active edge node
// (primary or standby only) sells, runs its drawers and seats walk-ins on that
// edge, so the cloud answers 409 POS_WRITE_ON_EDGE. An outlet without one, or
// whose node is revoked, is unchanged (the request reaches its handler), and
// the edge process itself is never refused. The gate runs after the
// permission guard: a caller without the permission still gets 403.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: ReturnType<typeof agent>;
let stranger: ReturnType<typeof agent>;

const base = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;

/** Every gated write of the outlet, with a body its handler would refuse. */
const writes: [string, () => string][] = [
  ["create order", () => `${base()}/pos/orders`],
  ["park order", () => `${base()}/pos/parked-orders`],
  ["open shift", () => `${base()}/pos/shifts`],
  [
    "cash movement",
    () => `${base()}/pos/shifts/${randomUUID()}/cash-movements`,
  ],
  ["walk-in seating", () => `${base()}/tables/${randomUUID()}/staff-session`],
];

function post(path: string, client = cashier) {
  return client
    .post(path)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID() });
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
    for (const [name, path] of writes) {
      const response = await post(path());
      expect(response.status, name).not.toBe(409);
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("an active primary edge: every write is 409 POS_WRITE_ON_EDGE", async () => {
    const id = await addEdge("primary");
    try {
      for (const [name, path] of writes) {
        const response = await post(path());
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
      for (const [name, path] of writes) {
        const response = await post(path());
        expect(response.status, name).toBe(409);
        expect(response.body.error.code, name).toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      await revoke(id);
    }
  });

  it("a revoked edge node leaves the outlet to the cloud again", async () => {
    for (const [name, path] of writes) {
      const response = await post(path());
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("a caller without the permission is refused by the permission guard, not the edge answer", async () => {
    const id = await addEdge("primary");
    try {
      const response = await post(`${base()}/pos/orders`, stranger);
      expect([403, 404]).toContain(response.status);
      expect(response.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
    } finally {
      await revoke(id);
    }
  });

  it("the edge process itself is never refused", async () => {
    const id = await addEdge("primary");
    const before = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...before, edgeMode: true });
    try {
      for (const [name, path] of writes) {
        const response = await post(path());
        expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      setEdgeRuntimeStateForTests(before);
      await revoke(id);
    }
  });
});
