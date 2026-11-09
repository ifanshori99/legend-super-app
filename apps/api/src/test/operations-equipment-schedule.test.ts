// Completing a maintenance schedule advances next_due_at (WS-14 slice B,
// legend-o032; OPS-04, TEN-01, TEN-03). Runs the real Express app, Better Auth,
// the RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  completeMaintenanceSchedule,
  createEquipment,
  createMaintenanceSchedule,
} from "@starter/shared/operations";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const DAY_MS = 86_400_000;
const createdUsers: string[] = [];
const createdEquipmentIds: string[] = [];
const createdScheduleIds: string[] = [];

/** Idempotency keys are tenant-scoped; the prefix keeps cleanup targeted. */
const nextKey = () => `legend-o032-${randomUUID()}`;
const completePath = (id: string) =>
  `/api/operations/maintenance-schedules/${id}/complete`;

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
  const result = await signedIn("Schedule Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

/** A caller scoped to one outlet; `permissions` decides what the role allows. */
async function outletClient(outletId: string, permissions: string[]) {
  const result = await signedIn("Schedule Outlet Caller");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Schedule API test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.id, result.userId, roleId, outletId],
  );
  return result;
}

async function createSchedule(
  client: ReturnType<typeof agent>,
  intervalDays: number,
  nextDueAt: string,
) {
  const equipment = await client
    .post("/api/operations/equipment")
    .set(originHeader)
    .send({
      outletId: outletA.id,
      name: "Grinder Jadwal Uji",
      category: "other",
      idempotencyKey: nextKey(),
    });
  expect(equipment.status, JSON.stringify(equipment.body)).toBe(201);
  createEquipment.response.parse(equipment.body);
  const equipmentId = equipment.body.data.id as string;
  createdEquipmentIds.push(equipmentId);
  const created = await client
    .post("/api/operations/maintenance-schedules")
    .set(originHeader)
    .send({
      outletId: outletA.id,
      equipmentId,
      intervalDays,
      nextDueAt,
      idempotencyKey: nextKey(),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  createMaintenanceSchedule.response.parse(created.body);
  const id = created.body.data.id as string;
  createdScheduleIds.push(id);
  return id;
}

async function storedRow(id: string) {
  const result = await asTenant((db) =>
    db.query(
      `SELECT next_due_at, reminded_for_due_at FROM maintenance_schedules
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    ),
  );
  return result.rows[0] as {
    next_due_at: Date;
    reminded_for_due_at: Date | null;
  };
}

afterAll(async () => {
  await asTenant(async (client) => {
    if (createdScheduleIds.length > 0)
      await client.query(
        "DELETE FROM maintenance_schedules WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdScheduleIds],
      );
    if (createdEquipmentIds.length > 0) {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'equipment' AND aggregate_id = ANY($2::uuid[])",
        [tenant.id, createdEquipmentIds],
      );
      await client.query(
        "DELETE FROM equipment WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEquipmentIds],
      );
    }
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-o032-%'",
      [tenant.id],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Schedule API test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("Maintenance schedule completion API (legend-o032)", () => {
  it("[legend-o032][OPS-04] advances next_due_at by the interval from completion, keeps the reminder marker and audits", async () => {
    const { client } = await ownerClient();
    const id = await createSchedule(client, 30, "2030-01-01T00:00:00.000Z");
    const before = Date.now();
    const key = nextKey();
    const done = await client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: key });
    const after = Date.now();
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    completeMaintenanceSchedule.response.parse(done.body);
    const next = new Date(done.body.data.nextDueAt).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(next).toBeLessThanOrEqual(after + 30 * DAY_MS);
    expect(done.body.data.id).toBe(id);

    const row = await storedRow(id);
    expect(row.next_due_at.getTime()).toBe(next);
    // The marker is left alone so the next reminder fires for the new due date.
    expect(row.reminded_for_due_at).toBeNull();

    const audit = await asTenant((db) =>
      db.query(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'maintenance_schedule.completed'`,
        [tenant.id, id],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("[legend-o032][OPS-04] counts a past completedAt as the base and clamps a future one to now", async () => {
    const { client } = await ownerClient();
    const id = await createSchedule(client, 10, "2030-01-01T00:00:00.000Z");
    const before = Date.now();
    const future = await client.post(completePath(id)).set(originHeader).send({
      completedAt: "2099-06-01T00:00:00.000Z",
      idempotencyKey: nextKey(),
    });
    expect(future.status, JSON.stringify(future.body)).toBe(200);
    const futureDue = new Date(future.body.data.nextDueAt).getTime();
    expect(futureDue).toBeGreaterThanOrEqual(before + 10 * DAY_MS);
    expect(futureDue).toBeLessThanOrEqual(Date.now() + 10 * DAY_MS);

    const past = await client.post(completePath(id)).set(originHeader).send({
      completedAt: "2020-01-01T00:00:00.000Z",
      idempotencyKey: nextKey(),
    });
    expect(past.status, JSON.stringify(past.body)).toBe(200);
    expect(past.body.data.nextDueAt).toBe("2020-01-11T00:00:00.000Z");
  });

  it("[legend-o032] replays the same idempotency key without advancing twice", async () => {
    const { client } = await ownerClient();
    const id = await createSchedule(client, 7, "2030-01-01T00:00:00.000Z");
    const key = nextKey();
    const first = await client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: key });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.nextDueAt).toBe(first.body.data.nextDueAt);
    const audit = await asTenant((db) =>
      db.query(
        `SELECT 1 FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'maintenance_schedule.completed'`,
        [tenant.id, id],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("[legend-o032][TEN-03] refuses a caller without ops.equipment.maintain with 403", async () => {
    const { client } = await ownerClient();
    const id = await createSchedule(client, 30, "2030-01-01T00:00:00.000Z");
    const noPermission = await outletClient(outletA.id, [
      "ops.handover.record",
    ]);
    const denied = await noPermission.client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect((await storedRow(id)).next_due_at.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });

  it("[legend-o032][TEN-01][TEN-03] answers 404 for another outlet's or an unknown schedule and refuses an untrusted origin", async () => {
    const { client } = await ownerClient();
    const id = await createSchedule(client, 30, "2030-01-01T00:00:00.000Z");
    const outsider = await outletClient(outletB.id, ["ops.equipment.maintain"]);
    const crossOutlet = await outsider.client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(crossOutlet.status, JSON.stringify(crossOutlet.body)).toBe(404);
    expect(crossOutlet.body.error.code).toBe("NOT_FOUND");

    const unknown = await client
      .post(completePath(randomUUID()))
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(unknown.status).toBe(404);

    const untrusted = await client
      .post(completePath(id))
      .set("Origin", "https://evil.example")
      .send({ idempotencyKey: nextKey() });
    expect(untrusted.status).toBe(403);

    const unknownField = await client
      .post(completePath(id))
      .set(originHeader)
      .send({ idempotencyKey: nextKey(), tenantId: tenant.id });
    expect(unknownField.status).toBe(422);
    expect((await storedRow(id)).next_due_at.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });
});
