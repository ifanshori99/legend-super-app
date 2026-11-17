// Facility incident raise/respond (PRD v1.7 §25, FAC-08; TEN-01..03; bead
// legend-1cj0). Runs the real Express app, Better Auth, the RBAC resolver and
// PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import {
  raiseFacilityIncident,
  respondFacilityIncident,
} from "@starter/shared/facility";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
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
const facilityBId = randomUUID();
const areaBId = randomUUID();
const unitBId = randomUUID();

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
  const result = await signedIn("Incident Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

async function outletClient(outletId: string) {
  const result = await signedIn("Incident Outlet B");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Facility incident test ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.booth.operate"]),
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
       VALUES ($1, $2, $3, 'Incident API', 'shower', 20, 10, 10, $4, $5, $6)`,
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
       VALUES ($1, $2, $3, $4, 'Area Insiden', 0)`,
      [areaId, tenant.id, outletA.id, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'I1', 'available', 0)`,
      [unitId, tenant.id, outletA.id, facilityId, areaId],
    );
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       SELECT $1, tenant_id, $2, 'Incident API B', type, session_minutes, cleaning_minutes,
              arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy
         FROM facilities WHERE tenant_id = $3 AND id = $4`,
      [facilityBId, outletB.id, tenant.id, facilityId],
    );
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Insiden B', 0)`,
      [areaBId, tenant.id, outletB.id, facilityBId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'I1', 'available', 0)`,
      [unitBId, tenant.id, outletB.id, facilityBId, areaBId],
    );
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND result_table = 'facility_incidents'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'facility_incident' AND outlet_id = $2",
      [tenant.id, outletA.id],
    );
    for (const table of [
      "facility_operating_hours_versions",
      "facility_incidents",
      "facility_units",
      "facility_areas",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
        [tenant.id, facilityId],
      );
    for (const table of [
      "facility_operating_hours_versions",
      "facility_incidents",
      "facility_units",
      "facility_areas",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
        [tenant.id, facilityBId],
      );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, [facilityId, facilityBId]],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Facility incident test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("Facility incidents API authorization and isolation", () => {
  it("[TEN-01] answers 401 to anonymous requests", async () => {
    const anonymous = agent(app);
    expect(
      (
        await anonymous
          .post("/api/facility/incidents")
          .set(originHeader)
          .send({ unitId, type: "panic" })
      ).status,
    ).toBe(401);
    expect(
      (
        await anonymous
          .post(`/api/facility/incidents/${randomUUID()}/respond`)
          .set(originHeader)
          .send({ resolution: "Ditangani" })
      ).status,
    ).toBe(401);
  });

  it("[TEN-03] a signed-in user without facility permissions gets 403", async () => {
    const { client } = await signedIn("Incident Nobody");
    expect(
      (
        await client
          .post("/api/facility/incidents")
          .set(originHeader)
          .send({ unitId, type: "panic" })
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .post(`/api/facility/incidents/${randomUUID()}/respond`)
          .set(originHeader)
          .send({ resolution: "Ditangani" })
      ).status,
    ).toBe(403);
  });

  it("[TEN-02] a write from an untrusted origin is refused", async () => {
    const { client } = await ownerClient();
    const response = await client
      .post("/api/facility/incidents")
      .set("Origin", "https://evil.example")
      .send({ unitId, type: "panic" });
    expect(response.status).toBe(403);
  });

  it("[TEN-03] an actor who only holds outlet B cannot raise or answer outlet A", async () => {
    const owned = await ownerClient();
    const raised = await owned.client
      .post("/api/facility/incidents")
      .set(originHeader)
      .send({ unitId, type: "assist" });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const { client } = await outletClient(outletB.id);
    expect(
      (
        await client
          .post("/api/facility/incidents")
          .set(originHeader)
          .send({ unitId, type: "panic" })
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .post(`/api/facility/incidents/${raised.body.data.id}/respond`)
          .set(originHeader)
          .send({ resolution: "Lintas outlet" })
      ).status,
    ).toBe(404);
    const stored = await owner.query(
      "SELECT responded_at FROM facility_incidents WHERE id = $1",
      [raised.body.data.id],
    );
    expect(stored.rows[0].responded_at).toBeNull();
  });
});

describe("Raise and respond to a facility incident (FAC-08)", () => {
  it("raises an incident in the contract shape and writes an audit entry", async () => {
    const { client, userId } = await ownerClient();
    const response = await client
      .post("/api/facility/incidents")
      .set(originHeader)
      .send({ unitId, type: "panic", note: "Tombol darurat ditekan" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    raiseFacilityIncident.response.parse(response.body);
    expect(response.body.data).toMatchObject({
      facilityId,
      unitId,
      type: "panic",
      offline: false,
      respondedAt: null,
      resolution: null,
    });
    expect(response.headers.location).toBe(
      `/api/facility/incidents/${response.body.data.id}`,
    );
    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'facility_incident.raise'
          AND event->>'objectId' = $2 AND event->>'actorId' = $3`,
      [tenant.id, response.body.data.id, userId],
    );
    expect(audit.rows[0].n).toBe(1);
    // legend-5rgl: the event is in the outbox, written with the incident.
    const outbox = await owner.query(
      `SELECT event, destination FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'facility_incident'
          AND aggregate_id = $2
        ORDER BY destination`,
      [tenant.id, response.body.data.id],
    );
    // Both destinations: cloud-sync, and notification for the worker rule.
    expect(outbox.rows.map((r) => r.destination)).toEqual([
      "cloud-sync",
      "notification",
    ]);
    expect(outbox.rows[0].event).toMatchObject({
      name: "facility_incident.raised",
      outletId: outletA.id,
      actor: { type: "user", id: userId },
      payload: {
        incidentId: response.body.data.id,
        facilityId,
        unitId,
        type: "panic",
        offline: false,
      },
    });
    // The contract note and no PII leave in the payload.
    expect(JSON.stringify(outbox.rows[0].event)).not.toContain(
      "Tombol darurat ditekan",
    );
  });

  it("rejects a body without unit or ticket, unknown fields, and unknown records", async () => {
    const { client } = await ownerClient();
    const post = (body: object) =>
      client.post("/api/facility/incidents").set(originHeader).send(body);
    expect((await post({ type: "panic" })).status).toBe(422);
    expect((await post({ unitId, type: "fire" })).status).toBe(422);
    expect(
      (await post({ unitId, type: "panic", tenantId: tenant.id })).status,
    ).toBe(422);
    expect((await post({ unitId: randomUUID(), type: "panic" })).status).toBe(
      404,
    );
    expect(
      (await post({ accessTicketId: createUlid(), type: "damage" })).status,
    ).toBe(404);
  });

  it("an Idempotency-Key replay returns the first incident; another payload under the key is 409", async () => {
    const { client } = await ownerClient();
    const key = `incident-${randomUUID()}`;
    const send = (type: string) =>
      client
        .post("/api/facility/incidents")
        .set(originHeader)
        .set("Idempotency-Key", key)
        .send({ unitId, type });
    const first = await send("damage");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await send("damage");
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const reused = await send("panic");
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const count = await owner.query(
      "SELECT count(*)::int AS n FROM facility_incidents WHERE tenant_id = $1 AND id = $2",
      [tenant.id, first.body.data.id],
    );
    expect(count.rows[0].n).toBe(1);
    // legend-5rgl: the replay did not publish a second event.
    const events = await owner.query(
      `SELECT count(*)::int AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'facility_incident'
          AND aggregate_id = $2`,
      [tenant.id, first.body.data.id],
    );
    expect(events.rows[0].n).toBe(2);
    const destinations = await owner.query(
      `SELECT destination, count(*)::int AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'facility_incident'
          AND aggregate_id = $2
        GROUP BY destination ORDER BY destination`,
      [tenant.id, first.body.data.id],
    );
    expect(destinations.rows).toEqual([
      { destination: "cloud-sync", n: 1 },
      { destination: "notification", n: 1 },
    ]);
    expect(
      (
        await client
          .post("/api/facility/incidents")
          .set(originHeader)
          .set("Idempotency-Key", "short")
          .send({ unitId, type: "panic" })
      ).status,
    ).toBe(422);
  });

  it("[TEN-03] one Idempotency-Key used on outlet A then outlet B is a 409 conflict, not a 500", async () => {
    const { client: clientA } = await outletClient(outletA.id);
    const { client: clientB } = await outletClient(outletB.id);
    const key = `incident-${randomUUID()}`;
    const send = (client: typeof clientA, unit: string) =>
      client
        .post("/api/facility/incidents")
        .set(originHeader)
        .set("Idempotency-Key", key)
        .send({ unitId: unit, type: "damage" });
    const first = await send(clientA, unitId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Outlet RLS hides outlet A's key from outlet B's lookup.
    const other = await send(clientB, unitBId);
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const rows = await owner.query(
      "SELECT 1 FROM facility_incidents WHERE tenant_id = $1 AND facility_id = $2",
      [tenant.id, facilityBId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("responds once; the same answer replays, another answer is 409", async () => {
    const { client, userId } = await ownerClient();
    const raised = await client
      .post("/api/facility/incidents")
      .set(originHeader)
      .send({ unitId, type: "assist" });
    const path = `/api/facility/incidents/${raised.body.data.id}/respond`;
    const answer = (resolution: string) =>
      client.post(path).set(originHeader).send({ resolution });
    expect((await answer("ab")).status).toBe(422);
    const first = await answer("Petugas sudah membantu tamu");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    respondFacilityIncident.response.parse(first.body);
    expect(first.body.data).toMatchObject({
      id: raised.body.data.id,
      respondedBy: userId,
      resolution: "Petugas sudah membantu tamu",
    });
    expect(first.body.data.respondedAt).not.toBeNull();
    const replay = await answer("Petugas sudah membantu tamu");
    expect(replay.status).toBe(200);
    expect(replay.body.data.respondedAt).toBe(first.body.data.respondedAt);
    const other = await answer("Jawaban lain");
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("INCIDENT_ALREADY_RESPONDED");
    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'facility_incident.respond'
          AND event->>'objectId' = $2`,
      [tenant.id, raised.body.data.id],
    );
    expect(audit.rows[0].n).toBe(1);
    expect(
      (
        await client
          .post(`/api/facility/incidents/${randomUUID()}/respond`)
          .set(originHeader)
          .send({ resolution: "Tidak ada" })
      ).status,
    ).toBe(404);
  });
});
