// Kasbon (employee loans) HTTP API (bead legend-gfcr slice D; contract
// `@starter/shared/hris/payroll` loans.ts + endpoints.ts). Runs the real
// Express app, Better Auth, the RBAC resolver and PostgreSQL against the seeded
// Cafe Legend tenant, plus an isolated second tenant for isolation checks.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outletId = cafeLegendPlatformFixtures.outlets[0].id as string;
const HR = "/api/hris/payroll/loans";
const ME = "/api/hris/me/loans";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const key = () => `loan-api-${randomUUID()}`;
const PRINCIPAL = 1_234_567;

async function asTenantOf<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
const asTenant = <T>(run: (client: PoolClient) => Promise<T>) =>
  asTenantOf(tenant.id, run);

async function signedInClient(name: string) {
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
  scope: { type: "tenant" } | { type: "outlet"; id: string } = {
    type: "tenant",
  },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenantOf(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Loan api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

// Cash kasbon needs a legal entity on the employee (legend-cv00j).
const fixtureEntityId = randomUUID();

async function seedEmployee(
  tenantId: string,
  homeOutletId: string,
  userId: string | null,
) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenantOf(tenantId, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, legal_entity_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Kasbon', $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        id,
        tenantId,
        userId,
        `LN-${id.slice(0, 8).toUpperCase()}`,
        homeOutletId,
        tenantId === tenant.id ? fixtureEntityId : null,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hrClient: Client; // hr.loan.approve + payroll.view + self
let hrEmployee: string;
let viewerClient: Client; // payroll.view only
let strangerClient: Client; // no payroll rights, no self right
let staffClient: Client; // self.loan.request, tenant scope
let staffEmployee: string;
let staff2Client: Client; // another employee
let staff2Employee: string;
let outletStaffClient: Client; // self.loan.request at outlet scope only
let noEmployeeClient: Client; // self right but no employee row
let profileOnlyEmployee: string;
let profileOnlyClient: Client; // self.profile.view + employee row, no self.loan.request
let isolated: IsolatedTenant;
let isolatedHr: Client;
let isolatedEmployee: string;
let isolatedLoan: string;

const newLoan = (overrides: Record<string, unknown> = {}) => ({
  principalIdr: PRINCIPAL,
  installmentCount: 3,
  reason: "Biaya sekolah anak (uji API)",
  idempotencyKey: key(),
  ...overrides,
});

async function request(client: Client, overrides = {}) {
  const response = await client
    .post(ME)
    .set(originHeader)
    .send(newLoan(overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as {
    id: string;
    status: string;
    employeeId: string;
  };
}

const decide = (client: Client, id: string, action: string, headers = {}) =>
  client
    .post(`${HR}/${id}/decision`)
    .set(originHeader)
    .set(headers)
    .send({ action, idempotencyKey: key() });
const disburse = (client: Client, id: string, headers = {}) =>
  client
    .post(`${HR}/${id}/disburse`)
    .set(originHeader)
    .set(headers)
    .send({ idempotencyKey: key() });

beforeAll(async () => {
  await asTenant((db) =>
    db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Fixture Kasbon API', false)`,
      [fixtureEntityId, tenant.id],
    ),
  );
  // Kasbon limits (legend-fij0l): a request is refused without a tenant policy.
  // This suite creates many loans per employee, so it runs under a lenient one;
  // the limits themselves are tested in payroll-loans-caps.test.ts.
  await asTenant((db) =>
    db.query(
      `INSERT INTO payroll_loan_policies
         (tenant_id, max_principal_idr, max_principal_of_base_salary_bp, max_installments,
          max_deduction_of_net_pay_bp, single_open_loan, max_total_open_idr)
       VALUES ($1, 100000000, NULL, 36, 5000, false, 1000000000)`,
      [tenant.id],
    ),
  );
  const hr = await signedInClient("Loan HR API");
  await grantRole(tenant.id, hr.userId, [
    "hr.loan.approve",
    "payroll.view",
    "self.loan.request",
  ]);
  hrClient = hr.client;
  hrEmployee = await seedEmployee(tenant.id, outletId, hr.userId);

  const viewer = await signedInClient("Loan viewer API");
  await grantRole(tenant.id, viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;

  strangerClient = (await signedInClient("Loan stranger API")).client;
  await grantRole(
    tenant.id,
    (await strangerClient.get("/api/auth/get-session")).body.user.id,
    ["hr.employee.view"],
  );

  const staff = await signedInClient("Loan staff API");
  await grantRole(tenant.id, staff.userId, ["self.loan.request"]);
  staffClient = staff.client;
  staffEmployee = await seedEmployee(tenant.id, outletId, staff.userId);

  const staff2 = await signedInClient("Loan staff2 API");
  await grantRole(tenant.id, staff2.userId, ["self.loan.request"]);
  staff2Client = staff2.client;
  staff2Employee = await seedEmployee(tenant.id, outletId, staff2.userId);

  const outletStaff = await signedInClient("Loan outlet staff API");
  await grantRole(tenant.id, outletStaff.userId, ["self.loan.request"], {
    type: "outlet",
    id: outletId,
  });
  outletStaffClient = outletStaff.client;
  await seedEmployee(tenant.id, outletId, outletStaff.userId);

  const profileOnly = await signedInClient("Loan profile-only API");
  await grantRole(tenant.id, profileOnly.userId, ["self.profile.view"]);
  profileOnlyClient = profileOnly.client;
  profileOnlyEmployee = await seedEmployee(
    tenant.id,
    outletId,
    profileOnly.userId,
  );

  const noEmployee = await signedInClient("Loan no employee API");
  await grantRole(tenant.id, noEmployee.userId, ["self.loan.request"]);
  noEmployeeClient = noEmployee.client;

  // Second tenant with its own approver and one pending loan.
  isolated = await createIsolatedTenant(`loan-${randomUUID().slice(0, 6)}`);
  const other = await signedInClient("Loan tenant B HR API");
  await grantRole(isolated.tenantId, other.userId, [
    "hr.loan.approve",
    "payroll.view",
    "self.loan.request",
  ]);
  isolatedHr = other.client;
  isolatedEmployee = await seedEmployee(
    isolated.tenantId,
    isolated.outletId,
    null,
  );
  isolatedLoan = randomUUID();
  await asTenantOf(isolated.tenantId, (db) =>
    db.query(
      `INSERT INTO employee_loans (id, tenant_id, employee_id, principal_idr, installment_idr,
                                   installment_count, outstanding_idr, first_deduction_period, reason)
       VALUES ($1, $2, $3, 900000, 300000, 3, 900000, '2030-01-01', 'Kasbon tenant B')`,
      [isolatedLoan, isolated.tenantId, isolatedEmployee],
    ),
  );
});

afterAll(async () => {
  await asTenantOf(isolated.tenantId, async (db) => {
    await db.query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [
      isolated.tenantId,
    ]);
    await db.query("DELETE FROM employee_loans WHERE tenant_id = $1", [
      isolated.tenantId,
    ]);
    await db.query("DELETE FROM employees WHERE tenant_id = $1", [
      isolated.tenantId,
    ]);
    await db.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      isolated.tenantId,
    ]);
  });
  await asTenant(async (db) => {
    await db.query("DELETE FROM payroll_loan_policies WHERE tenant_id = $1", [
      tenant.id,
    ]);
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'loan-api-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM employee_loans WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
      [tenant.id, fixtureEntityId],
    );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  });
  await dropIsolatedTenant(isolated);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("kasbon API: request (self-service)", () => {
  it("[HR-01] creates a pending loan for the caller's own employee row only", async () => {
    const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
    const [year, month] = today.split("-").map(Number) as [number, number];
    const first =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const response = await staffClient
      .post(ME)
      .set(originHeader)
      .send(newLoan());
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      tenantId: tenant.id,
      employeeId: staffEmployee,
      principalIdr: PRINCIPAL,
      installmentIdr: 411_523, // ceil(1,234,567 / 3)
      installmentCount: 3,
      outstandingIdr: PRINCIPAL,
      firstDeductionPeriod: first,
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      disbursedAt: null,
      settledAt: null,
    });
  });

  it("works with a self right granted at outlet scope", async () => {
    const response = await outletStaffClient
      .post(ME)
      .set(originHeader)
      .send(newLoan());
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe("pending");
  });

  it("answers 404 for an account without an employee row, 403 without the self right", async () => {
    const noRow = await noEmployeeClient
      .post(ME)
      .set(originHeader)
      .send(newLoan());
    expect(noRow.status).toBe(404);
    const denied = await strangerClient
      .post(ME)
      .set(originHeader)
      .send(newLoan());
    expect(denied.status).toBe(403);
    expect((await strangerClient.get(ME)).status).toBe(403);
    expect((await agent(app).get(ME)).status).toBe(401);
  });

  it("[legend-krvk7] self.profile.view alone is not enough: 403 on list and request, no row written", async () => {
    const denied = await profileOnlyClient
      .post(ME)
      .set(originHeader)
      .send(newLoan());
    expect(denied.status).toBe(403);
    expect((await profileOnlyClient.get(ME)).status).toBe(403);
    const written = await asTenant((db) =>
      db.query(
        "SELECT count(*)::int AS n FROM employee_loans WHERE employee_id = $1",
        [profileOnlyEmployee],
      ),
    );
    expect(written.rows[0].n).toBe(0);
    // the request-only staff account still works and sees only its own loans
    const own = await request(staffClient);
    const list = await staffClient.get(ME);
    expect(list.status).toBe(200);
    for (const row of list.body.data)
      expect(row.employeeId).toBe(staffEmployee);
    expect(list.body.data.some((r: { id: string }) => r.id === own.id)).toBe(
      true,
    );
  });

  it("[TEN-02] rejects tenantId, employeeId, unknown keys and bad amounts with 422", async () => {
    const bodies = [
      newLoan({ tenantId: tenant.id }),
      newLoan({ employeeId: hrEmployee }),
      newLoan({ status: "approved" }),
      newLoan({ principalIdr: 0 }),
      newLoan({ principalIdr: 1.5 }),
      newLoan({ installmentCount: 0 }),
      newLoan({ installmentCount: 37 }),
      newLoan({ reason: "" }),
      (() => {
        const { idempotencyKey: _omitted, ...rest } = newLoan();
        void _omitted;
        return rest;
      })(),
    ];
    for (const body of bodies) {
      const response = await staffClient.post(ME).set(originHeader).send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect((await staffClient.get(`${ME}?tenantId=${tenant.id}`)).status).toBe(
      422,
    );
    expect(
      (await staffClient.post(ME).send(newLoan())).status,
      "no Origin",
    ).toBe(403);
  });

  it("replays the first 201 for the same key and body and refuses the key with another body", async () => {
    const idempotencyKey = key();
    const first = await staff2Client
      .post(ME)
      .set(originHeader)
      .send(newLoan({ idempotencyKey }));
    expect(first.status).toBe(201);
    const replay = await staff2Client
      .post(ME)
      .set(originHeader)
      .send(newLoan({ idempotencyKey }));
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const rows = await asTenant((db) =>
      db.query("SELECT id FROM employee_loans WHERE id = $1", [
        first.body.data.id,
      ]),
    );
    expect(rows.rowCount).toBe(1);
    const other = await staff2Client
      .post(ME)
      .set(originHeader)
      .send(newLoan({ idempotencyKey, principalIdr: PRINCIPAL + 1 }));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[HR-03] keeps amounts and the reason out of the audit log", async () => {
    const loan = await request(staffClient, {
      reason: "Alasan rahasia kasbon unik",
    });
    const rows = await asTenant((db) =>
      db.query(
        "SELECT event::text AS event FROM audit_logs WHERE event->>'objectId' = $1",
        [loan.id],
      ),
    );
    expect(rows.rowCount).toBe(1);
    const event = rows.rows[0].event as string;
    expect(event).toContain("payroll.loan.requested");
    expect(event).not.toContain(String(PRINCIPAL));
    expect(event).not.toContain("rahasia");
  });
});

describe("kasbon API: lists", () => {
  it("/me lists only the caller's own loans", async () => {
    const own = await request(staff2Client);
    const mine = await staff2Client.get(ME);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(
      mine.body.data.every(
        (row: { employeeId: string }) => row.employeeId === staff2Employee,
      ),
    ).toBe(true);
    expect(mine.body.data.map((row: { id: string }) => row.id)).toContain(
      own.id,
    );
    const others = await staffClient.get(ME);
    expect(others.body.data.map((row: { id: string }) => row.id)).not.toContain(
      own.id,
    );
  });

  it("HR list: payroll.view or hr.loan.approve, filters and cursor pages", async () => {
    const a = await request(staff2Client);
    const b = await request(staff2Client);
    for (const client of [viewerClient, hrClient]) {
      const list = await client.get(`${HR}?employeeId=${staff2Employee}`);
      expect(list.status).toBe(200);
      const ids = list.body.data.map((row: { id: string }) => row.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(
        list.body.data.every(
          (row: { employeeId: string }) => row.employeeId === staff2Employee,
        ),
      ).toBe(true);
    }
    const approved = await decide(hrClient, a.id, "approve");
    expect(approved.status).toBe(200);
    const byStatus = await viewerClient.get(
      `${HR}?status=approved&employeeId=${staff2Employee}`,
    );
    expect(byStatus.body.data.map((row: { id: string }) => row.id)).toEqual([
      a.id,
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response: {
        status: number;
        body: { data: { id: string }[]; meta: { nextCursor: string | null } };
      } = await viewerClient.get(
        `${HR}?employeeId=${staff2Employee}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      seen.push(...response.body.data.map((row: { id: string }) => row.id));
      cursor = response.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await viewerClient.get(`${HR}?cursor=%21%21`)).status).toBe(422);
    expect((await viewerClient.get(`${HR}?status=nope`)).status).toBe(422);
  });

  it("answers 403 to an account without payroll.view or hr.loan.approve", async () => {
    expect((await strangerClient.get(HR)).status).toBe(403);
    expect((await staffClient.get(HR)).status).toBe(403);
  });
});

describe("kasbon API: decision and disbursement", () => {
  it("approves, disburses and refuses every other transition with 409", async () => {
    const loan = await request(staffClient);
    const early = await disburse(hrClient, loan.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");

    const approved = await decide(hrClient, loan.id, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: loan.id,
      status: "approved",
      outstandingIdr: PRINCIPAL,
      disbursedAt: null,
    });
    expect(approved.body.data.decidedBy).toEqual(expect.any(String));
    expect(approved.body.data.decidedAt).toEqual(expect.any(String));

    const again = await decide(hrClient, loan.id, "approve");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");

    const paid = await disburse(hrClient, loan.id);
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: "disbursed",
      outstandingIdr: PRINCIPAL,
    });
    expect(paid.body.data.disbursedAt).toEqual(expect.any(String));

    for (const action of ["approve", "reject", "cancel"]) {
      const response = await decide(hrClient, loan.id, action);
      expect(response.status, action).toBe(409);
    }
    expect((await disburse(hrClient, loan.id)).status).toBe(409);
  });

  it("rejects and cancels from the allowed states only", async () => {
    const rejected = await request(staffClient);
    const reject = await decide(hrClient, rejected.id, "reject");
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe("rejected");
    expect((await decide(hrClient, rejected.id, "approve")).status).toBe(409);
    expect((await disburse(hrClient, rejected.id)).status).toBe(409);

    const cancelled = await request(staffClient);
    await decide(hrClient, cancelled.id, "approve");
    const cancel = await decide(hrClient, cancelled.id, "cancel");
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("cancelled");
    expect((await disburse(hrClient, cancelled.id)).status).toBe(409);
  });

  it("replays a decision for the same key and refuses the key for another action", async () => {
    const loan = await request(staffClient);
    const idempotencyKey = key();
    const send = (action: string) =>
      hrClient
        .post(`${HR}/${loan.id}/decision`)
        .set(originHeader)
        .send({ action, idempotencyKey });
    const first = await send("approve");
    expect(first.status).toBe(200);
    const replay = await send("approve");
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    const other = await send("reject");
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[four-eyes] the borrower can neither decide nor disburse their own loan", async () => {
    const own = await request(hrClient);
    expect(own.employeeId).toBe(hrEmployee);
    const response = await decide(hrClient, own.id, "approve");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect((await disburse(hrClient, own.id)).status).toBe(403);
    const row = await asTenant((db) =>
      db.query("SELECT status FROM employee_loans WHERE id = $1", [own.id]),
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("answers 403 without hr.loan.approve and 404 for an unknown loan", async () => {
    const loan = await request(staffClient);
    expect((await decide(viewerClient, loan.id, "approve")).status).toBe(403);
    expect((await disburse(viewerClient, loan.id)).status).toBe(403);
    expect((await decide(staffClient, loan.id, "cancel")).status).toBe(403);
    expect((await decide(hrClient, randomUUID(), "approve")).status).toBe(404);
    expect((await disburse(hrClient, randomUUID())).status).toBe(404);
  });

  it("[TEN-02] rejects bad bodies and params with 422", async () => {
    const loan = await request(staffClient);
    const bad = [
      { action: "approve", idempotencyKey: key(), tenantId: tenant.id },
      { action: "disburse", idempotencyKey: key() },
      { action: "approve" },
    ];
    for (const body of bad) {
      const response = await hrClient
        .post(`${HR}/${loan.id}/decision`)
        .set(originHeader)
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (
        await hrClient
          .post(`${HR}/${loan.id}/disburse`)
          .set(originHeader)
          .send({ idempotencyKey: key(), amount: 1 })
      ).status,
    ).toBe(422);
    expect((await decide(hrClient, "not-a-uuid", "approve")).status).toBe(422);
  });
});

describe("kasbon API: tenant isolation", () => {
  it("[TEN-01] tenant B cannot read, decide or disburse tenant A's loans (404) and vice versa", async () => {
    const loan = await request(staffClient);
    await decide(hrClient, loan.id, "approve");
    const headers = { Host: isolated.hostname };

    expect((await decide(isolatedHr, loan.id, "cancel", headers)).status).toBe(
      404,
    );
    expect((await disburse(isolatedHr, loan.id, headers)).status).toBe(404);

    const listB = await isolatedHr.get(HR).set(headers);
    expect(listB.status).toBe(200);
    const idsB = listB.body.data.map((row: { id: string }) => row.id);
    expect(idsB).toEqual([isolatedLoan]);
    expect(idsB).not.toContain(loan.id);
    expect(
      (await isolatedHr.get(`${HR}?employeeId=${staffEmployee}`).set(headers))
        .body.data,
    ).toEqual([]);

    // Tenant A cannot touch tenant B's loan either.
    expect((await decide(hrClient, isolatedLoan, "approve")).status).toBe(404);
    expect((await disburse(hrClient, isolatedLoan)).status).toBe(404);
    const listA = await hrClient.get(HR);
    expect(listA.body.data.map((row: { id: string }) => row.id)).not.toContain(
      isolatedLoan,
    );

    const untouched = await asTenantOf(isolated.tenantId, (db) =>
      db.query("SELECT status FROM employee_loans WHERE id = $1", [
        isolatedLoan,
      ]),
    );
    expect(untouched.rows[0].status).toBe("pending");
    const stillApproved = await asTenant((db) =>
      db.query("SELECT status FROM employee_loans WHERE id = $1", [loan.id]),
    );
    expect(stillApproved.rows[0].status).toBe("approved");
  });
});

describe("kasbon API: review fixes", () => {
  it("refuses a resigned or terminated employee a new loan with 422", async () => {
    for (const status of ["resigned", "terminated"]) {
      const leaver = await signedInClient(`Loan ${status} API`);
      await grantRole(tenant.id, leaver.userId, ["self.loan.request"]);
      const employeeId = await seedEmployee(tenant.id, outletId, leaver.userId);
      await asTenant((db) =>
        db.query("UPDATE employees SET status = $2 WHERE id = $1", [
          employeeId,
          status,
        ]),
      );
      const response = await leaver.client
        .post(ME)
        .set(originHeader)
        .send(newLoan());
      expect(response.status, status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("answers 422, not 500, to a crafted cursor", async () => {
    for (const keys of [
      ["not-a-date", "x"],
      [new Date().toISOString(), "x"],
    ]) {
      const cursor = encodeURIComponent(encodeCursor(keys));
      expect((await viewerClient.get(`${HR}?cursor=${cursor}`)).status).toBe(
        422,
      );
      expect((await staffClient.get(`${ME}?cursor=${cursor}`)).status).toBe(
        422,
      );
    }
  });

  it("keeps the approver on cancelling an approved loan", async () => {
    const second = await signedInClient("Loan HR two API");
    await grantRole(tenant.id, second.userId, ["hr.loan.approve"]);
    const loan = await request(staffClient);
    const approved = await decide(hrClient, loan.id, "approve");
    expect(approved.status).toBe(200);
    const cancel = await decide(second.client, loan.id, "cancel");
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("cancelled");
    expect(cancel.body.data.decidedBy).toBe(approved.body.data.decidedBy);
    expect(cancel.body.data.decidedAt).toBe(approved.body.data.decidedAt);
    expect(cancel.body.data.decidedBy).not.toBe(second.userId);
  });
});
