// Leave types, balances, requests, holidays and overtime over HTTP (PRD v1.7
// §3 Kelompok D 29 "Cuti, Izin & Lembur", §3.7 Matriks Approval; TEN-01/02/03;
// bead legend-hggk section T2). Runs the real Express app, Better Auth, the
// RBAC resolver, the approval matrix and PostgreSQL against the seeded Cafe
// Legend tenant. Deep rules (accrual maths, pay tiers, concurrency) live in
// the *-db tests; this file checks what a client sees.
//
// Assumptions (the spec leaves these open):
//  - A body with an unknown key or a client-sent tenantId is answered 422,
//    as for every other HRIS route (hris-api.test.ts TEN-02), not 400.
//  - Any HRIS reader or employee may list leave types (the request form needs
//    them); only HR with the manage permission changes them.
//  - Run endpoints (accrual) answer 200 or 201; replays of a create with the
//    same idempotency key answer the same row with a 2xx status.
//  - An overlapping own request is refused with 409 or 422.
//  - Dates are in 2033 (leave, holidays) and Oct/Nov 2026 (overtime) so the
//    rows cannot collide with seeded data; overtime approvers are outlet
//    managers (template role) because the `leave` and `overtime` matrix rows
//    are seeded here, as the fixture tenant has none.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const ACTIONS = ["leave", "overtime"];
let savedPolicies: Record<string, unknown>[] = [];

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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantCustomRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Leave API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(db, userId, roleId, scope);
  });
}

async function assign(
  db: PoolClient,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function grantTemplateRole(
  userId: string,
  templateKey: string,
  outletId: string,
) {
  const roleId = await templateRoleId(templateKey);
  await asTenant((db) =>
    assign(db, userId, roleId, { type: "outlet", id: outletId }),
  );
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
}) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti API', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        input.userId,
        `LV-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hrClient: Client;
let staffClient: Client;
let otherStaffClient: Client;
let managerAClient: Client;
let managerBClient: Client;
let managerAUserId: string;
let ownEmployee: string;
let otherEmployee: string;

const key = () => `lv-api-${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const patch = (client: Client, path: string, body: unknown) =>
  client
    .patch(path)
    .set(originHeader)
    .send(body as object);
const del = (client: Client, path: string) =>
  client.delete(path).set(originHeader);

beforeAll(async () => {
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenant.id, ACTIONS],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenant.id, ACTIONS],
  );
  // §3.7: leave and overtime requests go to the outlet manager, one level.
  for (const action of ACTIONS)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, $2, NULL, $3, 1)`,
      [tenant.id, action, await templateRoleId("outlet_manager")],
    );

  const hr = await signedInClient("HR Cuti API", { mfa: true });
  await grantCustomRole(hr.userId, ["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  hrClient = hr.client;

  const staff = await signedInClient("Staf Cuti API");
  await grantCustomRole(
    staff.userId,
    ["self.profile.view", "self.leave.request", "self.attendance.clock"],
    { type: "outlet", id: outlet.id },
  );
  staffClient = staff.client;

  const otherStaff = await signedInClient("Staf Lain API");
  await grantCustomRole(
    otherStaff.userId,
    ["self.profile.view", "self.leave.request", "self.attendance.clock"],
    { type: "outlet", id: outlet.id },
  );
  otherStaffClient = otherStaff.client;

  const managerA = await signedInClient("Manajer A Cuti API", { mfa: true });
  await grantTemplateRole(managerA.userId, "outlet_manager", outlet.id);
  managerAClient = managerA.client;
  managerAUserId = managerA.userId;

  const managerB = await signedInClient("Manajer B Cuti API", { mfa: true });
  await grantTemplateRole(managerB.userId, "outlet_manager", secondOutlet.id);
  managerBClient = managerB.client;

  ownEmployee = await seedEmployee({
    userId: staff.userId,
    outletId: outlet.id,
  });
  otherEmployee = await seedEmployee({
    userId: otherStaff.userId,
    outletId: outlet.id,
  });
});

afterAll(async () => {
  await asTenant(async (db) => {
    const mine = `employee_id = ANY($2::uuid[])`;
    const types = `SELECT id FROM leave_types WHERE tenant_id = $1 AND code LIKE 'APITEST%'`;
    await db.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND ${mine}`,
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND leave_type_id IN (${types})`,
      [tenant.id],
    );
    await db.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND (${mine} OR leave_type_id IN (${types}))`,
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND (${mine} OR leave_type_id IN (${types}))`,
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM leave_types WHERE tenant_id = $1 AND code LIKE 'APITEST%'`,
      [tenant.id],
    );
    await db.query(
      `DELETE FROM overtime_requests WHERE tenant_id = $1 AND ${mine}`,
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM overtime_formulas WHERE tenant_id = $1 AND created_by = ANY($2::text[])`,
      [tenant.id, createdUsers],
    );
    await db.query(
      `DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'API %'`,
      [tenant.id],
    );
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lv-api-%'",
      [tenant.id],
    );
    await db.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenant.id, ACTIONS],
    );
    for (const row of savedPolicies)
      await db.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

const POLICY = {
  annualDays: "12.0000",
  carryOverMaxDays: "5.0000",
  carryOverExpiryMonths: 3,
  tracksBalance: true,
  accrual: "upfront",
  negativeAllowanceDays: "0.0000",
};
let leaveTypeId: string;

describe("authentication and tenant input", () => {
  it("[TEN-01] anonymous requests to every leave, holiday and overtime route answer 401", async () => {
    const anonymous = agent(app);
    for (const path of [
      "/api/hris/leave/types",
      "/api/hris/leave/balances",
      "/api/hris/leave/requests",
      "/api/hris/holidays",
      "/api/hris/overtime-requests",
      "/api/hris/overtime-formulas",
    ])
      expect((await anonymous.get(path)).status, path).toBe(401);
  });
});

describe("§29 Jenis Cuti", () => {
  it("[§29 Jenis Cuti] HR creates a leave type (201) and it appears in the list for HR and employees", async () => {
    const created = await post(hrClient, "/api/hris/leave/types", {
      code: "APITEST_ANNUAL",
      name: "Cuti tahunan uji",
      paid: true,
      requiresAttachment: false,
      policy: POLICY,
      idempotencyKey: key(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      code: "APITEST_ANNUAL",
      name: "Cuti tahunan uji",
      paid: true,
      requiresAttachment: false,
      isActive: true,
      policy: {
        annualDays: "12.0000",
        accrual: "upfront",
        tracksBalance: true,
      },
    });
    leaveTypeId = created.body.data.id;

    for (const client of [hrClient, staffClient]) {
      const list = await client.get("/api/hris/leave/types");
      expect(list.status).toBe(200);
      expect(list.body.data.map((row: { id: string }) => row.id)).toContain(
        leaveTypeId,
      );
    }
  });

  it("[§29 Jenis Cuti] a duplicate code is refused with 409", async () => {
    const duplicate = await post(hrClient, "/api/hris/leave/types", {
      code: "APITEST_ANNUAL",
      name: "Cuti lain",
      paid: true,
      requiresAttachment: false,
      policy: POLICY,
      idempotencyKey: key(),
    });
    expect(duplicate.status).toBe(409);
  });

  it("[§29 Jenis Cuti] HR renames a leave type and can deactivate it", async () => {
    const created = await post(hrClient, "/api/hris/leave/types", {
      code: "APITEST_SICK",
      name: "Sakit uji",
      paid: true,
      requiresAttachment: true,
      policy: { ...POLICY, tracksBalance: false },
      idempotencyKey: key(),
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const renamed = await patch(hrClient, `/api/hris/leave/types/${id}`, {
      name: "Sakit dengan surat dokter",
      idempotencyKey: key(),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({
      id,
      code: "APITEST_SICK",
      name: "Sakit dengan surat dokter",
      requiresAttachment: true,
    });
    const off = await patch(hrClient, `/api/hris/leave/types/${id}`, {
      isActive: false,
      idempotencyKey: key(),
    });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
  });

  it("[§29 Jenis Cuti] an employee cannot create or change a leave type (403)", async () => {
    const create = await post(staffClient, "/api/hris/leave/types", {
      code: "APITEST_NOPE",
      name: "Tidak boleh",
      paid: true,
      requiresAttachment: false,
      policy: POLICY,
      idempotencyKey: key(),
    });
    expect(create.status).toBe(403);
    const update = await patch(
      staffClient,
      `/api/hris/leave/types/${leaveTypeId}`,
      { name: "Diretas", idempotencyKey: key() },
    );
    expect(update.status).toBe(403);
  });

  it("[TEN-02] a leave type body with a tenantId, an unknown field, a lowercase code or no Origin is refused", async () => {
    const valid = {
      code: "APITEST_BAD",
      name: "Cuti buruk",
      paid: true,
      requiresAttachment: false,
      policy: POLICY,
      idempotencyKey: key(),
    };
    expect(
      (
        await post(hrClient, "/api/hris/leave/types", {
          ...valid,
          tenantId: tenant.id,
        })
      ).status,
    ).toBe(422);
    expect(
      (await post(hrClient, "/api/hris/leave/types", { ...valid, extra: 1 }))
        .status,
    ).toBe(422);
    expect(
      (
        await post(hrClient, "/api/hris/leave/types", {
          ...valid,
          code: "apitest_bad",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(hrClient, "/api/hris/leave/types", {
          ...valid,
          policy: { ...POLICY, annualDays: "-1.0000" },
        })
      ).status,
    ).toBe(422);
    const noOrigin = await hrClient
      .post("/api/hris/leave/types")
      .send({ ...valid, idempotencyKey: key() });
    expect(noOrigin.status).toBe(403);
  });
});

describe("§29 Hari Libur", () => {
  it("[§29 Hari Libur] HR creates (201), lists, renames and deletes a holiday; employees can read it", async () => {
    const created = await post(hrClient, "/api/hris/holidays", {
      date: "2033-08-17",
      name: "API Hari Kemerdekaan",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      date: "2033-08-17",
      name: "API Hari Kemerdekaan",
      type: "national",
      outletId: null,
    });
    const id = created.body.data.id as string;

    const list = await staffClient.get("/api/hris/holidays?year=2033");
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).toContain(id);

    const renamed = await patch(hrClient, `/api/hris/holidays/${id}`, {
      name: "API HUT RI",
      idempotencyKey: key(),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ id, name: "API HUT RI" });

    const removed = await del(hrClient, `/api/hris/holidays/${id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ id });
    const after = await hrClient.get("/api/hris/holidays?year=2033");
    expect(after.body.data.map((row: { id: string }) => row.id)).not.toContain(
      id,
    );
    expect((await del(hrClient, `/api/hris/holidays/${id}`)).status).toBe(404);
  });

  it("[§29 Hari Libur] the same date and outlet twice is refused with 409", async () => {
    const body = {
      date: "2033-09-01",
      name: "API Cuti bersama",
      type: "collective",
      outletId: null,
    };
    expect(
      (
        await post(hrClient, "/api/hris/holidays", {
          ...body,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(201);
    const again = await post(hrClient, "/api/hris/holidays", {
      ...body,
      name: "API Cuti bersama lagi",
      idempotencyKey: key(),
    });
    expect(again.status).toBe(409);
  });

  it("[§29 Hari Libur] a year without holidays lists an empty page", async () => {
    const empty = await hrClient.get("/api/hris/holidays?year=2040");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
  });

  it("[§29 Hari Libur] employees cannot create a holiday (403); an invalid date or unknown field is refused (422)", async () => {
    const body = {
      date: "2033-10-10",
      name: "API Tidak boleh",
      type: "company",
      outletId: outlet.id,
      idempotencyKey: key(),
    };
    expect((await post(staffClient, "/api/hris/holidays", body)).status).toBe(
      403,
    );
    expect(
      (
        await post(hrClient, "/api/hris/holidays", {
          ...body,
          date: "2033-13-40",
        })
      ).status,
    ).toBe(422);
    expect(
      (await post(hrClient, "/api/hris/holidays", { ...body, extra: true }))
        .status,
    ).toBe(422);
    expect(
      (
        await post(hrClient, "/api/hris/holidays", {
          ...body,
          tenantId: tenant.id,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(hrClient, "/api/hris/holidays", {
          ...body,
          type: "religious",
        })
      ).status,
    ).toBe(422);
  });
});

describe("§29 saldo cuti: accrual and balances", () => {
  it("[§29 Jenis Cuti] HR runs the accrual: balances are granted once, and a second run grants nothing", async () => {
    const first = await post(hrClient, "/api/hris/leave/accruals/run", {
      period: "2033-01",
    });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    expect(first.body.data.granted).toBeGreaterThanOrEqual(2);
    const second = await post(hrClient, "/api/hris/leave/accruals/run", {
      period: "2033-01",
    });
    expect(second.status).toBeLessThan(300);
    expect(second.body.data.granted).toBe(0);
    expect(second.body.data.skipped).toBeGreaterThanOrEqual(2);
  });

  it("[§29 Jenis Cuti] an employee cannot run accrual (403) and a malformed period is refused (422)", async () => {
    expect(
      (
        await post(staffClient, "/api/hris/leave/accruals/run", {
          period: "2033-02",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(hrClient, "/api/hris/leave/accruals/run", {
          period: "2033-13",
        })
      ).status,
    ).toBe(422);
    expect(
      (await post(hrClient, "/api/hris/leave/accruals/run", { period: "2033" }))
        .status,
    ).toBe(422);
    expect(
      (
        await post(hrClient, "/api/hris/leave/accruals/run", {
          period: "2033-02",
          tenantId: tenant.id,
        })
      ).status,
    ).toBe(422);
  });

  it("[HR-01] an employee lists only their own balance; HR can filter by employee and year", async () => {
    const own = await staffClient.get("/api/hris/leave/balances?year=2033");
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      own.body.data.every(
        (row: { employeeId: string }) => row.employeeId === ownEmployee,
      ),
    ).toBe(true);
    const mine = own.body.data.find(
      (row: { leaveTypeId: string }) => row.leaveTypeId === leaveTypeId,
    );
    expect(mine).toMatchObject({
      periodYear: 2033,
      entitledDays: "12.0000",
      usedDays: "0.0000",
      pendingDays: "0.0000",
    });

    const hr = await hrClient.get(
      `/api/hris/leave/balances?employeeId=${ownEmployee}&year=2033`,
    );
    expect(hr.status).toBe(200);
    expect(
      hr.body.data.some(
        (row: { leaveTypeId: string }) => row.leaveTypeId === leaveTypeId,
      ),
    ).toBe(true);
  });

  it("[§29 Jenis Cuti] a year with no balances lists an empty page", async () => {
    const empty = await staffClient.get("/api/hris/leave/balances?year=2040");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
  });
});

async function balanceOf(client: Client, employeeId: string) {
  const response = await client.get(
    `/api/hris/leave/balances?employeeId=${employeeId}&year=2033`,
  );
  expect(response.status).toBe(200);
  return response.body.data.find(
    (row: { leaveTypeId: string }) => row.leaveTypeId === leaveTypeId,
  ) as { entitledDays: string; usedDays: string; pendingDays: string };
}

const leaveBody = (overrides: Record<string, unknown> = {}) => ({
  leaveTypeId,
  startDate: "2033-03-14",
  endDate: "2033-03-16",
  reason: "Acara keluarga",
  attachmentUploadRef: null,
  idempotencyKey: key(),
  ...overrides,
});

describe("§29 Pengajuan & Approval cuti", () => {
  let approvedId: string;

  it("[§29 Pengajuan] an employee requests leave (201): days are computed by the server and held as pending", async () => {
    const body = leaveBody();
    const created = await post(staffClient, "/api/hris/leave/requests", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      employeeId: ownEmployee,
      leaveTypeId,
      startDate: "2033-03-14",
      endDate: "2033-03-16",
      days: "3.0000",
      status: "pending",
      decidedBy: null,
      decidedAt: null,
    });
    approvedId = created.body.data.id;
    expect(await balanceOf(hrClient, ownEmployee)).toMatchObject({
      entitledDays: "12.0000",
      pendingDays: "3.0000",
      usedDays: "0.0000",
    });

    // The same idempotency key replays the same row and holds nothing twice.
    const replay = await post(staffClient, "/api/hris/leave/requests", body);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(approvedId);
    expect((await balanceOf(hrClient, ownEmployee)).pendingDays).toBe("3.0000");
  });

  it("[§29 Pengajuan] an overlapping, over-balance or cross-year request is refused", async () => {
    const overlap = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-03-16", endDate: "2033-03-17" }),
    );
    expect([409, 422]).toContain(overlap.status);

    // 12 days entitled, 3 pending: 15 more days do not fit.
    const tooMany = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-05-02", endDate: "2033-05-16" }),
    );
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("INSUFFICIENT_LEAVE_BALANCE");

    const crossYear = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-12-30", endDate: "2034-01-02" }),
    );
    expect(crossYear.status).toBe(422);
    const backwards = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-04-05", endDate: "2033-04-01" }),
    );
    expect(backwards.status).toBe(422);
    // Nothing was held by the refusals.
    expect((await balanceOf(hrClient, ownEmployee)).pendingDays).toBe("3.0000");
  });

  it("[TEN-02] a leave request with an unknown field, a tenantId or no idempotency key is refused (422)", async () => {
    for (const bad of [
      { ...leaveBody(), extra: 1 },
      { ...leaveBody(), tenantId: tenant.id },
      { ...leaveBody(), employeeId: otherEmployee },
      { ...leaveBody(), idempotencyKey: undefined },
      { ...leaveBody(), leaveTypeId: "not-a-uuid" },
    ])
      expect(
        (await post(staffClient, "/api/hris/leave/requests", bad)).status,
      ).toBe(422);
  });

  it("[§29 Pengajuan] a holiday inside the range is not counted as a leave day, and rejecting releases the hold", async () => {
    await post(hrClient, "/api/hris/holidays", {
      date: "2033-06-07",
      name: "API Libur di tengah cuti",
      type: "company",
      outletId: null,
      idempotencyKey: key(),
    });
    const created = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-06-06", endDate: "2033-06-08" }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.days).toBe("2.0000");
    expect((await balanceOf(hrClient, ownEmployee)).pendingDays).toBe("5.0000");

    const rejected = await post(
      managerAClient,
      `/api/hris/leave/requests/${created.body.data.id}/decision`,
      {
        action: "reject",
        rejectionReason: "Jadwal penuh",
        idempotencyKey: key(),
      },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      decidedBy: managerAUserId,
    });
    expect(rejected.body.data.decidedAt).not.toBeNull();
    expect(await balanceOf(hrClient, ownEmployee)).toMatchObject({
      pendingDays: "3.0000",
      usedDays: "0.0000",
    });
  });

  it("[§3.7 Approval] only the matrix approver decides: the requester, another employee and another outlet's manager cannot", async () => {
    const own = await post(
      staffClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(own.status).toBe(403);
    const colleague = await post(
      otherStaffClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect([403, 404]).toContain(colleague.status);
    const otherOutlet = await post(
      managerBClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(otherOutlet.status).toBe(404);
    // Still pending, nothing consumed.
    expect(await balanceOf(hrClient, ownEmployee)).toMatchObject({
      pendingDays: "3.0000",
      usedDays: "0.0000",
    });
  });

  it("[§3.7 Approval] the outlet manager approves: pending days become used days", async () => {
    const decisionKey = key();
    const approved = await post(
      managerAClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "approve", idempotencyKey: decisionKey },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: approvedId,
      status: "approved",
      decidedBy: managerAUserId,
    });
    expect(await balanceOf(hrClient, ownEmployee)).toMatchObject({
      usedDays: "3.0000",
      pendingDays: "0.0000",
    });
    // A replay of the same decision changes nothing.
    const replay = await post(
      managerAClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "approve", idempotencyKey: decisionKey },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe("approved");
    expect((await balanceOf(hrClient, ownEmployee)).usedDays).toBe("3.0000");
    // A different decision on a decided request is a conflict.
    const reject = await post(
      managerAClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      {
        action: "reject",
        rejectionReason: "Jadwal penuh",
        idempotencyKey: key(),
      },
    );
    expect(reject.status).toBe(409);
  });

  it("[§29 Pengajuan] the employee cancels a future approved leave and gets the days back", async () => {
    const cancelled = await post(
      staffClient,
      `/api/hris/leave/requests/${approvedId}/decision`,
      { action: "cancel", idempotencyKey: key() },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(await balanceOf(hrClient, ownEmployee)).toMatchObject({
      usedDays: "0.0000",
      pendingDays: "0.0000",
    });
  });

  it("[§29 Pengajuan] the employee cancels a pending request and the hold is released", async () => {
    const created = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: "2033-07-04", endDate: "2033-07-04" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.days).toBe("1.0000");
    expect((await balanceOf(hrClient, ownEmployee)).pendingDays).toBe("1.0000");
    const cancelled = await post(
      staffClient,
      `/api/hris/leave/requests/${created.body.data.id}/decision`,
      { action: "cancel", idempotencyKey: key() },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect((await balanceOf(hrClient, ownEmployee)).pendingDays).toBe("0.0000");
  });

  it("[HR-01][TEN-03] each employee lists only their own requests; the outlet manager sees outlet A, the other outlet's manager sees none", async () => {
    const own = await staffClient.get("/api/hris/leave/requests?limit=100");
    expect(own.status).toBe(200);
    expect(own.body.data.length).toBeGreaterThanOrEqual(3);
    expect(
      own.body.data.every(
        (row: { employeeId: string }) => row.employeeId === ownEmployee,
      ),
    ).toBe(true);
    const other = await otherStaffClient.get(
      "/api/hris/leave/requests?limit=100",
    );
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([]);

    const managerA = await managerAClient.get(
      `/api/hris/leave/requests?employeeId=${ownEmployee}&status=rejected`,
    );
    expect(managerA.status).toBe(200);
    expect(managerA.body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      managerA.body.data.every(
        (row: { status: string }) => row.status === "rejected",
      ),
    ).toBe(true);
    expect(
      managerA.body.data.every(
        (row: { employeeName?: string }) =>
          row.employeeName === "Karyawan Cuti API",
      ),
      "legend-hvh9x: the authorized leave queue names its requester",
    ).toBe(true);
    const managerB = await managerBClient.get(
      `/api/hris/leave/requests?employeeId=${ownEmployee}`,
    );
    expect(managerB.status).toBe(200);
    expect(managerB.body.data).toEqual([]);
  });
});

const OVERTIME_PARAMETERS = {
  monthlyHoursDivisor: 173,
  tiersByDayType: {
    workday: [
      { fromHour: 0, toHour: 1, multiplier: "1.5000" },
      { fromHour: 1, toHour: null, multiplier: "2.0000" },
    ],
    rest_day_6_day_week: [
      { fromHour: 0, toHour: 7, multiplier: "2.0000" },
      { fromHour: 7, toHour: 8, multiplier: "3.0000" },
      { fromHour: 8, toHour: null, multiplier: "4.0000" },
    ],
    rest_day_5_day_week: [
      { fromHour: 0, toHour: 8, multiplier: "2.0000" },
      { fromHour: 8, toHour: 9, multiplier: "3.0000" },
      { fromHour: 9, toHour: null, multiplier: "4.0000" },
    ],
  },
  roundingMode: "half_up",
};
const overtimeBody = (overrides: Record<string, unknown> = {}) => ({
  outletId: outlet.id,
  date: "2026-10-12",
  minutes: 90,
  reason: "Menutup dapur lebih lama.",
  idempotencyKey: key(),
  ...overrides,
});

describe("§29 Lembur", () => {
  let formulaId: string;
  let approvedId: string;

  it("[§29 Lembur] no formula yet: an overtime request is refused with 409 OVERTIME_FORMULA_MISSING, and an employee cannot create a formula (403)", async () => {
    const draftBody = {
      effectiveFrom: "2026-01-01",
      parameters: OVERTIME_PARAMETERS,
      restDayType: "rest_day_6_day_week",
      legalBasis: "PP 35/2021 Pasal 31",
      idempotencyKey: key(),
    };
    expect(
      (await post(staffClient, "/api/hris/overtime-formulas", draftBody))
        .status,
    ).toBe(403);
    const draft = await post(
      hrClient,
      "/api/hris/overtime-formulas",
      draftBody,
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data).toMatchObject({
      status: "draft",
      effectiveFrom: "2026-01-01",
      restDayType: "rest_day_6_day_week",
      publishedAt: null,
    });
    formulaId = draft.body.data.id;

    const refused = await post(
      staffClient,
      "/api/hris/overtime-requests",
      overtimeBody(),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("OVERTIME_FORMULA_MISSING");
  });

  it("[§29 Lembur] HR publishes the formula (200) and it is listed as published", async () => {
    expect(
      (
        await post(
          staffClient,
          `/api/hris/overtime-formulas/${formulaId}/publish`,
          { idempotencyKey: key() },
        )
      ).status,
    ).toBe(403);
    const published = await post(
      hrClient,
      `/api/hris/overtime-formulas/${formulaId}/publish`,
      { idempotencyKey: key() },
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.data).toMatchObject({
      id: formulaId,
      status: "published",
      publishedBy: expect.any(String),
    });
    const list = await hrClient.get("/api/hris/overtime-formulas");
    expect(list.status).toBe(200);
    expect(
      list.body.data.find((row: { id: string }) => row.id === formulaId),
    ).toMatchObject({ status: "published", parameters: OVERTIME_PARAMETERS });
  });

  it("[§29 Lembur] an employee requests overtime (201): pinned to the published formula and waiting for approval", async () => {
    const created = await post(
      staffClient,
      "/api/hris/overtime-requests",
      overtimeBody(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      employeeId: ownEmployee,
      outletId: outlet.id,
      date: "2026-10-12",
      minutes: 90,
      status: "pending",
      dayType: "workday",
      formulaId,
      decidedBy: null,
    });
    approvedId = created.body.data.id;
  });

  it("[§29 Lembur] a holiday on the date makes the request a rest-day request", async () => {
    await post(hrClient, "/api/hris/holidays", {
      date: "2026-10-14",
      name: "API Libur lembur",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    });
    const created = await post(
      staffClient,
      "/api/hris/overtime-requests",
      overtimeBody({ date: "2026-10-14" }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.dayType).toBe("rest_day_6_day_week");
    // legend-arj.2: a normal day without a roster rest day is a workday; the
    // employee cannot pick a rest-day type (see the 422 test below).
    const normalDay = await post(
      staffClient,
      "/api/hris/overtime-requests",
      overtimeBody({ date: "2026-10-16" }),
    );
    expect(normalDay.status, JSON.stringify(normalDay.body)).toBe(201);
    expect(normalDay.body.data.dayType).toBe("workday");
  });

  it("[legend-arj.2] a day type sent by the client is refused with 422, whatever its value; the day kind comes from the roster and holidays", async () => {
    for (const dayType of [
      "rest_day_5_day_week",
      "rest_day_6_day_week",
      "workday",
    ]) {
      const refused = await post(
        staffClient,
        "/api/hris/overtime-requests",
        overtimeBody({ date: "2026-10-18", dayType }),
      );
      expect(refused.status, dayType).toBe(422);
    }
    // Nothing was created for that date.
    const none = await staffClient.get(
      "/api/hris/overtime-requests?from=2026-10-18&to=2026-10-18",
    );
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it("[§29 Lembur] a replay with the same idempotency key returns the same request", async () => {
    const body = overtimeBody({ date: "2026-10-17" });
    const first = await post(staffClient, "/api/hris/overtime-requests", body);
    const replay = await post(staffClient, "/api/hris/overtime-requests", body);
    expect(first.status).toBe(201);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
  });

  it("[TEN-02] overtime bodies with an unknown field, a tenantId, bad minutes or no idempotency key are refused (422)", async () => {
    for (const bad of [
      overtimeBody({ extra: true }),
      overtimeBody({ tenantId: tenant.id }),
      overtimeBody({ employeeId: otherEmployee }),
      overtimeBody({ minutes: 0 }),
      overtimeBody({ minutes: 721 }),
      overtimeBody({ minutes: 1.5 }),
      overtimeBody({ reason: "" }),
      overtimeBody({ date: "2026-02-31" }),
      overtimeBody({ dayType: "holiday" }),
      overtimeBody({ idempotencyKey: undefined }),
    ])
      expect(
        (await post(staffClient, "/api/hris/overtime-requests", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    const noOrigin = await staffClient
      .post("/api/hris/overtime-requests")
      .send(overtimeBody());
    expect(noOrigin.status).toBe(403);
  });

  it("[§3.7 Approval] only the outlet manager approves: the requester and another outlet's manager cannot", async () => {
    const path = `/api/hris/overtime-requests/${approvedId}/decision`;
    expect(
      (
        await post(staffClient, path, {
          action: "approve",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(managerBClient, path, {
          action: "approve",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(404);
    const approved = await post(managerAClient, path, {
      action: "approve",
      idempotencyKey: key(),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: approvedId,
      status: "approved",
      decidedBy: managerAUserId,
    });
    expect(approved.body.data.decidedAt).not.toBeNull();
    // Decided: a second, different decision is a conflict.
    expect(
      (
        await post(managerAClient, path, {
          action: "reject",
          rejectionReason: "Jadwal penuh",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(409);
  });

  it("[§3.7 Approval] a rejection ends the request", async () => {
    const created = await post(
      staffClient,
      "/api/hris/overtime-requests",
      overtimeBody({ date: "2026-10-21", minutes: 60 }),
    );
    const rejected = await post(
      managerAClient,
      `/api/hris/overtime-requests/${created.body.data.id}/decision`,
      {
        action: "reject",
        rejectionReason: "Jadwal penuh",
        idempotencyKey: key(),
      },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe("rejected");
  });

  it("[§29 Lembur] listing filters by employee, status and dates; employees and other outlets see only what they may; an empty range is an empty page", async () => {
    const approved = await managerAClient.get(
      `/api/hris/overtime-requests?employeeId=${ownEmployee}&status=approved&from=2026-10-01&to=2026-10-31`,
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data.map((row: { id: string }) => row.id)).toEqual([
      approvedId,
    ]);
    expect(approved.body.data[0]).toMatchObject({
      employeeName: "Karyawan Cuti API",
    });

    const pending = await hrClient.get(
      `/api/hris/overtime-requests?employeeId=${ownEmployee}&status=pending&limit=100`,
    );
    expect(pending.status).toBe(200);
    expect(pending.body.data.length).toBeGreaterThanOrEqual(3);
    expect(
      pending.body.data.every(
        (row: { status: string }) => row.status === "pending",
      ),
    ).toBe(true);

    const own = await staffClient.get("/api/hris/overtime-requests?limit=100");
    expect(own.status).toBe(200);
    expect(
      own.body.data.every(
        (row: { employeeId: string }) => row.employeeId === ownEmployee,
      ),
    ).toBe(true);
    const other = await otherStaffClient.get(
      "/api/hris/overtime-requests?limit=100",
    );
    expect(other.body.data).toEqual([]);

    const otherOutlet = await managerBClient.get(
      `/api/hris/overtime-requests?employeeId=${ownEmployee}`,
    );
    expect(otherOutlet.status).toBe(200);
    expect(otherOutlet.body.data).toEqual([]);

    const empty = await hrClient.get(
      "/api/hris/overtime-requests?from=2040-01-01&to=2040-12-31",
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    // Unknown query keys are refused like everywhere else in HRIS.
    expect(
      (await hrClient.get("/api/hris/overtime-requests?tenantId=x")).status,
    ).toBe(422);
    expect(
      (await hrClient.get("/api/hris/overtime-requests?status=maybe")).status,
    ).toBe(422);
  });
});
