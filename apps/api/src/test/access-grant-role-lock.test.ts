// legend-8ajy4 (tier K auth). grantRoleAssignment must decide "is the grantor
// an active Owner / does the grantor still hold access.role.assign" at a clock
// read AFTER the per-tenant advisory lock. Expected behavior comes from PRD
// v1.7 §3.7 / TEN-03: only an active Owner may grant the Owner template, and an
// Owner whose assignment has ended holds no permissions any more.
// Assumptions:
// - The loser of the race (grantor ended while its call waited) is refused with
//   PERMISSION_DENIED (403), for the Owner template and for other roles alike.
// - The grant shares the lock key with endRoleAssignment
//   (`legend:role-assignment-end:<tenantId>`); the barrier is best effort and
//   returns false (never throws) when no waiter appears, so on code without the
//   lock the outcome assertions fail first.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantRoleSchema, roleTemplate } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { grantRoleAssignment } from "../services/access.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

const TENANT_SCOPE = { type: "tenant", id: null } as const;

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

/** A fresh tenant with the Owner, Admin Tenant and Finance template roles. */
async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Grant role lock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `grant-role-lock-${tenantId}`, founderId],
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
  const financeRoleId = await insertRole(tenantId, {
    name: "Finance",
    templateKey: "finance",
    permissions: roleTemplate("finance").permissions,
    allowedScopeTypes: ["tenant", "brand", "outlet"],
  });
  return { tenantId, ownerRoleId, adminRoleId, financeRoleId };
}

/** Permanent tenant-scope assignment (valid_until IS NULL). */
async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: a container clock may drift from the Node clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', NULL, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
}

/** Number of assignments of this role the user holds (any validity). */
async function roleRowCount(
  tenantId: string,
  userId: string,
  roleId: string,
): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM role_assignments
     WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3`,
    [tenantId, userId, roleId],
  );
  return rows[0]!.count;
}

/**
 * Poll until a session waits (not granted) on this tenant's advisory lock.
 * Returns false after the timeout instead of throwing: without the lock no
 * waiter ever appears, and the test must still reach its outcome assertions.
 */
async function waitForLockWaiter(
  client: PoolClient,
  lockKey: string,
): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
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

/**
 * Hold the tenant lock, start the grant (not awaited), end Owner A with Node
 * time while the grant waits, then release the lock. Returns the grant outcome
 * and whether the barrier saw the grant waiting on the lock.
 */
async function grantWhileGrantorIsEnded(input: {
  tenantId: string;
  roleId: string;
  targetUserId: string;
  grantorUserId: string;
  grantorAssignmentId: string;
}): Promise<{ outcome: Outcome; sawWaiter: boolean }> {
  const lockKey = `legend:role-assignment-end:${input.tenantId}`;
  const holder = await owner.connect();
  let pending: Promise<Outcome> | null = null;
  let sawWaiter = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    pending = grantRoleAssignment(
      scopedContext(input.tenantId),
      grantRoleSchema.parse({
        userId: input.targetUserId,
        roleId: input.roleId,
        scope: TENANT_SCOPE,
      }),
      {
        actorUserId: input.grantorUserId,
        reauthenticatedAt: new Date(Date.now() - 5_000),
        mfaVerified: true,
      },
    ).then(
      () => ({ ok: true as const }),
      (reason: unknown) => ({ ok: false as const, reason }),
    );

    sawWaiter = await waitForLockWaiter(holder, lockKey);
    // Let the pending call's early clock read (if any) fall clearly in the past.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The grantor is ended meanwhile (simulated), then the lock is released.
    // Node time, not DB time: avoids container clock drift.
    await holder.query(
      "UPDATE role_assignments SET valid_until = $2 WHERE id = $1",
      [input.grantorAssignmentId, new Date()],
    );
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  return { outcome: await pending!, sawWaiter };
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
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

describe("legend-8ajy4 role grant decides after the tenant lock", () => {
  it("legend-8ajy4 an Owner ended while waiting for the lock cannot grant the Owner template", async () => {
    const founder = await signedIn("Grant Lock Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Grant Lock A");
    const ownerB = await signedIn("Grant Lock B");
    const member = await signedIn("Grant Lock M");
    const assignmentA = await assign(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    await assign(tenant.tenantId, ownerB, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    const { outcome, sawWaiter } = await grantWhileGrantorIsEnded({
      tenantId: tenant.tenantId,
      roleId: tenant.ownerRoleId,
      targetUserId: member,
      grantorUserId: ownerA,
      grantorAssignmentId: assignmentA,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    expect(
      await roleRowCount(tenant.tenantId, member, tenant.ownerRoleId),
    ).toBe(0);
    // Last on purpose: on code without the lock the outcome fails first.
    expect(sawWaiter).toBe(true);
  }, 20_000);

  it("legend-8ajy4 an Owner ended while waiting for the lock cannot grant a non-Owner role", async () => {
    const founder = await signedIn("Grant Lock Fin Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Grant Lock Fin A");
    const ownerB = await signedIn("Grant Lock Fin B");
    const member = await signedIn("Grant Lock Fin M");
    const assignmentA = await assign(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    await assign(tenant.tenantId, ownerB, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    const { outcome, sawWaiter } = await grantWhileGrantorIsEnded({
      tenantId: tenant.tenantId,
      roleId: tenant.financeRoleId,
      targetUserId: member,
      grantorUserId: ownerA,
      grantorAssignmentId: assignmentA,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    expect(
      await roleRowCount(tenant.tenantId, member, tenant.financeRoleId),
    ).toBe(0);
    expect(sawWaiter).toBe(true);
  }, 20_000);

  it("legend-8ajy4 an active Owner still grants the Owner template without contention", async () => {
    const founder = await signedIn("Grant Lock Ok Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Grant Lock Ok A");
    const member = await signedIn("Grant Lock Ok M");
    await assign(tenant.tenantId, ownerA, tenant.ownerRoleId, founder);
    await assign(tenant.tenantId, member, tenant.adminRoleId, founder);

    await grantRoleAssignment(
      scopedContext(tenant.tenantId),
      grantRoleSchema.parse({
        userId: member,
        roleId: tenant.ownerRoleId,
        scope: TENANT_SCOPE,
      }),
      {
        actorUserId: ownerA,
        reauthenticatedAt: new Date(Date.now() - 5_000),
        mfaVerified: true,
      },
    );

    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3
         AND valid_until IS NULL`,
      [tenant.tenantId, member, tenant.ownerRoleId],
    );
    expect(rows).toHaveLength(1);
  }, 20_000);
});
