// Cross-tenant and cross-outlet isolation for the six attendance tables (bead
// legend-wh71; PRD v1.7 TEN-01, TEN-02, TEN-03, F25). Tenant A is the seeded
// Cafe Legend tenant, tenant B a throwaway tenant (tenant-isolation-harness).
// Per table: RLS as the restricted legend_app login; per outlet-scoped table:
// the outlet backstop; plus authenticated HTTP requests through the contract
// endpoints (list, review, rotate), so nothing depends on service names.
//
// Assumptions (from docs/PRD.md and the team brief, not from implementation):
// - A foreign id or foreign filter answers 403 or 404 (never 5xx, never data);
//   a list filtered by a foreign employee/outlet may answer 200 with an empty
//   page. Tests assert "no foreign row appears" plus a status in that set.
// - An employee with only self.attendance.clock reads only their own logs and
//   devices (access.own); a filter on a colleague returns nothing of theirs.
// - Permission hr.attendance.manage at an outlet scope reaches that outlet's
//   logs only; at tenant scope it reaches every outlet of the tenant.
// - Outlet-RLS tables are logs, corrections, qr secrets and duty meals;
//   policies (nullable outlet) and devices (employee-owned) have tenant RLS
//   only, as stated in the migration notes.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const app = createApp();
const outletBaseId = cafeLegendPlatformFixtures.outlets[0].id;
const owner: Pool = createOwnerPool();
const appPool: Pool = createAppPool();
const unique = () => randomBytes(4).toString("hex");

type Client = ReturnType<typeof agent>;
interface Actor {
  client: Client;
  userId: string;
}
interface Fixture {
  tenantId: string;
  outletId: string;
  employeeId: string;
  logId: string; // uuid form of the ULID
  logUlid: string;
  flaggedLogUlid: string;
  deviceId: string;
  correctionId: string;
  policyId: string;
  qrId: string;
  mealId: string;
}

let tenantB: SecondTenant;
let tenantBHost: string; // Host header that resolves to tenant B
let outletA2: string;
let outletA3: string;
let employeeA2: string; // tenant A, outlet A2
let employeeA3: string; // tenant A, outlet A3
let employeeSelf: string; // tenant A, outlet A2, linked to the self user
let fixA2: Fixture; // tenant A, outlet A2
let fixA3: Fixture; // tenant A, outlet A3
let fixB: Fixture; // tenant B
let selfLogUlid: string;
let colleagueLogUlid: string;
let managerA: Actor; // tenant-wide hr.attendance.manage
let managerB: Actor;
let managerOutletA2: Actor; // hr.attendance.manage at outlet A2 only
let selfActor: Actor; // self.attendance.clock only

const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdOutlets: string[] = [];
const createdEmployees: { tenantId: string; id: string }[] = [];

/** Owner connection with the tenant GUCs set, so fixtures pass forced RLS. */
async function ownerTx<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedIn(name: string): Promise<Actor> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  outletScope?: string,
) {
  const roleId = randomUUID();
  createdRoles.push({ tenantId, id: roleId });
  await ownerTx(tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Isolasi absensi ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant", "outlet"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        userId,
        roleId,
        outletScope ? "outlet" : "tenant",
        outletScope ?? null,
      ],
    );
  });
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet absensi isolasi', address, opening_hours
       FROM outlets WHERE id = $2`,
    [id, outletBaseId, `ATT-${unique()}`.toUpperCase()],
  );
  return id;
}

async function seedEmployee(
  tenantId: string,
  outletId: string,
  userId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  createdEmployees.push({ tenantId, id });
  await ownerTx(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenantId, userId, `0000ATT${unique().toUpperCase()}`, outletId],
    ),
  );
  return id;
}

async function seedLog(
  tenantId: string,
  outletId: string,
  employeeId: string,
  options: { flagged?: boolean } = {},
): Promise<{ ulid: string; id: string }> {
  const ulid = createUlid();
  const id = ulidToUuid(ulid);
  const flagged = options.flagged ?? false;
  await ownerTx(tenantId, (client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 15, $5, $6, '2041-06-10', $7, $8)`,
      [
        id,
        tenantId,
        outletId,
        employeeId,
        flagged ? "flagged" : "valid",
        JSON.stringify(flagged ? ["outside_geofence"] : []),
        createUlid(),
        flagged ? "pending" : "none",
      ],
    ),
  );
  return { ulid, id };
}

/** One row in every attendance table for one tenant/outlet/employee. */
async function seedFixture(
  tenantId: string,
  outletId: string,
  employeeId: string,
  options: { policyOutletId: string | null },
): Promise<Fixture> {
  const log = await seedLog(tenantId, outletId, employeeId);
  const flagged = await seedLog(tenantId, outletId, employeeId, {
    flagged: true,
  });
  const deviceId = randomUUID();
  const correctionId = randomUUID();
  const policyId = randomUUID();
  const qrId = randomUUID();
  const mealId = randomUUID();
  await ownerTx(tenantId, async (client) => {
    await client.query(
      `INSERT INTO attendance_devices (id, tenant_id, employee_id, device_id_hash, label)
       VALUES ($1, $2, $3, $4, 'Ponsel isolasi')`,
      [deviceId, tenantId, employeeId, randomBytes(32).toString("hex")],
    );
    await client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'Lupa absen pulang', $5, $6)`,
      [
        correctionId,
        tenantId,
        outletId,
        employeeId,
        randomUUID(),
        `att-iso-${randomUUID()}`,
      ],
    );
    await client.query(
      `INSERT INTO attendance_policies (id, tenant_id, outlet_id, policy, sampling, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'attendance-isolation-test')`,
      [
        policyId,
        tenantId,
        options.policyOutletId,
        JSON.stringify({
          geofenceRadiusM: 100,
          outsideGeofenceAction: "flag",
          unboundDeviceAction: "flag",
          requireSelfie: true,
          requireDeviceBinding: false,
          allowRotatingQr: true,
          selfieRetentionDays: 90,
        }),
        JSON.stringify({
          rate: 0.1,
          flaggedAlways: true,
          minPerSupervisorPerWeek: 0,
        }),
      ],
    );
    await client.query(
      `INSERT INTO attendance_qr_secrets (id, tenant_id, outlet_id, seed)
       VALUES ($1, $2, $3, $4)`,
      [qrId, tenantId, outletId, randomBytes(32)],
    );
    await client.query(
      `INSERT INTO attendance_duty_meals
         (id, tenant_id, outlet_id, employee_id, business_date, meal_count, recorded_by, idempotency_key)
       VALUES ($1, $2, $3, $4, '2041-06-10', 1, $5, $6)`,
      [
        mealId,
        tenantId,
        outletId,
        employeeId,
        randomUUID(),
        `att-iso-${randomUUID()}`,
      ],
    );
  });
  return {
    tenantId,
    outletId,
    employeeId,
    logId: log.id,
    logUlid: log.ulid,
    flaggedLogUlid: flagged.ulid,
    deviceId,
    correctionId,
    policyId,
    qrId,
    mealId,
  };
}

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "attiso");
  // The API resolves the tenant from the Host header, so tenant B's manager
  // needs a verified domain of its own.
  tenantBHost = `tenant-${randomUUID().slice(0, 8)}.legend.test`;
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantB.tenantId, tenantB.brandId, tenantBHost],
  );
  outletA2 = await seedOutlet();
  outletA3 = await seedOutlet();

  managerA = await signedIn("Absensi Manajer A");
  managerB = await signedIn("Absensi Manajer B");
  managerOutletA2 = await signedIn("Absensi Manajer Outlet");
  selfActor = await signedIn("Absensi Karyawan");

  employeeA2 = await seedEmployee(tenantAId, outletA2);
  employeeA3 = await seedEmployee(tenantAId, outletA3);
  employeeSelf = await seedEmployee(tenantAId, outletA2, selfActor.userId);
  // An outlet-scoped supervisor reviews only direct reports (manager_id).
  const supervisorEmployee = await seedEmployee(
    tenantAId,
    outletA2,
    managerOutletA2.userId,
  );
  await ownerTx(tenantAId, (client) =>
    client.query(
      "UPDATE employees SET manager_id = $1 WHERE tenant_id = $2 AND id = $3",
      [supervisorEmployee, tenantAId, employeeA2],
    ),
  );
  const employeeB = await seedEmployee(tenantB.tenantId, tenantB.outletId);

  fixA2 = await seedFixture(tenantAId, outletA2, employeeA2, {
    policyOutletId: outletA2,
  });
  fixA3 = await seedFixture(tenantAId, outletA3, employeeA3, {
    policyOutletId: outletA3,
  });
  fixB = await seedFixture(tenantB.tenantId, tenantB.outletId, employeeB, {
    policyOutletId: null,
  });
  selfLogUlid = (await seedLog(tenantAId, outletA2, employeeSelf)).ulid;
  colleagueLogUlid = (await seedLog(tenantAId, outletA2, employeeA2)).ulid;

  const managePermissions = [
    "hr.attendance.manage",
    "hr.attendance_correction.approve",
  ];
  await grantRole(tenantAId, managerA.userId, managePermissions);
  await grantRole(tenantB.tenantId, managerB.userId, managePermissions);
  await grantRole(
    tenantAId,
    managerOutletA2.userId,
    managePermissions,
    outletA2,
  );
  await grantRole(tenantAId, selfActor.userId, ["self.attendance.clock"]);
}, 90_000);

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    // Rows are removed by the outlets and employees this file created (and
    // all of tenant B), never wholesale in tenant A, so parallel suites keep
    // their rows. Replica mode lets the owner clear audit and guarded rows.
    const employeeIds = createdEmployees.map((employee) => employee.id);
    const outletIds = [...createdOutlets, tenantB?.outletId ?? randomUUID()];
    const tenantIds = [tenantAId, tenantB?.tenantId].filter(
      (id): id is string => Boolean(id),
    );
    for (const tenantId of tenantIds)
      await step(() =>
        ownerTx(
          tenantId,
          async (client) => {
            const args = [tenantId, outletIds, employeeIds];
            for (const table of [
              "attendance_logs",
              "attendance_corrections",
              "attendance_duty_meals",
              "attendance_qr_secrets",
              "attendance_policies",
            ])
              await client.query(
                `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
                args.slice(0, 2),
              );
            // Tenant default policies (outlet_id NULL) belong to no outlet.
            if (tenantId === tenantB?.tenantId)
              await client.query(
                "DELETE FROM attendance_policies WHERE tenant_id = $1",
                [tenantId],
              );
            await client.query(
              "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
              [tenantId, employeeIds],
            );
            // Mutating routes write audit rows naming the fixtures.
            await client.query(
              `DELETE FROM audit_logs
                WHERE tenant_id = $1 AND (outlet_id = ANY($2::uuid[])
                   OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS e(id)
                               WHERE audit_logs.event::text LIKE '%' || e.id || '%'))`,
              args,
            );
            await client.query(
              "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-iso-%'",
              [tenantId],
            );
          },
          { replica: true },
        ),
      );
    for (const employee of createdEmployees)
      await step(() =>
        ownerTx(employee.tenantId, (client) =>
          client.query(
            "DELETE FROM employees WHERE tenant_id = $1 AND id = $2",
            [employee.tenantId, employee.id],
          ),
        ),
      );
    for (const role of createdRoles)
      await step(() =>
        ownerTx(role.tenantId, async (client) => {
          await client.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
            [role.tenantId, role.id],
          );
          await client.query(
            "DELETE FROM roles WHERE tenant_id = $1 AND id = $2",
            [role.tenantId, role.id],
          );
        }),
      );
    for (const outletId of createdOutlets)
      await step(() =>
        owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
          tenantAId,
          outletId,
        ]),
      );
    if (tenantB)
      await step(() =>
        owner.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
          tenantB.tenantId,
        ]),
      );
    if (tenantB) await step(() => removeSecondTenant(owner, tenantB));
    if (createdUsers.length > 0)
      await step(() =>
        owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]),
      );
  } finally {
    await step(() => owner.end());
    await step(() => appPool.end());
  }
  if (errors.length > 0) throw errors[0];
}, 90_000);

/** Ids of every page row; follows cursors so a late foreign row cannot hide. */
async function listAll(
  client: Client,
  path: string,
  pick: (row: Record<string, unknown>) => string,
  host?: string,
): Promise<{ status: number; ids: string[] }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const request = client.get(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const response: Awaited<typeof request> = await (host
      ? request.set("Host", host)
      : request);
    if (response.status !== 200) return { status: response.status, ids };
    ids.push(...(response.body.data as Record<string, unknown>[]).map(pick));
    cursor = (response.body.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return { status: 200, ids };
}

const logId = (row: Record<string, unknown>) => String(row.id).toUpperCase();
const plainId = (row: Record<string, unknown>) => String(row.id);
const reviewLogId = (row: Record<string, unknown>) =>
  String((row.log as { id: string }).id).toUpperCase();

describe("attendance tables: tenant isolation as legend_app (TEN-01, TEN-02)", () => {
  const cases: {
    table: string;
    updateSet: string;
    pick: (f: Fixture) => string;
  }[] = [
    {
      table: "attendance_logs",
      updateSet: "review_status = review_status",
      pick: (f) => f.logId,
    },
    {
      table: "attendance_devices",
      updateSet: "label = label",
      pick: (f) => f.deviceId,
    },
    {
      table: "attendance_corrections",
      updateSet: "reason = reason",
      pick: (f) => f.correctionId,
    },
    {
      table: "attendance_policies",
      updateSet: "updated_by = updated_by",
      pick: (f) => f.policyId,
    },
    {
      table: "attendance_qr_secrets",
      updateSet: "created_at = created_at",
      pick: (f) => f.qrId,
    },
    {
      table: "attendance_duty_meals",
      updateSet: "meal_count = meal_count",
      pick: (f) => f.mealId,
    },
  ];

  it.each(cases)(
    "$table: each tenant reads, updates and deletes only its own row",
    async ({ table, updateSet, pick }) => {
      await expectRowsIsolated(
        appPool,
        {
          table,
          updateSet,
          tenantA: { tenantId: tenantAId, rowId: pick(fixA2) },
          tenantB: { tenantId: tenantB.tenantId, rowId: pick(fixB) },
        },
        owner,
      );
    },
  );

  it("a tenant cannot write a row that names another tenant", async () => {
    await asTenant(appPool, tenantAId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO attendance_duty_meals
             (tenant_id, outlet_id, employee_id, business_date, meal_count, recorded_by, idempotency_key)
           VALUES ($1, $2, $3, '2041-06-11', 1, $4, $5)`,
          [
            tenantB.tenantId,
            tenantB.outletId,
            fixB.employeeId,
            randomUUID(),
            `att-iso-${randomUUID()}`,
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});

describe("attendance tables: outlet isolation as legend_app (TEN-03)", () => {
  const outletTables: { table: string; pick: (f: Fixture) => string }[] = [
    { table: "attendance_logs", pick: (f) => f.logId },
    { table: "attendance_corrections", pick: (f) => f.correctionId },
    { table: "attendance_qr_secrets", pick: (f) => f.qrId },
    { table: "attendance_duty_meals", pick: (f) => f.mealId },
  ];

  it.each(outletTables)(
    "$table: a session scoped to outlet A2 sees and changes only outlet A2",
    async ({ table, pick }) => {
      const both = [pick(fixA2), pick(fixA3)];
      // Positive control: the tenant-wide session sees both outlets' rows.
      await asTenant(appPool, tenantAId, async (client) => {
        const seen = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM ${table} WHERE id = ANY($1::uuid[])`,
          [both],
        );
        expect(seen.rows.map((row) => row.id).sort()).toEqual([...both].sort());
      });
      await asTenant(
        appPool,
        tenantAId,
        async (client) => {
          const seen = await client.query<{ id: string }>(
            `SELECT id::text AS id FROM ${table} WHERE id = ANY($1::uuid[])`,
            [both],
          );
          expect(seen.rows.map((row) => row.id)).toEqual([pick(fixA2)]);
          const deleted = await client.query(
            `DELETE FROM ${table} WHERE id = $1`,
            [pick(fixA3)],
          );
          expect(deleted.rowCount).toBe(0);
        },
        [outletA2],
      );
    },
  );

  it("an outlet A2 session cannot write an attendance log into outlet A3", async () => {
    await asTenant(
      appPool,
      tenantAId,
      async (client) => {
        await expect(
          client.query(
            `INSERT INTO attendance_logs
               (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
                validity, business_date, client_event_id)
             VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 'valid', '2041-06-12', $5)`,
            [
              ulidToUuid(createUlid()),
              tenantAId,
              outletA3,
              employeeA3,
              createUlid(),
            ],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      },
      [outletA2],
    );
  });
});

describe("attendance HTTP: tenant isolation (TEN-01)", () => {
  it("lists only the actor tenant's logs", async () => {
    const a = await listAll(
      managerA.client,
      "/api/hris/attendance/logs",
      logId,
    );
    expect(a.status).toBe(200);
    expect(a.ids).toContain(fixA2.logUlid);
    expect(a.ids).toContain(fixA3.logUlid);
    expect(a.ids).not.toContain(fixB.logUlid);

    const b = await listAll(
      managerB.client,
      "/api/hris/attendance/logs",
      logId,
      tenantBHost,
    );
    expect(b.status).toBe(200);
    expect(b.ids).toContain(fixB.logUlid);
    expect(b.ids).not.toContain(fixA2.logUlid);
    expect(b.ids).not.toContain(fixA3.logUlid);
  });

  it("a foreign employee or outlet filter never returns another tenant's logs", async () => {
    const byEmployee = await listAll(
      managerA.client,
      `/api/hris/attendance/logs?employeeId=${fixB.employeeId}`,
      logId,
    );
    expect([200, 403, 404]).toContain(byEmployee.status);
    expect(byEmployee.ids).toEqual([]);
    const byOutlet = await listAll(
      managerA.client,
      `/api/hris/attendance/logs?outletId=${tenantB.outletId}`,
      logId,
    );
    expect([200, 403, 404]).toContain(byOutlet.status);
    expect(byOutlet.ids).toEqual([]);
  });

  it("lists only the actor tenant's devices, corrections, duty meals and review queue", async () => {
    const devices = await listAll(
      managerA.client,
      "/api/hris/attendance/devices",
      plainId,
    );
    expect(devices.status).toBe(200);
    expect(devices.ids).toContain(fixA2.deviceId);
    expect(devices.ids).not.toContain(fixB.deviceId);

    const corrections = await listAll(
      managerA.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect(corrections.status).toBe(200);
    expect(corrections.ids).toContain(fixA2.correctionId);
    expect(corrections.ids).not.toContain(fixB.correctionId);

    const meals = await listAll(
      managerA.client,
      "/api/hris/attendance/duty-meals",
      plainId,
    );
    expect(meals.status).toBe(200);
    expect(meals.ids).toContain(fixA2.mealId);
    expect(meals.ids).not.toContain(fixB.mealId);

    const queue = await listAll(
      managerA.client,
      "/api/hris/attendance/review-queue",
      reviewLogId,
    );
    expect(queue.status).toBe(200);
    expect(queue.ids).toContain(fixA2.flaggedLogUlid);
    expect(queue.ids).not.toContain(fixB.flaggedLogUlid);
    const queueB = await listAll(
      managerB.client,
      "/api/hris/attendance/review-queue",
      reviewLogId,
      tenantBHost,
    );
    expect(queueB.ids).toContain(fixB.flaggedLogUlid);
    expect(queueB.ids).not.toContain(fixA2.flaggedLogUlid);
  });

  // legend-t3h6e: the review queue takes a `logId` filter (server side), so the
  // case-detail screen no longer pages every log to find one.
  // Assumptions (the bead gives the name only): query param `logId` is the
  // public ULID of one attendance log; the result is that single item or an
  // empty page; scope is unchanged (a log outside the caller's tenant or outlet
  // never appears, status 200 empty or 403/404). Runs before the review tests
  // below, which flip the review status of the fixtures.
  it("[t3h6e] the review queue filtered by logId returns only that log", async () => {
    const a2 = await listAll(
      managerA.client,
      `/api/hris/attendance/review-queue?logId=${fixA2.flaggedLogUlid}`,
      reviewLogId,
    );
    expect(a2.status).toBe(200);
    expect(a2.ids).toEqual([fixA2.flaggedLogUlid]);

    const a3 = await listAll(
      managerA.client,
      `/api/hris/attendance/review-queue?logId=${fixA3.flaggedLogUlid}`,
      reviewLogId,
    );
    expect(a3.status).toBe(200);
    expect(a3.ids).toEqual([fixA3.flaggedLogUlid]);

    // Without the filter both are in the queue, so the filter is what narrows it.
    const all = await listAll(
      managerA.client,
      "/api/hris/attendance/review-queue",
      reviewLogId,
    );
    expect(all.ids).toEqual(
      expect.arrayContaining([fixA2.flaggedLogUlid, fixA3.flaggedLogUlid]),
    );
  });

  it("[t3h6e] a logId that does not exist gives an empty page, and a malformed logId is refused", async () => {
    const unknown = await listAll(
      managerA.client,
      `/api/hris/attendance/review-queue?logId=${createUlid()}`,
      reviewLogId,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.ids).toEqual([]);

    const malformed = await managerA.client.get(
      "/api/hris/attendance/review-queue?logId=not-a-ulid",
    );
    expect([400, 422]).toContain(malformed.status);
  });

  it("[t3h6e] a logId of another tenant never leaks, in either direction", async () => {
    const aAsksB = await listAll(
      managerA.client,
      `/api/hris/attendance/review-queue?logId=${fixB.flaggedLogUlid}`,
      reviewLogId,
    );
    expect([200, 403, 404]).toContain(aAsksB.status);
    expect(aAsksB.ids).toEqual([]);

    const bAsksA = await listAll(
      managerB.client,
      `/api/hris/attendance/review-queue?logId=${fixA2.flaggedLogUlid}`,
      reviewLogId,
      tenantBHost,
    );
    expect([200, 403, 404]).toContain(bAsksA.status);
    expect(bAsksA.ids).toEqual([]);

    // Control: tenant B reads its own log through the same filter.
    const bOwn = await listAll(
      managerB.client,
      `/api/hris/attendance/review-queue?logId=${fixB.flaggedLogUlid}`,
      reviewLogId,
      tenantBHost,
    );
    expect(bOwn.status).toBe(200);
    expect(bOwn.ids).toEqual([fixB.flaggedLogUlid]);
  });

  it("[t3h6e] an outlet-scoped manager gets a log of their outlet but not one of another outlet by logId", async () => {
    const own = await listAll(
      managerOutletA2.client,
      `/api/hris/attendance/review-queue?logId=${fixA2.flaggedLogUlid}`,
      reviewLogId,
    );
    expect(own.status).toBe(200);
    expect(own.ids).toEqual([fixA2.flaggedLogUlid]);

    const foreign = await listAll(
      managerOutletA2.client,
      `/api/hris/attendance/review-queue?logId=${fixA3.flaggedLogUlid}`,
      reviewLogId,
    );
    expect([200, 403, 404]).toContain(foreign.status);
    expect(foreign.ids).toEqual([]);
  });

  it("hides another tenant's outlet policy and QR, and refuses to rotate its secret", async () => {
    // Own-outlet controls first, so the denials below are tenant scoping.
    const ownPolicy = await managerA.client.get(
      `/api/hris/attendance/policy?outletId=${outletA2}`,
    );
    expect(ownPolicy.status, JSON.stringify(ownPolicy.body)).toBe(200);
    const ownRotate = await managerA.client
      .post("/api/hris/attendance/qr/rotate")
      .set(originHeader)
      .send({ outletId: outletA2, idempotencyKey: `att-iso-${randomUUID()}` });
    expect([200, 201], JSON.stringify(ownRotate.body)).toContain(
      ownRotate.status,
    );

    const foreignPolicy = await managerA.client.get(
      `/api/hris/attendance/policy?outletId=${tenantB.outletId}`,
    );
    expect([403, 404]).toContain(foreignPolicy.status);
    const foreignQr = await managerA.client.get(
      `/api/hris/attendance/qr?outletId=${tenantB.outletId}`,
    );
    expect([403, 404]).toContain(foreignQr.status);

    const seedBefore = await owner.query(
      "SELECT encode(seed, 'hex') AS seed, rotated_at FROM attendance_qr_secrets WHERE id = $1",
      [fixB.qrId],
    );
    const foreignRotate = await managerA.client
      .post("/api/hris/attendance/qr/rotate")
      .set(originHeader)
      .send({
        outletId: tenantB.outletId,
        idempotencyKey: `att-iso-${randomUUID()}`,
      });
    expect([403, 404]).toContain(foreignRotate.status);
    const seedAfter = await owner.query(
      "SELECT encode(seed, 'hex') AS seed, rotated_at FROM attendance_qr_secrets WHERE id = $1",
      [fixB.qrId],
    );
    expect(seedAfter.rows).toEqual(seedBefore.rows);
  });

  it("refuses to review another tenant's log and leaves it untouched", async () => {
    // Control: a manager reviews a flagged log of their own tenant.
    const own = await managerA.client
      .post(`/api/hris/attendance/logs/${fixA3.flaggedLogUlid}/review`)
      .set(originHeader)
      .send({ action: "accept", idempotencyKey: `att-iso-${randomUUID()}` });
    expect([200, 201], JSON.stringify(own.body)).toContain(own.status);

    const foreign = await managerA.client
      .post(`/api/hris/attendance/logs/${fixB.flaggedLogUlid}/review`)
      .set(originHeader)
      .send({ action: "reject", idempotencyKey: `att-iso-${randomUUID()}` });
    expect([403, 404]).toContain(foreign.status);
    const { rows } = await owner.query(
      "SELECT review_status, reviewed_by FROM attendance_logs WHERE id = $1",
      [ulidToUuid(fixB.flaggedLogUlid)],
    );
    expect(rows).toEqual([{ review_status: "pending", reviewed_by: null }]);
  });
});

describe("attendance HTTP: outlet and own-data isolation (TEN-03, access.own)", () => {
  it("an outlet-scoped manager sees only that outlet's logs, a tenant-wide manager sees both", async () => {
    const wide = await listAll(
      managerA.client,
      "/api/hris/attendance/logs",
      logId,
    );
    expect(wide.status).toBe(200);
    expect(wide.ids).toContain(fixA2.logUlid);
    expect(wide.ids).toContain(fixA3.logUlid);

    const scoped = await listAll(
      managerOutletA2.client,
      "/api/hris/attendance/logs",
      logId,
    );
    expect(scoped.status).toBe(200);
    expect(scoped.ids).toContain(fixA2.logUlid);
    expect(scoped.ids).not.toContain(fixA3.logUlid);
    expect(scoped.ids).not.toContain(fixB.logUlid);

    const other = await listAll(
      managerOutletA2.client,
      `/api/hris/attendance/logs?outletId=${outletA3}`,
      logId,
    );
    expect([200, 403, 404]).toContain(other.status);
    expect(other.ids).toEqual([]);
  });

  it("an outlet-scoped manager cannot review or rotate outside their outlet", async () => {
    // Control: the same actor reviews a log of their own outlet.
    const own = await managerOutletA2.client
      .post(`/api/hris/attendance/logs/${fixA2.flaggedLogUlid}/review`)
      .set(originHeader)
      .send({ action: "accept", idempotencyKey: `att-iso-${randomUUID()}` });
    expect([200, 201], JSON.stringify(own.body)).toContain(own.status);

    const foreign = await managerOutletA2.client
      .post(`/api/hris/attendance/logs/${fixA3.flaggedLogUlid}/review`)
      .set(originHeader)
      .send({ action: "reject", idempotencyKey: `att-iso-${randomUUID()}` });
    expect([403, 404]).toContain(foreign.status);
    const rotate = await managerOutletA2.client
      .post("/api/hris/attendance/qr/rotate")
      .set(originHeader)
      .send({ outletId: outletA3, idempotencyKey: `att-iso-${randomUUID()}` });
    expect([403, 404]).toContain(rotate.status);
  });

  it("an employee with only self.attendance.clock reads only their own logs", async () => {
    const own = await listAll(
      selfActor.client,
      "/api/hris/attendance/logs",
      logId,
    );
    expect(own.status).toBe(200);
    expect(own.ids).toContain(selfLogUlid);
    // Same outlet, other employee, other outlet, other tenant: all hidden.
    expect(own.ids).not.toContain(colleagueLogUlid);
    expect(own.ids).not.toContain(fixA2.logUlid);
    expect(own.ids).not.toContain(fixA3.logUlid);
    expect(own.ids).not.toContain(fixB.logUlid);

    const colleague = await listAll(
      selfActor.client,
      `/api/hris/attendance/logs?employeeId=${employeeA2}`,
      logId,
    );
    expect([200, 403, 404]).toContain(colleague.status);
    expect(colleague.ids).toEqual([]);
  });

  it("an employee with only self.attendance.clock cannot read others' devices or corrections", async () => {
    const devices = await listAll(
      selfActor.client,
      "/api/hris/attendance/devices",
      plainId,
    );
    expect([200, 403]).toContain(devices.status);
    expect(devices.ids).not.toContain(fixA2.deviceId);
    expect(devices.ids).not.toContain(fixB.deviceId);

    const corrections = await listAll(
      selfActor.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect([200, 403]).toContain(corrections.status);
    expect(corrections.ids).not.toContain(fixA2.correctionId);
    expect(corrections.ids).not.toContain(fixB.correctionId);
  });
});
