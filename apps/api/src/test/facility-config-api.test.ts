// Facility list, incident-log and configuration write API (PRD v1.7 §3
// F22/F25 "Konfigurasi Legend", "Produk & Hak Akses", "Langganan Bulanan",
// "Keselamatan", §3 F39; FAC-02, FAC-03, FAC-14; TEN-01..03; bead legend-8dpm).
// Runs the real Express app, Better Auth, the RBAC resolver and PostgreSQL
// against the seeded Cafe Legend tenant.
//
// Needs `facilityRouter` mounted at /api/facility (already) and
// `wifiConfigRouter` mounted at /api/wifi (routes/index.ts line supplied by
// this bead's report).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFacilityAddon,
  createFacilityProduct,
  createSubscriptionPlanEndpoint,
  getFacilityConfig,
  listFacilities,
  listFacilityIncidents,
  putEntitlementRule,
  putWifiPolicy,
  updateFacilityAddon,
  updateFacilityProduct,
  updateSubscriptionPlan,
} from "@starter/shared/facility";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const facilityId = randomUUID();
const otherFacilityId = randomUUID();
const zoneId = randomUUID();
const ruleId = randomUUID();
const policyId = randomUUID();

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
  const result = await signedIn("Facility Config Owner");
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
  const result = await signedIn("Facility Config Outlet");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Facility config test ${roleId.slice(0, 8)}`,
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
     VALUES ($1, $2, $3, $4, 'shower', 20, 10, 10, $5, $6, $7)`,
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

beforeAll(async () => {
  await asTenant(async (client) => {
    await insertFacility(client, facilityId, outletA.id, "AAA Shower 8dpm");
    await insertFacility(
      client,
      otherFacilityId,
      outletB.id,
      "ZZZ Shower 8dpm",
    );
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
         service_charge_bp, minimum_spend_idr, hours, status, sort_order)
       VALUES ($1, $2, $3, 'Zona WFC 8dpm', 'pay_first', 0, 0, $4, 'active', 0)`,
      [
        zoneId,
        tenant.id,
        outletA.id,
        JSON.stringify([
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        ]),
      ],
    );
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "facility_products",
      "facility_addons",
      "entitlement_rules",
      "facility_subscription_plans",
      "wifi_policies",
      "facility_incidents",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
        [tenant.id, [facilityId, otherFacilityId]],
      );
    await client.query(
      "DELETE FROM floor_zones WHERE tenant_id = $1 AND id = $2",
      [tenant.id, zoneId],
    );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, [facilityId, otherFacilityId]],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Facility config test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("Facility list API (legend-8dpm)", () => {
  it("[FAC-02][legend-8dpm] lists every facility visible to the caller, paged by name", async () => {
    const { client } = await ownerClient();
    const all = await client.get("/api/facility/facilities");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    listFacilities.response.parse(all.body);
    const ids = all.body.data.map((row: { id: string }) => row.id);
    const names = all.body.data.map((row: { name: string }) => row.name);
    expect(ids).toContain(facilityId);
    expect(ids).toContain(otherFacilityId);
    expect(names).toEqual([...names].sort());
    const first = await client.get("/api/facility/facilities?limit=1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    listFacilities.response.parse(first.body);
    expect(first.body.data[0].id).toBe(ids[0]);
    expect(first.body.meta.nextCursor).not.toBeNull();
    const second = await client.get(
      `/api/facility/facilities?limit=1&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    listFacilities.response.parse(second.body);
    expect(second.body.data[0].id).toBe(ids[1]);
    expect(
      (await client.get("/api/facility/facilities?cursor=not-a-cursor")).status,
    ).toBe(422);
  });

  it("[TEN-03][legend-8dpm] an outlet-scoped caller lists only its own outlet's facilities", async () => {
    const { client } = await outletClient(outletB.id);
    const response = await client.get("/api/facility/facilities");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    listFacilities.response.parse(response.body);
    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(otherFacilityId);
    expect(ids).not.toContain(facilityId);
  });
});

describe("Facility incident log API (legend-8dpm)", () => {
  it("[FAC-03][legend-8dpm] reads an empty log, pages newest first, and rejects another outlet's facility", async () => {
    const { client } = await ownerClient();
    const empty = await client.get(
      `/api/facility/incidents?facilityId=${facilityId}`,
    );
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    listFacilityIncidents.response.parse(empty.body);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.nextCursor).toBeNull();

    await asTenant(async (db) => {
      for (const minutes of [2, 1])
        await db.query(
          `INSERT INTO facility_incidents (id, tenant_id, outlet_id, facility_id, type, triggered_at, offline)
           VALUES ($1, $2, $3, $4, 'panic', now() - make_interval(mins => $5::int), false)`,
          [randomUUID(), tenant.id, outletA.id, facilityId, minutes],
        );
    });

    const first = await client.get(
      `/api/facility/incidents?facilityId=${facilityId}&limit=1`,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    listFacilityIncidents.response.parse(first.body);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).not.toBeNull();
    const older = await client.get(
      `/api/facility/incidents?facilityId=${facilityId}&limit=1&cursor=${first.body.meta.nextCursor}`,
    );
    expect(older.status, JSON.stringify(older.body)).toBe(200);
    expect(older.body.data).toHaveLength(1);
    expect(
      older.body.data[0].triggeredAt < first.body.data[0].triggeredAt,
    ).toBe(true);
    expect(
      (
        await client.get(
          `/api/facility/incidents?facilityId=${facilityId}&cursor=@@`,
        )
      ).status,
    ).toBe(422);

    const { client: outletBRole } = await outletClient(outletB.id);
    expect(
      (
        await outletBRole.get(
          `/api/facility/incidents?facilityId=${facilityId}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("Facility products, add-ons and plans API (legend-8dpm)", () => {
  it("[FAC-02][legend-8dpm] creates and updates a product and an add-on, then the config read returns them", async () => {
    const { client } = await ownerClient();
    const product = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({
        facilityId,
        name: "Shower Sekali",
        type: "single",
        priceIdr: 25000,
        sessions: 1,
      });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    createFacilityProduct.response.parse(product.body);
    expect(product.body.data.isActive).toBe(true);
    const updatedProduct = await client
      .patch(`/api/facility/products/${product.body.data.id}`)
      .set(originHeader)
      .send({ priceIdr: 30000, isActive: false });
    expect(updatedProduct.status, JSON.stringify(updatedProduct.body)).toBe(
      200,
    );
    updateFacilityProduct.response.parse(updatedProduct.body);
    expect(updatedProduct.body.data.priceIdr).toBe(30000);
    expect(updatedProduct.body.data.isActive).toBe(false);

    const addon = await client
      .post("/api/facility/addons")
      .set(originHeader)
      .send({ facilityId, name: "Handuk", priceIdr: 10000, sortOrder: 1 });
    expect(addon.status, JSON.stringify(addon.body)).toBe(201);
    createFacilityAddon.response.parse(addon.body);
    expect(addon.body.data.isEnabled).toBe(true);
    const updatedAddon = await client
      .patch(`/api/facility/addons/${addon.body.data.id}`)
      .set(originHeader)
      .send({ isEnabled: false, sortOrder: 2 });
    expect(updatedAddon.status, JSON.stringify(updatedAddon.body)).toBe(200);
    updateFacilityAddon.response.parse(updatedAddon.body);
    expect(updatedAddon.body.data.isEnabled).toBe(false);

    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    getFacilityConfig.response.parse(config.body);
    expect(
      config.body.data.products.map((row: { id: string }) => row.id),
    ).toEqual([product.body.data.id]);
    expect(
      config.body.data.addons.map((row: { id: string }) => row.id),
    ).toEqual([addon.body.data.id]);
  });

  it("[FAC-02][legend-8dpm] rejects invalid product input, unknown fields and an empty PATCH", async () => {
    const { client } = await ownerClient();
    expect(
      (
        await client.post("/api/facility/products").set(originHeader).send({
          facilityId,
          name: "Harga Negatif",
          type: "single",
          priceIdr: -1,
          sessions: 1,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await client.post("/api/facility/addons").set(originHeader).send({
          facilityId,
          name: "Handuk",
          priceIdr: 1000,
          tenantId: tenant.id,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/products/${randomUUID()}`)
          .set(originHeader)
          .send({})
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/products/${randomUUID()}`)
          .set(originHeader)
          .send({ priceIdr: 1000 })
      ).status,
    ).toBe(404);
  });

  it("[FAC-02][legend-8dpm] creates and updates a subscription plan", async () => {
    const { client } = await ownerClient();
    const plan = await client
      .post("/api/facility/subscription-plans")
      .set(originHeader)
      .send({
        facilityId,
        name: "Langganan 10 Sesi",
        priceIdr: 250000,
        quotaPerPeriod: 10,
        interval: "month",
        maxPerDay: 1,
      });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    createSubscriptionPlanEndpoint.response.parse(plan.body);
    expect(plan.body.data.isActive).toBe(true);
    const updated = await client
      .patch(`/api/facility/subscription-plans/${plan.body.data.id}`)
      .set(originHeader)
      .send({ quotaPerPeriod: 20, isActive: false });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    updateSubscriptionPlan.response.parse(updated.body);
    expect(updated.body.data.quotaPerPeriod).toBe(20);
    expect(updated.body.data.isActive).toBe(false);
    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    expect(
      config.body.data.subscriptionPlans.map((row: { id: string }) => row.id),
    ).toEqual([plan.body.data.id]);
  });
});

describe("Entitlement rule and Wi-Fi policy PUT semantics (legend-8dpm)", () => {
  it("[FAC-02][legend-8dpm] PUT /entitlement-rules/:ruleId creates then replaces the rule wholesale", async () => {
    const { client } = await ownerClient();
    const created = await client
      .put(`/api/facility/entitlement-rules/${ruleId}`)
      .set(originHeader)
      .send({
        facilityId,
        type: "min_spend",
        condition: { minSpendIdr: 100000 },
        sessions: 1,
        validity: { kind: "operating_day" },
        isEnabled: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    putEntitlementRule.response.parse(created.body);
    expect(created.body.data.id).toBe(ruleId);
    expect(created.body.data.type).toBe("min_spend");

    const replaced = await client
      .put(`/api/facility/entitlement-rules/${ruleId}`)
      .set(originHeader)
      .send({
        facilityId,
        type: "tier_benefit",
        condition: { tierKeys: ["gold", "platinum"] },
        sessions: 2,
        validity: { kind: "billing_period" },
        isEnabled: false,
      });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    putEntitlementRule.response.parse(replaced.body);
    expect(replaced.body.data.type).toBe("tier_benefit");
    expect(replaced.body.data.sessions).toBe(2);
    expect(replaced.body.data.isEnabled).toBe(false);
    expect(replaced.body.data.condition).toEqual({
      tierKeys: ["gold", "platinum"],
    });

    // The condition is fixed per type: a min-spend rule without a threshold is
    // rejected instead of silently dropping the rule's condition.
    expect(
      (
        await client
          .put(`/api/facility/entitlement-rules/${ruleId}`)
          .set(originHeader)
          .send({
            facilityId,
            type: "min_spend",
            condition: { tierKeys: ["gold"] },
            sessions: 1,
            validity: { kind: "operating_day" },
            isEnabled: true,
          })
      ).status,
    ).toBe(422);

    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    const rules = config.body.data.entitlementRules.filter(
      (row: { id: string }) => row.id === ruleId,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe("tier_benefit");
  });

  it("[FAC-14][legend-8dpm] PUT /api/wifi/policies/:policyId creates then replaces the zone policy", async () => {
    const { client } = await ownerClient();
    const body = {
      zoneId,
      facilityId,
      freeMinutes: 120,
      peakFreeMinutes: 60,
      spendPerExtraHourIdr: 30000,
      extraMinutes: 60,
      maxDevices: 2,
      peakSchedule: [
        { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
      ],
      baseSpeedKbps: 2048,
      fullSpeedKbps: 10240,
      minSpendPerHourIdr: null,
      tierBonusMinutes: { gold: 60, platinum: 120 },
    };
    const created = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    putWifiPolicy.response.parse(created.body);
    expect(created.body.data.id).toBe(policyId);
    expect(created.body.data.freeMinutes).toBe(120);

    const replaced = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send({ ...body, freeMinutes: 180, peakFreeMinutes: 90 });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    putWifiPolicy.response.parse(replaced.body);
    expect(replaced.body.data.id).toBe(policyId);
    expect(replaced.body.data.freeMinutes).toBe(180);
    expect(replaced.body.data.peakFreeMinutes).toBe(90);

    // Cross-field rule of the contract: the peak allowance cannot exceed the
    // off-peak one.
    expect(
      (
        await client
          .put(`/api/wifi/policies/${policyId}`)
          .set(originHeader)
          .send({ ...body, freeMinutes: 60, peakFreeMinutes: 120 })
      ).status,
    ).toBe(422);
    // The facility must belong to the zone's outlet.
    expect(
      (
        await client
          .put(`/api/wifi/policies/${policyId}`)
          .set(originHeader)
          .send({ ...body, facilityId: otherFacilityId })
      ).status,
    ).toBe(422);
    // A zone of another outlet is invisible to an outlet-scoped caller (TEN-03).
    const { client: outletBRole } = await outletClient(outletB.id);
    expect(
      (
        await outletBRole
          .put(`/api/wifi/policies/${randomUUID()}`)
          .set(originHeader)
          .send(body)
      ).status,
    ).toBe(404);

    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    const policies = config.body.data.wifiPolicies.filter(
      (row: { id: string }) => row.id === policyId,
    );
    expect(policies).toHaveLength(1);
    expect(policies[0].freeMinutes).toBe(180);
  });
});

describe("Facility config authorization (legend-8dpm)", () => {
  it("[TEN-03][legend-8dpm] a caller without facility permissions gets 403 on config reads and writes", async () => {
    const { client } = await signedIn("Facility Config Nobody");
    for (const request of [
      client.get("/api/facility/facilities"),
      client.get(`/api/facility/incidents?facilityId=${facilityId}`),
      client.post("/api/facility/products").set(originHeader).send({
        facilityId,
        name: "Tanpa Izin",
        type: "single",
        priceIdr: 1000,
        sessions: 1,
      }),
      client
        .post("/api/facility/addons")
        .set(originHeader)
        .send({ facilityId, name: "Tanpa Izin", priceIdr: 1000 }),
      client
        .put(`/api/facility/entitlement-rules/${randomUUID()}`)
        .set(originHeader)
        .send({
          facilityId,
          type: "min_spend",
          condition: { minSpendIdr: 1000 },
          sessions: 1,
          validity: { kind: "operating_day" },
          isEnabled: true,
        }),
      client.post("/api/facility/subscription-plans").set(originHeader).send({
        facilityId,
        name: "Tanpa Izin",
        priceIdr: 1000,
        quotaPerPeriod: 1,
        interval: "month",
      }),
      client.put(`/api/wifi/policies/${randomUUID()}`).set(originHeader).send({
        zoneId,
        freeMinutes: 120,
        peakFreeMinutes: 60,
        spendPerExtraHourIdr: 30000,
        extraMinutes: 60,
        maxDevices: 2,
        peakSchedule: [],
        baseSpeedKbps: 2048,
        fullSpeedKbps: 10240,
        minSpendPerHourIdr: null,
        tierBonusMinutes: {},
      }),
    ])
      expect((await request).status).toBe(403);
  });

  it("[TEN-03][legend-8dpm] an outlet-scoped caller cannot write another outlet's facility (404)", async () => {
    const { client } = await outletClient(outletB.id);
    expect(
      (
        await client.post("/api/facility/products").set(originHeader).send({
          facilityId,
          name: "Outlet Lain",
          type: "single",
          priceIdr: 1000,
          sessions: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .put(`/api/facility/entitlement-rules/${randomUUID()}`)
          .set(originHeader)
          .send({
            facilityId,
            type: "min_spend",
            condition: { minSpendIdr: 1000 },
            sessions: 1,
            validity: { kind: "operating_day" },
            isEnabled: true,
          })
      ).status,
    ).toBe(404);
    expect(
      (await client.get(`/api/facility/config?facilityId=${facilityId}`))
        .status,
    ).toBe(404);
  });
});
