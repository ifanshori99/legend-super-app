// Facility configuration, availability, unit and queue HTTP API (PRD v1.7 §3
// F22; FAC-02, FAC-06; TEN-01..03; bead legend-nm4f). Runs the real Express
// app, Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe
// Legend tenant. Needs `facilityRouter` mounted at /api/facility.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFacilityArea,
  createFacilityUnit,
  getFacilityAvailability,
  getFacilityConfig,
  joinFacilityQueue,
  updateFacilityUnit,
} from "@starter/shared/facility";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setFacilityCustomerResolver } from "../routes/facility.routes.ts";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const facilityId = randomUUID();
const areaId = randomUUID();
const unitId = randomUUID();
const guestProfile = randomUUID();

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
  const result = await signedIn("Facility Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

async function outletClient(outletId: string) {
  const result = await signedIn("Facility Outlet B");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Facility API test ${roleId.slice(0, 8)}`,
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

beforeAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower API', 'shower', 20, 10, 10, $4, $5, $6)`,
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
       VALUES ($1, $2, $3, $4, 'Area Pria', 0)`,
      [areaId, tenant.id, outletA.id, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'available', 0)`,
      [unitId, tenant.id, outletA.id, facilityId, areaId],
    );
  });
});

afterAll(async () => {
  setFacilityCustomerResolver(null);
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
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Facility API test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

const availabilityPath = (id = facilityId) =>
  `/api/facility/availability?facilityId=${id}&date=2030-01-15`;

describe("Facility API authorization and isolation", () => {
  it("[TEN-01] answers 401 to anonymous requests", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get(availabilityPath())).status).toBe(401);
    expect(
      (
        await anonymous
          .patch(`/api/facility/units/${unitId}`)
          .set(originHeader)
          .send({ action: "flag_maintenance" })
      ).status,
    ).toBe(401);
  });

  it("[TEN-03] a signed-in user without facility permissions gets 403 everywhere", async () => {
    const { client } = await signedIn("Facility Nobody");
    expect((await client.get(availabilityPath())).status).toBe(403);
    expect(
      (await client.get(`/api/facility/config?facilityId=${facilityId}`))
        .status,
    ).toBe(403);
    expect(
      (
        await client
          .patch(`/api/facility/units/${unitId}`)
          .set(originHeader)
          .send({ action: "flag_maintenance" })
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .post("/api/facility/areas")
          .set(originHeader)
          .send({ facilityId, name: "Area X" })
      ).status,
    ).toBe(403);
  });

  it("[TEN-02] a write from an untrusted origin is refused before it reaches the service", async () => {
    const { client } = await ownerClient();
    const response = await client
      .post("/api/facility/areas")
      .set("Origin", "https://evil.example")
      .send({ facilityId, name: "Area Evil" });
    expect(response.status).toBe(403);
  });

  it("[TEN-03] an actor who only holds outlet B cannot read or change outlet A's facility", async () => {
    const { client } = await outletClient(outletB.id);
    expect((await client.get(availabilityPath())).status).toBe(404);
    expect(
      (await client.get(`/api/facility/config?facilityId=${facilityId}`))
        .status,
    ).toBe(404);
    expect(
      (
        await client
          .patch(`/api/facility/units/${unitId}`)
          .set(originHeader)
          .send({ action: "flag_maintenance" })
      ).status,
    ).toBe(404);
  });

  it("[TEN-01] an unknown facility id is a 404, never another tenant's row", async () => {
    const { client } = await ownerClient();
    expect((await client.get(availabilityPath(randomUUID()))).status).toBe(404);
  });
});

describe("Facility configuration API", () => {
  it("[FAC-06] reads availability and config in the contract shape; strict inputs reject unknown fields", async () => {
    const { client } = await ownerClient();
    const availability = await client.get(availabilityPath());
    expect(availability.status, JSON.stringify(availability.body)).toBe(200);
    getFacilityAvailability.response.parse(availability.body);
    expect(availability.body.data.areas[0].units[0].bookable).toBe(true);
    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    getFacilityConfig.response.parse(config.body);
    expect(
      (
        await client.get(
          "/api/facility/availability?facilityId=nope&date=2030-01-15",
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/units/${unitId}`)
          .set(originHeader)
          .send({ action: "flag_maintenance", tenantId: tenant.id })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/facility/units/${unitId}`)
          .set(originHeader)
          .send({ action: "explode" })
      ).status,
    ).toBe(422);
  });

  it("[FAC-06] flagging maintenance blocks the unit on availability; releasing leaves it needing cleaning", async () => {
    const { client } = await ownerClient();
    const flagged = await client
      .patch(`/api/facility/units/${unitId}`)
      .set(originHeader)
      .send({ action: "flag_maintenance" });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);
    updateFacilityUnit.response.parse(flagged.body);
    expect(flagged.body.data.status).toBe("maintenance");
    const blocked = await client.get(availabilityPath());
    const unit = blocked.body.data.areas[0].units[0];
    expect(unit.bookable).toBe(false);
    expect(
      unit.slots.some((slot: { available: boolean }) => slot.available),
    ).toBe(false);
    const released = await client
      .patch(`/api/facility/units/${unitId}`)
      .set(originHeader)
      .send({ action: "release_maintenance" });
    expect(released.body.data.status).toBe("needs_cleaning");
    const again = await client
      .patch(`/api/facility/units/${unitId}`)
      .set(originHeader)
      .send({ action: "release_maintenance" });
    expect(again.status).toBe(409);
    // Back to a clean unit for the next tests.
    await asTenant((db) =>
      db.query("UPDATE facility_units SET status = 'available' WHERE id = $1", [
        unitId,
      ]),
    );
  });

  it("creates areas and units, refuses duplicates, and writes an audit trail", async () => {
    const { client } = await ownerClient();
    const area = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({
        facilityId,
        name: "Area Wanita",
        sortOrder: 1,
        idempotencyKey: randomUUID(),
      });
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    createFacilityArea.response.parse(area.body);
    const duplicateArea = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({ facilityId, name: "Area Wanita", idempotencyKey: randomUUID() });
    expect(duplicateArea.status).toBe(409);
    const unit = await client
      .post("/api/facility/units")
      .set(originHeader)
      .send({
        facilityId,
        areaId: area.body.data.id,
        code: "W1",
        idempotencyKey: randomUUID(),
      });
    expect(unit.status, JSON.stringify(unit.body)).toBe(201);
    createFacilityUnit.response.parse(unit.body);
    expect(unit.body.data.status).toBe("available");
    const duplicateUnit = await client
      .post("/api/facility/units")
      .set(originHeader)
      .send({
        facilityId,
        areaId: area.body.data.id,
        code: "W1",
        idempotencyKey: randomUUID(),
      });
    expect(duplicateUnit.status).toBe(409);
    // An area of another facility is refused (not a silent re-parent).
    const wrongArea = await client
      .post("/api/facility/units")
      .set(originHeader)
      .send({
        facilityId,
        areaId: randomUUID(),
        code: "W2",
        idempotencyKey: randomUUID(),
      });
    expect(wrongArea.status).toBe(404);
    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' IN ('facility_area.created', 'facility_unit.created')
          AND event->>'objectId' = ANY($2)`,
      [tenant.id, [area.body.data.id, unit.body.data.id]],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it("updates the session length, which changes the slot grid (PUT /facilities/:id)", async () => {
    const { client } = await ownerClient();
    // The editor echoes the stamp it read (legend-6jms).
    const config = await client.get(
      `/api/facility/config?facilityId=${facilityId}`,
    );
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    const response = await client
      .put(`/api/facility/facilities/${facilityId}`)
      .set(originHeader)
      .send({
        sessionMinutes: 30,
        cleaningMinutes: 15,
        expectedUpdatedAt: config.body.data.facility.updatedAt,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.sessionMinutes).toBe(30);
    const availability = await client.get(availabilityPath());
    const [first, second] = availability.body.data.areas[0].units[0].slots;
    expect(Date.parse(second.startsAt) - Date.parse(first.startsAt)).toBe(
      45 * 60_000,
    );
    expect(
      (
        await client
          .put(`/api/facility/facilities/${facilityId}`)
          .set(originHeader)
          .send({ expectedUpdatedAt: response.body.data.updatedAt })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .put(`/api/facility/facilities/${facilityId}`)
          .set(originHeader)
          .send({
            sessionMinutes: 481,
            expectedUpdatedAt: response.body.data.updatedAt,
          })
      ).status,
    ).toBe(422);
  });
});

describe("Facility queue API", () => {
  it("[FAC-02] without a customer profile the queue fails closed (403)", async () => {
    setFacilityCustomerResolver(null);
    const { client } = await ownerClient();
    const response = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("CUSTOMER_PROFILE_REQUIRED");
  });

  it("[FAC-02] join, see own place, refuse a second place, leave", async () => {
    setFacilityCustomerResolver(async () => guestProfile);
    const { client } = await ownerClient();
    const joined = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    joinFacilityQueue.response.parse(joined.body);
    const second = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_QUEUED");
    const current = await client.get(
      `/api/facility/queue/current?facilityId=${facilityId}`,
    );
    expect(current.body.data.id).toBe(joined.body.data.id);
    const body = await client
      .post("/api/facility/queue")
      .set(originHeader)
      .send({ facilityId, areaId, customerProfileId: randomUUID() });
    expect(body.status).toBe(422);
    const left = await client
      .delete(`/api/facility/queue/${joined.body.data.id}`)
      .set(originHeader);
    expect(left.status).toBe(204);
    const after = await client.get(
      `/api/facility/queue/current?facilityId=${facilityId}`,
    );
    expect(after.body.data).toBeNull();
  });
});
