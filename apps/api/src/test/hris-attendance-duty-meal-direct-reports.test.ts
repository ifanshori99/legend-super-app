// legend-e6xi5 (akses): duty meals ("makan dinas") follow the same
// direct-report rule as the selfie review and manual-correction queues
// (finding 501-1). A supervisor who holds hr.attendance.manage at OUTLET scope
// may list and record duty meals only for their DIRECT subordinates
// (employees.manager_id = the supervisor's employee id); HR (the same
// permission held tenant-wide) keeps the unchanged tenant view. Expected
// behaviour comes from the brief, the shared endpoint contracts
// (packages/shared/src/hris/endpoints.ts) and the sibling test
// hris-attendance-supervisor-scope.test.ts, not from service code. Everything
// runs through HTTP against the real Express app, Better Auth, RBAC and
// PostgreSQL.
//
// Assumptions (the brief leaves these open):
//  - Recording a duty meal needs hr.attendance.manage (see
//    hris-attendance-correction.test.ts). A "supervisor" holds it at outlet
//    scope; "HR" holds it tenant-wide.
//  - "Direct subordinate" means employees.manager_id equals the supervisor's
//    own employee id. Indirect reports (a subordinate's own subordinate) are
//    NOT direct and are refused.
//  - A refused list read answers 200 with no rows, or 403/404; the test only
//    requires that no row, employee id or meal id of the refused subject
//    leaks. A refused record answers 403 or 404 (422 is also accepted for an
//    employee id that does not exist) and stores nothing.
//  - "Cross-tenant" is probed with an employee id that does not exist in the
//    actor's tenant (a second tenant's employee is invisible to the actor
//    through RLS the same way): the record is refused and nothing is stored.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();
const KEY_PREFIX = "duty-meal-dr-";

type Client = ReturnType<typeof agent>;
type JsonRow = Record<string, unknown>;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
let outletX: string;
let outletY: string;

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

const PERMISSIONS = [
  "hr.attendance.manage",
  "hr.attendance_correction.approve",
];

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
        `Duty meal scope ${roleId.slice(0, 8)}`,
        JSON.stringify(PERMISSIONS),
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
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet duty meal', 'Jl. Makan Dinas', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `DM-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ latitude: -6.2, longitude: 106.8, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(options: {
  userId: string | null;
  managerId: string | null;
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
        options.userId,
        `DM-${id.slice(0, 8).toUpperCase()}`,
        options.name,
        options.homeOutletId,
        options.managerId,
      ],
    ),
  );
  return id;
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

// One distinct business day per meal so the "one meal per employee, day and
// shift" rule never interferes between cases.
let dayCounter = 0;
const nextDate = () => {
  dayCounter += 1;
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + dayCounter);
  return date.toISOString().slice(0, 10);
};

const mealBody = (
  employeeId: string,
  outlet: string,
  businessDate = nextDate(),
) => ({
  outletId: outlet,
  employeeId,
  shiftAssignmentId: null,
  businessDate,
  mealCount: 1,
  idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
});

const mealRowsFor = async (employeeId: string, businessDate: string) =>
  (
    await owner.query(
      "SELECT id FROM attendance_duty_meals WHERE tenant_id = $1 AND employee_id = $2 AND business_date = $3",
      [tenant.id, employeeId, businessDate],
    )
  ).rows;

/** Every row of a list endpoint; follows cursors so a late row cannot hide. */
async function collectAll(client: Client, path: string) {
  const rows: JsonRow[] = [];
  const bodies: unknown[] = [];
  let status = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    status = response.status;
    bodies.push(response.body);
    if (status !== 200) break;
    rows.push(...(response.body.data as JsonRow[]));
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return { status, rows, text: JSON.stringify(bodies) };
}

const mealEmployeeIds = (rows: JsonRow[]) =>
  rows.map((row) => String(row.employeeId).toLowerCase());

let hr: Awaited<ReturnType<typeof signedInClient>>;
let supA: Awaited<ReturnType<typeof signedInClient>>;
let supB: Awaited<ReturnType<typeof signedInClient>>;
let supC: Awaited<ReturnType<typeof signedInClient>>;
let empA: string;
let subA: string; // direct report of supA, outlet X
let subAOfSub: string; // report of subA: indirect for supA
let subB: string; // direct report of supB, outlet X
let peer: string; // outlet X, no manager
let subAOutletY: string; // direct report of supA whose home outlet is Y
const seeded: Record<string, { id: string; date: string }> = {};

beforeAll(async () => {
  outletX = await seedOutlet();
  outletY = await seedOutlet();
  hr = await signedInClient("HR Duty Meal");
  await grantRole(hr.userId, { type: "tenant" });
  supA = await signedInClient("Supervisor Duty Meal A");
  supB = await signedInClient("Supervisor Duty Meal B");
  supC = await signedInClient("Supervisor Duty Meal C");
  for (const supervisor of [supA, supB, supC])
    await grantRole(supervisor.userId, {
      type: "outlet",
      outletIds: [outletX],
    });

  empA = await seedEmployee({
    userId: supA.userId,
    managerId: null,
    name: "Supervisor Makan A",
    homeOutletId: outletX,
  });
  const empB = await seedEmployee({
    userId: supB.userId,
    managerId: null,
    name: "Supervisor Makan B",
    homeOutletId: outletX,
  });
  await seedEmployee({
    userId: supC.userId,
    managerId: null,
    name: "Supervisor Makan C",
    homeOutletId: outletX,
  });
  subA = await seedEmployee({
    userId: null,
    managerId: empA,
    name: "Bawahan Makan A",
    homeOutletId: outletX,
  });
  subAOfSub = await seedEmployee({
    userId: null,
    managerId: subA,
    name: "Cucu Makan A",
    homeOutletId: outletX,
  });
  subB = await seedEmployee({
    userId: null,
    managerId: empB,
    name: "Bawahan Makan B",
    homeOutletId: outletX,
  });
  peer = await seedEmployee({
    userId: null,
    managerId: null,
    name: "Tanpa Atasan Makan",
    homeOutletId: outletX,
  });
  subAOutletY = await seedEmployee({
    userId: null,
    managerId: empA,
    name: "Bawahan Outlet Lain",
    homeOutletId: outletY,
  });

  // HR (tenant-wide) seeds one meal per employee so the list cases have rows.
  const targets: Array<[string, string, string]> = [
    ["subA", subA, outletX],
    ["subB", subB, outletX],
    ["peer", peer, outletX],
    ["subAOfSub", subAOfSub, outletX],
    ["subAOutletY", subAOutletY, outletY],
  ];
  for (const [name, employeeId, outlet] of targets) {
    const body = mealBody(employeeId, outlet);
    const response = await post(
      hr.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    seeded[name] = {
      id: String(response.body.data.id),
      date: body.businessDate,
    };
  }
}, 120_000);

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await owner.query(
      "DELETE FROM attendance_duty_meals WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
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
    await owner.query("COMMIT");
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

const mealList = (client: Client, query = `outletId=${outletX}`) =>
  collectAll(client, `/api/hris/attendance/duty-meals?${query}`);

describe("[legend-e6xi5] supervisor lists duty meals of direct reports only", () => {
  it("lists a direct subordinate's duty meal", async () => {
    const list = await mealList(supA.client);
    expect(list.status, list.text).toBe(200);
    expect(mealEmployeeIds(list.rows)).toContain(subA);
  });

  it("hides another supervisor's subordinate, a manager-less colleague and an indirect report in the same outlet", async () => {
    const list = await mealList(supA.client);
    expect(list.status, list.text).toBe(200);
    const ids = mealEmployeeIds(list.rows);
    expect(ids).not.toContain(subB);
    expect(ids).not.toContain(peer);
    expect(ids).not.toContain(subAOfSub);
    for (const name of ["subB", "peer", "subAOfSub"])
      expect(list.text).not.toContain(seeded[name]!.id);
  });

  it("shows the other supervisor only their own subordinate", async () => {
    const list = await mealList(supB.client);
    expect(list.status, list.text).toBe(200);
    const ids = mealEmployeeIds(list.rows);
    expect(ids).toContain(subB);
    expect(ids).not.toContain(subA);
    expect(list.text).not.toContain(seeded.subA!.id);
  });

  it("answers an empty list to a supervisor with no subordinates", async () => {
    const list = await mealList(supC.client);
    expect(list.status, list.text).toBe(200);
    expect(list.rows).toHaveLength(0);
  });

  it("does not leak a non-subordinate's meals through ?employeeId", async () => {
    for (const target of [subB, peer, subAOfSub]) {
      const leak = await mealList(
        supA.client,
        `outletId=${outletX}&employeeId=${target}`,
      );
      if (leak.status === 200) expect(leak.rows).toHaveLength(0);
      else expect([403, 404]).toContain(leak.status);
      expect(leak.text).not.toContain(target);
    }
  });

  it("does not leak meals of another outlet, even for the supervisor's own direct report there", async () => {
    const leak = await mealList(supA.client, `outletId=${outletY}`);
    if (leak.status === 200) expect(leak.rows).toHaveLength(0);
    else expect([403, 404]).toContain(leak.status);
    expect(leak.text).not.toContain(seeded.subAOutletY!.id);
  });

  it("keeps the HR (tenant-wide) view of every employee's duty meals", async () => {
    const list = await collectAll(hr.client, "/api/hris/attendance/duty-meals");
    expect(list.status, list.text).toBe(200);
    const ids = mealEmployeeIds(list.rows);
    for (const employeeId of [subA, subB, peer, subAOfSub, subAOutletY])
      expect(ids).toContain(employeeId);
  });
});

describe("[legend-e6xi5] supervisor records duty meals for direct reports only", () => {
  it("records a duty meal for a direct subordinate", async () => {
    const body = mealBody(subA, outletX);
    const response = await post(
      supA.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      employeeId: subA,
      outletId: outletX,
      businessDate: body.businessDate,
    });
    expect(await mealRowsFor(subA, body.businessDate)).toHaveLength(1);
  });

  for (const [label, target] of [
    ["another supervisor's subordinate in the same outlet", () => subB],
    ["a colleague without a manager in the same outlet", () => peer],
    ["an indirect report (a subordinate's subordinate)", () => subAOfSub],
    ["the supervisor's own colleague supervisor", () => empA],
  ] as const) {
    it(`refuses recording for ${label} and stores nothing`, async () => {
      const employeeId = label.includes("colleague supervisor")
        ? (
            await owner.query<{ id: string }>(
              "SELECT id FROM employees WHERE tenant_id = $1 AND user_id = $2",
              [tenant.id, supB.userId],
            )
          ).rows[0]!.id
        : target();
      const body = mealBody(employeeId, outletX);
      const response = await post(
        supA.client,
        "/api/hris/attendance/duty-meals",
        body,
      );
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await mealRowsFor(employeeId, body.businessDate)).toHaveLength(0);
    });
  }

  it("refuses recording in another outlet and stores nothing", async () => {
    // subAOutletY is a direct report, but outlet Y is outside the supervisor's reach.
    const body = mealBody(subAOutletY, outletY);
    const response = await post(
      supA.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(subAOutletY, body.businessDate)).toHaveLength(0);
  });

  it("refuses recording for an employee that does not exist in this tenant", async () => {
    const ghost = randomUUID();
    const body = mealBody(ghost, outletX);
    const response = await post(
      supA.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([403, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(ghost, body.businessDate)).toHaveLength(0);
  });

  it("refuses recording for an inactive direct report and stores nothing", async () => {
    const inactive = await seedEmployee({
      userId: null,
      managerId: empA,
      name: "Bawahan Makan Nonaktif",
      homeOutletId: outletX,
    });
    await asTenant((client) =>
      client.query(
        "UPDATE employees SET status = 'terminated', end_date = '2026-01-01' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, inactive],
      ),
    );
    for (const client of [supA.client, hr.client]) {
      const body = mealBody(inactive, outletX);
      const response = await post(
        client,
        "/api/hris/attendance/duty-meals",
        body,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(await mealRowsFor(inactive, body.businessDate)).toHaveLength(0);
    }
  });

  it("refuses a supervisor with no subordinates", async () => {
    const body = mealBody(subA, outletX);
    const response = await post(
      supC.client,
      "/api/hris/attendance/duty-meals",
      body,
    );
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await mealRowsFor(subA, body.businessDate)).toHaveLength(0);
  });

  it("keeps HR (tenant-wide) able to record for any employee, in any outlet", async () => {
    for (const [employeeId, outlet] of [
      [subB, outletX],
      [peer, outletX],
      [subAOutletY, outletY],
    ] as const) {
      const body = mealBody(employeeId, outlet);
      const response = await post(
        hr.client,
        "/api/hris/attendance/duty-meals",
        body,
      );
      expect([200, 201], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await mealRowsFor(employeeId, body.businessDate)).toHaveLength(1);
    }
  });
});
