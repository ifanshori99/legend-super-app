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
  createFacility,
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
  updateFacilityUnitConfig,
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
const key = () => `facility-config-${randomUUID()}`;
/** Facilities the tests create through the API (cleaned up in afterAll). */
const createdFacilityIds: string[] = [];

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
    const allFacilityIds = [facilityId, otherFacilityId, ...createdFacilityIds];
    for (const table of [
      "facility_units",
      "facility_areas",
      "facility_products",
      "facility_addons",
      "entitlement_rules",
      "facility_subscription_plans",
      "wifi_policies",
      "facility_incidents",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
        [tenant.id, allFacilityIds],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'facility-config-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM floor_zones WHERE tenant_id = $1 AND id = $2",
      [tenant.id, zoneId],
    );
    await client.query(
      "DELETE FROM facility_operating_hours_versions WHERE tenant_id = $1 AND facility_id = ANY($2)",
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
        idempotencyKey: key(),
      });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    createFacilityProduct.response.parse(product.body);
    expect(product.body.data.isActive).toBe(true);
    const updatedProduct = await client
      .patch(`/api/facility/products/${product.body.data.id}`)
      .set(originHeader)
      .send({
        priceIdr: 30000,
        isActive: false,
        expectedUpdatedAt: product.body.data.updatedAt,
      });
    expect(updatedProduct.status, JSON.stringify(updatedProduct.body)).toBe(
      200,
    );
    updateFacilityProduct.response.parse(updatedProduct.body);
    expect(updatedProduct.body.data.priceIdr).toBe(30000);
    expect(updatedProduct.body.data.isActive).toBe(false);

    const addon = await client
      .post("/api/facility/addons")
      .set(originHeader)
      .send({
        facilityId,
        name: "Handuk",
        priceIdr: 10000,
        sortOrder: 1,
        idempotencyKey: key(),
      });
    expect(addon.status, JSON.stringify(addon.body)).toBe(201);
    createFacilityAddon.response.parse(addon.body);
    expect(addon.body.data.isEnabled).toBe(true);
    const updatedAddon = await client
      .patch(`/api/facility/addons/${addon.body.data.id}`)
      .set(originHeader)
      .send({
        isEnabled: false,
        sortOrder: 2,
        expectedUpdatedAt: addon.body.data.updatedAt,
      });
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
          idempotencyKey: key(),
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
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/products/${randomUUID()}`)
          .set(originHeader)
          .send({ expectedUpdatedAt: new Date().toISOString() })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/products/${randomUUID()}`)
          .set(originHeader)
          .send({ priceIdr: 1000, expectedUpdatedAt: new Date().toISOString() })
      ).status,
    ).toBe(404);
  });

  it("[TEN-01][legend-8dpm] rejects a tax rule or menu item id that is not a row of this tenant (404)", async () => {
    const { client } = await ownerClient();
    const base = {
      facilityId,
      name: "Referensi Asing",
      type: "single",
      priceIdr: 1000,
      sessions: 1,
    };
    const foreignTax = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...base, taxRuleId: randomUUID(), idempotencyKey: key() });
    expect(foreignTax.status, JSON.stringify(foreignTax.body)).toBe(404);
    const foreignMenu = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...base, menuItemId: randomUUID(), idempotencyKey: key() });
    expect(foreignMenu.status, JSON.stringify(foreignMenu.body)).toBe(404);

    const product = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...base, idempotencyKey: key() });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const stamp = product.body.data.updatedAt as string;
    expect(
      (
        await client
          .patch(`/api/facility/products/${product.body.data.id}`)
          .set(originHeader)
          .send({ taxRuleId: randomUUID(), expectedUpdatedAt: stamp })
      ).status,
    ).toBe(404);
    // Clearing a reference is always allowed.
    expect(
      (
        await client
          .patch(`/api/facility/products/${product.body.data.id}`)
          .set(originHeader)
          .send({
            taxRuleId: null,
            menuItemId: null,
            expectedUpdatedAt: stamp,
          })
      ).status,
    ).toBe(200);

    expect(
      (
        await client
          .put(`/api/facility/entitlement-rules/${randomUUID()}`)
          .set(originHeader)
          .send({
            facilityId,
            type: "package",
            condition: { menuItemId: randomUUID() },
            sessions: 1,
            validity: { kind: "operating_day" },
            isEnabled: true,
            expectedUpdatedAt: null,
          })
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
        idempotencyKey: key(),
      });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    createSubscriptionPlanEndpoint.response.parse(plan.body);
    expect(plan.body.data.isActive).toBe(true);
    const updated = await client
      .patch(`/api/facility/subscription-plans/${plan.body.data.id}`)
      .set(originHeader)
      .send({
        quotaPerPeriod: 20,
        isActive: false,
        expectedUpdatedAt: plan.body.data.updatedAt,
      });
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
        expectedUpdatedAt: null,
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
        expectedUpdatedAt: created.body.data.updatedAt,
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
            expectedUpdatedAt: replaced.body.data.updatedAt,
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
      .send({ ...body, expectedUpdatedAt: null });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    putWifiPolicy.response.parse(created.body);
    expect(created.body.data.id).toBe(policyId);
    expect(created.body.data.freeMinutes).toBe(120);

    const replaced = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send({
        ...body,
        freeMinutes: 180,
        peakFreeMinutes: 90,
        expectedUpdatedAt: created.body.data.updatedAt,
      });
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
          .send({
            ...body,
            freeMinutes: 60,
            peakFreeMinutes: 120,
            expectedUpdatedAt: replaced.body.data.updatedAt,
          })
      ).status,
    ).toBe(422);
    // The facility must belong to the zone's outlet.
    expect(
      (
        await client
          .put(`/api/wifi/policies/${policyId}`)
          .set(originHeader)
          .send({
            ...body,
            facilityId: otherFacilityId,
            expectedUpdatedAt: replaced.body.data.updatedAt,
          })
      ).status,
    ).toBe(422);
    // A zone of another outlet is invisible to an outlet-scoped caller (TEN-03).
    const { client: outletBRole } = await outletClient(outletB.id);
    expect(
      (
        await outletBRole
          .put(`/api/wifi/policies/${randomUUID()}`)
          .set(originHeader)
          .send({ ...body, expectedUpdatedAt: null })
      ).status,
    ).toBe(404);

    // legend-kmd3: spendMode round-trips; absent in the body clears it (null in
    // the DB) and reads back as no `spendMode` key.
    const perOrder = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send({
        ...body,
        freeMinutes: 180,
        peakFreeMinutes: 90,
        spendMode: "per_order",
        expectedUpdatedAt: replaced.body.data.updatedAt,
      });
    expect(perOrder.status, JSON.stringify(perOrder.body)).toBe(200);
    putWifiPolicy.response.parse(perOrder.body);
    expect(perOrder.body.data.spendMode).toBe("per_order");
    const perDay = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send({
        ...body,
        freeMinutes: 180,
        peakFreeMinutes: 90,
        spendMode: "per_day_multiple",
        expectedUpdatedAt: perOrder.body.data.updatedAt,
      });
    expect(perDay.status, JSON.stringify(perDay.body)).toBe(200);
    expect(perDay.body.data.spendMode).toBe("per_day_multiple");
    const cleared = await client
      .put(`/api/wifi/policies/${policyId}`)
      .set(originHeader)
      .send({
        ...body,
        freeMinutes: 180,
        peakFreeMinutes: 90,
        expectedUpdatedAt: perDay.body.data.updatedAt,
      });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.spendMode).toBeUndefined();
    const modeAudit = (await auditEntries(policyId)).find(
      (row) => row.after?.spendMode === "per_order",
    );
    expect(modeAudit?.before?.spendMode).toBeUndefined();
    expect(
      (
        await client
          .put(`/api/wifi/policies/${policyId}`)
          .set(originHeader)
          .send({
            ...body,
            spendMode: "weekly",
            expectedUpdatedAt: cleared.body.data.updatedAt,
          })
      ).status,
    ).toBe(422);

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
    // Build each request lazily: supertest closes its ephemeral server between
    // sequential awaits, so a pre-built batch of Test objects would reuse a
    // closed server (app null).
    const requests = [
      () => client.get("/api/facility/facilities"),
      () => client.get(`/api/facility/incidents?facilityId=${facilityId}`),
      () =>
        client.post("/api/facility/products").set(originHeader).send({
          facilityId,
          name: "Tanpa Izin",
          type: "single",
          priceIdr: 1000,
          sessions: 1,
          idempotencyKey: key(),
        }),
      () =>
        client.post("/api/facility/addons").set(originHeader).send({
          facilityId,
          name: "Tanpa Izin",
          priceIdr: 1000,
          idempotencyKey: key(),
        }),
      () =>
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
            expectedUpdatedAt: null,
          }),
      () =>
        client.post("/api/facility/subscription-plans").set(originHeader).send({
          facilityId,
          name: "Tanpa Izin",
          priceIdr: 1000,
          quotaPerPeriod: 1,
          interval: "month",
          idempotencyKey: key(),
        }),
      () =>
        client
          .put(`/api/wifi/policies/${randomUUID()}`)
          .set(originHeader)
          .send({
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
            expectedUpdatedAt: null,
          }),
    ];
    for (const request of requests) expect((await request()).status).toBe(403);
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
          idempotencyKey: key(),
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
            expectedUpdatedAt: null,
          })
      ).status,
    ).toBe(404);
    expect(
      (await client.get(`/api/facility/config?facilityId=${facilityId}`))
        .status,
    ).toBe(404);
  });
});

async function auditEntries(objectId: string) {
  const { rows } = await owner.query<{
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    `SELECT event->>'action' AS action,
            event->'maskedChanges'->'before' AS before,
            event->'maskedChanges'->'after' AS after
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
      ORDER BY event->>'createdAt', id`,
    [tenant.id, objectId],
  );
  return rows;
}

const facilityBody = {
  name: "Ruang Kerja 6jms",
  type: "coworking",
  sessionMinutes: 60,
  cleaningMinutes: 10,
  arrivalGraceMinutes: 10,
  operatingHours: [
    { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], opensAt: "08:00", closesAt: "20:00" },
  ],
  overtimePolicy: { graceMinutes: 5, blockMinutes: 15, feePerBlockIdr: 5000 },
  cancellationPolicy: {
    freeCancelMinutesBefore: 30,
    lateCancelResolution: "no_refund",
    lateCancelFeeIdr: 0,
    noShowResolution: "no_refund",
  },
};

describe("Facility config: expectedUpdatedAt + idempotency (legend-6jms)", () => {
  it("[FAC-02][legend-6jms] PATCH answers 412 on a stale expectedUpdatedAt and the loser changes nothing", async () => {
    const { client } = await ownerClient();
    const product = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({
        facilityId,
        name: "Produk Konflik",
        type: "single",
        priceIdr: 20000,
        sessions: 1,
        idempotencyKey: key(),
      });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const stamp = product.body.data.updatedAt as string;
    const url = `/api/facility/products/${product.body.data.id}`;
    const first = await client
      .patch(url)
      .set(originHeader)
      .send({ priceIdr: 22000, expectedUpdatedAt: stamp });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.updatedAt).not.toBe(stamp);
    const loser = await client
      .patch(url)
      .set(originHeader)
      .send({ priceIdr: 99000, expectedUpdatedAt: stamp });
    expect(loser.status, JSON.stringify(loser.body)).toBe(412);
    expect(loser.body.error.code).toBe("PRECONDITION_FAILED");
    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    const stored = config.body.data.products.find(
      (row: { id: string }) => row.id === product.body.data.id,
    );
    expect(stored.priceIdr).toBe(22000);
    // The stamp is required by the contract.
    expect(
      (await client.patch(url).set(originHeader).send({ priceIdr: 1000 }))
        .status,
    ).toBe(422);
  });

  it("[FAC-02][legend-6jms] addon, plan, area, rule and Wi-Fi writes refuse a stale stamp", async () => {
    const { client } = await ownerClient();
    const old = "2000-01-01T00:00:00.000Z";
    const addon = await client
      .post("/api/facility/addons")
      .set(originHeader)
      .send({
        facilityId,
        name: "Add-on 6jms",
        priceIdr: 5000,
        idempotencyKey: key(),
      });
    expect(
      (
        await client
          .patch(`/api/facility/addons/${addon.body.data.id}`)
          .set(originHeader)
          .send({ priceIdr: 6000, expectedUpdatedAt: old })
      ).status,
    ).toBe(412);
    const plan = await client
      .post("/api/facility/subscription-plans")
      .set(originHeader)
      .send({
        facilityId,
        name: "Paket 6jms",
        priceIdr: 100000,
        quotaPerPeriod: 5,
        interval: "month",
        idempotencyKey: key(),
      });
    expect(
      (
        await client
          .patch(`/api/facility/subscription-plans/${plan.body.data.id}`)
          .set(originHeader)
          .send({ quotaPerPeriod: 6, expectedUpdatedAt: old })
      ).status,
    ).toBe(412);
    const area = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({ facilityId, name: "Area 6jms", idempotencyKey: key() });
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    expect(
      (
        await client
          .patch(`/api/facility/areas/${area.body.data.id}`)
          .set(originHeader)
          .send({ name: "Area Baru", expectedUpdatedAt: old })
      ).status,
    ).toBe(412);
    // The facility itself (PUT).
    expect(
      (
        await client
          .put(`/api/facility/facilities/${facilityId}`)
          .set(originHeader)
          .send({ name: "Dirubah", expectedUpdatedAt: old })
      ).status,
    ).toBe(412);

    const ruleBody = {
      facilityId,
      type: "min_spend",
      condition: { minSpendIdr: 50000 },
      sessions: 1,
      validity: { kind: "operating_day" },
      isEnabled: true,
    };
    const newRuleId = randomUUID();
    const rulePath = `/api/facility/entitlement-rules/${newRuleId}`;
    const createdRule = await client
      .put(rulePath)
      .set(originHeader)
      .send({ ...ruleBody, expectedUpdatedAt: null });
    expect(createdRule.status, JSON.stringify(createdRule.body)).toBe(200);
    // A row that exists cannot be "created" again, and a stale stamp loses.
    expect(
      (
        await client
          .put(rulePath)
          .set(originHeader)
          .send({ ...ruleBody, expectedUpdatedAt: null })
      ).status,
    ).toBe(412);
    expect(
      (
        await client
          .put(rulePath)
          .set(originHeader)
          .send({ ...ruleBody, expectedUpdatedAt: old })
      ).status,
    ).toBe(412);
    expect(
      (
        await client
          .put(rulePath)
          .set(originHeader)
          .send({
            ...ruleBody,
            sessions: 3,
            expectedUpdatedAt: createdRule.body.data.updatedAt,
          })
      ).status,
    ).toBe(200);
    // A stamp for a row that does not exist is also a conflict.
    expect(
      (
        await client
          .put(`/api/facility/entitlement-rules/${randomUUID()}`)
          .set(originHeader)
          .send({ ...ruleBody, expectedUpdatedAt: old })
      ).status,
    ).toBe(412);
    await owner.query("DELETE FROM entitlement_rules WHERE id = $1", [
      newRuleId,
    ]);
  });

  it("[FAC-14][legend-6jms] a stale Wi-Fi policy PUT answers 412 and keeps the stored numbers", async () => {
    const { client } = await ownerClient();
    const id = randomUUID();
    const zone = randomUUID();
    await asTenant((db) =>
      db.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
           service_charge_bp, minimum_spend_idr, hours, status, sort_order)
         VALUES ($1, $2, $3, 'Zona WFC 6jms', 'pay_first', 0, 0, $4, 'active', 1)`,
        [zone, tenant.id, outletA.id, JSON.stringify([])],
      ),
    );
    try {
      const body = {
        zoneId: zone,
        facilityId,
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
      };
      const created = await client
        .put(`/api/wifi/policies/${id}`)
        .set(originHeader)
        .send({ ...body, expectedUpdatedAt: null });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const stamp = created.body.data.updatedAt as string;
      expect(
        (
          await client
            .put(`/api/wifi/policies/${id}`)
            .set(originHeader)
            .send({ ...body, freeMinutes: 150, expectedUpdatedAt: stamp })
        ).status,
      ).toBe(200);
      const stale = await client
        .put(`/api/wifi/policies/${id}`)
        .set(originHeader)
        .send({ ...body, freeMinutes: 90, expectedUpdatedAt: stamp });
      expect(stale.status, JSON.stringify(stale.body)).toBe(412);
      const stored = await owner.query(
        "SELECT free_minutes FROM wifi_policies WHERE id = $1",
        [id],
      );
      expect(stored.rows[0].free_minutes).toBe(150);
      // Old and new quota are readable in the audit.
      const audit = await auditEntries(id);
      const replaced = audit.find(
        (row) => row.action === "wifi_policy.replaced",
      );
      expect(replaced?.before?.freeMinutes).toBe(120);
      expect(replaced?.after?.freeMinutes).toBe(150);
    } finally {
      await owner.query("DELETE FROM wifi_policies WHERE zone_id = $1", [zone]);
      await asTenant((db) =>
        db.query("DELETE FROM floor_zones WHERE id = $1", [zone]),
      );
    }
  });

  it("[FAC-02][legend-6jms] POST create with the same idempotencyKey returns the first row; another payload is refused", async () => {
    const { client } = await ownerClient();
    const idempotencyKey = key();
    const body = {
      facilityId,
      name: "Produk Idempoten",
      type: "single",
      priceIdr: 15000,
      sessions: 1,
      idempotencyKey,
    };
    const first = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const rows = await owner.query(
      "SELECT 1 FROM facility_products WHERE tenant_id = $1 AND facility_id = $2 AND name = 'Produk Idempoten'",
      [tenant.id, facilityId],
    );
    expect(rows.rowCount).toBe(1);
    const reused = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...body, priceIdr: 16000 });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The same key on another kind of row is also a reuse, not a second write.
    const otherKind = await client
      .post("/api/facility/addons")
      .set(originHeader)
      .send({ facilityId, name: "Lain", priceIdr: 1000, idempotencyKey });
    expect(otherKind.status).toBe(409);
    // A key is required.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit field
    const { idempotencyKey: _omit, ...withoutKey } = body;
    expect(
      (
        await client
          .post("/api/facility/products")
          .set(originHeader)
          .send(withoutKey)
      ).status,
    ).toBe(422);
  });

  it("[TEN-03][FAC-02] one idempotencyKey used on outlet A then outlet B is a 409 conflict, not a 500", async () => {
    const { client: clientA } = await outletClient(outletA.id);
    const { client: clientB } = await outletClient(outletB.id);
    const idempotencyKey = key();
    const body = {
      name: "Produk Dua Outlet",
      type: "single",
      priceIdr: 15000,
      sessions: 1,
      idempotencyKey,
    };
    const first = await clientA
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...body, facilityId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Outlet B cannot see outlet A's key (outlet RLS), so the lookup misses.
    const other = await clientB
      .post("/api/facility/products")
      .set(originHeader)
      .send({ ...body, facilityId: otherFacilityId });
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const rows = await owner.query(
      "SELECT 1 FROM facility_products WHERE tenant_id = $1 AND facility_id = $2 AND name = 'Produk Dua Outlet'",
      [tenant.id, otherFacilityId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("[FAC-02][legend-6jms] a price and quota change is audited with the old and the new value", async () => {
    const { client } = await ownerClient();
    const product = await client
      .post("/api/facility/products")
      .set(originHeader)
      .send({
        facilityId,
        name: "Produk Audit",
        type: "single",
        priceIdr: 25000,
        sessions: 1,
        idempotencyKey: key(),
      });
    const updated = await client
      .patch(`/api/facility/products/${product.body.data.id}`)
      .set(originHeader)
      .send({
        priceIdr: 30000,
        sessions: 2,
        expectedUpdatedAt: product.body.data.updatedAt,
      });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const entries = await auditEntries(product.body.data.id);
    const change = entries.find(
      (row) => row.action === "facility_product.updated",
    );
    expect(change?.before).toMatchObject({ priceIdr: 25000, quota: 1 });
    expect(change?.after).toMatchObject({ priceIdr: 30000, quota: 2 });

    const plan = await client
      .post("/api/facility/subscription-plans")
      .set(originHeader)
      .send({
        facilityId,
        name: "Paket Audit",
        priceIdr: 100000,
        quotaPerPeriod: 10,
        interval: "month",
        idempotencyKey: key(),
      });
    await client
      .patch(`/api/facility/subscription-plans/${plan.body.data.id}`)
      .set(originHeader)
      .send({
        quotaPerPeriod: 12,
        priceIdr: 110000,
        expectedUpdatedAt: plan.body.data.updatedAt,
      });
    const planChange = (await auditEntries(plan.body.data.id)).find(
      (row) => row.action === "facility_subscription_plan.updated",
    );
    expect(planChange?.before).toMatchObject({
      quotaPerPeriod: 10,
      priceIdr: 100000,
    });
    expect(planChange?.after).toMatchObject({
      quotaPerPeriod: 12,
      priceIdr: 110000,
    });
  });
});

describe("Facility admin create/update endpoints without SQL seeding (legend-nngz)", () => {
  it("[FAC-02][legend-nngz] creates a facility, an area and a unit, edits the unit config, and replays by key", async () => {
    const { client } = await ownerClient();
    const facilityKey = key();
    const created = await client
      .post("/api/facility/facilities")
      .set(originHeader)
      .send({
        ...facilityBody,
        outletId: outletA.id,
        idempotencyKey: facilityKey,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createFacility.response.parse(created.body);
    const newFacilityId = created.body.data.id as string;
    createdFacilityIds.push(newFacilityId);
    const replay = await client
      .post("/api/facility/facilities")
      .set(originHeader)
      .send({
        ...facilityBody,
        outletId: outletA.id,
        idempotencyKey: facilityKey,
      });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(newFacilityId);

    const area = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({
        facilityId: newFacilityId,
        name: "Lantai 1",
        idempotencyKey: key(),
      });
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    const area2 = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({
        facilityId: newFacilityId,
        name: "Lantai 2",
        idempotencyKey: key(),
      });
    const unit = await client
      .post("/api/facility/units")
      .set(originHeader)
      .send({
        facilityId: newFacilityId,
        areaId: area.body.data.id,
        code: "M1",
        idempotencyKey: key(),
      });
    expect(unit.status, JSON.stringify(unit.body)).toBe(201);
    const unitPath = `/api/facility/units/${unit.body.data.id}/config`;
    const edited = await client.patch(unitPath).set(originHeader).send({
      code: "M2",
      areaId: area2.body.data.id,
      expectedUpdatedAt: unit.body.data.updatedAt,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    updateFacilityUnitConfig.response.parse(edited.body);
    expect(edited.body.data.code).toBe("M2");
    expect(edited.body.data.areaId).toBe(area2.body.data.id);
    expect(edited.body.data.status).toBe("available");
    // Stale stamp, empty change and an area of another facility are refused.
    expect(
      (
        await client
          .patch(unitPath)
          .set(originHeader)
          .send({ code: "M3", expectedUpdatedAt: unit.body.data.updatedAt })
      ).status,
    ).toBe(412);
    expect(
      (
        await client
          .patch(unitPath)
          .set(originHeader)
          .send({ expectedUpdatedAt: edited.body.data.updatedAt })
      ).status,
    ).toBe(422);
    const foreignArea = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({ facilityId, name: "Area Asing 6jms", idempotencyKey: key() });
    expect(
      (
        await client.patch(unitPath).set(originHeader).send({
          areaId: foreignArea.body.data.id,
          expectedUpdatedAt: edited.body.data.updatedAt,
        })
      ).status,
    ).toBe(422);
    // An invalid slot (session + cleaning above 12 hours) is a 422.
    expect(
      (
        await client
          .post("/api/facility/facilities")
          .set(originHeader)
          .send({
            ...facilityBody,
            sessionMinutes: 480,
            cleaningMinutes: 241,
            outletId: outletA.id,
            idempotencyKey: key(),
          })
      ).status,
    ).toBe(422);
    const audit = await auditEntries(newFacilityId);
    expect(audit.map((row) => row.action)).toContain("facility.created");
    const config = await client.get(
      `/api/facility/config?facilityId=${newFacilityId}`,
    );
    expect(config.status).toBe(200);
    expect(config.body.data.units[0].code).toBe("M2");
  });

  it("[TEN-03][legend-nngz] another outlet's caller cannot create a facility or edit a unit there; nobody gets 403", async () => {
    const owned = await ownerClient();
    const area = await owned.client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({ facilityId, name: "Area Lintas 6jms", idempotencyKey: key() });
    const unit = await owned.client
      .post("/api/facility/units")
      .set(originHeader)
      .send({
        facilityId,
        areaId: area.body.data.id,
        code: "X1",
        idempotencyKey: key(),
      });
    expect(unit.status, JSON.stringify(unit.body)).toBe(201);
    const { client: outletBRole } = await outletClient(outletB.id);
    expect(
      (
        await outletBRole
          .post("/api/facility/facilities")
          .set(originHeader)
          .send({
            ...facilityBody,
            outletId: outletA.id,
            idempotencyKey: key(),
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await outletBRole
          .patch(`/api/facility/units/${unit.body.data.id}/config`)
          .set(originHeader)
          .send({ code: "X2", expectedUpdatedAt: unit.body.data.updatedAt })
      ).status,
    ).toBe(404);
    const { client: nobody } = await signedIn("Facility Config Nobody 2");
    expect(
      (
        await nobody
          .post("/api/facility/facilities")
          .set(originHeader)
          .send({
            ...facilityBody,
            outletId: outletA.id,
            idempotencyKey: key(),
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await nobody
          .patch(`/api/facility/units/${unit.body.data.id}/config`)
          .set(originHeader)
          .send({ code: "X2", expectedUpdatedAt: unit.body.data.updatedAt })
      ).status,
    ).toBe(403);
  });
});
