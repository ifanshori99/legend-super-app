// legend-cot3 follow-up (sub-ai-scope W2-U): GET /api/ai/usage for askers whose
// assignments are only outlet- or station-scoped. The gate accepts ai.ask at
// any scope and reads under a tenant-wide context, so these tests prove the
// body carries only the caller's own counter and no other user's, outlet's or
// tenant's data. Real Express app, Better Auth, RBAC resolver and PostgreSQL.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { usageDateOf, usageMonthOf } from "../services/ai-gateway.service.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdStations: string[] = [];

const tenantB = randomUUID();
const otherUser = randomUUID(); // same tenant as the callers, other person
const foreignUser = randomUUID(); // tenant B
const today = usageDateOf(new Date());
const month = usageMonthOf(new Date());

// Distinctive numbers so a leak cannot hide behind a coincidence.
const OWN_COUNT = 3;
const OTHER_USER_COUNT = 41;
const FOREIGN_COUNT = 53;
const TENANT_A_COST_IDR = 12_345;
const TENANT_B_COST_IDR = 98_765;

async function asTenant<T>(
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

type Scope =
  | { type: "tenant" }
  | { type: "outlet"; id: string }
  | { type: "station"; id: string };

/** Signed-in user holding one custom role at one scope (no role: none). */
async function principal(
  name: string,
  grant?: { permissions: string[]; scope: Scope },
) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (grant) {
    const roleId = randomUUID();
    createdRoles.push(roleId);
    await asTenant(tenant.id, async (db) => {
      await db.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, $3, false, $4, $5)`,
        [
          roleId,
          tenant.id,
          `legend-cot3 ai usage ${roleId.slice(0, 8)}`,
          JSON.stringify(grant.permissions),
          JSON.stringify([grant.scope.type]),
        ],
      );
      await db.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
        [
          tenant.id,
          userId,
          roleId,
          grant.scope.type,
          grant.scope.type === "tenant" ? null : grant.scope.id,
        ],
      );
    });
  }
  return { client, userId };
}

async function seedDaily(tenantId: string, userId: string, count: number) {
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO ai_usage_daily (tenant_id, user_id, usage_date, request_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id, usage_date) DO UPDATE SET request_count = EXCLUDED.request_count`,
      [tenantId, userId, today, count],
    ),
  );
}

async function seedMonthly(tenantId: string, costIdr: number) {
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO ai_usage_monthly (tenant_id, usage_month, cost_idr, request_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, usage_month) DO UPDATE SET cost_idr = EXCLUDED.cost_idr`,
      [tenantId, month, costIdr],
    ),
  );
}

type Who = Awaited<ReturnType<typeof principal>>;
let outletAsker: Who;
let stationAsker: Who;
let tenantAsker: Who;
let manager: Who;
let outletManager: Who;
let nobody: Who;
let noAskOutlet: Who;

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'AI usage scope other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB, `ai-usage-${tenantB.slice(0, 8)}`, tenant.id],
  );
  for (const id of [otherUser, foreignUser])
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI usage other', $2)`,
      [id, `${id}@example.test`],
    );
  const stationId = (
    await asTenant(tenant.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO stations (tenant_id, outlet_id, name, type)
         VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
        [tenant.id, outletA.id, `Uji ${randomUUID().slice(0, 8)}`],
      ),
    )
  ).rows[0].id;
  createdStations.push(stationId);

  outletAsker = await principal("AI usage outlet A", {
    permissions: ["ai.ask"],
    scope: { type: "outlet", id: outletA.id },
  });
  stationAsker = await principal("AI usage station", {
    permissions: ["ai.ask"],
    scope: { type: "station", id: stationId },
  });
  tenantAsker = await principal("AI usage tenant asker", {
    permissions: ["ai.ask"],
    scope: { type: "tenant" },
  });
  manager = await principal("AI usage manager", {
    permissions: ["ai.ask", "ai.governance.manage"],
    scope: { type: "tenant" },
  });
  outletManager = await principal("AI usage outlet manager", {
    permissions: ["ai.ask", "ai.governance.manage"],
    scope: { type: "outlet", id: outletA.id },
  });
  noAskOutlet = await principal("AI usage no ask", {
    permissions: ["sales.read"],
    scope: { type: "outlet", id: outletA.id },
  });
  nobody = await principal("AI usage nobody");

  // Own counters (distinct from every other row), another user of the same
  // tenant, and a user of another tenant on the same day.
  for (const who of [outletAsker, stationAsker, tenantAsker, manager])
    await seedDaily(tenant.id, who.userId, OWN_COUNT);
  await seedDaily(tenant.id, outletManager.userId, OWN_COUNT);
  await seedDaily(tenant.id, otherUser, OTHER_USER_COUNT);
  await seedDaily(tenantB, foreignUser, FOREIGN_COUNT);
  await seedMonthly(tenant.id, TENANT_A_COST_IDR);
  await seedMonthly(tenantB, TENANT_B_COST_IDR);
});

afterAll(async () => {
  for (const [table, ids] of [
    ["ai_usage_daily", [tenant.id, tenantB]],
    ["ai_usage_monthly", [tenant.id, tenantB]],
  ] as const)
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [ids]);
  await owner.query(`DELETE FROM role_assignments WHERE role_id = ANY($1)`, [
    createdRoles,
  ]);
  await owner.query(`DELETE FROM roles WHERE id = ANY($1)`, [createdRoles]);
  await owner.query(`DELETE FROM stations WHERE id = ANY($1::uuid[])`, [
    createdStations,
  ]);
  await owner.query(`DELETE FROM tenants WHERE id = $1`, [tenantB]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1)`, [
    [...createdUsers, otherUser, foreignUser],
  ]);
  await owner.end();
});

type Feature = { feature: string; usedToday: number };
const usedTodayOf = (body: { data: { features: Feature[] } }) =>
  body.data.features.map((f) => f.usedToday);

/** Strings that must never appear in a non-manager's (or any) body. */
function expectNoForeignData(
  body: unknown,
  extra: { allowedUserId?: string } = {},
) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(otherUser);
  expect(text).not.toContain(foreignUser);
  expect(text).not.toContain(tenantB);
  expect(text).not.toContain(outletB.id);
  expect(text).not.toContain(String(OTHER_USER_COUNT));
  expect(text).not.toContain(String(FOREIGN_COUNT));
  expect(text).not.toContain(String(TENANT_B_COST_IDR));
  if (!extra.allowedUserId) expect(text).not.toContain("userId");
}

describe("legend-cot3 ai usage scope: GET /api/ai/usage", () => {
  it("legend-cot3 ai usage positive control: a tenant-wide asker sees its own counter and no budget", async () => {
    const res = await tenantAsker.client.get("/api/ai/usage");
    expect(res.status).toBe(200);
    expect(usedTodayOf(res.body)).toEqual(Array(14).fill(OWN_COUNT));
    expect(res.body.data.budget).toBeNull();
    expectNoForeignData(res.body);
  });

  it("legend-cot3 ai usage outlet-A asker: 200, own counter only, no budget, no other data", async () => {
    const res = await outletAsker.client.get("/api/ai/usage");
    expect(res.status).toBe(200);
    // Own row is read (not 0), other user (41) and tenant B (53) are not added.
    expect(usedTodayOf(res.body)).toEqual(Array(14).fill(OWN_COUNT));
    expect(res.body.data.budget).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(String(TENANT_A_COST_IDR));
    expectNoForeignData(res.body);
  });

  it("legend-cot3 ai usage station-only asker: 200, own counter only, no budget, no other data", async () => {
    const res = await stationAsker.client.get("/api/ai/usage");
    expect(res.status).toBe(200);
    expect(usedTodayOf(res.body)).toEqual(Array(14).fill(OWN_COUNT));
    expect(res.body.data.budget).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(String(TENANT_A_COST_IDR));
    expectNoForeignData(res.body);
  });

  it("legend-cot3 ai usage ignores query parameters that name another user, outlet or tenant", async () => {
    const control = await outletAsker.client.get("/api/ai/usage");
    expect(control.status).toBe(200);
    const res = await outletAsker.client.get(
      `/api/ai/usage?userId=${otherUser}&outletId=${outletB.id}&tenantId=${tenantB}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(control.body);
    expectNoForeignData(res.body);
  });

  it("legend-cot3 ai usage positive control: the tenant-wide manager sees this tenant's spend, never tenant B's", async () => {
    const res = await manager.client.get("/api/ai/usage");
    expect(res.status).toBe(200);
    expect(res.body.data.budget).toMatchObject({ usedIdr: TENANT_A_COST_IDR });
    expect(usedTodayOf(res.body)).toEqual(Array(14).fill(OWN_COUNT));
    expect(JSON.stringify(res.body)).not.toContain(String(TENANT_B_COST_IDR));
    expectNoForeignData(res.body);
  });

  // ai.governance.manage held only for outlet A is not tenant-wide, yet the
  // summary reads it flat (ai-governance.service.ts:226) and returns the
  // tenant's monthly spend. Secure behaviour: budget stays hidden.
  it("legend-cot3 ai usage an outlet-A governance holder does not get tenant-wide spend", async () => {
    const control = await outletManager.client.get("/api/ai/usage");
    expect(control.status).toBe(200);
    expect(usedTodayOf(control.body)).toEqual(Array(14).fill(OWN_COUNT));
    expect(control.body.data.budget).toBeNull();
    expect(JSON.stringify(control.body)).not.toContain(
      String(TENANT_A_COST_IDR),
    );
  });

  it("legend-cot3 ai usage refuses a user without ai.ask at any scope", async () => {
    // Positive control: the same gate answers 200 for an outlet asker.
    expect((await outletAsker.client.get("/api/ai/usage")).status).toBe(200);
    const noRole = await nobody.client.get("/api/ai/usage");
    expect(noRole.status).toBe(403);
    expect(noRole.body.error?.code ?? noRole.body.code).toBe(
      "PERMISSION_DENIED",
    );
    const otherPermission = await noAskOutlet.client.get("/api/ai/usage");
    expect(otherPermission.status).toBe(403);
    expect((await agent(app).get("/api/ai/usage")).status).toBe(401);
  });
});
