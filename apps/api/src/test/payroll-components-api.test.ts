// Pay components and employee pay components HTTP API (bead legend-gfcr;
// contract `@starter/shared/hris/payroll` endpoints.ts). Runs the real Express
// app (routers mounted at /api/hris/payroll/components and
// /api/hris/payroll/employees), Better Auth, the RBAC resolver and PostgreSQL
// against the seeded Cafe Legend tenant. Cross-tenant checks call the service
// with a second tenant's context: the HTTP tenant is fixed by the host.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  openPayrollAmount,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import * as service from "../services/payroll-components.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const otherTenant = randomUUID();
const COMPONENTS = "/api/hris/payroll/components";
const employeeUrl = (employeeId: string) =>
  `/api/hris/payroll/employees/${employeeId}/components`;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdComponents: string[] = [];

const key = () => `components-api-${randomUUID()}`;
const codeOf = (prefix = "CMP") =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

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

async function grantRole(
  userId: string,
  permissions: string[],
  tenantId: string = tenant.id,
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
        `Components api ${roleId.slice(0, 8)}`,
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

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function seedEmployee(): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Komponen API', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, `PC-${id.slice(0, 8).toUpperCase()}`, outlet],
    ),
  );
  return id;
}

const componentBody = (overrides: Record<string, unknown> = {}) => ({
  code: codeOf(),
  name: "Tunjangan uji API",
  category: "fixed_allowance",
  recurrence: "fixed",
  taxable: true,
  taxScheme: "gross",
  bpjsBase: true,
  overtimeBase: false,
  thrBase: true,
  displayOrder: 5,
  idempotencyKey: key(),
  ...overrides,
});

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let adminClient: Client;
let viewerClient: Client;
let strangerClient: Client;
let otherAdmin: string;
let employeeId: string;

async function createComponent(overrides: Record<string, unknown> = {}) {
  const response = await adminClient
    .post(COMPONENTS)
    .set(originHeader)
    .send(componentBody(overrides));
  expect(response.status).toBe(201);
  createdComponents.push(response.body.data.id);
  return response.body.data as {
    id: string;
    code: string;
    updatedAt: string;
  };
}

const setAmount = (
  client: Client,
  employee: string,
  componentId: string,
  amountIdr: number,
  effectiveFrom: string,
  idempotencyKey = key(),
) =>
  client
    .put(employeeUrl(employee))
    .set(originHeader)
    .send({ componentId, amountIdr, effectiveFrom, idempotencyKey });

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("Expected a failure");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Components RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `components-rls-${otherTenant.slice(0, 8)}`, tenant.id],
  );
  const admin = await signedInClient("Components admin API");
  await grantRole(admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  const viewer = await signedInClient("Components viewer API");
  await grantRole(viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;
  const stranger = await signedInClient("Components stranger API");
  await grantRole(stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client;
  const other = await signedInClient("Components other-tenant admin");
  await grantRole(other.userId, ["payroll.view", "payroll.run"], otherTenant);
  otherAdmin = other.userId;
  employeeId = await seedEmployee();
});

afterAll(async () => {
  await asTenant(tenant.id, async (db) => {
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'components-api-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdComponents],
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
  await asTenant(otherTenant, async (db) => {
    await db.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await db.query("DELETE FROM roles WHERE tenant_id = $1", [otherTenant]);
  });
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [otherTenant])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("pay components API: permission and input", () => {
  it("[AUTH] answers 401 anonymous, 403 without payroll.run (write) or payroll.view (read)", async () => {
    expect((await agent(app).get(COMPONENTS)).status).toBe(401);
    expect(
      (
        await viewerClient
          .post(COMPONENTS)
          .set(originHeader)
          .send(componentBody())
      ).status,
    ).toBe(403);
    expect((await strangerClient.get(COMPONENTS)).status).toBe(403);
    expect((await strangerClient.get(employeeUrl(employeeId))).status).toBe(
      403,
    );
    expect(
      (
        await viewerClient.put(employeeUrl(employeeId)).set(originHeader).send({
          componentId: randomUUID(),
          amountIdr: 1,
          effectiveFrom: "2026-01-01",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
  });

  it("[TEN-02] rejects tenantId and unknown keys with 422", async () => {
    for (const extra of [{ tenantId: tenant.id }, { isSystem: true }]) {
      const response = await adminClient
        .post(COMPONENTS)
        .set(originHeader)
        .send({ ...componentBody(), ...extra });
      expect(response.status).toBe(422);
    }
    const created = await createComponent();
    const patched = await adminClient
      .patch(`${COMPONENTS}/${created.id}`)
      .set(originHeader)
      .send({ category: "bonus", idempotencyKey: key() });
    expect(patched.status).toBe(422);
    const amount = await adminClient
      .put(employeeUrl(employeeId))
      .set(originHeader)
      .send({
        componentId: created.id,
        amountIdr: 100,
        effectiveFrom: "2026-01-01",
        tenantId: tenant.id,
        idempotencyKey: key(),
      });
    expect(amount.status).toBe(422);
  });

  it("rejects a deduction that is taxable or a wage base, and a bad code, with 422", async () => {
    for (const bad of [
      { category: "custom_deduction", taxable: true },
      { category: "late_deduction", bpjsBase: true, taxable: false },
      { category: "reimbursement", taxable: true },
      { code: "bad code" },
    ]) {
      const response = await adminClient
        .post(COMPONENTS)
        .set(originHeader)
        .send(componentBody(bad));
      expect(response.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("rejects a mutation without Origin with 403 and a bad cursor or unknown query key with 422", async () => {
    expect(
      (await adminClient.post(COMPONENTS).send(componentBody())).status,
    ).toBe(403);
    expect((await viewerClient.get(`${COMPONENTS}?cursor=nope`)).status).toBe(
      422,
    );
    expect(
      (await viewerClient.get(`${COMPONENTS}?tenantId=${tenant.id}`)).status,
    ).toBe(422);
  });
});

describe("pay components API: create, list, update", () => {
  it("creates a component with kind from the category, lists it and pages by code", async () => {
    const earning = await createComponent();
    const deduction = await adminClient
      .post(COMPONENTS)
      .set(originHeader)
      .send(
        componentBody({
          category: "custom_deduction",
          taxable: false,
          bpjsBase: false,
          thrBase: false,
        }),
      );
    expect(deduction.status).toBe(201);
    createdComponents.push(deduction.body.data.id);
    expect(deduction.body.data).toMatchObject({
      tenantId: tenant.id,
      kind: "deduction",
      isSystem: false,
      isActive: true,
    });

    const first = await viewerClient.get(`${COMPONENTS}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await viewerClient.get(
      `${COMPONENTS}?limit=1&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.data[0].code > first.body.data[0].code).toBe(true);

    const all = await viewerClient.get(`${COMPONENTS}?limit=100`);
    const ids = all.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(earning.id);
    expect(
      all.body.data.every(
        (row: { tenantId: string }) => row.tenantId === tenant.id,
      ),
    ).toBe(true);
  });

  it("answers 409 for a duplicate code, and replays the first 201 for the same key", async () => {
    const created = await createComponent();
    const duplicate = await adminClient
      .post(COMPONENTS)
      .set(originHeader)
      .send(componentBody({ code: created.code }));
    expect(duplicate.status).toBe(409);

    const idempotencyKey = key();
    const payload = componentBody({ idempotencyKey });
    const one = await adminClient
      .post(COMPONENTS)
      .set(originHeader)
      .send(payload);
    expect(one.status).toBe(201);
    createdComponents.push(one.body.data.id);
    const replay = await adminClient
      .post(COMPONENTS)
      .set(originHeader)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(one.body.data);
    const reused = await adminClient
      .post(COMPONENTS)
      .set(originHeader)
      .send(componentBody({ idempotencyKey }));
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("updates name, flags, order and activity; code and category stay", async () => {
    const created = await createComponent();
    const response = await adminClient
      .patch(`${COMPONENTS}/${created.id}`)
      .set(originHeader)
      .send({
        name: "Nama baru",
        taxable: false,
        displayOrder: 9,
        isActive: false,
        idempotencyKey: key(),
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: created.id,
      code: created.code,
      category: "fixed_allowance",
      name: "Nama baru",
      taxable: false,
      displayOrder: 9,
      isActive: false,
    });
    expect(response.body.data.updatedAt >= created.updatedAt).toBe(true);
  });

  it("[zjwa] re-parses the merged row: a patch cannot make a deduction taxable or an expense income", async () => {
    const deduction = await createComponent({
      category: "custom_deduction",
      taxable: false,
      bpjsBase: false,
      thrBase: false,
    });
    for (const patch of [
      { taxable: true },
      { bpjsBase: true },
      { overtimeBase: true },
      { thrBase: true },
    ]) {
      const response = await adminClient
        .patch(`${COMPONENTS}/${deduction.id}`)
        .set(originHeader)
        .send({ ...patch, idempotencyKey: key() });
      expect(response.status, JSON.stringify(patch)).toBe(422);
    }
    const reimbursement = await createComponent({
      category: "reimbursement",
      taxable: false,
    });
    const income = await adminClient
      .patch(`${COMPONENTS}/${reimbursement.id}`)
      .set(originHeader)
      .send({ taxable: true, idempotencyKey: key() });
    expect(income.status).toBe(422);
    const rows = await asTenant(tenant.id, (db) =>
      db.query(
        "SELECT id, taxable FROM pay_components WHERE id = ANY($1) AND taxable",
        [[deduction.id, reimbursement.id]],
      ),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("answers 404 for an unknown component and 422 for an empty patch", async () => {
    const missing = await adminClient
      .patch(`${COMPONENTS}/${randomUUID()}`)
      .set(originHeader)
      .send({ name: "x", idempotencyKey: key() });
    expect(missing.status).toBe(404);
    const created = await createComponent();
    const empty = await adminClient
      .patch(`${COMPONENTS}/${created.id}`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(empty.status).toBe(422);
  });

  it("audits a creation and an update with field names only (no name, no code)", async () => {
    const created = await createComponent({ name: "Rahasia Nama Audit" });
    await adminClient
      .patch(`${COMPONENTS}/${created.id}`)
      .set(originHeader)
      .send({ name: "Rahasia Nama Baru", idempotencyKey: key() });
    const rows = await asTenant(tenant.id, (db) =>
      db.query<{ text: string }>(
        `SELECT event::text AS text FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenant.id, created.id],
      ),
    );
    expect(rows.rowCount).toBe(2);
    for (const row of rows.rows) {
      expect(row.text).not.toContain("Rahasia");
      expect(row.text).not.toContain(created.code);
    }
  });
});

describe("employee pay components API: amounts (HR-03)", () => {
  it("sets, lists and seals an amount; the raw column holds no plaintext", async () => {
    const component = await createComponent();
    const amount = 7_345_921;
    const set = await setAmount(
      adminClient,
      employeeId,
      component.id,
      amount,
      "2026-01-01",
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({
      tenantId: tenant.id,
      employeeId,
      componentId: component.id,
      amountIdr: amount,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    });

    const list = await viewerClient.get(employeeUrl(employeeId));
    expect(list.status).toBe(200);
    expect(
      list.body.data.find((row: { id: string }) => row.id === set.body.data.id)
        .amountIdr,
    ).toBe(amount);

    const raw = await asTenant(tenant.id, (db) =>
      db.query<{ amount_encrypted: Buffer; pii_key_version: number }>(
        "SELECT amount_encrypted, pii_key_version FROM employee_pay_components WHERE id = $1",
        [set.body.data.id],
      ),
    );
    const sealed = raw.rows[0]!.amount_encrypted;
    expect(raw.rows[0]!.pii_key_version).toBe(PAYROLL_SEAL_KEY_VERSION);
    for (const encoding of ["utf8", "latin1", "hex", "base64"] as const)
      expect(sealed.toString(encoding)).not.toContain(String(amount));
  });

  it("keeps the amount out of the idempotency record and the audit log", async () => {
    const component = await createComponent();
    const amount = 8_123_457;
    const idempotencyKey = key();
    const set = await setAmount(
      adminClient,
      employeeId,
      component.id,
      amount,
      "2026-02-01",
      idempotencyKey,
    );
    expect(set.status).toBe(200);
    const replay = await setAmount(
      adminClient,
      employeeId,
      component.id,
      amount,
      "2026-02-01",
      idempotencyKey,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(set.body.data);
    const stored = await asTenant(tenant.id, (db) =>
      db.query<{ text: string }>(
        "SELECT response::text AS text FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
        [tenant.id, idempotencyKey],
      ),
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]!.text).not.toContain(String(amount));
    const audit = await asTenant(tenant.id, (db) =>
      db.query<{ text: string }>(
        `SELECT event::text AS text FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenant.id, set.body.data.id],
      ),
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.text).not.toContain(String(amount));
    expect(audit.rows[0]!.text).not.toContain("amount");
  });

  it("[HR-03] a ciphertext copied to another row does not open", async () => {
    const component = await createComponent();
    const first = await setAmount(
      adminClient,
      employeeId,
      component.id,
      4_000_000,
      "2026-01-01",
    );
    const second = await setAmount(
      adminClient,
      employeeId,
      component.id,
      5_000_000,
      "2026-06-01",
    );
    const rows = await asTenant(tenant.id, (db) =>
      db.query<{ id: string; amount_encrypted: Buffer }>(
        "SELECT id, amount_encrypted FROM employee_pay_components WHERE id = ANY($1)",
        [[first.body.data.id, second.body.data.id]],
      ),
    );
    const sealedFirst = rows.rows.find(
      (row) => row.id === first.body.data.id,
    )!.amount_encrypted;
    const binding = (rowId: string) => ({
      tenantId: tenant.id,
      table: "employee_pay_components" as const,
      rowId,
      field: "amount" as const,
    });
    expect(
      openPayrollAmount(
        sealedFirst,
        binding(first.body.data.id),
        PAYROLL_SEAL_KEY_VERSION,
      ),
    ).toBe(4_000_000);
    expect(() =>
      openPayrollAmount(
        sealedFirst,
        binding(second.body.data.id),
        PAYROLL_SEAL_KEY_VERSION,
      ),
    ).toThrow();
  });

  it("closes the open row the day before a later start; same start 409; earlier start 422", async () => {
    const component = await createComponent();
    const open = await setAmount(
      adminClient,
      employeeId,
      component.id,
      3_000_000,
      "2026-03-01",
    );
    expect(open.status).toBe(200);

    const next = await setAmount(
      adminClient,
      employeeId,
      component.id,
      3_500_000,
      "2026-07-01",
    );
    expect(next.status).toBe(200);
    expect(next.body.data.effectiveTo).toBeNull();
    const history = await viewerClient.get(
      `${employeeUrl(employeeId)}?limit=100`,
    );
    const mine = history.body.data.filter(
      (row: { componentId: string }) => row.componentId === component.id,
    );
    expect(mine).toHaveLength(2);
    expect(
      mine.find((row: { id: string }) => row.id === open.body.data.id),
    ).toMatchObject({ effectiveTo: "2026-06-30", amountIdr: 3_000_000 });
    expect(
      mine.find((row: { id: string }) => row.id === next.body.data.id),
    ).toMatchObject({ effectiveTo: null, amountIdr: 3_500_000 });

    // Same start: amounts are never rewritten.
    const same = await setAmount(
      adminClient,
      employeeId,
      component.id,
      9_999_999,
      "2026-07-01",
    );
    expect(same.status).toBe(409);
    const sameAsClosed = await setAmount(
      adminClient,
      employeeId,
      component.id,
      9_999_999,
      "2026-03-01",
    );
    expect(sameAsClosed.status).toBe(409);

    // Earlier than the open row.
    const earlier = await setAmount(
      adminClient,
      employeeId,
      component.id,
      1,
      "2026-05-01",
    );
    expect(earlier.status).toBe(422);
    const after = await viewerClient.get(
      `${employeeUrl(employeeId)}?limit=100`,
    );
    expect(
      after.body.data.filter(
        (row: { componentId: string }) => row.componentId === component.id,
      ),
    ).toHaveLength(2);
  });

  it("answers 404 for an unknown employee or component and 422 for an inactive one", async () => {
    const component = await createComponent();
    expect(
      (
        await setAmount(
          adminClient,
          randomUUID(),
          component.id,
          1,
          "2026-01-01",
        )
      ).status,
    ).toBe(404);
    expect((await viewerClient.get(employeeUrl(randomUUID()))).status).toBe(
      404,
    );
    expect(
      (await setAmount(adminClient, employeeId, randomUUID(), 1, "2026-01-01"))
        .status,
    ).toBe(404);

    await adminClient
      .patch(`${COMPONENTS}/${component.id}`)
      .set(originHeader)
      .send({ isActive: false, idempotencyKey: key() });
    expect(
      (await setAmount(adminClient, employeeId, component.id, 1, "2026-01-01"))
        .status,
    ).toBe(422);
  });

  it("rejects a negative or fractional amount and a bad date with 422", async () => {
    const component = await createComponent();
    for (const bad of [
      { amountIdr: -1, effectiveFrom: "2026-01-01" },
      { amountIdr: 10.5, effectiveFrom: "2026-01-01" },
      { amountIdr: 10, effectiveFrom: "01-01-2026" },
    ]) {
      const response = await adminClient
        .put(employeeUrl(employeeId))
        .set(originHeader)
        .send({ componentId: component.id, idempotencyKey: key(), ...bad });
      expect(response.status, JSON.stringify(bad)).toBe(422);
    }
  });
});

describe("pay components: tenant isolation", () => {
  it("[TEN-01] another tenant cannot read, update or set amounts on this tenant's rows", async () => {
    const component = await createComponent();
    const set = await setAmount(
      adminClient,
      employeeId,
      component.id,
      6_000_000,
      "2026-01-01",
    );
    expect(set.status).toBe(200);
    const theirs = scope(otherTenant);

    const listed = await service.listPayComponents(theirs, otherAdmin, {
      limit: 100,
    });
    expect(listed.data.map((row) => row.id)).not.toContain(component.id);
    expect(
      (
        await failure(
          service.updatePayComponent(theirs, otherAdmin, component.id, {
            name: "Bocor",
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          service.listEmployeePayComponents(theirs, otherAdmin, employeeId, {
            limit: 100,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          service.setEmployeePayComponent(theirs, otherAdmin, employeeId, {
            componentId: component.id,
            amountIdr: 1 as never,
            effectiveFrom: "2026-01-01" as never,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(404);

    const unchanged = await asTenant(tenant.id, (db) =>
      db.query("SELECT name FROM pay_components WHERE id = $1", [component.id]),
    );
    expect(unchanged.rows[0]!.name).toBe("Tunjangan uji API");

    // The same code is free in the other tenant (unique per tenant).
    const mirror = await service.createPayComponent(theirs, otherAdmin, {
      ...componentBody({ code: component.code }),
    } as never);
    expect(mirror.tenantId).toBe(otherTenant);
    await asTenant(otherTenant, (db) =>
      db.query("DELETE FROM pay_components WHERE id = $1", [mirror.id]),
    );
  });
});
