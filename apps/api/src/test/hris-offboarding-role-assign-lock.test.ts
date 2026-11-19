// legend-ig3dg (tier K, access). The exit clearance (POST
// /api/hris/offboardings/:id/revoke-access) may only end a leaver's tenant-scope
// role assignment when the caller holds `access.role.assign` at tenant scope;
// otherwise it answers 409 OFFBOARDING_ADMIN_ROLE and changes nothing (PRD v1.7
// §3.7 / TEN-03; the rule is pinned by hris-offboarding-clearance.test.ts D2).
// The permission must be judged on the access the caller holds when the
// per-tenant advisory lock `legend:role-assignment-end:<tenant>` is granted, not
// on a snapshot taken before the request queued behind that lock.
// Expected behavior comes from docs/briefs/1183-akses-so1181.md "Kartu A"
// (second opinion 1181, P1), not from the service code.
// Assumptions:
// - The caller is tenant HR with two tenant-scope assignments: one role with
//   hr.employee.manage (+ view), one role with access.role.assign only. Dropping
//   the second while the request waits for the lock must make the clearance fail.
// - "Dropped" means the lock holder ends that assignment (valid_until in the past
//   by the DB clock), commits, then releases the lock, exactly like a concurrent
//   role removal would.
// - The leaver holds a tenant-scope (non-Owner) assignment, which is what makes
//   the permission matter; two outlet assignments ride along.
// - "Nothing changes": no leaver assignment ended, staff session not revoked, push
//   subscription kept, employee still active, offboarding still open with
//   accessRevokedAt null and revocationResult null, no `role_assignment.ended`
//   audit row or outbox event for the leaver's assignments, and no new audit row
//   by the caller or about the offboarding. (A denied-attempt audit, if the
//   product adds one, would break the last check; the existing D2 test pins that
//   a refused clearance writes none.)
// - The barrier is best effort and never throws when no waiter appears; the
//   waiter assertion comes last so a missing lock fails on the outcome first.
// - Control: the same barrier with a holder that changes nothing clears the exit
//   (200) and ends every leaver assignment, so the 409 is caused by the dropped
//   permission and not by the barrier.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];

type Client = ReturnType<typeof agent>;

let jkt: string;
let hrMgr: Client;

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
      `Offboarding role-assign lock ${roleId.slice(0, 8)}`,
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
      `RA-${id.slice(0, 8)}`.toUpperCase(),
      `Outlet kunci izin ${label}`,
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
     VALUES ($1, $2, $3, $4, 'Karyawan Keluar Kunci Izin', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenant.id, userId, `RA-${id.slice(0, 8).toUpperCase()}`, outletId],
  );
  return id;
}

async function seedPush(userId: string) {
  await owner.query(
    `INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version)
     VALUES ($1, $2, $3, $4, 'encrypted', 'v1')`,
    [tenant.id, randomUUID(), userId, `ra-${randomUUID()}`],
  );
}

/**
 * An employee with a login: two outlet assignments plus one non-Owner
 * tenant-scope assignment (the one that needs access.role.assign), a staff
 * session bound to this tenant, one push subscription, an employee row.
 */
async function makeLeaver() {
  const { userId, sessionId } = await signedInClient("Keluar Kunci Izin", {
    mfa: true,
  });
  const assignmentIds = [
    await assignRole({
      userId,
      roleId: await newRole(
        ["self.profile.view", "self.schedule.view"],
        ["outlet"],
      ),
      scope: { type: "outlet", id: jkt },
    }),
    await assignRole({
      userId,
      roleId: await templateRoleId("cashier"),
      scope: { type: "outlet", id: jkt },
    }),
    await assignRole({
      userId,
      roleId: await newRole(["self.profile.view"], ["tenant"]),
      scope: { type: "tenant" },
    }),
  ];
  await owner.query(
    `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
    [sessionId, tenant.id],
  );
  await seedPush(userId);
  const employeeId = await seedEmployee(userId, jkt);
  return { userId, sessionId, employeeId, assignmentIds };
}

/**
 * Tenant HR with two separate tenant-scope assignments: HR management and
 * access.role.assign. Returns the second assignment id so a test can drop it.
 */
async function makeTenantHr() {
  const hr = await signedInClient("HR Pusat Kunci Izin", { mfa: true });
  await assignRole({
    userId: hr.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["tenant"],
    ),
    scope: { type: "tenant" },
  });
  const roleAssignAssignmentId = await assignRole({
    userId: hr.userId,
    roleId: await newRole(["access.role.assign"], ["tenant"]),
    scope: { type: "tenant" },
  });
  return { ...hr, roleAssignAssignmentId };
}

/** A due exit (last working day in the past) for the employee. */
async function dueOffboarding(employeeId: string) {
  const created = await post(
    hrMgr,
    `/api/hris/employees/${employeeId}/offboarding`,
    {
      exitType: "termination",
      reason: "Akhir hubungan kerja uji kunci izin.",
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

/** Poll until a session waits on the advisory lock. */
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

type Outcome = { status: number; body: unknown; sawWaiter: boolean };

/**
 * Hold the tenant lock, start the clearance (not awaited), wait until it parks,
 * run `whileHolding` inside the holder's transaction, commit and release.
 */
async function revokeWhileLocked(
  caller: Client,
  offboardingId: string,
  whileHolding: (holder: PoolClient) => Promise<void>,
): Promise<Outcome> {
  const lockKey = `legend:role-assignment-end:${tenant.id}`;
  const holder = await owner.connect();
  let pending: Promise<{ status: number; body: unknown }> | null = null;
  let sawWaiter = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    pending = (async () => {
      const response = await post(
        caller,
        `/api/hris/offboardings/${offboardingId}/revoke-access`,
        {},
      );
      return { status: response.status, body: response.body as unknown };
    })();

    sawWaiter = await waitForLockWaiter(holder, lockKey);
    await whileHolding(holder);
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  const response = await pending!;
  return { ...response, sawWaiter };
}

async function endedFlags(assignmentIds: string[]) {
  const { rows } = await owner.query<{ id: string; ended: boolean }>(
    "SELECT id, valid_until IS NOT NULL AS ended FROM role_assignments WHERE id = ANY($1::uuid[])",
    [assignmentIds],
  );
  return new Map(rows.map((row) => [row.id, row.ended]));
}

async function sessionRevoked(sessionId: string) {
  const { rows } = await owner.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM "session" WHERE id = $1`,
    [sessionId],
  );
  return rows[0]!.revoked;
}

async function pushCount(userId: string) {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM push_subscriptions WHERE tenant_id = $1 AND user_id::text = $2",
    [tenant.id, userId],
  );
  return rows[0]!.count;
}

async function employeeStatus(employeeId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM employees WHERE tenant_id = $1 AND id = $2",
    [tenant.id, employeeId],
  );
  return rows[0]!.status;
}

async function auditCountByActor(actorId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'actorId' = $2`,
      [tenant.id, actorId],
    );
    return rows[0]!.count;
  });
}

async function auditCountByObject(objectId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2`,
      [tenant.id, objectId],
    );
    return rows[0]!.count;
  });
}

async function endedAuditCount(assignmentIds: string[]) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = ANY($2::text[])
          AND event->>'action' = 'role_assignment.ended'`,
      [tenant.id, assignmentIds],
    );
    return rows[0]!.count;
  });
}

async function endedEventCount(assignmentIds: string[]) {
  return asTenant(async (client) => {
    let total = 0;
    for (const assignmentId of assignmentIds) {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'role_assignment.ended'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, assignmentId],
      );
      total += rows[0]!.count;
    }
    return total;
  });
}

beforeAll(async () => {
  jkt = await seedOutlet("A");

  // Creates the exits (outlet-scope hr.employee.manage reaches the leaver).
  const manager = await signedInClient("Manajer HR Kunci Izin", { mfa: true });
  await assignRole({
    userId: manager.userId,
    roleId: await newRole(
      ["hr.employee.manage", "hr.employee.view"],
      ["outlet"],
    ),
    scope: { type: "outlet", id: jkt },
  });
  hrMgr = manager.client;
}, 120_000);

afterAll(async () => {
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

describe("legend-ig3dg exit clearance re-checks access.role.assign after the tenant lock", () => {
  it("legend-ig3dg access.role.assign dropped while the clearance waits for the lock: 409 OFFBOARDING_ADMIN_ROLE and nothing changes", async () => {
    const leaver = await makeLeaver();
    const hr = await makeTenantHr();
    const offboardingId = await dueOffboarding(leaver.employeeId);
    expect(await pushCount(leaver.userId)).toBe(1);

    const auditActorBefore = await auditCountByActor(hr.userId);
    const auditObjectBefore = await auditCountByObject(offboardingId);

    const run = await revokeWhileLocked(
      hr.client,
      offboardingId,
      async (holder) => {
        // The permission is taken away (in the past by the DB clock) while the
        // request is parked behind the lock.
        await holder.query(
          `UPDATE role_assignments SET valid_until = now() - interval '1 minute'
          WHERE id = $1 AND tenant_id = $2`,
          [hr.roleAssignAssignmentId, tenant.id],
        );
      },
    );

    expect(run.status, JSON.stringify(run.body)).toBe(409);
    expect((run.body as { error: { code: string } }).error.code).toBe(
      "OFFBOARDING_ADMIN_ROLE",
    );

    // Nothing changed: the leaver keeps every assignment, session and push.
    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      false,
      false,
      false,
    ]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(false);
    expect(await pushCount(leaver.userId)).toBe(1);
    expect(await employeeStatus(leaver.employeeId)).toBe("active");
    expect(await endedAuditCount(leaver.assignmentIds)).toBe(0);
    expect(await endedEventCount(leaver.assignmentIds)).toBe(0);
    expect(await auditCountByActor(hr.userId)).toBe(auditActorBefore);
    expect(await auditCountByObject(offboardingId)).toBe(auditObjectBefore);

    // The caller still manages HR (only access.role.assign was dropped), so it
    // can read the exit: still open, access not revoked.
    const read = await hr.client.get(`/api/hris/offboardings/${offboardingId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({
      status: "open",
      accessRevokedAt: null,
      revocationResult: null,
    });

    // Last on purpose: if the lock were missing the outcome checks fail first.
    expect(run.sawWaiter).toBe(true);
  }, 120_000);

  it("legend-ig3dg control: the same wait with the permission intact clears the exit and ends every leaver assignment", async () => {
    const leaver = await makeLeaver();
    const hr = await makeTenantHr();
    const offboardingId = await dueOffboarding(leaver.employeeId);

    const run = await revokeWhileLocked(
      hr.client,
      offboardingId,
      async () => undefined,
    );

    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect([...(await endedFlags(leaver.assignmentIds)).values()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await sessionRevoked(leaver.sessionId)).toBe(true);
    expect(await pushCount(leaver.userId)).toBe(0);
    expect(await employeeStatus(leaver.employeeId)).toBe("terminated");

    const read = await hr.client.get(`/api/hris/offboardings/${offboardingId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({ status: "revoked" });
    expect(read.body.data.accessRevokedAt).not.toBeNull();

    expect(run.sawWaiter).toBe(true);
  }, 120_000);
});
