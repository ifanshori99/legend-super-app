// legend-hzdy5 (tier K auth). grantRoleAssignment and endRoleAssignment must
// stamp valid_from / valid_until, and decide "is the assignment active", with the
// DATABASE clock (SELECT clock_timestamp()) read AFTER the per-tenant advisory
// lock, not with the application clock and not with the transaction-start now().
// Expected behavior comes from PRD v1.7 §3.7 / TEN-03: grant and end order is
// consistent for every reader, which only the shared DB clock guarantees.
// Assumptions:
// - A grant without validFrom starts now (valid_from = DB clock after the lock);
//   an end without validUntil ends now (valid_until = DB clock after the lock).
// - Proof that the DB clock is used, not the app clock: the application `Date` is
//   faked 60 s into the past while the service runs. Code that stamps with
//   `new Date()` writes a time 60 s before the DB bracket and fails. Stamps passed
//   to the service (reauthenticatedAt) are taken from that same faked clock, so
//   re-auth age stays valid whichever clock the service reads.
// - Proof that the time is read AFTER the lock: the lock holder waits 200 ms
//   after the call parked, then reads clock_timestamp() on its own connection and
//   commits. The stamp must be >= that reading (a read taken at call start, or
//   the transaction-start now(), is earlier). All comparisons run in SQL on DB
//   timestamps, so Node/DB clock drift does not matter.
// - The barrier is best effort and never throws when no waiter appears.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantRoleSchema, roleTemplate } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import {
  endRoleAssignment,
  grantRoleAssignment,
} from "../services/access.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

const TENANT_SCOPE = { type: "tenant", id: null } as const;
const APP_CLOCK_SKEW_MS = 60_000;

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return session.body.user.id as string;
}

async function insertRole(
  tenantId: string,
  input: {
    name: string;
    templateKey: string;
    permissions: readonly string[];
    allowedScopeTypes: readonly string[];
  },
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, $4::jsonb, true, $5::jsonb)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.templateKey,
      JSON.stringify(input.permissions),
      JSON.stringify(input.allowedScopeTypes),
    ],
  );
  return rows[0]!.id;
}

/** A fresh tenant with the Owner and Admin Tenant template roles. */
async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Assignment DB clock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `assignment-db-clock-${tenantId}`, founderId],
  );
  const ownerRoleId = await insertRole(tenantId, {
    name: "Owner",
    templateKey: "owner",
    permissions: roleTemplate("owner").permissions,
    allowedScopeTypes: ["tenant", "brand"],
  });
  const adminRoleId = await insertRole(tenantId, {
    name: "Admin Tenant",
    templateKey: "tenant_admin",
    permissions: roleTemplate("tenant_admin").permissions,
    allowedScopeTypes: ["tenant"],
  });
  return { tenantId, ownerRoleId, adminRoleId };
}

/** Permanent tenant-scope assignment (valid_until IS NULL), backdated 10 min. */
async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '10 minutes', NULL, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
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

type Outcome = { ok: true } | { ok: false; reason: unknown };
type Bracket = {
  outcome: Outcome;
  sawWaiter: boolean;
  /** DB clock read by the lock holder just before it released the lock. */
  releasedAt: string;
  /** DB clock read right after the service call settled. */
  doneAt: string;
};

const settle = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true as const }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );

/**
 * Hold the tenant lock, start `start()` (not awaited) with the app Date faked
 * 60 s into the past, wait until it parks, wait 200 ms, read the DB clock,
 * release. Always restores real timers.
 */
async function runAfterLock(
  tenantId: string,
  start: () => Promise<unknown>,
): Promise<Bracket> {
  const lockKey = `legend:role-assignment-end:${tenantId}`;
  const holder = await owner.connect();
  let pending: Promise<Outcome> | null = null;
  let sawWaiter = false;
  let releasedAt = "";
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - APP_CLOCK_SKEW_MS));
    pending = settle(start());

    sawWaiter = await waitForLockWaiter(holder, lockKey);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { rows } = await holder.query<{ t: string }>(
      "SELECT clock_timestamp()::text AS t",
    );
    releasedAt = rows[0]!.t;
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  let outcome: Outcome;
  try {
    outcome = await pending!;
  } finally {
    vi.useRealTimers();
  }
  const { rows } = await owner.query<{ t: string }>(
    "SELECT clock_timestamp()::text AS t",
  );
  return { outcome, sawWaiter, releasedAt, doneAt: rows[0]!.t };
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  vi.useRealTimers();
  setAuditWriter(null);
  if (tenantIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[])",
      [tenantIds],
    );
    await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      tenantIds,
    ]);
  }
  await owner.end();
});

describe("legend-hzdy5 role assignment grant and end use the DB clock after the lock", () => {
  it("legend-hzdy5 a grant stamps valid_from with the DB clock read after the lock", async () => {
    const founder = await signedIn("Clock Grant Founder");
    const tenant = await createTenant(founder);
    const grantor = await signedIn("Clock Grant Owner");
    const member = await signedIn("Clock Grant Member");
    await assign(tenant.tenantId, grantor, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    const run = await runAfterLock(tenant.tenantId, () =>
      grantRoleAssignment(
        scopedContext(tenant.tenantId),
        grantRoleSchema.parse({
          userId: member,
          roleId: tenant.ownerRoleId,
          scope: TENANT_SCOPE,
        }),
        {
          actorUserId: grantor,
          reauthenticatedAt: new Date(),
          mfaVerified: true,
        },
      ),
    );

    expect(run.outcome.ok).toBe(true);
    const { rows } = await owner.query<{
      after_release: boolean;
      before_done: boolean;
    }>(
      `SELECT valid_from >= date_trunc('milliseconds', $4::timestamptz) AS after_release,
              valid_from <= $5::timestamptz AS before_done
       FROM role_assignments
       WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3
         AND valid_until IS NULL`,
      [tenant.tenantId, member, tenant.ownerRoleId, run.releasedAt, run.doneAt],
    );
    expect(rows).toHaveLength(1);
    // Not the faked app clock, not the call start or transaction-start now().
    expect(rows[0]!.after_release).toBe(true);
    expect(rows[0]!.before_done).toBe(true);
    // Last on purpose: on code without the lock the checks above fail first.
    expect(run.sawWaiter).toBe(true);
  }, 30_000);

  it("legend-hzdy5 an end stamps valid_until with the DB clock read after the lock", async () => {
    const founder = await signedIn("Clock End Founder");
    const tenant = await createTenant(founder);
    const ender = await signedIn("Clock End Owner");
    const member = await signedIn("Clock End Member");
    await assign(tenant.tenantId, ender, tenant.ownerRoleId, founder);
    const memberAssignment = await assign(
      tenant.tenantId,
      member,
      tenant.adminRoleId,
      founder,
    );

    const run = await runAfterLock(tenant.tenantId, () =>
      endRoleAssignment(
        scopedContext(tenant.tenantId),
        memberAssignment,
        { reason: "Selesai tugas, ditutup." },
        ender,
      ),
    );

    expect(run.outcome.ok).toBe(true);
    const { rows } = await owner.query<{
      ended: boolean;
      after_release: boolean;
      before_done: boolean;
    }>(
      `SELECT valid_until IS NOT NULL AS ended,
              valid_until >= date_trunc('milliseconds', $2::timestamptz) AS after_release,
              valid_until <= $3::timestamptz AS before_done
       FROM role_assignments WHERE id = $1`,
      [memberAssignment, run.releasedAt, run.doneAt],
    );
    expect(rows[0]!.ended).toBe(true);
    expect(rows[0]!.after_release).toBe(true);
    expect(rows[0]!.before_done).toBe(true);
    expect(run.sawWaiter).toBe(true);
  }, 30_000);

  it("legend-hzdy5 a granted assignment is active at the DB clock right after the grant, and ended right after the end", async () => {
    // Order consistency without any barrier: what the service stamped is what
    // every DB-clock reader sees at once.
    const founder = await signedIn("Clock Order Founder");
    const tenant = await createTenant(founder);
    const actor = await signedIn("Clock Order Owner");
    const member = await signedIn("Clock Order Member");
    await assign(tenant.tenantId, actor, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    await grantRoleAssignment(
      scopedContext(tenant.tenantId),
      grantRoleSchema.parse({
        userId: member,
        roleId: tenant.ownerRoleId,
        scope: TENANT_SCOPE,
      }),
      { actorUserId: actor, reauthenticatedAt: new Date(), mfaVerified: true },
    );
    const granted = await owner.query<{ id: string; active: boolean }>(
      `SELECT id, (valid_from <= clock_timestamp()
                   AND (valid_until IS NULL OR valid_until > clock_timestamp())) AS active
       FROM role_assignments
       WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3`,
      [tenant.tenantId, member, tenant.ownerRoleId],
    );
    expect(granted.rows).toHaveLength(1);
    expect(granted.rows[0]!.active).toBe(true);

    await endRoleAssignment(
      scopedContext(tenant.tenantId),
      granted.rows[0]!.id,
      { reason: "Selesai tugas, ditutup." },
      actor,
    );
    const ended = await owner.query<{ inactive: boolean; ordered: boolean }>(
      `SELECT (valid_until <= clock_timestamp()) AS inactive,
              (valid_until >= valid_from) AS ordered
       FROM role_assignments WHERE id = $1`,
      [granted.rows[0]!.id],
    );
    expect(ended.rows[0]!.inactive).toBe(true);
    expect(ended.rows[0]!.ordered).toBe(true);
  }, 30_000);

  // Actor / grantee validity is judged by the DB clock, not the app clock.
  // Assumptions:
  // - The skewed app clock is derived from the DB clock (not from Node's), so
  //   drift between Node and the container cannot change the outcome.
  // - Expired actor: the actor's only role assignment ended 30 s ago by the DB
  //   clock while the app Date says it ends 30 s from now (app 60 s behind).
  //   Grant and end are refused with PERMISSION_DENIED and change nothing.
  // - Banned grantee (deviation from the brief wording, recorded in the report):
  //   with the app clock BEHIND the DB clock, a ban whose banExpires lies
  //   between the two is already over by the DB clock, so DB-clock code would
  //   allow the grant and the test could not expect 422. To get a 422 that only
  //   the DB clock can produce, the app Date is faked 60 s AHEAD: the ban
  //   (banExpires = DB clock + 30 s) looks over to the app clock but is still
  //   running by the DB clock. The grant must be refused with 422.

  /** Fake only the app `Date` to DB clock + offsetMs while `run` executes. */
  async function withAppDateAtDbClock<T>(
    offsetMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const { rows } = await owner.query<{ ms: number }>(
      "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(rows[0]!.ms + offsetMs));
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Tenant-scope assignment that ended 30 s ago by the DB clock. */
  async function assignEndedByDbClock(
    tenantId: string,
    userId: string,
    roleId: string,
    assignedBy: string,
  ): Promise<void> {
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'tenant', clock_timestamp() - interval '10 minutes',
               clock_timestamp() - interval '30 seconds', $4)`,
      [tenantId, userId, roleId, assignedBy],
    );
  }

  it("legend-hzdy5 an actor whose assignment ended by the DB clock is refused a grant although the app clock says it is still valid", async () => {
    const founder = await signedIn("Clock Expired Grantor Founder");
    const tenant = await createTenant(founder);
    const grantor = await signedIn("Clock Expired Grantor");
    const member = await signedIn("Clock Expired Grantor Member");
    await assignEndedByDbClock(
      tenant.tenantId,
      grantor,
      tenant.ownerRoleId,
      founder,
    );
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    const outcome = await withAppDateAtDbClock(-APP_CLOCK_SKEW_MS, () =>
      settle(
        grantRoleAssignment(
          scopedContext(tenant.tenantId),
          grantRoleSchema.parse({
            userId: member,
            roleId: tenant.ownerRoleId,
            scope: TENANT_SCOPE,
          }),
          {
            actorUserId: grantor,
            reauthenticatedAt: new Date(),
            mfaVerified: true,
          },
        ),
      ),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    const { rows } = await owner.query(
      `SELECT 1 FROM role_assignments
       WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3`,
      [tenant.tenantId, member, tenant.ownerRoleId],
    );
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("legend-hzdy5 an actor whose assignment ended by the DB clock is refused an end although the app clock says it is still valid", async () => {
    const founder = await signedIn("Clock Expired Ender Founder");
    const tenant = await createTenant(founder);
    const ender = await signedIn("Clock Expired Ender");
    const member = await signedIn("Clock Expired Ender Member");
    await assignEndedByDbClock(
      tenant.tenantId,
      ender,
      tenant.ownerRoleId,
      founder,
    );
    const memberAssignment = await assign(
      tenant.tenantId,
      member,
      tenant.adminRoleId,
      founder,
    );

    const outcome = await withAppDateAtDbClock(-APP_CLOCK_SKEW_MS, () =>
      settle(
        endRoleAssignment(
          scopedContext(tenant.tenantId),
          memberAssignment,
          { reason: "Selesai tugas, ditutup." },
          ender,
        ),
      ),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    const { rows } = await owner.query<{ ended: boolean }>(
      "SELECT valid_until IS NOT NULL AS ended FROM role_assignments WHERE id = $1",
      [memberAssignment],
    );
    expect(rows[0]!.ended).toBe(false);
  }, 30_000);

  it("legend-hzdy5 a grantee whose ban is still running by the DB clock is refused 422 although the app clock says it is over", async () => {
    const founder = await signedIn("Clock Ban Founder");
    const tenant = await createTenant(founder);
    const grantor = await signedIn("Clock Ban Owner");
    const member = await signedIn("Clock Ban Member");
    await assign(tenant.tenantId, grantor, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);
    // Banned after the assignment (a banned account cannot be given a role).
    await owner.query(
      `UPDATE "user"
          SET banned = true, ban_expires = clock_timestamp() + interval '30 seconds'
        WHERE id = $1`,
      [member],
    );

    const outcome = await withAppDateAtDbClock(APP_CLOCK_SKEW_MS, () =>
      settle(
        grantRoleAssignment(
          scopedContext(tenant.tenantId),
          grantRoleSchema.parse({
            userId: member,
            roleId: tenant.ownerRoleId,
            scope: TENANT_SCOPE,
          }),
          {
            actorUserId: grantor,
            reauthenticatedAt: new Date(),
            mfaVerified: true,
          },
        ),
      ),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { status?: number }).status).toBe(422);
    }
    const { rows } = await owner.query(
      `SELECT 1 FROM role_assignments
       WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3`,
      [tenant.tenantId, member, tenant.ownerRoleId],
    );
    expect(rows).toHaveLength(0);
  }, 30_000);
});
