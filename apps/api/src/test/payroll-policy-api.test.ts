// Payroll policy and THR schedule HTTP API (bead legend-gfcr; contract
// `@starter/shared/hris/payroll` endpoints.ts). Runs the real Express app
// (routers mounted at /api/hris/payroll/policies and
// /api/hris/payroll/thr-schedules by routes/index.ts), Better Auth, the RBAC
// resolver and PostgreSQL against the seeded Cafe Legend tenant plus one
// isolated second tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const POLICIES = "/api/hris/payroll/policies";
const THR = "/api/hris/payroll/thr-schedules";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const policyIds: string[] = [];
const thrIds: string[] = [];
const employeeIds: { tenantId: string; id: string }[] = [];
const runTag = randomUUID().slice(0, 6);
const key = () => `payroll-policy-api-${randomUUID()}`;
const groupCode = (suffix: string) =>
  `T${runTag.toUpperCase()}_${suffix}`.slice(0, 30);

async function asTenant<T>(
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
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Payroll policy api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId],
    );
  });
}

async function seedEmployee(tenantId: string, outletId: string) {
  const id = randomUUID();
  employeeIds.push({ tenantId, id });
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id, employment_type, join_date)
       VALUES ($1, $2, $3, $4, $5, 'pkwt', '2030-01-01')`,
      [
        id,
        tenantId,
        `PP-${id.slice(0, 8).toUpperCase()}`,
        `Policy ${id.slice(0, 8)}`,
        outletId,
      ],
    ),
  );
  return id;
}

type PageBody = {
  data: { id: string }[];
  meta: { nextCursor: string | null };
};
type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let adminClient: Client;
let viewerClient: Client;
let strangerClient: Client;
let otherClient: Client;
// Both tenants are created by this file. The shared seeded tenant is not used:
// its payroll_policies are read by the other payroll files, and the [zjwa] test
// corrupts a row on purpose, which would fail their lists (and the other way
// round: their rows fail the list and the cursor walk here) on two workers.
let tenant: { id: string };
let isolatedA: IsolatedTenant;
let isolated: IsolatedTenant;
let otherHeaders: { Host: string };
let legalEntityId: string;
let employeeA: string;
let employeeB: string;

const policyBody = (
  suffix: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey = key(),
) => ({
  legalEntityId,
  name: `Kebijakan ${runTag} ${suffix}`,
  employeeGroup: {
    code: groupCode(suffix),
    name: `Grup ${suffix}`,
    employmentTypes: ["pkwt"],
  },
  cycle: {
    frequency: "monthly",
    cutoffDay: 25,
    payDay: 28,
    payMonthOffset: 0,
  },
  payDateAdjustment: "previous_working_day",
  jkkRiskClass: "low",
  bpjsProgrammes: ["bpjs_kes", "jht"],
  idempotencyKey,
  ...overrides,
});

const thrBody = (
  suffix: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey = key(),
) => ({
  legalEntityId,
  name: `THR ${runTag} ${suffix}`,
  holidayName: "Idul Fitri",
  holidayDate: "2031-03-31",
  tenureAsOfDate: "2031-03-01",
  payDate: "2031-03-20",
  employeeIds: null,
  idempotencyKey,
  ...overrides,
});

async function createPolicy(
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await adminClient
    .post(POLICIES)
    .set(originHeader)
    .send(policyBody(suffix, overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  policyIds.push(response.body.data.id);
  return response.body.data as { id: string; [field: string]: unknown };
}

beforeAll(async () => {
  isolatedA = await createIsolatedTenant(`pola-${runTag}`);
  tenant = { id: isolatedA.tenantId };
  const admin = await signedInClient("Policy admin API");
  await grantRole(tenant.id, admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client.host(isolatedA.hostname);
  const viewer = await signedInClient("Policy viewer API");
  await grantRole(tenant.id, viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client.host(isolatedA.hostname);
  const stranger = await signedInClient("Policy stranger API");
  await grantRole(tenant.id, stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client.host(isolatedA.hostname);

  isolated = await createIsolatedTenant(`pol-${runTag}`);
  otherHeaders = { Host: isolated.hostname };
  const other = await signedInClient("Policy tenant B API");
  await grantRole(isolated.tenantId, other.userId, [
    "payroll.view",
    "payroll.run",
  ]);
  otherClient = other.client;

  legalEntityId = isolatedA.legalEntityId;
  employeeA = await seedEmployee(tenant.id, isolatedA.outletId);
  employeeB = await seedEmployee(isolated.tenantId, isolated.outletId);
});

// Bead legend-1213: an active policy blocks any other active policy of the
// same legal entity with a shared employment type. Every case here builds the
// default pkwt policy, so retire what the case created (rows stay for the
// cleanup below; deactivation is not what any case asserts afterwards).
afterEach(async () => {
  if (!isolatedA || policyIds.length === 0) return;
  await asTenant(isolatedA.tenantId, (db) =>
    db.query(
      "UPDATE payroll_policies SET is_active = false WHERE id = ANY($1)",
      [policyIds],
    ),
  );
});

afterAll(async () => {
  for (const tenantId of [isolatedA?.tenantId, isolated?.tenantId]) {
    if (!tenantId) continue;
    await asTenant(tenantId, async (db) => {
      await db.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'payroll-policy-api-%'",
        [tenantId],
      );
      await db.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
        policyIds,
      ]);
      await db.query("DELETE FROM thr_schedules WHERE id = ANY($1)", [thrIds]);
      await db.query("DELETE FROM employees WHERE id = ANY($1)", [
        employeeIds.map((row) => row.id),
      ]);
      await db.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenantId, createdUsers],
      );
      await db.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdRoles],
      );
    });
  }
  if (isolated) await dropIsolatedTenant(isolated);
  if (isolatedA) await dropIsolatedTenant(isolatedA);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("payroll policy API: create, list, update", () => {
  it("[PAYR-01] creates a policy, stores the group code and lists it with the legal entity filter", async () => {
    const created = await createPolicy("A");
    expect(created).toMatchObject({
      tenantId: tenant.id,
      legalEntityId,
      isActive: true,
      employeeGroup: { code: groupCode("A") },
      cycle: { frequency: "monthly", cutoffDay: 25, payDay: 28 },
    });
    const stored = await asTenant(tenant.id, (db) =>
      db.query(
        "SELECT employee_group_code FROM payroll_policies WHERE id = $1",
        [created.id],
      ),
    );
    expect(stored.rows[0].employee_group_code).toBe(groupCode("A"));

    const list = await viewerClient.get(
      `${POLICIES}?legalEntityId=${legalEntityId}&limit=100`,
    );
    expect(list.status).toBe(200);
    expect(list.body.meta.limit).toBe(100);
    expect(list.body.data.map((row: { id: string }) => row.id)).toContain(
      created.id,
    );
    const nobody = await viewerClient.get(
      `${POLICIES}?legalEntityId=${randomUUID()}`,
    );
    expect(nobody.body.data).toEqual([]);
  });

  it("pages by name with a cursor and never repeats a row", async () => {
    const first = await createPolicy("P1");
    // Another employment type: two active policies of one entity never share one.
    const second = await createPolicy("P2", {
      employeeGroup: {
        code: groupCode("P2"),
        name: "Grup P2",
        employmentTypes: ["daily"],
      },
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const response: { status: number; body: PageBody } =
        await viewerClient.get(
          `${POLICIES}?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
      expect(response.status).toBe(200);
      seen.push(...response.body.data.map((row: { id: string }) => row.id));
      cursor = response.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.indexOf(first.id)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(first.id)).toBeLessThan(seen.indexOf(second.id));
  });

  it("[state] updates, deactivates and reactivates; id, group and legal entity stay", async () => {
    const created = await createPolicy("U");
    const patched = await adminClient
      .patch(`${POLICIES}/${created.id}`)
      .set(originHeader)
      .send({
        name: `Kebijakan ${runTag} U2`,
        cycle: { frequency: "daily", payDaysAfterPeriodEnd: 1 },
        jkkRiskClass: "high",
        bpjsProgrammes: ["jkk"],
        idempotencyKey: key(),
      });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.data).toMatchObject({
      id: created.id,
      legalEntityId,
      name: `Kebijakan ${runTag} U2`,
      employeeGroup: created.employeeGroup,
      cycle: { frequency: "daily", payDaysAfterPeriodEnd: 1 },
      jkkRiskClass: "high",
      bpjsProgrammes: ["jkk"],
      isActive: true,
    });
    const off = await adminClient
      .patch(`${POLICIES}/${created.id}`)
      .set(originHeader)
      .send({ isActive: false, idempotencyKey: key() });
    expect(off.body.data.isActive).toBe(false);
    // Fields the patch left out keep their stored value.
    expect(off.body.data.name).toBe(`Kebijakan ${runTag} U2`);
    const on = await adminClient
      .patch(`${POLICIES}/${created.id}`)
      .set(originHeader)
      .send({ isActive: true, idempotencyKey: key() });
    expect(on.body.data.isActive).toBe(true);
    const stored = await asTenant(tenant.id, (db) =>
      db.query(
        "SELECT employee_group_code, employee_group FROM payroll_policies WHERE id = $1",
        [created.id],
      ),
    );
    expect(stored.rows[0].employee_group_code).toBe(groupCode("U"));
  });

  it("[zjwa] re-parses the merged object server-side: a stored row the contract refuses cannot be saved", async () => {
    const created = await createPolicy("Z");
    // Corrupt the row outside the service: pay day before cut-off, same month.
    await asTenant(tenant.id, (db) =>
      db.query(
        `UPDATE payroll_policies
            SET cycle = '{"frequency":"monthly","cutoffDay":20,"payDay":10,"payMonthOffset":0}'::jsonb
          WHERE id = $1`,
        [created.id],
      ),
    );
    const response = await adminClient
      .patch(`${POLICIES}/${created.id}`)
      .set(originHeader)
      .send({ name: "Tidak boleh tersimpan", idempotencyKey: key() });
    expect(response.status).toBe(422);
    const stored = await asTenant(tenant.id, (db) =>
      db.query("SELECT name FROM payroll_policies WHERE id = $1", [created.id]),
    );
    expect(stored.rows[0].name).toBe(`Kebijakan ${runTag} Z`);
    // A list fails loudly while the row is corrupt; put it back for the rest.
    const broken = await viewerClient.get(`${POLICIES}?limit=100`);
    expect(broken.status).toBeGreaterThanOrEqual(400);
    await asTenant(tenant.id, (db) =>
      db.query("UPDATE payroll_policies SET cycle = $2::jsonb WHERE id = $1", [
        created.id,
        JSON.stringify(created.cycle),
      ]),
    );
  });

  it("answers 404 for an unknown policy", async () => {
    const response = await adminClient
      .patch(`${POLICIES}/${randomUUID()}`)
      .set(originHeader)
      .send({ isActive: false, idempotencyKey: key() });
    expect(response.status).toBe(404);
  });

  it("audits field names only, never the policy name", async () => {
    const created = await createPolicy("AU");
    const rows = await asTenant(tenant.id, (db) =>
      db.query(
        "SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2",
        [tenant.id, created.id],
      ),
    );
    expect(rows.rowCount).toBe(1);
    const text = JSON.stringify(rows.rows[0].event);
    expect(text).toContain("payroll.policy.created");
    expect(text).not.toContain(`Kebijakan ${runTag}`);
    expect(text).not.toContain(groupCode("AU"));
  });
});

describe("payroll policy API: permission and input", () => {
  it("[AUTH] answers 401 anonymous, 403 without payroll.run (write) or payroll.view (read)", async () => {
    expect((await agent(app).get(POLICIES)).status).toBe(401);
    expect((await agent(app).get(THR)).status).toBe(401);
    const noRun = await viewerClient
      .post(POLICIES)
      .set(originHeader)
      .send(policyBody("N1"));
    expect(noRun.status).toBe(403);
    const created = await createPolicy("N2");
    expect(
      (
        await viewerClient
          .patch(`${POLICIES}/${created.id}`)
          .set(originHeader)
          .send({ isActive: false, idempotencyKey: key() })
      ).status,
    ).toBe(403);
    expect((await strangerClient.get(POLICIES)).status).toBe(403);
    expect((await strangerClient.get(THR)).status).toBe(403);
    expect(
      (await viewerClient.post(THR).set(originHeader).send(thrBody("N3")))
        .status,
    ).toBe(403);
  });

  it("[TEN-02] rejects a tenantId or an unknown key in the body with 422", async () => {
    for (const extra of [{ tenantId: tenant.id }, { surprise: true }]) {
      const response = await adminClient
        .post(POLICIES)
        .set(originHeader)
        .send(policyBody("V1", extra));
      expect(response.status).toBe(422);
      const thr = await adminClient
        .post(THR)
        .set(originHeader)
        .send(thrBody("V1", extra));
      expect(thr.status).toBe(422);
    }
    const created = await createPolicy("V2");
    for (const extra of [
      { tenantId: tenant.id },
      { legalEntityId },
      { employeeGroup: created.employeeGroup },
    ]) {
      const response = await adminClient
        .patch(`${POLICIES}/${created.id}`)
        .set(originHeader)
        .send({ isActive: false, idempotencyKey: key(), ...extra });
      expect(response.status).toBe(422);
    }
  });

  it("rejects an invalid cycle, a bad query and an empty patch with 422", async () => {
    const badCycle = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(
        policyBody("V3", {
          cycle: {
            frequency: "monthly",
            cutoffDay: 25,
            payDay: 20,
            payMonthOffset: 0,
          },
        }),
      );
    expect(badCycle.status).toBe(422);
    expect(
      (await viewerClient.get(`${POLICIES}?tenantId=${tenant.id}`)).status,
    ).toBe(422);
    expect((await viewerClient.get(`${POLICIES}?cursor=nope`)).status).toBe(
      422,
    );
    expect((await viewerClient.get(`${POLICIES}?limit=0`)).status).toBe(422);
    const created = await createPolicy("V4");
    const empty = await adminClient
      .patch(`${POLICIES}/${created.id}`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(empty.status).toBe(422);
  });

  it("rejects a mutation without Origin with 403", async () => {
    const response = await adminClient.post(POLICIES).send(policyBody("O1"));
    expect(response.status).toBe(403);
  });

  it("answers 422 for a legal entity that is not in the tenant (composite FK)", async () => {
    const unknown = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(policyBody("L1", { legalEntityId: randomUUID() }));
    expect(unknown.status).toBe(422);
    const foreign = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(policyBody("L2", { legalEntityId: isolated.legalEntityId }));
    expect(foreign.status).toBe(422);
  });
});

describe("payroll policy API: conflicts and idempotency", () => {
  it("answers 409 for a second policy of the same legal entity and group code", async () => {
    await createPolicy("D");
    const duplicate = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(policyBody("D", { name: "Nama lain" }));
    expect(duplicate.status).toBe(409);
    // Another group code is fine.
    await createPolicy("D2", {
      employeeGroup: {
        code: groupCode("D2"),
        name: "Grup D2",
        employmentTypes: ["daily"],
      },
    });
  });

  it("replays the first 201 for the same key and body, and refuses the key with another body", async () => {
    const idempotencyKey = key();
    const body = policyBody("I", {}, idempotencyKey);
    const first = await adminClient.post(POLICIES).set(originHeader).send(body);
    expect(first.status).toBe(201);
    policyIds.push(first.body.data.id);
    const replay = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const other = await adminClient
      .post(POLICIES)
      .set(originHeader)
      .send(policyBody("I", { name: "Berbeda" }, idempotencyKey));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("payroll policy API: tenant isolation", () => {
  it("[TEN-01] tenant B cannot list or update tenant A's policy (404), and the row is unchanged", async () => {
    const created = await createPolicy("T");
    const list = await otherClient
      .get(`${POLICIES}?limit=100`)
      .set(otherHeaders);
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(
      created.id,
    );
    const patched = await otherClient
      .patch(`${POLICIES}/${created.id}`)
      .set(otherHeaders)
      .set(originHeader)
      .send({ isActive: false, idempotencyKey: key() });
    expect(patched.status).toBe(404);
    const stored = await asTenant(tenant.id, (db) =>
      db.query("SELECT is_active FROM payroll_policies WHERE id = $1", [
        created.id,
      ]),
    );
    expect(stored.rows[0].is_active).toBe(true);
  });

  it("tenant B creates its own policy with its own legal entity; tenant A does not see it", async () => {
    const response = await otherClient
      .post(POLICIES)
      .set(otherHeaders)
      .set(originHeader)
      .send(policyBody("B", { legalEntityId: isolated.legalEntityId }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    policyIds.push(response.body.data.id);
    expect(response.body.data.tenantId).toBe(isolated.tenantId);
    const list = await viewerClient.get(`${POLICIES}?limit=100`);
    expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(
      response.body.data.id,
    );
  });
});

describe("payroll THR schedule API", () => {
  it("creates a schedule for everyone and for named employees, then lists newest holiday first", async () => {
    const all = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("ALL"));
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    thrIds.push(all.body.data.id);
    expect(all.body.data).toMatchObject({
      tenantId: tenant.id,
      legalEntityId,
      status: "scheduled",
      employeeIds: null,
      holidayDate: "2031-03-31",
    });

    const named = await adminClient
      .post(THR)
      .set(originHeader)
      .send(
        thrBody("NAMED", {
          holidayDate: "2031-12-25",
          tenureAsOfDate: "2031-12-01",
          payDate: "2031-12-20",
          employeeIds: [employeeA, employeeA],
        }),
      );
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    thrIds.push(named.body.data.id);
    // A repeated id is stored once.
    expect(named.body.data.employeeIds).toEqual([employeeA]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const response: { status: number; body: PageBody } =
        await viewerClient.get(
          `${THR}?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
      expect(response.status).toBe(200);
      seen.push(...response.body.data.map((row: { id: string }) => row.id));
      cursor = response.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.indexOf(named.body.data.id)).toBeLessThan(
      seen.indexOf(all.body.data.id),
    );
    expect(seen.indexOf(all.body.data.id)).toBeGreaterThanOrEqual(0);
  });

  it("answers 422 for an unknown employee, another tenant's employee and a foreign legal entity", async () => {
    for (const ids of [[randomUUID()], [employeeA, employeeB], [employeeB]]) {
      const response = await adminClient
        .post(THR)
        .set(originHeader)
        .send(thrBody("E", { employeeIds: ids }));
      expect(response.status).toBe(422);
    }
    const foreign = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("E2", { legalEntityId: isolated.legalEntityId }));
    expect(foreign.status).toBe(422);
    const unknown = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("E3", { legalEntityId: randomUUID() }));
    expect(unknown.status).toBe(422);
  });

  it("rejects a pay date after the holiday, an empty employee list and a bad cursor with 422", async () => {
    const late = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("D1", { payDate: "2031-04-01" }));
    expect(late.status).toBe(422);
    const empty = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("D2", { employeeIds: [] }));
    expect(empty.status).toBe(422);
    expect((await viewerClient.get(`${THR}?cursor=nope`)).status).toBe(422);
    expect(
      (await viewerClient.get(`${THR}?tenantId=${tenant.id}`)).status,
    ).toBe(422);
  });

  it("replays the first 201 for the same key and body, and refuses the key with another body", async () => {
    const idempotencyKey = key();
    const body = thrBody("IDEM", {}, idempotencyKey);
    const first = await adminClient.post(THR).set(originHeader).send(body);
    expect(first.status).toBe(201);
    thrIds.push(first.body.data.id);
    const replay = await adminClient.post(THR).set(originHeader).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const rows = await asTenant(tenant.id, (db) =>
      db.query("SELECT id FROM thr_schedules WHERE name = $1", [body.name]),
    );
    expect(rows.rowCount).toBe(1);
    const other = await adminClient
      .post(THR)
      .set(originHeader)
      .send(thrBody("IDEM", { holidayName: "Natal" }, idempotencyKey));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[TEN-01] tenant B does not see tenant A's schedules and creates its own with its own employee", async () => {
    const own = await otherClient
      .post(THR)
      .set(otherHeaders)
      .set(originHeader)
      .send(
        thrBody("B", {
          legalEntityId: isolated.legalEntityId,
          employeeIds: [employeeB],
        }),
      );
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    thrIds.push(own.body.data.id);
    expect(own.body.data.tenantId).toBe(isolated.tenantId);

    const listB = await otherClient.get(`${THR}?limit=100`).set(otherHeaders);
    expect(listB.status).toBe(200);
    expect(listB.body.data.map((row: { id: string }) => row.id)).toEqual([
      own.body.data.id,
    ]);
    const listA = await viewerClient.get(`${THR}?limit=100`);
    expect(listA.body.data.map((row: { id: string }) => row.id)).not.toContain(
      own.body.data.id,
    );
  });
});
