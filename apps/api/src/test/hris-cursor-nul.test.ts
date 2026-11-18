// legend-uese: a pagination cursor whose keys contain a NUL character
// (\u0000) must be refused with a 422 validation error. PostgreSQL text cannot
// hold NUL, so today such a cursor would fall through to the database and end
// in a 500. Expected behaviour comes from the shared cursor contract
// (packages/shared/src/core/pagination.ts: a cursor the API cannot honour is a
// validation error) and the task brief; everything goes through HTTP against
// the real Express app, Better Auth, RBAC and PostgreSQL.
//
// Assumptions: the brief names no endpoint, so the check runs against two HRIS
// list endpoints that page with a two-key cursor (employees, SOP documents).
// Because their key order is not in the contract, each is probed with NUL in
// the first key, in the second key and in both. A well-formed cursor taken
// from a real page keeps working (no regression).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0]!;
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let hr: ReturnType<typeof agent>;

beforeAll(async () => {
  hr = agent(app);
  await signUp(hr, "HR Cursor NUL");
  const session = await hr.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'HR cursor NUL', false, $3, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        JSON.stringify(["hr.employee.view", "hr.sop.manage"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
    // Two employees so that limit=1 yields a real next-page cursor.
    for (const name of ["Cursor Satu", "Cursor Dua"]) {
      const id = randomUUID();
      createdEmployees.push(id);
      await client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, NULL, $3, $4, $5, 'pkwtt', '2025-03-01', 'active')`,
        [id, tenant.id, `CUR-${id.slice(0, 8).toUpperCase()}`, name, outlet.id],
      );
    }
  });
});

afterAll(async () => {
  try {
    await asTenant(async (client) => {
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [tenant.id, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdRoles],
      );
    });
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } finally {
    await owner.end();
  }
});

const endpoints = [
  ["employees", "/api/hris/employees"],
  ["SOP documents", "/api/hris/sop-documents"],
] as const;

const nulText = "abc\u0000def";
const shapes: Array<[string, () => string]> = [
  ["NUL in the first key", () => encodeCursor([nulText, randomUUID()])],
  ["NUL in the second key", () => encodeCursor(["abc", nulText])],
  ["NUL in both keys", () => encodeCursor([nulText, nulText])],
  ["a lone NUL as the first key", () => encodeCursor(["\u0000", randomUUID()])],
];

describe("[legend-uese] cursor keys containing NUL are a 422, not a 500", () => {
  for (const [label, path] of endpoints) {
    for (const [shape, build] of shapes) {
      it(`${label}: ${shape} answers 422`, async () => {
        const response = await hr.get(
          `${path}?limit=5&cursor=${encodeURIComponent(build())}`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(422);
      });
    }
  }

  it("employees: a cursor from a real page still pages on (no regression)", async () => {
    const first = await hr.get("/api/hris/employees?limit=1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const next = first.body?.meta?.nextCursor as string | null;
    expect(next, "two seeded employees give a second page").toBeTruthy();
    const second = await hr.get(
      `/api/hris/employees?limit=1&cursor=${encodeURIComponent(next!)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
  });
});
