// Tutup Hari for an outlet with an active primary edge (bead legend-k0i8,
// sizing-1246 K0-1). The edge closes the day itself (the day/close route is in
// EDGE_API_PREFIXES) and its late offline orders land in the cloud through the
// order ingest. A second Tutup Hari in the cloud would freeze a recap that
// misses those orders, so the cloud refuses it: 409 DAY_CLOSE_ON_EDGE.
// An outlet without an active primary edge (none, standby only, revoked) and
// the edge process itself keep closing as before.
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
let manager: ReturnType<typeof agent>;

function close(businessDate: string) {
  return manager
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day/close`)
    .set(headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

async function dailyCloseCount(businessDate: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pos_daily_closes
     WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenant.tenantId, tenant.outletId, businessDate],
  );
  return Number(rows[0]?.n ?? 0);
}

async function addEdge(role: "primary" | "standby", status: "active") {
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
     VALUES ($1, $2, $3, $4, $5, 'Server lokal', $6)`,
    [
      randomUUID(),
      tenant.tenantId,
      tenant.outletId,
      role,
      status,
      "c".repeat(64),
    ],
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`late-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer Edge', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(["pos.day.close"])],
  );
  manager = agent(app);
  await signUp(manager, "Manajer Edge");
  const session = await manager.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
}, 120_000);

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("Tutup Hari cloud vs edge outlet (legend-k0i8)", () => {
  it("an outlet without an edge still closes its day in the cloud", async () => {
    const response = await close("2025-01-13");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await dailyCloseCount("2025-01-13")).toBe(1);
  });

  it("a standby-only edge does not block the cloud close", async () => {
    await addEdge("standby", "active");
    const response = await close("2025-01-14");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await dailyCloseCount("2025-01-14")).toBe(1);
  });

  it("an active primary edge makes the cloud refuse Tutup Hari with 409 DAY_CLOSE_ON_EDGE", async () => {
    await addEdge("primary", "active");
    const response = await close("2025-01-15");
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("DAY_CLOSE_ON_EDGE");
    expect(response.body.error.message).toMatch(/server lokal/i);
    expect(await dailyCloseCount("2025-01-15")).toBe(0);
  });

  it("the edge process itself still closes the day", async () => {
    const before = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...before, edgeMode: true });
    try {
      const response = await close("2025-01-16");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await dailyCloseCount("2025-01-16")).toBe(1);
    } finally {
      setEdgeRuntimeStateForTests(before);
    }
  });
});
