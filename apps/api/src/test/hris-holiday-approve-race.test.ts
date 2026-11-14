// Repro for bead legend-agn0i: approving a leave request while a holiday is
// created, moved or deleted on a date inside it, and concurrent holiday
// creates on one (outlet, date), must never answer 5xx (no unique-violation
// leak, no deadlock 40P01). Runs the real Express app, Better Auth, the RBAC
// resolver, the approval matrix and PostgreSQL against the seeded Cafe Legend
// tenant. Flow map: hris-holiday.service.ts createHoliday/updateHoliday/
// deleteHoliday, hris-leave-request.service.ts applyOutcome and
// hris-leave-collective.service.ts reverseCollectiveLeaveDeductions.
//
// Fixture rows are unique to this file: leave type code and holiday names are
// prefixed `HRACE`, idempotency keys `hrace-`, all dates are in 2037, so
// cleanup only touches this file's rows.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const ACTIONS = ["leave"];
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
        `Holiday race ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(db, userId, roleId, scope);
  });
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
       VALUES ($1, $2, $3, $4, 'Karyawan Race Libur', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        input.userId,
        `HR-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hrClient: Client;
let staffClient: Client;
let managerClient: Client;
let leaveTypeId: string;

const key = () => `hrace-${randomUUID()}`;
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

type Reply = { status: number; body: unknown };
const describeReply = (label: string, reply: Reply) =>
  `${label}: ${reply.status} ${JSON.stringify(reply.body)}`;
/** No 5xx and no Postgres deadlock text anywhere in the answers. */
function expectNoServerError(replies: Record<string, Reply>) {
  for (const [label, reply] of Object.entries(replies)) {
    expect(reply.status, describeReply(label, reply)).toBeLessThan(500);
    expect(JSON.stringify(reply.body), describeReply(label, reply)).not.toMatch(
      /40P01|deadlock/i,
    );
  }
}

/** ISO date `delta` calendar days after `date` (plain calendar math, UTC). */
function addDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const holidayBody = (overrides: Record<string, unknown>) => ({
  date: "2037-01-05",
  name: "HRACE libur",
  type: "company",
  outletId: null,
  idempotencyKey: key(),
  ...overrides,
});

async function requestLeave(startDate: string, endDate: string) {
  const created = await post(staffClient, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate,
    endDate,
    reason: "Race libur",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const approve = (leaveRequestId: string) =>
  post(managerClient, `/api/hris/leave/requests/${leaveRequestId}/decision`, {
    action: "approve",
    idempotencyKey: key(),
  });

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
  // §3.7: leave requests go to the outlet manager, one level.
  for (const action of ACTIONS)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, $2, NULL, $3, 1)`,
      [tenant.id, action, await templateRoleId("outlet_manager")],
    );

  const hr = await signedInClient("HR Race Libur", { mfa: true });
  await grantCustomRole(hr.userId, ["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  hrClient = hr.client;

  const staff = await signedInClient("Staf Race Libur");
  await grantCustomRole(
    staff.userId,
    ["self.profile.view", "self.leave.request", "self.attendance.clock"],
    { type: "outlet", id: outlet.id },
  );
  staffClient = staff.client;

  const manager = await signedInClient("Manajer Race Libur", { mfa: true });
  await grantTemplateRole(manager.userId, "outlet_manager", outlet.id);
  managerClient = manager.client;

  await seedEmployee({ userId: staff.userId, outletId: outlet.id });

  const type = await post(hrClient, "/api/hris/leave/types", {
    code: "HRACE_ANNUAL",
    name: "Cuti race libur",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "100.0000",
      carryOverMaxDays: "5.0000",
      carryOverExpiryMonths: 3,
      tracksBalance: true,
      accrual: "upfront",
      negativeAllowanceDays: "0.0000",
    },
    idempotencyKey: key(),
  });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  leaveTypeId = type.body.data.id;
  // The balance for the test year only exists after the accrual run.
  const accrual = await post(hrClient, "/api/hris/leave/accruals/run", {
    period: "2037-01",
  });
  expect(accrual.status, JSON.stringify(accrual.body)).toBeLessThan(300);
});

afterAll(async () => {
  await asTenant(async (db) => {
    const mine = `employee_id = ANY($2::uuid[])`;
    const types = `SELECT id FROM leave_types WHERE tenant_id = $1 AND code LIKE 'HRACE%'`;
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
    // The accrual run in beforeAll grants every tracked type of the tenant, so
    // drop everything it wrote for the test year (2037 belongs to this file).
    await db.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND period_year = 2037`,
      [tenant.id],
    );
    await db.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND period LIKE '2037%'`,
      [tenant.id],
    );
    await db.query(
      `DELETE FROM leave_types WHERE tenant_id = $1 AND code LIKE 'HRACE%'`,
      [tenant.id],
    );
    await db.query(
      `DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'HRACE %'`,
      [tenant.id],
    );
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'hrace-%'",
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

describe("legend-agn0i holiday write races", () => {
  it("[legend-agn0i] 8 concurrent creates of one (outlet, date): exactly one 201, the rest 409, never 5xx", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        post(
          hrClient,
          "/api/hris/holidays",
          holidayBody({
            date: "2037-01-05",
            name: `HRACE serentak ${index}`,
            outletId: outlet.id,
            idempotencyKey: key(),
          }),
        ),
      ),
    );
    const statuses = replies.map((reply) => reply.status);
    const detail = replies
      .map((reply, index) => describeReply(`#${index}`, reply))
      .join("\n");
    expect(
      statuses.filter((status) => status >= 500),
      detail,
    ).toEqual([]);
    expect(
      statuses.filter((status) => status === 201),
      detail,
    ).toHaveLength(1);
    expect(
      statuses.filter((status) => status === 409),
      detail,
    ).toHaveLength(7);
  });

  it("[legend-agn0i] creating a holiday inside a pending leave while it is approved: 15 rounds, never 5xx", async () => {
    for (let round = 0; round < 15; round += 1) {
      const start = addDays("2037-03-01", round * 4);
      const middle = addDays(start, 1);
      const leaveId = await requestLeave(start, addDays(start, 2));
      const [holiday, decision] = await Promise.all([
        post(
          hrClient,
          "/api/hris/holidays",
          holidayBody({
            date: middle,
            name: `HRACE tengah cuti ${round}`,
            type: round % 2 === 0 ? "company" : "national",
          }),
        ),
        approve(leaveId),
      ]);
      expectNoServerError({
        [`round ${round} holiday`]: holiday,
        [`round ${round} approve`]: decision,
      });
    }
  }, 90_000);

  it("[legend-agn0i] moving or deleting collective holidays on one date while the leave over it is approved: 8 rounds, never 5xx and no 40P01", async () => {
    for (let round = 0; round < 8; round += 1) {
      const start = addDays("2037-06-01", round * 5);
      const day = addDays(start, 1);
      const leaveId = await requestLeave(start, addDays(start, 3));
      // A tenant-wide and an outlet row on the same collective date: both
      // writes serialize on the per-date advisory lock after their row locks.
      const wide = await post(
        hrClient,
        "/api/hris/holidays",
        holidayBody({
          date: day,
          name: `HRACE bersama luas ${round}`,
          type: "collective",
          outletId: null,
        }),
      );
      const own = await post(
        hrClient,
        "/api/hris/holidays",
        holidayBody({
          date: day,
          name: `HRACE bersama outlet ${round}`,
          type: "collective",
          outletId: outlet.id,
        }),
      );
      expect(wide.status, JSON.stringify(wide.body)).toBe(201);
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      const wideId = wide.body.data.id as string;
      const ownId = own.body.data.id as string;

      const writes =
        round % 2 === 0
          ? [
              patch(hrClient, `/api/hris/holidays/${wideId}`, {
                date: addDays(day, 1),
                idempotencyKey: key(),
              }),
              del(hrClient, `/api/hris/holidays/${ownId}`),
            ]
          : [
              del(hrClient, `/api/hris/holidays/${wideId}`),
              patch(hrClient, `/api/hris/holidays/${ownId}`, {
                type: "company",
                idempotencyKey: key(),
              }),
            ];
      const [first, second, decision] = await Promise.all([
        ...writes,
        approve(leaveId),
      ]);
      expectNoServerError({
        [`round ${round} write A`]: first,
        [`round ${round} write B`]: second,
        [`round ${round} approve`]: decision,
      });
    }
  }, 90_000);
});
