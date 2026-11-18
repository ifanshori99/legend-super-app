// Facility index child counts (PRD v1.7 §3 F22/F25 "Model Generik"; TEN-03;
// bead legend-34fu). `GET /api/facility/facilities` rows carry `areaCount`,
// `unitCount`, `activeUnitCount` and `productCount` counted in the same statement as the page.
// Runs the real Express app, Better Auth, the RBAC resolver and PostgreSQL
// against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFacilities } from "@starter/shared/facility";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const busyFacilityId = randomUUID();
const emptyFacilityId = randomUUID();
const otherOutletFacilityId = randomUUID();
const allFacilityIds = [busyFacilityId, emptyFacilityId, otherOutletFacilityId];

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function ownerClient() {
  const result = await signedIn("Facility Counts Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

/** Holds both facility permissions, but only in the named outlet (TEN-03). */
async function outletClient(outletId: string) {
  const result = await signedIn("Facility Counts Outlet");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Facility counts test ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.booth.operate", "facility.config.manage"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.id, result.userId, roleId, outletId],
  );
  return result;
}

async function insertFacility(
  client: PoolClient,
  id: string,
  outletId: string,
  name: string,
) {
  await client.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, $4, 'coworking', 60, 10, 10, $5, $6, $7)`,
    [
      id,
      tenant.id,
      outletId,
      name,
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
}

async function insertChildren(
  client: PoolClient,
  facilityId: string,
  outletId: string,
  counts: {
    areas: number;
    units: number;
    products: number;
    // The last N units are in maintenance (not active).
    maintenanceUnits?: number;
  },
) {
  const areaIds: string[] = [];
  for (let index = 0; index < counts.areas; index += 1) {
    const areaId = randomUUID();
    areaIds.push(areaId);
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [areaId, tenant.id, outletId, facilityId, `Area ${index}`, index],
    );
  }
  for (let index = 0; index < counts.units; index += 1)
    await client.query(
      `INSERT INTO facility_units (tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $7, $6)`,
      [
        tenant.id,
        outletId,
        facilityId,
        areaIds[index % areaIds.length],
        `U${index}`,
        index,
        index >= counts.units - (counts.maintenanceUnits ?? 0)
          ? "maintenance"
          : "available",
      ],
    );
  for (let index = 0; index < counts.products; index += 1)
    await client.query(
      `INSERT INTO facility_products (tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active)
       VALUES ($1, $2, $3, $4, 'single', 10000, 1, $5)`,
      [
        tenant.id,
        outletId,
        facilityId,
        `Produk ${index}`,
        // An inactive product still counts: the figure is the size of the config.
        index !== 0,
      ],
    );
}

beforeAll(async () => {
  await asTenant(async (client) => {
    await insertFacility(client, busyFacilityId, outletA.id, "AAA Counts 34fu");
    await insertFacility(
      client,
      emptyFacilityId,
      outletA.id,
      "BBB Counts 34fu",
    );
    await insertFacility(
      client,
      otherOutletFacilityId,
      outletB.id,
      "ZZZ Counts 34fu",
    );
    await insertChildren(client, busyFacilityId, outletA.id, {
      areas: 2,
      units: 3,
      products: 2,
      maintenanceUnits: 1,
    });
    await insertChildren(client, otherOutletFacilityId, outletB.id, {
      areas: 1,
      units: 1,
      products: 4,
    });
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "facility_operating_hours_versions",
      "facility_units",
      "facility_areas",
      "facility_products",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
        [tenant.id, allFacilityIds],
      );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, allFacilityIds],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Facility counts test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

type Row = {
  id: string;
  areaCount: number;
  unitCount: number;
  activeUnitCount: number;
  productCount: number;
};

describe("Facility index child counts (legend-34fu)", () => {
  it("[legend-34fu] each row carries its own area, unit and product counts", async () => {
    const { client } = await ownerClient();
    const response = await client.get("/api/facility/facilities?limit=100");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    listFacilities.response.parse(response.body);
    const rows = response.body.data as Row[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(busyFacilityId)).toMatchObject({
      areaCount: 2,
      unitCount: 3,
      activeUnitCount: 2,
      productCount: 2,
    });
    // A facility without children reports zero, never undefined.
    expect(byId.get(emptyFacilityId)).toMatchObject({
      areaCount: 0,
      unitCount: 0,
      activeUnitCount: 0,
      productCount: 0,
    });
    // Children of another facility of the tenant never leak into a count.
    expect(byId.get(otherOutletFacilityId)).toMatchObject({
      areaCount: 1,
      unitCount: 1,
      activeUnitCount: 1,
      productCount: 4,
    });
  });

  it("[legend-34fu] counts survive paging and keep the keyset order", async () => {
    const { client } = await ownerClient();
    const all = await client.get("/api/facility/facilities?limit=100");
    const ids = (all.body.data as Row[]).map((row) => row.id);
    const first = await client.get("/api/facility/facilities?limit=1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    listFacilities.response.parse(first.body);
    expect(first.body.data[0].id).toBe(ids[0]);
    const second = await client.get(
      `/api/facility/facilities?limit=1&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    listFacilities.response.parse(second.body);
    expect(second.body.data[0].id).toBe(ids[1]);
    const expected = (all.body.data as Row[])[1];
    expect(second.body.data[0]).toMatchObject({
      areaCount: expected.areaCount,
      unitCount: expected.unitCount,
      activeUnitCount: expected.activeUnitCount,
      productCount: expected.productCount,
    });
  });

  it("[TEN-03][legend-34fu] an outlet-scoped caller sees only its own outlet's rows and counts", async () => {
    const { client } = await outletClient(outletB.id);
    const response = await client.get("/api/facility/facilities?limit=100");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    listFacilities.response.parse(response.body);
    const rows = response.body.data as Row[];
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(otherOutletFacilityId);
    expect(ids).not.toContain(busyFacilityId);
    expect(ids).not.toContain(emptyFacilityId);
    expect(rows.find((row) => row.id === otherOutletFacilityId)).toMatchObject({
      areaCount: 1,
      unitCount: 1,
      activeUnitCount: 1,
      productCount: 4,
    });
  });

  it("[legend-34fu] a caller without the config permission is refused", async () => {
    const { client } = await signedIn("Facility Counts Nobody");
    const response = await client.get("/api/facility/facilities");
    expect([401, 403]).toContain(response.status);
  });
});
