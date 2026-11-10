// Kitchen capacity rules (beads legend-w4nq4 + legend-44jm; PRD v1.7 §6
// `kitchen_capacity_rules`, F12, KDS-05). Contract: @starter/shared/kitchen
// `listCapacityRules` + `updateCapacityRules`.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in two fresh
// isolated tenants. Written against the contract (never against the service).
//
// Assumption where the brief is silent: the config screen is guarded by the
// existing outlet permission `kds.station.manage`; `kds.ticket.process` alone
// (a cook) is refused on both routes.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capacityRuleSchema,
  listCapacityRules,
  updateCapacityRules,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const short = () => randomUUID().slice(0, 6);

const ids = {
  manageRole: randomUUID(),
  cookRole: randomUUID(),
  manageRoleB: randomUUID(),
  outletB: randomUUID(),
  barA: randomUUID(),
  kitchenA: randomUUID(),
  barB: randomUUID(),
  stationTenantB: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let manager: Member; // kds.station.manage, tenant scope
let outletAManager: Member; // kds.station.manage on outlet A only
let outletBManager: Member; // kds.station.manage on outlet B only
let cook: Member; // kds.ticket.process only
let tenantBManager: Member; // kds.station.manage in the other tenant

type RuleInput = {
  windowMinutes: number;
  capacityPoints: number;
  nearCapacityBp: number;
  schedule: { daysOfWeek: number[]; start: string; end: string }[];
  channelPriority: string[];
};

function rule(patch: Partial<RuleInput> = {}): RuleInput {
  return {
    windowMinutes: 15,
    capacityPoints: 40,
    nearCapacityBp: 8000,
    schedule: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "22:00" }],
    channelPriority: ["dine_in", "gofood"],
    ...patch,
  };
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  outletIds = "*",
  asAppRole = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outletIds],
    );
    // The test owner is a superuser, which bypasses RLS: read as the app role.
    if (asAppRole) await client.query("SET LOCAL ROLE legend_app");
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

function api(who: Member | null, forHeaders = headers, outletId?: string) {
  const client = who?.client ?? agent(app);
  const outlet = outletId ?? tenant.outletId;
  return {
    list: () =>
      client
        .get(`/api/outlets/${outlet}/kitchen/capacity-rules`)
        .set(forHeaders)
        .set(originHeader),
    replace: (stationId: string, body: unknown) =>
      client
        .put(
          `/api/outlets/${outlet}/kitchen/stations/${stationId}/capacity-rules`,
        )
        .set(forHeaders)
        .set(originHeader)
        .send(body as object),
  };
}

/** Rule rows of one outlet, as the owner connection sees them. */
async function storedCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kitchen_capacity_rules
     WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  );
  return Number(rows[0]!.n);
}

/** Rows of one station, as the owner connection sees them. */
async function storedWindows(
  stationId: string,
  tenantId = tenant.tenantId,
): Promise<number[]> {
  const { rows } = await owner.query<{ window_minutes: number }>(
    `SELECT window_minutes FROM kitchen_capacity_rules
     WHERE tenant_id = $1 AND station_id = $2 ORDER BY window_minutes`,
    [tenantId, stationId],
  );
  return rows.map((row) => row.window_minutes);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`cap-${short()}`);
  tenantB = await createIsolatedTenant(`capb-${short()}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.manageRole,
    "Pengelola Stasiun",
    ["kds.station.manage"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    ids.cookRole,
    "Koki Saja",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.manageRoleB,
    "Pengelola Stasiun B",
    ["kds.station.manage"],
    ["tenant"],
  );

  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Kapasitas B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      ids.outletB,
      `CB-${short()}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  for (const [id, forTenant, outletId, name, type] of [
    [ids.barA, tenant.tenantId, tenant.outletId, "Bar A", "beverage_bar"],
    [ids.kitchenA, tenant.tenantId, tenant.outletId, "Dapur A", "hot_kitchen"],
    [ids.barB, tenant.tenantId, ids.outletB, "Bar B", "beverage_bar"],
    [
      ids.stationTenantB,
      tenantB.tenantId,
      tenantB.outletId,
      "Bar T",
      "beverage_bar",
    ],
  ])
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, forTenant, outletId, name, type],
    );

  manager = await member(
    tenant,
    ids.manageRole,
    { type: "tenant", id: null },
    "Pengelola Kapasitas",
  );
  outletAManager = await member(
    tenant,
    ids.manageRole,
    { type: "outlet", id: tenant.outletId },
    "Pengelola Outlet A",
  );
  outletBManager = await member(
    tenant,
    ids.manageRole,
    { type: "outlet", id: ids.outletB },
    "Pengelola Outlet B",
  );
  cook = await member(
    tenant,
    ids.cookRole,
    { type: "tenant", id: null },
    "Koki Kapasitas",
  );
  tenantBManager = await member(
    tenantB,
    ids.manageRoleB,
    { type: "tenant", id: null },
    "Pengelola Tenant B",
  );
});

afterAll(async () => {
  // Rows stay in the disposable database, like the other KDS tests.
});

describe("contract", () => {
  it("serves the contract paths", () => {
    expect(listCapacityRules.path).toBe(
      "/api/outlets/:outletId/kitchen/capacity-rules",
    );
    expect(updateCapacityRules.path).toBe(
      "/api/outlets/:outletId/kitchen/stations/:stationId/capacity-rules",
    );
  });
});

describe("PUT capacity-rules", () => {
  it("stores the list and answers with the contract rows", async () => {
    const res = await api(manager).replace(ids.barA, {
      rules: [
        rule({ windowMinutes: 30, capacityPoints: 60 }),
        rule({ windowMinutes: 15 }),
      ],
    });
    expect(res.status).toBe(200);
    const rules = updateCapacityRules.response.parse(res.body).data;
    expect(rules).toHaveLength(2);
    for (const stored of rules) {
      expect(capacityRuleSchema.parse(stored)).toEqual(stored);
      expect(stored).toMatchObject({
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        stationId: ids.barA,
      });
    }
    // Stable order inside the station: window_minutes ascending.
    expect(rules.map((r) => r.windowMinutes)).toEqual([15, 30]);
    expect(rules[1]).toMatchObject({
      capacityPoints: 60,
      nearCapacityBp: 8000,
      channelPriority: ["dine_in", "gofood"],
    });
    expect(await storedWindows(ids.barA)).toEqual([15, 30]);
  });

  it("replaces the whole list of that station and leaves the others alone", async () => {
    await api(manager).replace(ids.kitchenA, {
      rules: [rule({ windowMinutes: 10, capacityPoints: 25 })],
    });
    await api(manager, headers, ids.outletB).replace(ids.barB, {
      rules: [rule({ windowMinutes: 5 })],
    });
    await api(manager).replace(ids.barA, {
      rules: [rule({ windowMinutes: 15 }), rule({ windowMinutes: 30 })],
    });
    const second = await api(manager).replace(ids.barA, {
      rules: [rule({ windowMinutes: 20, capacityPoints: 99 })],
    });
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(await storedWindows(ids.barA)).toEqual([20]);
    // Other stations (same outlet and other outlet) are intact.
    expect(await storedWindows(ids.kitchenA)).toEqual([10]);
    expect(await storedWindows(ids.barB)).toEqual([5]);
  });

  it("keeps the old list when the new one is rejected", async () => {
    const before = await storedWindows(ids.barA);
    const res = await api(manager).replace(ids.barA, {
      rules: [rule({ windowMinutes: 15 }), rule({ windowMinutes: 7 })],
    });
    expect(res.status).toBe(422);
    expect(await storedWindows(ids.barA)).toEqual(before);
  });

  it("is idempotent for the same list", async () => {
    const body = { rules: [rule({ windowMinutes: 25 })] };
    const first = await api(manager).replace(ids.barA, body);
    const second = await api(manager).replace(ids.barA, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await storedWindows(ids.barA)).toEqual([25]);
  });

  it("accepts an outlet-scoped manager for that outlet", async () => {
    const res = await api(outletAManager).replace(ids.kitchenA, {
      rules: [rule({ windowMinutes: 10 })],
    });
    expect(res.status).toBe(200);
  });

  describe("body validation (strict)", () => {
    const bad: [string, unknown][] = [
      ["an empty list", { rules: [] }],
      ["a missing list", {}],
      ["an unknown key on the body", { rules: [rule()], extra: 1 }],
      ["a tenant id on the body", { rules: [rule()], tenantId: randomUUID() }],
      [
        "an unknown key on a rule",
        { rules: [{ ...rule(), stationId: ids.barA }] },
      ],
      [
        "a window that is not a multiple of 5",
        { rules: [rule({ windowMinutes: 7 })] },
      ],
      ["a window below 5", { rules: [rule({ windowMinutes: 0 })] }],
      ["a window above 60", { rules: [rule({ windowMinutes: 65 })] }],
      ["zero capacity points", { rules: [rule({ capacityPoints: 0 })] }],
      ["zero near-capacity level", { rules: [rule({ nearCapacityBp: 0 })] }],
      [
        "a near-capacity level above 10000 bp",
        { rules: [rule({ nearCapacityBp: 10_001 })] },
      ],
      [
        "a duplicate channel",
        { rules: [rule({ channelPriority: ["dine_in", "dine_in"] })] },
      ],
      [
        "an unknown channel",
        { rules: [rule({ channelPriority: ["telepati"] })] },
      ],
      ["an empty channel list", { rules: [rule({ channelPriority: [] })] }],
      ["an empty schedule", { rules: [rule({ schedule: [] })] }],
      [
        "a bad time of day",
        {
          rules: [
            rule({
              schedule: [{ daysOfWeek: [1], start: "25:00", end: "22:00" }],
            }),
          ],
        },
      ],
      [
        "more than 24 rules",
        { rules: Array.from({ length: 25 }, () => rule()) },
      ],
    ];
    it.each(bad)("rejects %s with 422", async (_label, body) => {
      const before = await storedWindows(ids.barA);
      const res = await api(manager).replace(ids.barA, body);
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(await storedWindows(ids.barA)).toEqual(before);
    });
  });

  describe("authorization and isolation", () => {
    const body = () => ({ rules: [rule({ windowMinutes: 45 })] });

    it("answers 401 without a session", async () => {
      const res = await api(null).replace(ids.barA, body());
      expect(res.status).toBe(401);
    });

    it("answers 403 for a role without kds.station.manage", async () => {
      const res = await api(cook).replace(ids.barA, body());
      expect(res.status).toBe(403);
      expect(await storedWindows(ids.barA)).not.toContain(45);
    });

    it("answers 403 for a manager of another outlet", async () => {
      const res = await api(outletBManager).replace(ids.barA, body());
      expect(res.status).toBe(403);
      expect(await storedWindows(ids.barA)).not.toContain(45);
    });

    it("answers 404 for a station of another outlet in the path", async () => {
      const res = await api(manager).replace(ids.barB, body());
      expect(res.status).toBe(404);
      expect(await storedWindows(ids.barB)).not.toContain(45);
    });

    it("answers 404 for an unknown station", async () => {
      const res = await api(manager).replace(randomUUID(), body());
      expect(res.status).toBe(404);
    });

    it("never reaches a station of another tenant", async () => {
      // Tenant B's manager names tenant A's outlet and station.
      const cross = await api(tenantBManager, headersB).replace(
        ids.barA,
        body(),
      );
      expect([403, 404]).toContain(cross.status);
      // Tenant B's manager names its own outlet with tenant A's station.
      const own = await api(tenantBManager, headersB, tenantB.outletId).replace(
        ids.barA,
        body(),
      );
      expect(own.status).toBe(404);
      // Tenant A's manager on tenant B's host.
      const host = await api(manager, headersB, tenantB.outletId).replace(
        ids.stationTenantB,
        body(),
      );
      expect([401, 403, 404]).toContain(host.status);
      expect(await storedWindows(ids.barA)).not.toContain(45);
      expect(await storedWindows(ids.stationTenantB, tenantB.tenantId)).toEqual(
        [],
      );
    });
  });
});

describe("GET capacity-rules", () => {
  beforeAll(async () => {
    await api(manager).replace(ids.barA, {
      rules: [
        rule({ windowMinutes: 30 }),
        rule({ windowMinutes: 5 }),
        rule({ windowMinutes: 15 }),
      ],
    });
    await api(manager).replace(ids.kitchenA, {
      rules: [rule({ windowMinutes: 20 }), rule({ windowMinutes: 10 })],
    });
    await api(manager, headers, ids.outletB).replace(ids.barB, {
      rules: [rule({ windowMinutes: 60 })],
    });
    await api(tenantBManager, headersB, tenantB.outletId).replace(
      ids.stationTenantB,
      { rules: [rule({ windowMinutes: 35 })] },
    );
  });

  it("returns the contract rows of every station of the outlet", async () => {
    const res = await api(manager).list();
    expect(res.status).toBe(200);
    const rules = listCapacityRules.response.parse(res.body).data;
    expect(rules).toHaveLength(await storedCount(tenant.outletId));
    expect(new Set(rules.map((r) => r.stationId))).toEqual(
      new Set([ids.barA, ids.kitchenA]),
    );
    for (const stored of rules) {
      expect(stored.tenantId).toBe(tenant.tenantId);
      expect(stored.outletId).toBe(tenant.outletId);
    }
  });

  it("orders by station, then window_minutes, the same on every call", async () => {
    const first = (await api(manager).list()).body.data as {
      stationId: string;
      windowMinutes: number;
    }[];
    const second = (await api(manager).list()).body.data as typeof first;
    expect(second).toEqual(first);
    // Rows of one station sit together, windows ascending inside each.
    const stationOrder = [...new Set(first.map((r) => r.stationId))];
    expect(stationOrder).toEqual([...stationOrder].sort());
    for (const stationId of stationOrder) {
      const windows = first
        .filter((r) => r.stationId === stationId)
        .map((r) => r.windowMinutes);
      expect(windows).toEqual([...windows].sort((a, b) => a - b));
    }
    expect(first.map((r) => r.stationId)).toEqual(
      stationOrder.flatMap((id) =>
        first.filter((r) => r.stationId === id).map(() => id),
      ),
    );
  });

  it("returns exactly the rows a PUT answered, with the same ids", async () => {
    const put = await api(manager).replace(ids.kitchenA, {
      rules: [
        rule({ windowMinutes: 20, capacityPoints: 30 }),
        rule({ windowMinutes: 10, capacityPoints: 15 }),
      ],
    });
    const listed = (await api(manager).list()).body.data as {
      stationId: string;
    }[];
    expect(listed.filter((r) => r.stationId === ids.kitchenA)).toEqual(
      put.body.data,
    );
  });

  it("breaks a tie on the same window by row id, the same on every call", async () => {
    await api(manager).replace(ids.kitchenA, {
      rules: [
        rule({ windowMinutes: 15, capacityPoints: 11 }),
        rule({ windowMinutes: 15, capacityPoints: 12 }),
        rule({ windowMinutes: 15, capacityPoints: 13 }),
      ],
    });
    const read = async () =>
      (
        (await api(manager).list()).body.data as {
          id: string;
          stationId: string;
        }[]
      )
        .filter((r) => r.stationId === ids.kitchenA)
        .map((r) => r.id);
    const first = await read();
    expect(first).toHaveLength(3);
    expect(first).toEqual([...first].sort());
    expect(await read()).toEqual(first);
  });

  it("never shows a station of another outlet or tenant", async () => {
    const res = await api(manager).list();
    const stationIds = (res.body.data as { stationId: string }[]).map(
      (r) => r.stationId,
    );
    expect(stationIds).not.toContain(ids.barB);
    expect(stationIds).not.toContain(ids.stationTenantB);
    const other = await api(manager, headers, ids.outletB).list();
    expect(other.status).toBe(200);
    expect(
      (other.body.data as { stationId: string }[]).map((r) => r.stationId),
    ).toEqual([ids.barB]);
    const tenantBList = await api(
      tenantBManager,
      headersB,
      tenantB.outletId,
    ).list();
    expect(tenantBList.status).toBe(200);
    expect(
      (tenantBList.body.data as { stationId: string }[]).map(
        (r) => r.stationId,
      ),
    ).toEqual([ids.stationTenantB]);
  });

  it("returns an empty list for an outlet without rules", async () => {
    await owner.query(
      `DELETE FROM kitchen_capacity_rules WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, ids.outletB],
    );
    const res = await api(manager, headers, ids.outletB).list();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("answers 401 without a session", async () => {
    expect((await api(null).list()).status).toBe(401);
  });

  it("answers 403 for a role without kds.station.manage", async () => {
    expect((await api(cook).list()).status).toBe(403);
  });

  it("answers 403 for a manager of another outlet", async () => {
    expect((await api(outletBManager).list()).status).toBe(403);
  });

  it("serves an outlet-scoped manager their own outlet", async () => {
    const res = await api(outletAManager).list();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(await storedCount(tenant.outletId));
  });

  it("answers 403 or 404 for another tenant's outlet", async () => {
    const res = await api(tenantBManager, headersB, tenant.outletId).list();
    expect([403, 404]).toContain(res.status);
  });
});

describe("database guards", () => {
  async function insertRaw(
    client: PoolClient,
    patch: {
      tenantId?: string;
      outletId?: string;
      stationId?: string;
      windowMinutes?: number;
      points?: number;
      bp?: number;
    } = {},
  ) {
    return client.query(
      `INSERT INTO kitchen_capacity_rules
         (tenant_id, outlet_id, station_id, window_minutes, capacity_points,
          near_capacity_bp, schedule, channel_priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        patch.tenantId ?? tenant.tenantId,
        patch.outletId ?? tenant.outletId,
        patch.stationId ?? ids.barA,
        patch.windowMinutes ?? 15,
        patch.points ?? 10,
        patch.bp ?? 8000,
        JSON.stringify(rule().schedule),
        JSON.stringify(["dine_in"]),
      ],
    );
  }

  it.each([
    ["window not a multiple of 5", { windowMinutes: 7 }],
    ["window below 5", { windowMinutes: 0 }],
    ["window above 60", { windowMinutes: 65 }],
    ["zero capacity points", { points: 0 }],
    ["zero near-capacity level", { bp: 0 }],
  ])("refuses a row with %s", async (_label, patch) => {
    await expect(
      asOwnerTenant(tenant.tenantId, (client) => insertRaw(client, patch)),
    ).rejects.toThrow(/kitchen_capacity_rules_.*_check/);
  });

  it("refuses a station of another tenant", async () => {
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        insertRaw(client, { stationId: ids.stationTenantB }),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("hides other outlets and tenants from the app role (RLS)", async () => {
    const countFor = (tenantId: string, outletIds: string) =>
      asOwnerTenant(
        tenantId,
        async (client) => {
          const { rows } = await client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kitchen_capacity_rules",
          );
          return Number(rows[0]!.n);
        },
        outletIds === "*" ? "*" : JSON.stringify([outletIds]),
        true,
      );
    // Outlet B had its rows deleted above: seed one so the scopes differ.
    await asOwnerTenant(tenant.tenantId, (client) =>
      insertRaw(client, { outletId: ids.outletB, stationId: ids.barB }),
    );
    const inA = await storedCount(tenant.outletId);
    expect(await countFor(tenant.tenantId, "*")).toBe(inA + 1);
    expect(await countFor(tenant.tenantId, tenant.outletId)).toBe(inA);
    expect(await countFor(tenant.tenantId, ids.outletB)).toBe(1);
    expect(await countFor(tenant.tenantId, randomUUID())).toBe(0);
    // Tenant B sees only its own row.
    expect(await countFor(tenantB.tenantId, "*")).toBe(1);
  });

  it("refuses a write outside the app role's outlet scope (RLS)", async () => {
    await expect(
      asOwnerTenant(
        tenant.tenantId,
        (client) => insertRaw(client, { stationId: ids.kitchenA }),
        JSON.stringify([ids.outletB]),
        true,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOwnerTenant(
        tenant.tenantId,
        (client) =>
          insertRaw(client, {
            tenantId: tenantB.tenantId,
            outletId: tenantB.outletId,
            stationId: ids.stationTenantB,
          }),
        "*",
        true,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
