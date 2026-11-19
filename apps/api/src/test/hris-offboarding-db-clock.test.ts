// legend-e3qgo (tier K, access). The exit clearance (POST
// /api/hris/offboardings/:id/revoke-access) ends the leaver's role assignments.
// The `valid_until` it stamps must come from the DATABASE clock
// (SELECT clock_timestamp()) read AFTER the per-tenant advisory lock
// `legend:role-assignment-end:<tenant>`, never from the application `Date`.
// Expected behavior comes from PRD v1.7 §3.7 / TEN-03 (grant and end order must be
// consistent for every reader, which only the shared DB clock guarantees) and
// docs/briefs/1172-access-audit-guard.md "Tambahan: legend-e3qgo", not from the
// service code. Sibling proof for grant/end: access-role-assignment-db-clock.test.ts.
// Assumptions:
// - The path is driven over HTTP in-process (supertest on the same Node process),
//   so faking the application `Date` with vi.useFakeTimers({ toFake: ["Date"] })
//   reaches the service. Only `Date` is faked; timers stay real.
// - Active assignments are ended with valid_until = DB clock after the lock
//   (an assignment already active, valid_from one hour ago, valid_until NULL).
// - Skewed app clock: once 10 s behind and once 10 s ahead of the real clock.
//   Code that stamps with `new Date()` writes a time before the lock holder's
//   reading (behind) or after the call settled (ahead) and fails. 10 s is far
//   larger than the ~250 ms the lock is held and smaller than any session or
//   MFA freshness window, so the request is still authorized.
// - Proof that the time is read AFTER the lock: the holder waits 200 ms after the
//   call parked, then reads clock_timestamp() on its own connection and commits.
//   The stamp must be >= that reading (a read before the lock, or the
//   transaction-start now(), is earlier). Lower bound uses
//   date_trunc('milliseconds', ...) because JS/pg round-trips drop microseconds.
//   Comparisons run in SQL on DB timestamps, so Node/DB clock drift is harmless.
// - The barrier is best effort and never throws when no waiter appears; the
//   waiter assertion comes last so a missing lock fails on the stamps first.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const LAST_DAY = "2026-01-15"; // strictly in the past: the exit is due
const FAR_FUTURE = "2034-09-30"; // accepted when the exit is created
const APP_CLOCK_SKEW_MS = 10_000;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];

type Client = ReturnType<typeof agent>;

let jkt: string;
let hrMgr: Client;
let hrTenant: Client;

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

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

async function newRole(permissions: string[], scopeTypes: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Offboarding DB clock ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(scopeTypes),
    ],
  );
  return roleId;
}

/** Active permanent assignment, backdated one hour (valid_until IS NULL). */
async function assignRole(input: {
  userId: string;
  roleId: string;
  scope: { type: "tenant" } | { type: "outlet"; id: string };
}) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)
     RETURNING id`,
    [
      tenant.id,
      input.userId,
      input.roleId,
      input.scope.type,
      input.scope.type === "outlet" ? input.scope.id : null,
    ],
  );
  return rows[0]!.id;
}

async function templateRoleId(templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Keluar', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenant.id,
      cafeLegendPlatformFixtures.brand.id,
      cafeLegendPlatformFixtures.legalEntity.id,
      `OC-${id.slice(0, 8)}`.toUpperCase(),
      `Outlet jam DB ${label}`,
    ],
  );
  return id;
}

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId, sessionId: session.body.session.id as string };
}

async function seedEmployee(userId: string, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Keluar Jam DB', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenant.id, userId, `OC-${id.slice(0, 8).toUpperCase()}`, outletId],
  );
  return id;
}

/** An employee with a login and two active outlet-scope role assignments. */
async function makeLeaver() {
  const { userId, sessionId } = await signedInClient("Keluar Jam DB", {
    mfa: true,
  });
  const selfRole = await newRole(
    ["self.profile.view", "self.schedule.view"],
    ["outlet"],
  );
  const assignmentIds = [
    await assignRole({
      userId,
      roleId: selfRole,
      scope: { type: "outlet", id: jkt },
    }),
    await assignRole({
      userId,
      roleId: await templateRoleId("cashier"),
      scope: { type: "outlet", id: jkt },
    }),
  ];
  await owner.query(
    `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
    [sessionId, tenant.id],
  );
  const employeeId = await seedEmployee(userId, jkt);
  return { userId, employeeId, assignmentIds };
}

/** A due exit (last working day in the past) for the employee. */
async function dueOffboarding(employeeId: string) {
  const created = await post(
    hrMgr,
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "termination",
      reason: "Akhir hubungan kerja uji jam DB.",
      lastWorkingDate: FAR_FUTURE,
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body.data as { id: string }).id;
  await asTenant((client) =>
    client.query(
      "UPDATE hris_offboardings SET last_working_date = $2 WHERE tenant_id = $3 AND id = $1",
      [id, LAST_DAY, tenant.id],
    ),
  );
  return id;
}

/** Poll (by iteration count, the app Date is faked) until a session waits. */
async function waitForLockWaiter(
  client: PoolClient,
  lockKey: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const { rows } = await client.query<{ waiting: boolean }>(
      `WITH k AS (SELECT hashtextextended($1, 0) AS key)
       SELECT EXISTS (
         SELECT 1 FROM pg_locks l, k
         WHERE l.locktype = 'advisory'
           AND NOT l.granted
           AND l.classid::bigint = ((k.key >> 32) & 4294967295)
           AND l.objid::bigint = (k.key & 4294967295)
       ) AS waiting`,
      [lockKey],
    );
    if (rows[0]!.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

type Bracket = {
  status: number;
  body: unknown;
  sawWaiter: boolean;
  /** DB clock read by the lock holder just before it released the lock. */
  releasedAt: string;
  /** DB clock read right after the request settled. */
  doneAt: string;
};

/**
 * Hold the tenant lock, start the clearance (not awaited) with the app Date
 * faked `skewMs` away from the real clock, wait until it parks, wait 200 ms,
 * read the DB clock, release. Always restores real timers.
 */
async function revokeAfterLock(
  offboardingId: string,
  skewMs: number,
): Promise<Bracket> {
  const lockKey = `legend:role-assignment-end:${tenant.id}`;
  const holder = await owner.connect();
  let pending: Promise<{ status: number; body: unknown }> | null = null;
  let sawWaiter = false;
  let releasedAt = "";
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + skewMs));
    pending = (async () => {
      const response = await post(
        hrTenant,
        `/api/hris/offboardings/${offboardingId}/revoke-access`,
        {},
      );
      return { status: response.status, body: response.body as unknown };
    })();

    sawWaiter = await waitForLockWaiter(holder, lockKey);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { rows } = await holder.query<{ t: string }>(
      "SELECT clock_timestamp()::text AS t",
    );
    releasedAt = rows[0]!.t;
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    vi.useRealTimers();
    throw error;
  } finally {
    holder.release();
  }
  let response: { status: number; body: unknown };
  try {
    response = await pending!;
  } finally {
    vi.useRealTimers();
  }
  const { rows } = await owner.query<{ t: string }>(
    "SELECT clock_timestamp()::text AS t",
  );
  return { ...response, sawWaiter, releasedAt, doneAt: rows[0]!.t };
}

/** Every assignment ended inside [lock released, request settled] by the DB clock. */
async function endedInsideBracket(assignmentIds: string[], run: Bracket) {
  const { rows } = await owner.query<{
    id: string;
    ended: boolean;
    after_release: boolean | null;
    before_done: boolean | null;
  }>(
    `SELECT id,
            valid_until IS NOT NULL AS ended,
            valid_until >= date_trunc('milliseconds', $2::timestamptz) AS after_release,
            valid_until <= $3::timestamptz AS before_done
       FROM role_assignments
      WHERE id = ANY($1::uuid[])`,
    [assignmentIds, run.releasedAt, run.doneAt],
  );
  return rows;
}

beforeAll(async () => {
  jkt = await seedOutlet("A");

  const manager = await signedInClient("Manajer HR Jam DB", { mfa: true });
  await assignRole({
    userId: manager.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["outlet"],
    ),
    scope: { type: "outlet", id: jkt },
  });
  hrMgr = manager.client;

  // Clearance is a tenant-wide act: tenant-scope hr.employee.manage.
  const tenantHr = await signedInClient("HR Pusat Jam DB", { mfa: true });
  await assignRole({
    userId: tenantHr.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["tenant"],
    ),
    scope: { type: "tenant" },
  });
  hrTenant = tenantHr.client;
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await asTenant(async (client) => {
    await client.query(
      `DELETE FROM hris_checklist_task_actions WHERE tenant_id = $1 AND task_id IN
         (SELECT id FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[]))`,
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN
         (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[]))`,
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM push_subscriptions WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
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
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

describe("legend-e3qgo exit clearance stamps valid_until with the DB clock after the lock", () => {
  it("legend-e3qgo clearance with the app clock behind: valid_until is the DB clock read after the lock, not the lagging app time", async () => {
    const leaver = await makeLeaver();
    const offboardingId = await dueOffboarding(leaver.employeeId);

    const run = await revokeAfterLock(offboardingId, -APP_CLOCK_SKEW_MS);

    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const rows = await endedInsideBracket(leaver.assignmentIds, run);
    expect(rows).toHaveLength(leaver.assignmentIds.length);
    for (const row of rows) {
      expect(row.ended).toBe(true);
      // A stamp from the lagging app Date (or read before the lock) is earlier.
      expect(row.after_release).toBe(true);
      expect(row.before_done).toBe(true);
    }
    // Last on purpose: on code without the lock the checks above fail first.
    expect(run.sawWaiter).toBe(true);
  }, 60_000);

  it("legend-e3qgo clearance with the app clock ahead: valid_until is the DB clock read after the lock, not the advanced app time", async () => {
    const leaver = await makeLeaver();
    const offboardingId = await dueOffboarding(leaver.employeeId);

    const run = await revokeAfterLock(offboardingId, APP_CLOCK_SKEW_MS);

    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const rows = await endedInsideBracket(leaver.assignmentIds, run);
    expect(rows).toHaveLength(leaver.assignmentIds.length);
    for (const row of rows) {
      expect(row.ended).toBe(true);
      expect(row.after_release).toBe(true);
      // A stamp from the advanced app Date lies after the request settled, so
      // the leaver's access would stay "active" for the DB clock until then.
      expect(row.before_done).toBe(true);
    }
    expect(run.sawWaiter).toBe(true);
  }, 60_000);

  it("legend-e3qgo after the clearance every ended assignment is inactive at the DB clock right away", async () => {
    // Regression guard without any barrier or skew (passes before the fix too):
    // what the service stamped is what every DB-clock reader sees at once.
    const leaver = await makeLeaver();
    const offboardingId = await dueOffboarding(leaver.employeeId);

    const response = await post(
      hrTenant,
      `/api/hris/offboardings/${offboardingId}/revoke-access`,
      {},
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const { rows } = await owner.query<{
      inactive: boolean;
      ordered: boolean;
    }>(
      `SELECT (valid_until <= clock_timestamp()) AS inactive,
              (valid_until >= valid_from) AS ordered
         FROM role_assignments WHERE id = ANY($1::uuid[])`,
      [leaver.assignmentIds],
    );
    expect(rows).toHaveLength(leaver.assignmentIds.length);
    for (const row of rows) {
      expect(row.inactive).toBe(true);
      expect(row.ordered).toBe(true);
    }
  }, 60_000);
});
