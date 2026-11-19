// legend-2n5qj (tier K, auth): appointing or replacing a tenant Owner is a
// Super Admin-only action (founder decision Q44, PRD v1.7 TEN-03). The Super
// Admin registry (platform_admins) must be checked again AFTER the per-tenant
// owner-change advisory lock, because a request can queue on that lock while
// another transaction revokes the actor. A request that waited and then found
// its actor revoked must be refused and change nothing.
//
// Expected behavior comes from the PRD/contract, not the service code:
// - a revoked Super Admin gets 403 FORBIDDEN;
// - the old Owner stays active, no new Owner assignment exists;
// - no success audit (tenant_owner.assigned / tenant_owner.replaced /
//   role_assignment.granted) and no tenant_owner.changed event is written.
//
// Assumptions:
// - A denial audit (tenant_owner.denied) after the lock is allowed, so it is
//   not asserted either way.
// - The barrier lock key is `legend:role-assignment-end:${tenantId}` (given by
//   the brief); the request parks on it before the registry is re-read.
// - Requests go through the real platform HTTP route with a real TOTP code, as
//   in platform-tenant-owner.test.ts. The route-level Super Admin check runs
//   before the lock and passes, so the 403 can only come from the post-lock
//   re-check.
// - Stale-MFA-while-waiting (brief item 3) is skipped: it needs the DB clock to
//   cross the 5 minute edge while the API clock is checked pre-lock, which is
//   not deterministic under container clock drift.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const platformAdminIds: string[] = [];

const REASON = "Pemilik ditunjuk Super Admin, diuji dengan kunci antrean.";

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const randomWhatsapp = () =>
  `628${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("")}`;

type Admin = {
  client: ReturnType<typeof agent>;
  userId: string;
  /** A valid, unused TOTP code for this admin's enrolled factor. */
  code: () => Promise<string>;
};

/** Platform Super Admin with a real enrolled, verified TOTP factor. */
async function platformAdmin(name: string): Promise<Admin> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  platformAdminIds.push(userId);

  const enroll = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enroll.status).toBe(201);
  const { factorId, secretBase32 } = enroll.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status).toBe(200);

  return {
    client,
    userId,
    code: async () => {
      // A TOTP step is single-use; clear it so every request gets a valid code.
      await owner.query(
        `UPDATE mfa_factors
            SET last_used_step = NULL, failed_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [factorId],
      );
      return totpCode(secretBase32, totpStep(new Date()));
    },
  };
}

/** A tenant with seeded templates, one tenant_admin and no Owner. */
async function newTenant(admin: Admin): Promise<string> {
  const created = await admin.client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `owner-lock-${randomBytes(4).toString("hex")}`,
      name: "Uji Kunci Registry Owner",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: randomWhatsapp(),
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const invite = () => ({
  invite: { name: "Pemilik Baru", whatsapp: randomWhatsapp(), email: null },
});

const ownersPath = (tenantId: string) =>
  `/api/platform/tenants/${tenantId}/owners`;

async function appoint(admin: Admin, tenantId: string) {
  return admin.client
    .post(ownersPath(tenantId))
    .set(originHeader)
    .send({
      account: invite(),
      reason: REASON,
      mfaCode: await admin.code(),
    });
}

async function replace(admin: Admin, tenantId: string, assignmentId: string) {
  return admin.client
    .post(`${ownersPath(tenantId)}/${assignmentId}/replace`)
    .set(originHeader)
    .send({
      account: invite(),
      reason: REASON,
      mfaCode: await admin.code(),
    });
}

/** Tenant-scope Owner assignments that are currently active (DB clock). */
async function activeOwnerIds(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT ra.id FROM role_assignments ra JOIN roles r
       ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'owner'
        AND ra.scope_type = 'tenant'
        AND ra.valid_from <= now() + interval '1 minute'
        AND (ra.valid_until IS NULL OR ra.valid_until > now())
      ORDER BY ra.id`,
    [tenantId],
  );
  return rows.map((row) => row.id);
}

async function allOwnerAssignmentCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM role_assignments ra JOIN roles r
       ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.template_key = 'owner'`,
    [tenantId],
  );
  return rows[0]!.count;
}

async function successAuditCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs
      WHERE tenant_id = $1
        AND event->>'action' IN
          ('tenant_owner.assigned', 'tenant_owner.replaced', 'role_assignment.granted')`,
    [tenantId],
  );
  return rows[0]!.count;
}

async function changedEventCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'tenant_owner.changed'`,
    [tenantId],
  );
  return rows[0]!.count;
}

/** Poll until a session waits (not granted) on this advisory lock key. */
async function waitForLockWaiter(
  client: PoolClient,
  lockKey: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
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
    if (rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the Owner request never waited on the advisory lock");
}

type Outcome = {
  status: number;
  body: { error?: { code?: string }; data?: { assignmentId?: string } };
};

/**
 * Holds the tenant lock, starts `request`, waits until it queues on the lock,
 * optionally revokes the actor's Super Admin registry row inside the holding
 * transaction, then commits (releasing the lock) and returns the response.
 */
async function requestQueuedOnLock(
  tenantId: string,
  actorUserId: string,
  revokeWhileWaiting: boolean,
  request: () => Promise<Outcome>,
): Promise<Outcome> {
  const lockKey = `legend:role-assignment-end:${tenantId}`;
  const holder = await owner.connect();
  let pending: Promise<Outcome> | null = null;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );
    pending = request();
    await waitForLockWaiter(holder, lockKey);
    if (revokeWhileWaiting) {
      await holder.query(
        "UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1",
        [actorUserId],
      );
    }
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    // Do not leave the parked request dangling after a setup failure.
    await pending?.catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  return pending!;
}

afterAll(async () => {
  // Owners appointed by invite are WhatsApp accounts (@wa.invalid) that grant
  // roles to others; remove those rows so later files can delete the accounts.
  await owner.query(
    `DELETE FROM role_assignments
      WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)
         OR assigned_by IN (SELECT id FROM "user" WHERE email LIKE $1)`,
    ["%@wa.invalid"],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await owner.end();
});

describe("legend-2n5qj Owner appointment re-checks the Super Admin registry after the lock", () => {
  it("legend-2n5qj refuses an appointment (403) when the Super Admin is revoked while queued on the lock", async () => {
    const admin = await platformAdmin("Registry Lock Assign");
    const tenantId = await newTenant(admin);
    expect(await activeOwnerIds(tenantId)).toHaveLength(0);
    // Tenant creation already audits the first admin's grant: compare to it.
    const auditBefore = await successAuditCount(tenantId);
    const eventsBefore = await changedEventCount(tenantId);

    const response = await requestQueuedOnLock(
      tenantId,
      admin.userId,
      true,
      () => appoint(admin, tenantId),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("FORBIDDEN");
    expect(await activeOwnerIds(tenantId)).toHaveLength(0);
    expect(await allOwnerAssignmentCount(tenantId)).toBe(0);
    expect(await successAuditCount(tenantId)).toBe(auditBefore);
    expect(await changedEventCount(tenantId)).toBe(eventsBefore);
  }, 30_000);

  it("legend-2n5qj refuses an Owner replacement (403) when the Super Admin is revoked while queued on the lock, and the old Owner stays active", async () => {
    const admin = await platformAdmin("Registry Lock Replace");
    const tenantId = await newTenant(admin);
    const first = await appoint(admin, tenantId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body.data.assignmentId as string;
    const auditBefore = await successAuditCount(tenantId);
    const eventsBefore = await changedEventCount(tenantId);
    expect(await activeOwnerIds(tenantId)).toEqual([firstId]);

    const response = await requestQueuedOnLock(
      tenantId,
      admin.userId,
      true,
      () => replace(admin, tenantId, firstId),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("FORBIDDEN");
    // The old Owner is still the only active Owner; no new row was created.
    expect(await activeOwnerIds(tenantId)).toEqual([firstId]);
    expect(await allOwnerAssignmentCount(tenantId)).toBe(1);
    expect(await successAuditCount(tenantId)).toBe(auditBefore);
    expect(await changedEventCount(tenantId)).toBe(eventsBefore);
  }, 30_000);

  it("legend-2n5qj control: an appointment that waited on the lock without a revoke succeeds", async () => {
    const admin = await platformAdmin("Registry Lock Control Assign");
    const tenantId = await newTenant(admin);

    const response = await requestQueuedOnLock(
      tenantId,
      admin.userId,
      false,
      () => appoint(admin, tenantId),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await activeOwnerIds(tenantId)).toHaveLength(1);
    expect(await successAuditCount(tenantId)).toBeGreaterThan(0);
  }, 30_000);

  it("legend-2n5qj control: a replacement that waited on the lock without a revoke succeeds and ends the old Owner", async () => {
    const admin = await platformAdmin("Registry Lock Control Replace");
    const tenantId = await newTenant(admin);
    const first = await appoint(admin, tenantId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body.data.assignmentId as string;

    const response = await requestQueuedOnLock(
      tenantId,
      admin.userId,
      false,
      () => replace(admin, tenantId, firstId),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const secondId = response.body.data?.assignmentId as string;
    expect(secondId).not.toBe(firstId);
    expect(await activeOwnerIds(tenantId)).toEqual([secondId]);
  }, 30_000);

  it("legend-2n5qj an unknown tenant id never parks on a lock (sanity: 404, not 403)", async () => {
    // Guards the helper assumption that a fresh admin is not refused by the
    // registry check itself: the only difference in the tests above is the
    // revoke made while the request is queued.
    const admin = await platformAdmin("Registry Lock Sanity");
    const response = await appoint(admin, randomUUID());
    expect(response.status).toBe(404);
  });
});
