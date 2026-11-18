// legend-5bx8v (1087): a duty meal ("makan dinas") may only be recorded for an
// employee who is on duty at the recorded outlet. The CTO decision (restrictive
// rule): POST /api/hris/attendance/duty-meals answers 422
// ATTENDANCE_DUTY_MEAL_EMPLOYEE_NOT_ON_DUTY unless the employee's home outlet is
// the recorded outlet, or the employee has a published or swapped shift
// assignment at that outlet on the recorded business date. Nothing is stored on a refusal.
// Expected behaviour comes from the brief and the shared endpoint contract
// (packages/shared/src/hris/endpoints.ts recordAttendanceDutyMeal), not from
// service code. Everything runs through HTTP against the real Express app,
// Better Auth, RBAC and PostgreSQL.
//
// Assumptions:
//  - The actor is HR (hr.attendance.manage tenant-wide) unless a case says
//    otherwise; a supervisor holds the same permission at outlet scope and
//    records for direct reports (employees.manager_id), as in
//    hris-attendance-duty-meal-direct-reports.test.ts.
//  - "Cancelled" shift assignments (status 'cancelled') do not put the employee
//    on duty; a 'published' one does. A shift of another outlet or another date
//    does not count.
//  - Cross-tenant: an employee of another tenant is not reachable; the answer
//    is 403, 404 or 422 and nothing is stored in either tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();
const KEY_PREFIX = "duty-meal-od-";
const NOT_ON_DUTY = "ATTENDANCE_DUTY_MEAL_EMPLOYEE_NOT_ON_DUTY";

type Client = ReturnType<typeof agent>;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let tenantB: SecondTenant | null = null;
let tenantBEmployee = "";
let outletX: string;
let outletY: string;
let outletZ: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Duty meal on duty ${roleId.slice(0, 8)}`,
        JSON.stringify([
          "hr.attendance.manage",
          "hr.attendance_correction.approve",
        ]),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "tenant" ? [null] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

async function seedOutlet() {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet on duty', 'Jl. Tugas', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `OD-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ latitude: -6.2, longitude: 106.8, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(options: {
  userId?: string | null;
  managerId?: string | null;
  name: string;
  homeOutletId: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenant.id,
        options.userId ?? null,
        `OD-${id.slice(0, 8).toUpperCase()}`,
        options.name,
        options.homeOutletId,
        options.managerId ?? null,
      ],
    ),
  );
  return id;
}

async function seedShift(options: {
  employeeId: string;
  outletId: string;
  businessDate: string;
  status: "published" | "cancelled" | "draft";
  publishedBy: string;
}): Promise<string> {
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7::text, 'user',
               CASE WHEN $7::text = 'draft' THEN NULL ELSE $8::text END,
               CASE WHEN $7::text = 'draft' THEN NULL ELSE now() END, $8)`,
      [
        id,
        tenant.id,
        options.outletId,
        options.employeeId,
        options.businessDate,
        JSON.stringify([
          {
            startsAt: `${options.businessDate}T02:00:00.000Z`,
            endsAt: `${options.businessDate}T10:00:00.000Z`,
          },
        ]),
        options.status,
        options.publishedBy,
      ],
    ),
  );
  return id;
}

const post = (client: Client, body: unknown) =>
  client
    .post("/api/hris/attendance/duty-meals")
    .set(originHeader)
    .send(body as object);

// One distinct business day per case so the one-meal-per-day rule never
// interferes between cases.
let dayCounter = 0;
const nextDate = () => {
  dayCounter += 1;
  const date = new Date(Date.UTC(2026, 2, 1));
  date.setUTCDate(date.getUTCDate() + dayCounter);
  return date.toISOString().slice(0, 10);
};

const mealBody = (
  employeeId: string,
  outletId: string,
  businessDate = nextDate(),
) => ({
  outletId,
  employeeId,
  shiftAssignmentId: null,
  businessDate,
  mealCount: 1,
  idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
});

const mealRowsFor = async (
  employeeId: string,
  businessDate: string,
  tenantId = tenant.id,
) =>
  (
    await owner.query(
      "SELECT id FROM attendance_duty_meals WHERE tenant_id = $1 AND employee_id = $2 AND business_date = $3",
      [tenantId, employeeId, businessDate],
    )
  ).rows;

let hr: Awaited<ReturnType<typeof signedInClient>>;
let sup: Awaited<ReturnType<typeof signedInClient>>;
let homeX: string; // home outlet X
let homeY: string; // home outlet Y
let supReportHomeY: string; // direct report of sup, home outlet Y
let supReportHomeX: string; // direct report of sup, home outlet X

beforeAll(async () => {
  outletX = await seedOutlet();
  outletY = await seedOutlet();
  outletZ = await seedOutlet();
  hr = await signedInClient("HR Duty Meal On Duty");
  await grantRole(hr.userId, { type: "tenant" });
  sup = await signedInClient("Supervisor Duty Meal On Duty");
  await grantRole(sup.userId, { type: "outlet", outletIds: [outletX] });
  const supEmployee = await seedEmployee({
    userId: sup.userId,
    name: "Supervisor Tugas",
    homeOutletId: outletX,
  });
  homeX = await seedEmployee({ name: "Bertugas di X", homeOutletId: outletX });
  homeY = await seedEmployee({ name: "Bertugas di Y", homeOutletId: outletY });
  supReportHomeY = await seedEmployee({
    managerId: supEmployee,
    name: "Bawahan Home Y",
    homeOutletId: outletY,
  });
  supReportHomeX = await seedEmployee({
    managerId: supEmployee,
    name: "Bawahan Home X",
    homeOutletId: outletX,
  });

  tenantB = await createSecondTenant(owner, "dutymeal");
  tenantBEmployee = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'active')`,
    [
      tenantBEmployee,
      tenantB.tenantId,
      `TB-${tenantBEmployee.slice(0, 8).toUpperCase()}`,
      tenantB.outletId,
    ],
  );
}, 120_000);

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    for (const table of ["attendance_duty_meals", "shift_assignments"])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
        [tenant.id, createdEmployees],
      );
    await owner.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await owner.query(
      "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'actorId' = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await owner.query(
      "DELETE FROM outlets WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await owner.query("COMMIT");
    if (tenantB)
      await owner.query("DELETE FROM employees WHERE tenant_id = $1", [
        tenantB.tenantId,
      ]);
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
    if (tenantB) await removeSecondTenant(owner, tenantB);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

async function expectNotOnDuty(
  client: Client,
  employeeId: string,
  outletId: string,
  businessDate = nextDate(),
) {
  const response = await post(
    client,
    mealBody(employeeId, outletId, businessDate),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(422);
  expect(response.body?.error?.code).toBe(NOT_ON_DUTY);
  expect(await mealRowsFor(employeeId, businessDate)).toHaveLength(0);
}

describe("[legend-5bx8v] duty meal needs the employee on duty at the recorded outlet", () => {
  it("records for an employee whose home outlet is the recorded outlet", async () => {
    const body = mealBody(homeX, outletX);
    const response = await post(hr.client, body);
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      employeeId: homeX,
      outletId: outletX,
    });
    expect(await mealRowsFor(homeX, body.businessDate)).toHaveLength(1);
  });

  it("refuses 422 when the employee's home outlet is another outlet and there is no shift", async () => {
    await expectNotOnDuty(hr.client, homeX, outletY);
  });

  it("records at a non-home outlet when a published shift puts the employee there that day", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: homeX,
      outletId: outletY,
      businessDate: date,
      status: "published",
      publishedBy: hr.userId,
    });
    const response = await post(hr.client, mealBody(homeX, outletY, date));
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(homeX, date)).toHaveLength(1);
  });

  it("refuses 422 when the only shift at that outlet is cancelled", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: homeX,
      outletId: outletY,
      businessDate: date,
      status: "cancelled",
      publishedBy: hr.userId,
    });
    await expectNotOnDuty(hr.client, homeX, outletY, date);
  });

  it("refuses 422 when the only shift at that outlet is a draft", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: homeX,
      outletId: outletY,
      businessDate: date,
      status: "draft",
      publishedBy: hr.userId,
    });
    await expectNotOnDuty(hr.client, homeX, outletY, date);
  });

  it("refuses 422 when the shift is on another date", async () => {
    const shiftDate = nextDate();
    const mealDate = nextDate();
    await seedShift({
      employeeId: homeX,
      outletId: outletY,
      businessDate: shiftDate,
      status: "published",
      publishedBy: hr.userId,
    });
    await expectNotOnDuty(hr.client, homeX, outletY, mealDate);
  });

  it("refuses 422 when the shift is at a third outlet, not the recorded one", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: homeX,
      outletId: outletZ,
      businessDate: date,
      status: "published",
      publishedBy: hr.userId,
    });
    await expectNotOnDuty(hr.client, homeX, outletY, date);
  });

  it("a shift at the recorded outlet for another employee does not put this employee on duty", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: homeY,
      outletId: outletZ,
      businessDate: date,
      status: "published",
      publishedBy: hr.userId,
    });
    await expectNotOnDuty(hr.client, homeX, outletZ, date);
  });
});

describe("[legend-5bx8v] cross-outlet: a supervisor's direct report on duty elsewhere", () => {
  it("lets the supervisor record for a direct report homed at the supervisor's outlet", async () => {
    const body = mealBody(supReportHomeX, outletX);
    const response = await post(sup.client, body);
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(supReportHomeX, body.businessDate)).toHaveLength(
      1,
    );
  });

  it("refuses 422 for a direct report homed at another outlet, even though the supervisor reaches the recorded outlet", async () => {
    await expectNotOnDuty(sup.client, supReportHomeY, outletX);
  });

  it("lets the supervisor record that direct report at the supervisor's outlet once a published shift puts them there", async () => {
    const date = nextDate();
    await seedShift({
      employeeId: supReportHomeY,
      outletId: outletX,
      businessDate: date,
      status: "published",
      publishedBy: hr.userId,
    });
    const response = await post(
      sup.client,
      mealBody(supReportHomeY, outletX, date),
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(supReportHomeY, date)).toHaveLength(1);
  });

  it("still refuses recording at an outlet outside the supervisor's reach and stores nothing", async () => {
    const body = mealBody(supReportHomeY, outletY);
    const response = await post(sup.client, body);
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(supReportHomeY, body.businessDate)).toHaveLength(
      0,
    );
  });
});

describe("[legend-5bx8v] cross-tenant", () => {
  it("refuses an employee of another tenant at the other tenant's outlet and stores nothing", async () => {
    const body = mealBody(tenantBEmployee, tenantB!.outletId);
    const response = await post(hr.client, body);
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(
      await mealRowsFor(tenantBEmployee, body.businessDate, tenantB!.tenantId),
    ).toHaveLength(0);
  });

  it("refuses an employee of another tenant at this tenant's outlet and stores nothing", async () => {
    const body = mealBody(tenantBEmployee, outletX);
    const response = await post(hr.client, body);
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(
      await mealRowsFor(tenantBEmployee, body.businessDate, tenantB!.tenantId),
    ).toHaveLength(0);
    expect(await mealRowsFor(tenantBEmployee, body.businessDate)).toHaveLength(
      0,
    );
  });

  it("refuses this tenant's employee at another tenant's outlet and stores nothing", async () => {
    const body = mealBody(homeX, tenantB!.outletId);
    const response = await post(hr.client, body);
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(homeX, body.businessDate)).toHaveLength(0);
  });
});
