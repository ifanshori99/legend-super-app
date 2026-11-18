// Unit config stale-check and area-move guard (PRD v1.7 §3 F22/F25; FAC-02,
// FAC-03; TEN-01..03; WS-09 F2): a status transition leaves the config stamp
// alone, and a unit with an active ticket cannot move to another area.
// Runs the real Express app, Better Auth, the RBAC resolver and PostgreSQL
// against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA] = cafeLegendPlatformFixtures.outlets;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const facilityId = randomUUID();
const key = () => `facility-unit-guard-${randomUUID()}`;

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

async function ownerClient() {
  const client = agent(app);
  await signUp(client, "Facility Unit Guard Owner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, userId],
  );
  return client;
}

beforeAll(async () => {
  await asTenant((client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Fasilitas Unit Guard', 'shower', 20, 10, 10, $4, $5, $6)`,
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
    ),
  );
});

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of ["access_tickets", "facility_units", "facility_areas"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
        [tenant.id, facilityId],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'facility-unit-guard-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM facility_operating_hours_versions WHERE tenant_id = $1 AND facility_id = $2",
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
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

async function seedUnit(client: ReturnType<typeof agent>, code: string) {
  const area = async (name: string) => {
    const response = await client
      .post("/api/facility/areas")
      .set(originHeader)
      .send({ facilityId, name, idempotencyKey: key() });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  };
  const areaId = await area(`Area ${code}`);
  const otherAreaId = await area(`Area lain ${code}`);
  const unit = await client
    .post("/api/facility/units")
    .set(originHeader)
    .send({ facilityId, areaId, code, idempotencyKey: key() });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  return {
    unitId: unit.body.data.id as string,
    areaId,
    otherAreaId,
    stamp: unit.body.data.updatedAt as string,
  };
}

async function insertTicket(unitId: string, areaId: string, status: string) {
  await asTenant((client) =>
    client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', now() + interval '1 day',
               now() + interval '1 day 20 minutes', now() + interval '1 day 30 minutes', 10, $9)`,
      [
        randomUUID(),
        tenant.id,
        outletA.id,
        facilityId,
        areaId,
        unitId,
        randomUUID(),
        randomUUID(),
        status,
      ],
    ),
  );
}

describe("Unit config guard (WS-09 F2)", () => {
  it("[FAC-02] a status change does not move the config stamp", async () => {
    const client = await ownerClient();
    const seed = await seedUnit(client, "G1");
    const flagged = await client
      .patch(`/api/facility/units/${seed.unitId}`)
      .set(originHeader)
      .send({ action: "flag_maintenance" });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);
    expect(flagged.body.data.status).toBe("maintenance");
    expect(flagged.body.data.updatedAt).toBe(seed.stamp);
    const edited = await client
      .patch(`/api/facility/units/${seed.unitId}/config`)
      .set(originHeader)
      .send({ code: "G1b", expectedUpdatedAt: seed.stamp });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.code).toBe("G1b");
    expect(edited.body.data.status).toBe("maintenance");
  });

  it("[FAC-03] refuses an area move while the unit has an active ticket", async () => {
    const client = await ownerClient();
    for (const status of ["pending_payment", "issued", "in_use"]) {
      const seed = await seedUnit(client, `G-${status.slice(0, 4)}`);
      await insertTicket(seed.unitId, seed.areaId, status);
      const moved = await client
        .patch(`/api/facility/units/${seed.unitId}/config`)
        .set(originHeader)
        .send({ areaId: seed.otherAreaId, expectedUpdatedAt: seed.stamp });
      expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(
        409,
      );
      expect(moved.body.error.code).toBe("CONFLICT");
      // A rename of the same unit (no area change) is still allowed.
      const renamed = await client
        .patch(`/api/facility/units/${seed.unitId}/config`)
        .set(originHeader)
        .send({
          code: `R-${status.slice(0, 4)}`,
          expectedUpdatedAt: seed.stamp,
        });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    }
  });

  it("[FAC-03] allows the move with no active ticket and audits the device ids", async () => {
    const client = await ownerClient();
    const seed = await seedUnit(client, "G3");
    // A finished ticket does not block the move.
    await insertTicket(seed.unitId, seed.areaId, "completed");
    const lockDeviceId = randomUUID();
    const panicDeviceId = randomUUID();
    const moved = await client
      .patch(`/api/facility/units/${seed.unitId}/config`)
      .set(originHeader)
      .send({
        areaId: seed.otherAreaId,
        lockDeviceId,
        panicDeviceId,
        expectedUpdatedAt: seed.stamp,
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.areaId).toBe(seed.otherAreaId);
    const { rows } = await owner.query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      `SELECT event->'maskedChanges'->'before' AS before,
              event->'maskedChanges'->'after' AS after
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'facility_unit.config_updated'`,
      [tenant.id, seed.unitId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({
      lockDeviceId: null,
      panicDeviceId: null,
    });
    // The audit masker redacts device identifiers: the keys are recorded, the
    // values are not leaked.
    expect(rows[0].after).toMatchObject({
      lockDeviceId: "[REDACTED]",
      panicDeviceId: "[REDACTED]",
    });
    expect(JSON.stringify(rows[0])).not.toContain(lockDeviceId);
  });
});
