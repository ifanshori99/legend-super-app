// legend-p30t3 (1087): the checklist task list pages with a three-key cursor
// [kind, sortOrder, id]. A cursor whose kind or id key contains a NUL character
// (\u0000) must be refused with 422 VALIDATION_ERROR, like cursorPair does for
// the employee and SOP lists (hris-cursor-nul.test.ts, legend-uese). PostgreSQL
// text cannot hold NUL, so today such a cursor reaches the database and ends in
// a 500. Expected behaviour comes from the shared cursor contract
// (packages/shared/src/core/pagination.ts) and the brief; everything goes
// through HTTP against the real Express app, Better Auth, RBAC and PostgreSQL.
//
// Assumptions: the endpoint is GET /api/hris/employees/:employeeId/checklist-tasks
// (shared contract listChecklistTasks); the actor holds hr.employee.view and
// hr.employee.manage tenant-wide; the employee has no tasks, which is fine
// because the cursor is decoded before any row is read. A well-formed cursor
// without NUL keeps answering 200 (no regression).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

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
let employeeId: string;

beforeAll(async () => {
  hr = agent(app);
  const email = await signUp(hr, "HR Checklist Cursor NUL");
  const session = await hr.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'HR checklist cursor NUL', false, $3, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        JSON.stringify(["hr.employee.view", "hr.employee.manage"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Cursor Checklist', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        `CCN-${employeeId.slice(0, 8).toUpperCase()}`,
        outlet.id,
      ],
    );
  });
}, 60_000);

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

const nulText = "abc\u0000def";
const shapes: Array<[string, () => string]> = [
  ["NUL in the kind key", () => encodeCursor([nulText, "1", randomUUID()])],
  ["NUL in the id key", () => encodeCursor(["onboarding", "1", nulText])],
  ["NUL in both kind and id", () => encodeCursor([nulText, "1", nulText])],
  ["a lone NUL as the kind", () => encodeCursor(["\u0000", "1", randomUUID()])],
  ["a lone NUL as the id", () => encodeCursor(["onboarding", "1", "\u0000"])],
];

const list = (cursor: string) =>
  hr.get(
    `/api/hris/employees/${employeeId}/checklist-tasks?limit=5&cursor=${encodeURIComponent(cursor)}`,
  );

describe("[legend-p30t3] checklist task cursor keys containing NUL are a 422, not a 500", () => {
  for (const [shape, build] of shapes) {
    it(`${shape} answers 422 VALIDATION_ERROR`, async () => {
      const response = await list(build());
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body?.error?.code).toBe("VALIDATION_ERROR");
    });
  }

  it("a well-formed cursor without NUL is still accepted (no regression)", async () => {
    const response = await list(
      encodeCursor(["onboarding", "1", randomUUID()]),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});
