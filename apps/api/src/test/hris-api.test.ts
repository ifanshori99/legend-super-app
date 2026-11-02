// HRIS master-data HTTP API (PRD v1.7 §3 F26; HR-01, HR-03; TEN-01/02/03;
// bead legend-qe1z). Runs the real Express app (router mounted at /api/hris
// by routes/index.ts), Better Auth, the RBAC resolver and PostgreSQL against
// the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

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

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
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
        `HRIS api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant.id,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

/** Seeds an employee row without PII (PII goes through the PUT route). */
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
       VALUES ($1, $2, $3, $4, 'Karyawan API', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        input.userId,
        `API-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hrClient: Client;
let staffClient: Client;
let managerBClient: Client;
let ownEmployee: string;
let otherEmployee: string;
let outletBEmployee: string;
const NIK = `33${String(Date.now()).slice(-8)}000777`;
const BANK = "0987654321001";

beforeAll(async () => {
  const hr = await signedInClient("HR API");
  await grantRole(hr.userId, ["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  hrClient = hr.client;
  const staff = await signedInClient("Staf API");
  await grantRole(staff.userId, ["self.profile.view"], {
    type: "outlet",
    id: outlet.id,
  });
  staffClient = staff.client;
  const managerB = await signedInClient("Manajer B API");
  await grantRole(managerB.userId, ["hr.employee.view"], {
    type: "outlet",
    id: secondOutlet.id,
  });
  managerBClient = managerB.client;

  ownEmployee = await seedEmployee({
    userId: staff.userId,
    outletId: outlet.id,
  });
  otherEmployee = await seedEmployee({ userId: null, outletId: outlet.id });
  outletBEmployee = await seedEmployee({
    userId: null,
    outletId: secondOutlet.id,
  });
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'hris-api-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEmployees],
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("HRIS API authentication and tenant input", () => {
  it("[TEN-01] answers 401 to anonymous requests", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get("/api/hris/employees")).status).toBe(401);
    expect((await anonymous.get("/api/hris/me")).status).toBe(401);
  });

  it("[TEN-02] rejects a tenantId or unknown field in the PII body, and a mutation without Origin", async () => {
    const withTenant = await hrClient
      .put(`/api/hris/employees/${otherEmployee}/pii`)
      .set(originHeader)
      .send({
        tenantId: tenant.id,
        nik: NIK,
        idempotencyKey: `hris-api-${randomUUID()}`,
      });
    expect(withTenant.status).toBe(422);
    const noOrigin = await hrClient
      .put(`/api/hris/employees/${otherEmployee}/pii`)
      .send({ nik: NIK, idempotencyKey: `hris-api-${randomUUID()}` });
    expect(noOrigin.status).toBe(403);
    const badQuery = await hrClient.get("/api/hris/employees?tenantId=x");
    expect(badQuery.status).toBe(422);
  });
});

describe("HR-03 PII over HTTP", () => {
  it("[HR-03] HR writes PII and gets only masked values back; plaintext never appears in any response", async () => {
    const put = await hrClient
      .put(`/api/hris/employees/${ownEmployee}/pii`)
      .set(originHeader)
      .send({
        nik: NIK,
        bankAccount: BANK,
        idempotencyKey: `hris-api-${randomUUID()}`,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.nik).toEqual({
      masked: `****${NIK.slice(-4)}`,
      keyVersion: 1,
    });
    expect(put.body.data.bankAccount.masked).toBe(`****${BANK.slice(-4)}`);
    expect(put.text).not.toContain(NIK);
    expect(put.text).not.toContain(BANK);

    const pii = await hrClient.get(`/api/hris/employees/${ownEmployee}/pii`);
    expect(pii.status).toBe(200);
    expect(pii.headers["cache-control"]).toContain("no-store");
    expect(pii.text).not.toContain(NIK);

    // The list and detail endpoints carry no PII at all.
    const list = await hrClient.get("/api/hris/employees?limit=100");
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(NIK);
    const row = list.body.data.find(
      (item: { id: string }) => item.id === ownEmployee,
    );
    expect(row).toBeDefined();
    expect(Object.keys(row)).not.toContain("nik");
    expect(Object.keys(row)).not.toContain("bankAccount");
  });

  it("[HR-03] a supervisor-level viewer gets null for every PII field", async () => {
    const response = await managerBClient.get(
      `/api/hris/employees/${outletBEmployee}/pii`,
    );
    expect(response.status).toBe(200);
    expect(
      Object.values(response.body.data).every((value) => value === null),
    ).toBe(true);
    // And cannot write it.
    const put = await managerBClient
      .put(`/api/hris/employees/${outletBEmployee}/pii`)
      .set(originHeader)
      .send({ nik: NIK, idempotencyKey: `hris-api-${randomUUID()}` });
    expect(put.status).toBe(403);
  });
});

describe("HR-01 self-service over HTTP", () => {
  it("[HR-01] /api/hris/me returns the caller's own employee row", async () => {
    const me = await staffClient.get("/api/hris/me");
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.employee.id).toBe(ownEmployee);
    expect(me.body.data.outlet.id).toBe(outlet.id);
  });

  it("[HR-01] the employee reads their own masked PII but another employee's record answers 404", async () => {
    const own = await staffClient.get(`/api/hris/employees/${ownEmployee}/pii`);
    expect(own.status).toBe(200);
    expect(own.body.data.nik?.masked).toBe(`****${NIK.slice(-4)}`);
    expect(own.text).not.toContain(NIK);
    expect(
      (await staffClient.get(`/api/hris/employees/${otherEmployee}`)).status,
    ).toBe(404);
    expect(
      (await staffClient.get(`/api/hris/employees/${otherEmployee}/pii`))
        .status,
    ).toBe(404);
    expect(
      (await staffClient.get(`/api/hris/employees/${otherEmployee}/documents`))
        .status,
    ).toBe(404);
    expect((await staffClient.get("/api/hris/employees")).status).toBe(403);
  });

  it("[TEN-03] an outlet-B viewer cannot open an outlet-A employee", async () => {
    expect(
      (await managerBClient.get(`/api/hris/employees/${otherEmployee}`)).status,
    ).toBe(404);
    const list = await managerBClient.get("/api/hris/employees?limit=100");
    expect(list.status).toBe(200);
    expect(
      list.body.data.every(
        (item: { homeOutletId: string }) =>
          item.homeOutletId === secondOutlet.id,
      ),
    ).toBe(true);
  });
});
