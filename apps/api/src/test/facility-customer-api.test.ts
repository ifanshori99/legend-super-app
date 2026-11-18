// Guest-facing facility reads: price board and QR entry lookup (PRD v1.7 §25;
// FAC-11; beads legend-zjfi, legend-humf). Runs the real Express app and
// PostgreSQL against the seeded Cafe Legend tenant. Both reads are public (no
// session), tenant from the host, and must never expose staff configuration.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  facilityCatalogSchema,
  facilityEntrySchema,
  listSubscriptionPlans,
} from "@starter/shared/facility";
import { createApp } from "../app";
import { agent } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers";

const app = createApp();
const facilityId = randomUUID();
const areaPria = randomUUID();
const areaWanita = randomUUID();
const activeProduct = randomUUID();
const inactiveProduct = randomUUID();
const enabledAddon = randomUUID();
const disabledAddon = randomUUID();
const activePlan = randomUUID();
const inactivePlan = randomUUID();
let otherTenant: IsolatedTenant;

// Staff-only configuration that a guest response must never carry.
const STAFF_ONLY_KEYS = [
  "overtimePolicy",
  "cancellationPolicy",
  "arrivalGraceMinutes",
  "cleaningMinutes",
  "taxRuleId",
  "menuItemId",
  "inventoryItemId",
  "providerPlanId",
  "entranceLockDeviceId",
  "lockDeviceId",
  "panicDeviceId",
  "entitlementRules",
  "units",
  "isActive",
  "isEnabled",
  "tenantId",
];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object")
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  return keys;
}

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

const publicGet = (path: string, host = seededHostname) =>
  agent(app).get(path).set("Host", host);

beforeAll(async () => {
  otherTenant = await createIsolatedTenant(`facguest${Date.now() % 100_000}`);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'WFC Guest API', 'coworking', 60, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        seededTenantId,
        seededOutletA,
        JSON.stringify([
          { daysOfWeek: [1, 2, 3, 4, 5], opensAt: "08:00", closesAt: "22:00" },
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
    for (const [id, name, sort] of [
      [areaWanita, "Area Wanita", 1],
      [areaPria, "Area Pria", 0],
    ] as const)
      await client.query(
        `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, seededTenantId, seededOutletA, facilityId, name, sort],
      );
    await client.query(
      `INSERT INTO facility_units (tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, 'K1', 'available', 0)`,
      [seededTenantId, seededOutletA, facilityId, areaPria],
    );
    for (const [id, name, type, price, active] of [
      [activeProduct, "Day Pass WFC", "single", 75000, true],
      [inactiveProduct, "Produk Lama", "single", 10000, false],
    ] as const)
      await client.query(
        `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
        [
          id,
          seededTenantId,
          seededOutletA,
          facilityId,
          name,
          type,
          price,
          active,
        ],
      );
    for (const [id, name, enabled] of [
      [enabledAddon, "Colokan Ekstra", true],
      [disabledAddon, "Add-on Mati", false],
    ] as const)
      await client.query(
        `INSERT INTO facility_addons (id, tenant_id, outlet_id, facility_id, name, price_idr, is_enabled)
         VALUES ($1, $2, $3, $4, $5, 5000, $6)`,
        [id, seededTenantId, seededOutletA, facilityId, name, enabled],
      );
    for (const [id, name, active] of [
      [activePlan, "Langganan 10x", true],
      [inactivePlan, "Langganan Lama", false],
    ] as const)
      await client.query(
        `INSERT INTO facility_subscription_plans (id, tenant_id, outlet_id, facility_id, name, price_idr,
                                                  quota_per_period, interval, provider_plan_id, is_active)
         VALUES ($1, $2, $3, $4, $5, 300000, 10, 'month', 'provider-secret-plan', $6)`,
        [id, seededTenantId, seededOutletA, facilityId, name, active],
      );
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "facility_operating_hours_versions",
      "facility_subscription_plans",
      "facility_addons",
      "facility_products",
      "facility_units",
      "facility_areas",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
        [seededTenantId, facilityId],
      );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, facilityId],
    );
  });
  await dropIsolatedTenant(otherTenant);
});

describe("GET /api/facility/catalog (public)", () => {
  it("[FAC-11] serves the price board without a session", async () => {
    const response = await publicGet(
      `/api/facility/catalog?facilityId=${facilityId}`,
    );
    expect(response.status).toBe(200);
    const catalog = facilityCatalogSchema.parse(response.body.data);
    expect(catalog.facility).toMatchObject({
      id: facilityId,
      name: "WFC Guest API",
      type: "coworking",
      sessionMinutes: 60,
      outletId: seededOutletA,
    });
    expect(catalog.facility.operatingHours[0]).toMatchObject({
      opensAt: "08:00",
      closesAt: "22:00",
    });
    expect(catalog.products).toEqual([
      expect.objectContaining({
        id: activeProduct,
        name: "Day Pass WFC",
        priceIdr: 75000,
      }),
    ]);
    expect(catalog.addons.map((addon) => addon.id)).toEqual([enabledAddon]);
    expect(catalog.plans.map((plan) => plan.id)).toEqual([activePlan]);
  });

  it("never exposes staff configuration", async () => {
    const response = await publicGet(
      `/api/facility/catalog?facilityId=${facilityId}`,
    );
    const keys = collectKeys(response.body);
    for (const key of STAFF_ONLY_KEYS) expect(keys.has(key)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("provider-secret-plan");
  });

  it("answers 404 for an unknown facility and 422 for a bad query", async () => {
    expect(
      (await publicGet(`/api/facility/catalog?facilityId=${randomUUID()}`))
        .status,
    ).toBe(404);
    expect((await publicGet("/api/facility/catalog")).status).toBe(422);
    expect(
      (await publicGet("/api/facility/catalog?facilityId=not-a-uuid")).status,
    ).toBe(422);
  });

  it("[TEN-01] another tenant's host cannot read this facility", async () => {
    const response = await publicGet(
      `/api/facility/catalog?facilityId=${facilityId}`,
      otherTenant.hostname,
    );
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("WFC Guest API");
  });
});

describe("GET /api/facility/subscription-plans (public)", () => {
  const plansPath = (id: string = facilityId) =>
    `/api/facility/subscription-plans?facilityId=${id}`;

  it("[FAC-11] lists the active plans without a session, allow-listed", async () => {
    const response = await publicGet(plansPath());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    listSubscriptionPlans.response.parse(response.body);
    expect(
      response.body.data.plans.map((plan: { id: string }) => plan.id),
    ).toEqual([activePlan]);
    const keys = collectKeys(response.body);
    for (const key of STAFF_ONLY_KEYS) expect(keys.has(key)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("provider-secret-plan");
  });

  it("answers 404 for an unknown facility and 422 for a bad query", async () => {
    expect((await publicGet(plansPath(randomUUID()))).status).toBe(404);
    expect((await publicGet("/api/facility/subscription-plans")).status).toBe(
      422,
    );
  });

  it("[TEN-01] another tenant's host cannot read this facility's plans", async () => {
    const response = await publicGet(plansPath(), otherTenant.hostname);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("Langganan 10x");
  });
});

describe("GET /api/facility/entry/:token (public)", () => {
  it("resolves the facility id token to the facility and its area choices", async () => {
    const response = await publicGet(`/api/facility/entry/${facilityId}`);
    expect(response.status).toBe(200);
    const entry = facilityEntrySchema.parse(response.body.data);
    expect(entry.facility.id).toBe(facilityId);
    expect(entry.areas.map((area) => area.name)).toEqual([
      "Area Pria",
      "Area Wanita",
    ]);
    const keys = collectKeys(response.body);
    for (const key of STAFF_ONLY_KEYS) expect(keys.has(key)).toBe(false);
  });

  it("answers the same 404 for a malformed, unknown or foreign token", async () => {
    const malformed = await publicGet("/api/facility/entry/not-a-token");
    const unknown = await publicGet(`/api/facility/entry/${randomUUID()}`);
    const foreign = await publicGet(
      `/api/facility/entry/${facilityId}`,
      otherTenant.hostname,
    );
    for (const response of [malformed, unknown, foreign])
      expect(response.status).toBe(404);
    const shape = (body: { error: { code: string; message: string } }) => ({
      code: body.error.code,
      message: body.error.message,
    });
    expect(shape(malformed.body)).toEqual(shape(unknown.body));
    expect(shape(foreign.body)).toEqual(shape(unknown.body));
  });
});
