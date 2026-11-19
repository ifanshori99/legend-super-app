// legend-e3qgo (tier K, access + personal data): PATCH /api/hris/employees/:employeeId/manager
// must judge the manager's role and stamp updated_at / the audit time with the DATABASE clock
// (clock_timestamp()) read AFTER the per-tenant advisory lock
// `legend:role-assignment-end:<tenant>`, not with the application clock and not with a time
// captured before the lock. Written from docs/briefs/1172-access-audit-guard.md (section
// "Tambahan: legend-e3qgo") and the HTTP contract exercised in
// hris-employee-manager-change.test.ts / hris-employee-manager-lock-order.test.ts, not from the
// implementation. Helpers are copied from those tests (a test file cannot be imported).
//
// How the skew is made deterministic:
// - A separate connection holds the tenant advisory lock. The PATCH is sent (real clock) and the
//   test waits, by polling pg_locks, until a backend is parked on that lock.
// - Only then the application `Date` is faked (vi.useFakeTimers({ toFake: ["Date"] })) 60 s
//   behind or 60 s ahead of the real clock, so everything the service does before the lock (auth,
//   session) runs on the real clock and only the post-lock reading is exposed to the skew.
// - After 200 ms the lock holder reads clock_timestamp() on its own connection (`releasedAt`) and
//   commits. Every comparison against DB timestamps runs in SQL, so Node/DB drift is irrelevant.
//
// What fails on today's code:
// - a stamp taken before the lock (real clock at call time) is >= 200 ms earlier than releasedAt;
// - a stamp taken from the application clock after the lock is 60 s off in either direction;
// - a role rule judged with the faked application clock gives the wrong answer for a senior
//   assignment that is still valid (clock ahead) or already expired (clock behind) in DB time.
//
// Assumptions:
// - The manager change takes the tenant advisory lock above (brief). If no backend ever waits on
//   it the test fails with an explicit "setup precondition" message.
// - updated_at and the audit event createdAt (asserted only when present) carry the DB clock
//   after the lock: releasedAt (truncated to ms, JS Date has ms precision) <= stamp <= the DB
//   clock read right after the response.
// - A template "supervisor" role is non-junior and "cashier" is junior (as in
//   hris-employee-manager-change.test.ts); a boss without a valid supervisor assignment gives
//   422 MANAGER_ROLE_TOO_LOW for a supervisor target.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 5,
});
const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.example.test/file/${objectId}`,
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

type Client = ReturnType<typeof agent>;
type Res = Awaited<ReturnType<Client["get"]>>;

const ACTION = "hris.employee_manager_change";
const KEY_PREFIX = "mgr-db-clock-";
const APP_CLOCK_SKEW_MS = 60_000;
const LOCK_KEY = `legend:role-assignment-end:${tenant.id}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
let outletId: string;

async function inTenant<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function newUserId(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

/** Tenant-scope role with the given permissions. */
async function grantTenantRole(
  userId: string,
  permissions: string[],
): Promise<void> {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await inTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `DB clock ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, 'tenant', NULL, now() - interval '1 hour', $3)`,
      [randomUUID(), tenant.id, userId, roleId],
    );
  });
}

// Template role (the tenant's own when present, else created and removed afterwards).
const templateRoleIds = new Map<string, string>();
async function templateRole(key: string): Promise<string> {
  const cached = templateRoleIds.get(key);
  if (cached) return cached;
  const id = await inTenant(async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2 LIMIT 1",
      [tenant.id, key],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = randomUUID();
    createdRoles.push(created);
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, '[]'::jsonb, false, '["outlet"]'::jsonb)`,
      [created, tenant.id, key, key],
    );
    return created;
  });
  templateRoleIds.set(key, id);
  return id;
}

/** Outlet-scope assignment of a template role; returns the role_assignments id. */
async function assignOutletRole(
  userId: string,
  roleId: string,
): Promise<string> {
  const id = randomUUID();
  await inTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, $4, 'outlet', $5, now() - interval '1 day', NULL, $3)`,
      [id, tenant.id, userId, roleId, outletId],
    ),
  );
  return id;
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  await inTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet DB clock', 'Jl. Clock', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `DC-${id.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  return id;
}

async function seedEmployee(userId: string | null = null): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await inTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', NULL, now() - interval '1 day')`,
      [
        id,
        tenant.id,
        userId,
        `DC-${id.slice(0, 8).toUpperCase()}`,
        `Karyawan Jam ${id.slice(0, 8)}`,
        outletId,
      ],
    ),
  );
  return id;
}

async function managerOf(employeeId: string): Promise<string | null> {
  const rows = await inTenant(async (client) => {
    const result = await client.query<{ manager_id: string | null }>(
      "SELECT manager_id FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.manager_id;
}

/** Stamps judged in SQL against DB timestamps: lower = releasedAt (ms), upper = doneAt. */
async function stampsWithinBracket(
  employeeId: string,
  releasedAt: string,
  doneAt: string,
): Promise<{
  updatedAt: { afterLock: boolean; beforeDone: boolean };
  audit: Array<{ afterLock: boolean | null; beforeDone: boolean | null }>;
}> {
  return inTenant(async (client) => {
    const updated = await client.query<{
      after_lock: boolean;
      before_done: boolean;
    }>(
      `SELECT updated_at >= date_trunc('milliseconds', $3::timestamptz) AS after_lock,
              updated_at <= $4::timestamptz AS before_done
         FROM employees WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, employeeId, releasedAt, doneAt],
    );
    const audit = await client.query<{
      after_lock: boolean | null;
      before_done: boolean | null;
    }>(
      `SELECT (event->>'createdAt')::timestamptz >= date_trunc('milliseconds', $3::timestamptz) AS after_lock,
              (event->>'createdAt')::timestamptz <= $4::timestamptz AS before_done
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $5 AND event->>'objectId' = $2`,
      [tenant.id, employeeId, releasedAt, doneAt, ACTION],
    );
    return {
      updatedAt: {
        afterLock: updated.rows[0]!.after_lock,
        beforeDone: updated.rows[0]!.before_done,
      },
      audit: audit.rows.map((row) => ({
        afterLock: row.after_lock,
        beforeDone: row.before_done,
      })),
    };
  });
}

async function auditCount(employeeId: string): Promise<number> {
  return inTenant(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenant.id, ACTION, employeeId],
    );
    return result.rowCount ?? 0;
  });
}

const patchManager = (
  client: Client,
  employeeId: string,
  managerId: string | null,
) =>
  client
    .patch(`/api/hris/employees/${employeeId}/manager`)
    .set(originHeader)
    .send({ managerId, idempotencyKey: `${KEY_PREFIX}${randomUUID()}` });

/** A fresh HR actor: manage + view at tenant scope, plus a view-only role. */
async function seedActor(name: string) {
  const actor = await signedInClient(name);
  await grantTenantRole(actor.userId, [
    "hr.employee.manage",
    "hr.employee.view",
  ]);
  await grantTenantRole(actor.userId, ["hr.employee.view"]);
  return actor;
}

/** Target is a supervisor (non-junior); the boss holds cashier + a supervisor assignment. */
async function seedScenario(name: string) {
  const actor = await seedActor(name);
  const supervisorRole = await templateRole("supervisor");
  const cashierRole = await templateRole("cashier");

  const targetUser = await newUserId("Target supervisor");
  await assignOutletRole(targetUser, supervisorRole);
  const target = await seedEmployee(targetUser);

  const bossUser = await newUserId("Boss senior");
  await assignOutletRole(bossUser, cashierRole);
  const bossSeniorAssignment = await assignOutletRole(bossUser, supervisorRole);
  const boss = await seedEmployee(bossUser);
  return { actor, target, boss, bossSeniorAssignment };
}

/** Poll (by iteration count, the app Date may be faked) until a backend waits on the lock. */
async function waitForLockWaiter(client: PoolClient): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await client.query<{ waiting: boolean }>(
      `WITH k AS (SELECT hashtextextended($1, 0) AS key)
       SELECT EXISTS (
         SELECT 1 FROM pg_locks l, k
         WHERE l.locktype = 'advisory'
           AND NOT l.granted
           AND l.classid::bigint = ((k.key >> 32) & 4294967295)
           AND l.objid::bigint = (k.key & 4294967295)
       ) AS waiting`,
      [LOCK_KEY],
    );
    if (rows[0]!.waiting) return true;
    await sleep(20);
  }
  return false;
}

type Bracket = {
  res: Res;
  sawWaiter: boolean;
  /** DB clock read by the lock holder just before it released the lock. */
  releasedAt: string;
  /** DB clock read right after the response arrived. */
  doneAt: string;
};

/**
 * Hold the tenant lock, send the PATCH (real clock), wait until it parks, then fake the app
 * `Date` `skewMs` away from real time, wait 200 ms (plus `untilDbAfter`, a DB timestamp the
 * holder waits to pass, by polling the DB clock), read the DB clock and release.
 * Always restores real timers.
 */
async function patchWhileLockHeld(
  actor: { client: Client },
  target: string,
  boss: string,
  skewMs: number,
  untilDbAfter: { assignmentId: string } | null = null,
): Promise<Bracket> {
  const holder = await owner.connect();
  let pending: Promise<Res> | undefined;
  let sawWaiter = false;
  let releasedAt = "";
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [LOCK_KEY],
    );

    pending = patchManager(actor.client, target, boss).then((res) => res);
    pending.catch(() => undefined);

    sawWaiter = await waitForLockWaiter(holder);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + skewMs));
    await sleep(200);
    if (untilDbAfter) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const { rows } = await holder.query<{ passed: boolean }>(
          `SELECT clock_timestamp() > valid_until + interval '100 milliseconds' AS passed
             FROM role_assignments WHERE id = $1`,
          [untilDbAfter.assignmentId],
        );
        if (rows[0]?.passed) break;
        await sleep(20);
      }
    }
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
  let res: Res;
  try {
    res = await pending!;
  } finally {
    vi.useRealTimers();
  }
  const { rows } = await owner.query<{ t: string }>(
    "SELECT clock_timestamp()::text AS t",
  );
  return { res, sawWaiter, releasedAt, doneAt: rows[0]!.t };
}

beforeAll(async () => {
  outletId = await seedOutlet();
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("legend-e3qgo manager change uses the DB clock read after the tenant lock", () => {
  it.each([
    ["behind", -APP_CLOCK_SKEW_MS],
    ["ahead", APP_CLOCK_SKEW_MS],
  ] as const)(
    "legend-e3qgo stamps updated_at and the audit time with the DB clock after the lock while the app clock is 60 s %s",
    async (_label, skewMs) => {
      const actor = await seedActor(`HR DB Clock Stamp ${_label}`);
      const target = await seedEmployee();
      const boss = await seedEmployee();

      const run = await patchWhileLockHeld(actor, target, boss, skewMs);

      expect(
        run.sawWaiter,
        "setup precondition: the manager change must wait on the tenant advisory lock held by the test",
      ).toBe(true);
      expect(run.res.status, JSON.stringify(run.res.body)).toBe(200);
      expect(await managerOf(target)).toBe(boss);
      const stamps = await stampsWithinBracket(
        target,
        run.releasedAt,
        run.doneAt,
      );
      // Lower bound: a time captured before the lock, or the faked-behind app clock, is earlier
      // than the DB clock read by the lock holder before it released. Upper bound: the
      // faked-ahead app clock is 60 s after the DB clock read once the call has settled.
      expect(
        stamps.updatedAt.afterLock,
        "updated_at >= DB clock at release",
      ).toBe(true);
      expect(
        stamps.updatedAt.beforeDone,
        "updated_at <= DB clock after the call",
      ).toBe(true);
      expect(await auditCount(target)).toBe(1);
      for (const row of stamps.audit) {
        if (row.afterLock !== null) expect(row.afterLock).toBe(true);
        if (row.beforeDone !== null) expect(row.beforeDone).toBe(true);
      }
    },
  );

  it("legend-e3qgo a senior role that is still valid in DB time passes when the app clock is 60 s ahead of it", async () => {
    // valid_until is 30 s ahead of the DB clock. An application clock 60 s ahead would judge
    // the assignment expired and answer 422 MANAGER_ROLE_TOO_LOW.
    const s = await seedScenario("HR DB Clock Role Ahead");
    await inTenant((client) =>
      client.query(
        "UPDATE role_assignments SET valid_until = clock_timestamp() + interval '30 seconds' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, s.bossSeniorAssignment],
      ),
    );

    const run = await patchWhileLockHeld(
      s.actor,
      s.target,
      s.boss,
      APP_CLOCK_SKEW_MS,
    );

    expect(
      run.sawWaiter,
      "setup precondition: the manager change must wait on the tenant advisory lock held by the test",
    ).toBe(true);
    expect(run.res.status, JSON.stringify(run.res.body)).toBe(200);
    expect(run.res.body.data).toMatchObject({
      id: s.target,
      managerId: s.boss,
    });
    expect(await managerOf(s.target)).toBe(s.boss);
    expect(await auditCount(s.target)).toBe(1);
  });

  it("legend-e3qgo a senior role that expired in DB time while waiting is rejected when the app clock is 60 s behind", async () => {
    // valid_until is ~1.5 s ahead of the DB clock when the request is sent; the lock holder
    // releases only after the DB clock has passed it. An application clock 60 s behind would
    // still judge the assignment valid and answer 200.
    const s = await seedScenario("HR DB Clock Role Behind");
    await inTenant((client) =>
      client.query(
        "UPDATE role_assignments SET valid_until = clock_timestamp() + interval '1500 milliseconds' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, s.bossSeniorAssignment],
      ),
    );

    const run = await patchWhileLockHeld(
      s.actor,
      s.target,
      s.boss,
      -APP_CLOCK_SKEW_MS,
      { assignmentId: s.bossSeniorAssignment },
    );

    expect(
      run.sawWaiter,
      "setup precondition: the manager change must wait on the tenant advisory lock held by the test",
    ).toBe(true);
    expect(run.res.status, JSON.stringify(run.res.body)).toBe(422);
    expect(run.res.body?.error?.code, JSON.stringify(run.res.body)).toBe(
      "MANAGER_ROLE_TOO_LOW",
    );
    expect(await managerOf(s.target)).toBeNull();
    expect(await auditCount(s.target)).toBe(0);
  });
});

afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      await client.query(
        "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = ANY($2::text[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
        [tenant.id, `%${KEY_PREFIX}%`],
      );
      await client.query(
        "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
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
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
        [tenant.id, outletId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } finally {
    await owner.end();
  }
}, 60_000);
