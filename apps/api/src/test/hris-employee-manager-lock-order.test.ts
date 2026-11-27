// legend-c79uy P1 follow-ups (tier K, access + personal data) for
// PATCH /api/hris/employees/:employeeId/manager.
//
// (a) Lock order. An HR actor who sets THEMSELF as the new manager while their own
//     offboarding runs concurrently must not deadlock (Postgres 40P01). Offboarding locks the
//     leaver's employee row first and the leaver's role assignments second. The manager change
//     must take locks in the same order: target employee FOR UPDATE, new-manager employee FOR
//     SHARE, then role assignments, then reload access.
// (b) Post-lock time. If the proposed manager's senior role expires while the request waits for
//     the locks, the role rule must be judged with the time AFTER the lock: 422
//     MANAGER_ROLE_TOO_LOW. updated_at and the audit time use that post-lock time too.
//
// Written from the brief docs/briefs/fix-ykk88-c79uy.md section B and the HTTP contract that
// hris-employee-manager-change.test.ts / hris-employee-manager-authz-lock.test.ts exercise,
// not from the implementation. Helpers are copied from the authz-lock test (a test file cannot
// be imported without running it).
//
// How the races are made deterministic (no sleeps for ordering):
// - (a) A separate transaction plays "offboarding": it locks the actor's own employee row
//   (as the leaver's employee row is locked), the request is sent, the test waits until a
//   backend is really blocked by that transaction, and only THEN the transaction asks for the
//   actor's role assignments FOR UPDATE (second step of offboarding). If the service already
//   holds the role assignments while it waits for the employee row, this is a real lock cycle
//   and Postgres raises 40P01 for one of the two sides. With the correct order the service
//   holds only the target row while it waits, so nothing cycles.
// - (b) A separate transaction holds the target and new-manager employee rows (so the request
//   is blocked after its first authorization) and has an uncommitted UPDATE that gives the
//   manager's supervisor assignment a valid_until slightly in the future. The commit happens
//   only once the clock has passed that instant, so the first read (before the lock, no
//   committed expiry) and the post-lock read differ only by the clock passed to the rule.
//
// Assumptions:
// - Offboarding is simulated with its lock steps (employee row, then role assignments of the
//   leaver); the HTTP offboarding endpoint cannot be paused. The simulation does not change
//   any role, so after the commit the manager change is allowed: 200 with manager_id set.
// - The service passes a JS Date (not DB now()) to the role rule, the same clock the other
//   HRIS tests use for valid_until; all expiry instants here are JS-clock instants.
// - "Expired" means role_assignments.valid_until in the past; a template "supervisor" role is
//   non-junior and "cashier" is junior (as in hris-employee-manager-change.test.ts).
// - The audit event may carry event.createdAt (ISO). It is asserted only when present.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

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
const KEY_PREFIX = "mgr-lock-order-";
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

/** Tenant-scope role with the given permissions; returns the role_assignments id. */
async function grantTenantRole(
  userId: string,
  permissions: string[],
): Promise<string> {
  const roleId = randomUUID();
  const assignmentId = randomUUID();
  createdRoles.push(roleId);
  await inTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `Lock order ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, 'tenant', NULL, now() - interval '1 hour', $3)`,
      [assignmentId, tenant.id, userId, roleId],
    );
  });
  return assignmentId;
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
       VALUES ($1, $2, $3, $4, $5, 'Outlet lock order', 'Jl. Lock', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `LO-${id.slice(0, 8)}`.toUpperCase(),
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
        `LO-${id.slice(0, 8).toUpperCase()}`,
        `Karyawan Urutan ${id.slice(0, 8)}`,
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

async function updatedAtOf(employeeId: string): Promise<number> {
  const rows = await inTenant(async (client) => {
    const result = await client.query<{ at: Date }>(
      "SELECT updated_at AS at FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.at.getTime();
}

async function auditEvents(
  employeeId: string,
): Promise<Array<{ createdAt?: string }>> {
  return inTenant(async (client) => {
    const result = await client.query<{ event: { createdAt?: string } }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenant.id, ACTION, employeeId],
    );
    return result.rows.map((row) => row.event);
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

async function newHolder(): Promise<{ holder: PoolClient; pid: number }> {
  const holder = await owner.connect();
  await holder.query("BEGIN");
  await holder.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant.id],
  );
  const backend = await holder.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return { holder, pid: backend.rows[0]!.pid };
}

/** Send the PATCH and wait until a backend is really blocked by the holder transaction. */
async function sendAndWaitUntilBlocked(
  actor: { client: Client },
  target: string,
  newManager: string,
  holderPid: number,
): Promise<{
  pending: Promise<Res>;
  waiting: boolean;
  diagnostics: () => string;
}> {
  let settled = false;
  let diagnostics = "";
  const pending = patchManager(actor.client, target, newManager).then((res) => {
    settled = true;
    return res;
  });
  pending.catch(() => {
    settled = true;
  });
  const deadline = Date.now() + 15_000;
  let waiting = false;
  while (!settled && Date.now() < deadline) {
    const blockers = await owner.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
      [holderPid],
    );
    if (blockers.rows[0]?.waiting) {
      waiting = true;
      break;
    }
    await sleep(20);
  }
  if (!waiting) {
    // Diagnostics for the setup precondition: what did the request do instead of waiting?
    const activity = await owner.query(
      `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, left(query, 100) AS q
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
    );
    diagnostics = `settled=${settled}; holderPid=${holderPid}; active=${JSON.stringify(activity.rows)}`;
  }
  return { pending, waiting, diagnostics: () => diagnostics };
}

/** Throws (after the caller released its locks) when the request never waited. */
async function assertWaited(
  started: Awaited<ReturnType<typeof sendAndWaitUntilBlocked>>,
): Promise<void> {
  if (started.waiting) return;
  throw new Error(
    `setup precondition: the request did not wait on the employee locks held by the test; ${started.diagnostics()}`,
  );
}

type SeedActor = Awaited<ReturnType<typeof seedActor>>;

/**
 * (a) The actor PATCHes target -> new manager = the actor's own employee row while a
 * simulated offboarding of the actor holds that employee row and then wants the actor's role
 * assignments.
 */
async function patchSelfWhileOwnOffboarding(
  actor: SeedActor,
  target: string,
  ownEmployee: string,
): Promise<{ res: Res; holderError: { code?: string } | undefined }> {
  const { holder, pid } = await newHolder();
  let pending: Promise<Res> | undefined;
  let holderError: { code?: string } | undefined;
  try {
    // Offboarding step 1: lock the leaver's employee row.
    await holder.query(
      "SELECT id FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenant.id, ownEmployee],
    );
    const started = await sendAndWaitUntilBlocked(
      actor,
      target,
      ownEmployee,
      pid,
    );
    pending = started.pending;
    if (!started.waiting) {
      // Release first so the request is not left hanging, then fail the precondition.
      await holder.query("ROLLBACK").catch(() => undefined);
      await pending.catch(() => undefined);
      await assertWaited(started);
    }
    // Offboarding step 2: lock (then end) the leaver's role assignments. With the wrong lock
    // order the service holds them while it waits for step 1 -> lock cycle -> 40P01.
    try {
      await holder.query(
        "SELECT id FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE",
        [tenant.id, actor.userId],
      );
      await holder.query("COMMIT");
    } catch (error) {
      holderError = error as { code?: string };
      await holder.query("ROLLBACK").catch(() => undefined);
    }
    return { res: await pending, holderError };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
}

/**
 * (b) Target and new-manager employee rows are held; the manager's supervisor assignment
 * (when `expiring`) gets valid_until = a JS instant ~2.5 s ahead (uncommitted, so the first
 * read sees it as unlimited). The commit happens only after that instant has passed.
 */
async function patchWhileManagerRoleExpires(
  actor: SeedActor,
  target: string,
  boss: string,
  expiring: { assignmentId: string } | null,
): Promise<{ res: Res; releasedAt: number }> {
  const { holder, pid } = await newHolder();
  let pending: Promise<Res> | undefined;
  try {
    const validUntil = Date.now() + 2_500;
    await holder.query(
      "UPDATE employees SET status = 'active' WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, [target, boss]],
    );
    if (expiring)
      await holder.query(
        "UPDATE role_assignments SET valid_until = $3::timestamptz WHERE tenant_id = $1 AND id = $2",
        [tenant.id, expiring.assignmentId, new Date(validUntil).toISOString()],
      );
    const started = await sendAndWaitUntilBlocked(actor, target, boss, pid);
    pending = started.pending;
    if (!started.waiting) {
      await holder.query("ROLLBACK").catch(() => undefined);
      await pending.catch(() => undefined);
      await assertWaited(started);
    }
    // Wait on the clock (not for ordering): long enough that the post-lock time is clearly
    // later than the pre-lock time, and past valid_until when the role is expiring.
    const releaseNotBefore = expiring ? validUntil + 150 : Date.now() + 400;
    while (Date.now() < releaseNotBefore) await sleep(20);
    // The service stamps with the database clock, which can differ from this process's
    // clock by a few ms (Docker VM): take the release instant from the database too.
    const releasedAt = Number(
      (
        await holder.query<{ ms: string }>(
          "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms",
        )
      ).rows[0]!.ms,
    );
    await holder.query("COMMIT");
    return { res: await pending, releasedAt };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
}

beforeAll(async () => {
  outletId = await seedOutlet();
}, 60_000);

describe("legend-c79uy P1 manager change lock order: self as new manager during own offboarding", () => {
  it("does not deadlock (40P01) and succeeds when the actor sets themself as manager while their offboarding locks run", async () => {
    // Fails on current code: the service holds the actor's role assignments while it waits
    // for the new-manager employee row (taken after them); the offboarding side holds that
    // row and asks for the assignments. Postgres breaks the cycle with 40P01: either the
    // holder's second lock fails (holderError.code) or the request dies (status != 200).
    const actor = await seedActor("HR Self Manager Offboarding");
    const ownEmployee = await seedEmployee(actor.userId);
    const target = await seedEmployee();

    const { res, holderError } = await patchSelfWhileOwnOffboarding(
      actor,
      target,
      ownEmployee,
    );

    expect(
      holderError?.code,
      "the offboarding transaction must not be chosen as deadlock victim",
    ).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("40P01");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: target, managerId: ownEmployee });
    expect(await managerOf(target)).toBe(ownEmployee);
    expect((await auditEvents(target)).length).toBe(1);
  });
});

describe("legend-c79uy P1 manager change judges the manager's role with the post-lock time", () => {
  /** Target is a supervisor (non-junior); the boss holds cashier + a supervisor assignment. */
  async function seedScenario(name: string) {
    const actor = await seedActor(name);
    const supervisorRole = await templateRole("supervisor");
    const cashierRole = await templateRole("cashier");

    const targetUser = await newUserId("Target supervisor");
    await assignOutletRole(targetUser, supervisorRole);
    const target = await seedEmployee(targetUser);

    const bossUser = await newUserId("Boss expiring");
    await assignOutletRole(bossUser, cashierRole);
    const bossSeniorAssignment = await assignOutletRole(
      bossUser,
      supervisorRole,
    );
    const boss = await seedEmployee(bossUser);
    return { actor, target, boss, bossSeniorAssignment };
  }

  it("control: a still-valid senior role passes after waiting on the lock", async () => {
    const s = await seedScenario("HR Role Control");

    const { res } = await patchWhileManagerRoleExpires(
      s.actor,
      s.target,
      s.boss,
      null,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: s.target, managerId: s.boss });
    expect(await managerOf(s.target)).toBe(s.boss);
    expect(await auditEvents(s.target)).toHaveLength(1);
  });

  it("stamps updated_at and the audit time with the time after the lock, not before the wait", async () => {
    // Fails on current code: both use the time captured before the lock, ~400 ms earlier
    // than the moment the lock was released (`releasedAt`).
    const s = await seedScenario("HR Role Post Lock Time");

    const { res, releasedAt } = await patchWhileManagerRoleExpires(
      s.actor,
      s.target,
      s.boss,
      null,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await updatedAtOf(s.target)).toBeGreaterThanOrEqual(releasedAt);
    const events = await auditEvents(s.target);
    expect(events).toHaveLength(1);
    if (typeof events[0]!.createdAt === "string")
      expect(Date.parse(events[0]!.createdAt)).toBeGreaterThanOrEqual(
        releasedAt,
      );
  });

  it("rejects with 422 MANAGER_ROLE_TOO_LOW when the manager's senior role expires while the request waits for the lock", async () => {
    // Fails on current code: loadRoleKeys uses the time captured before the lock, when the
    // supervisor assignment was still valid -> 200, manager_id moves, audit row written.
    const s = await seedScenario("HR Role Expires");

    const { res } = await patchWhileManagerRoleExpires(
      s.actor,
      s.target,
      s.boss,
      { assignmentId: s.bossSeniorAssignment },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBe(
      "MANAGER_ROLE_TOO_LOW",
    );
    expect(await managerOf(s.target)).toBeNull();
    expect(await auditEvents(s.target)).toHaveLength(0);
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
