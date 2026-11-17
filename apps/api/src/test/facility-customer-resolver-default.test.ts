// legend-bj5m: two production wiring gaps, tested fail-first.
//
// (1) worker-main.ts must sweep expired slot holds inside a tenant transaction.
//     worker-main.ts has top-level side effects, so it is read as source (same
//     approach as edge-worker-refund-gate.test.ts). May already pass.
// (2) The facility routes must, by default, resolve a signed-in user to their
//     customer profile id. This file NEVER calls setFacilityCustomerResolver:
//     it exercises the default resolver after createApp(). A user with a
//     profile must get past 403 CUSTOMER_PROFILE_REQUIRED; a user without a
//     profile must still get that 403 (fail closed).
// Setup follows facility-api.test.ts (seeded Cafe Legend tenant, real app).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const workerSource = readFileSync(
  new URL("../worker-main.ts", import.meta.url),
  "utf8",
);

describe("legend-bj5m worker-main wiring", () => {
  it("imports releaseExpiredSlotHolds", () => {
    expect(workerSource).toMatch(
      /import\s*\{[^}]*\breleaseExpiredSlotHolds\b[^}]*\}\s*from/,
    );
  });

  it("calls releaseExpiredSlotHolds inside withTenant", () => {
    // Assumption: the call sits in a withTenant(...) callback; allow any
    // arguments/whitespace between the two but keep them in one expression.
    expect(workerSource).toMatch(
      /withTenant\([\s\S]{0,400}?releaseExpiredSlotHolds\(/,
    );
  });
});

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const facilityId = randomUUID();
const areaId = randomUUID();
const unitId = randomUUID();
const profileId = randomUUID();
// Extra profiles for the non-active / other-tenant cases; removed in afterAll.
const extraProfileIds: string[] = [];
const otherTenantId = randomUUID();
let otherTenantCreated = false;

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

async function asTenantId<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
) {
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

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  // Same as facility-api.test.ts ownerClient(): the queue route needs a tenant
  // role, so the 403 under test is CUSTOMER_PROFILE_REQUIRED, not a role gap.
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, userId],
  );
  return { client, userId };
}

beforeAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower Resolver', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.id,
        outletA.id,
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
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Resolver', 0)`,
      [areaId, tenant.id, outletA.id, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'R1', 'available', 0)`,
      [unitId, tenant.id, outletA.id, facilityId, areaId],
    );
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "facility_operating_hours_versions",
      "facility_queue_entries",
      "access_tickets",
      "facility_units",
      "facility_areas",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
        [tenant.id, facilityId],
      );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = $2",
      [tenant.id, facilityId],
    );
    await client.query(
      "DELETE FROM customer_profiles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, [profileId, ...extraProfileIds]],
    );
  });
  if (otherTenantCreated) {
    await asTenantId(otherTenantId, (client) =>
      client.query("DELETE FROM customer_profiles WHERE tenant_id = $1", [
        otherTenantId,
      ]),
    );
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  }
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("legend-bj5m default facility customer resolver", () => {
  it("[FAC-02] a signed-in user with a customer profile can join the queue (no 403)", async () => {
    const { client, userId } = await signedIn("Resolver Member");
    await asTenant((db) =>
      db.query(
        `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
         VALUES ($1, $2, $3, 'Resolver Member', 'active', now())`,
        [profileId, tenant.id, userId],
      ),
    );
    const response = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("[FAC-02] a signed-in user without a customer profile still gets 403 CUSTOMER_PROFILE_REQUIRED", async () => {
    const { client } = await signedIn("Resolver No Profile");
    const response = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("CUSTOMER_PROFILE_REQUIRED");
  });

  // Spec assumption: only an `active` membership counts as a customer. Every
  // other status (pending_verification, suspended, closed) must fail closed with
  // the same 403 as "no profile", never reach the queue service.
  it.each([
    ["pending_verification", false],
    ["suspended", true],
    ["closed", false],
  ] as const)(
    "[FAC-02] a profile with membershipStatus %s still gets 403 CUSTOMER_PROFILE_REQUIRED",
    async (status, verified) => {
      const { client, userId } = await signedIn(`Resolver ${status}`);
      const id = randomUUID();
      extraProfileIds.push(id);
      await asTenant((db) =>
        db.query(
          `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
           VALUES ($1, $2, $3, $4, $5, ${verified ? "now()" : "NULL"})`,
          [id, tenant.id, userId, `Resolver ${status}`, status],
        ),
      );
      const response = await client
        .post("/api/facility/queue")
        .set(originHeader)
        .send({ facilityId, areaId });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe("CUSTOMER_PROFILE_REQUIRED");
    },
  );

  it("[FAC-02] an active profile in ANOTHER tenant does not count (403 CUSTOMER_PROFILE_REQUIRED)", async () => {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Resolver Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
      [
        otherTenantId,
        `resolver-${randomUUID().slice(0, 8)}`,
        JSON.stringify({ modules: [], integrationProviders: [] }),
        JSON.stringify({
          maxOutlets: 1,
          maxActiveEmployees: 1,
          maxDevices: 1,
          aiRequestsPerMonth: 0,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 0,
          emailCostCapIdr: 0,
        }),
        randomUUID(),
      ],
    );
    otherTenantCreated = true;
    const { client, userId } = await signedIn("Resolver Other Tenant");
    await asTenantId(otherTenantId, (db) =>
      db.query(
        `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
         VALUES ($1, $2, $3, 'Resolver Other Tenant', 'active', now())`,
        [randomUUID(), otherTenantId, userId],
      ),
    );
    const response = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("CUSTOMER_PROFILE_REQUIRED");
  });
});
