// A support (impersonation) session must stop being readable once its grant is
// gone, even when the cleanup of the session row did not run (brief
// docs/briefs/466-platform-codex-fixes.md item 3, TEN-04).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui sesi
// berjangka" (PRD v1.7 §3 F4 Support Access): a session row left behind after
// the grant ended or lapsed must not still answer GET /api/auth/get-session as
// the tenant user.
//
// Assumptions (the brief, not the implementation):
//   - "Not a session" means: status 200 with a null body (Better Auth's usual
//     answer for no session), or 401 or 403. Never 200 with a user. 5xx fails.
//   - The cleanup failure is forced at the database, not by mocking the
//     service: a trigger on "session" refuses DELETE and revoked_at updates of
//     the impersonated tenant user's rows. This works whether the cleanup is
//     called inside or outside the service module (a vi.mock of one export
//     would not intercept an internal call). The test also proves the row is
//     still there after the revoke, so the failed cleanup is not assumed.
//   - Revoking while cleanup fails must still answer 200 (the failure is only
//     logged, brief item 3).
//   - The tenant owner's own normal session is never touched by any of this.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
} from "@starter/shared/platform";
import { tenantIdSchema } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { requestSupportAccess } from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas pengaturan tenant.";

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Person = { client: Client; userId: string; email: string };

/** A tenant owner (normal session) with a verified second factor. */
async function newTenantOwner(name: string): Promise<Person> {
  const client = agent(app);
  const email = await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  const { rowCount } = await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2,
            now() - interval '1 day' FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  expect(rowCount).toBe(1);
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin(): Promise<Person> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Sesi Dukungan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId, email };
}

function openGrant(adminUserId: string) {
  const now = new Date();
  return requestSupportAccess({
    tenantId: tenantIdSchema.parse(tenantId),
    actorUserId: adminUserId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes: 60,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** The admin's client becomes an impersonated session of the tenant user. */
async function impersonate(admin: Person, target: Person): Promise<Client> {
  const response = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: target.userId });
  expect(response.status).toBe(200);
  return admin.client;
}

/** Whether a session row of this user still exists and is not revoked. */
async function liveSessionCount(userId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "session"
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rows[0]!.n;
}

/**
 * Forces the session cleanup to fail: while `fn` runs, deleting or revoking a
 * session row of `userId` raises in the database. The trigger only matches this
 * user, so suites running in parallel are not affected.
 */
async function withSessionCleanupBlocked<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!/^[\w-]+$/.test(userId)) throw new Error("unexpected user id shape");
  const suffix = randomBytes(6).toString("hex");
  const fnName = `test_block_session_cleanup_${suffix}`;
  const trgName = `test_block_session_cleanup_trg_${suffix}`;
  await db.query(
    `CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'test: session cleanup blocked';
       END IF;
       IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
         RAISE EXCEPTION 'test: session cleanup blocked';
       END IF;
       RETURN NEW;
     END $f$`,
  );
  await db.query(
    `CREATE TRIGGER ${trgName} BEFORE DELETE OR UPDATE ON "session"
       FOR EACH ROW WHEN (OLD.user_id = '${userId}')
       EXECUTE FUNCTION ${fnName}()`,
  );
  try {
    return await fn();
  } finally {
    await db.query(`DROP TRIGGER IF EXISTS ${trgName} ON "session"`);
    await db.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
  }
}

/** "No session": a null body (200) or a 401/403; never a user. */
function expectNoSession(response: {
  status: number;
  body: { user?: unknown } | null;
}) {
  expect([200, 401, 403]).toContain(response.status);
  expect(response.body?.user ?? null).toBeNull();
}

afterAll(async () => {
  await db.query(
    "DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, tenantUserIds],
  );
  await db.end();
});

describe("TEN-04 support session read stops with its grant", () => {
  it("TEN-04 while the grant is active, get-session of the impersonated cookie is the tenant user", async () => {
    const target = await newTenantOwner("Pemilik Tenant Sasaran");
    const admin = await newSuperAdmin();
    await openGrant(admin.userId);
    const support = await impersonate(admin, target);

    const response = await support.get("/api/auth/get-session");
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(target.userId);
  });

  it("TEN-04 owner revokes the grant while the session cleanup fails: revoke is 200 and the leftover session no longer reads as a session", async () => {
    const target = await newTenantOwner("Pemilik Tenant Sasaran");
    const revoker = await newTenantOwner("Pemilik Pencabut");
    const admin = await newSuperAdmin();
    const grant = await openGrant(admin.userId);
    const support = await impersonate(admin, target);
    expect((await support.get("/api/auth/get-session")).status).toBe(200);

    await withSessionCleanupBlocked(target.userId, async () => {
      const revoked = await revoker.client
        .post(`/api/org/support-access/${grant.id}/revoke`)
        .set(originHeader)
        .send({});
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.endedAt).not.toBeNull();

      // Precondition: the cleanup really failed, so the impersonation session
      // row (and the tenant user's own session) are still there.
      expect(await liveSessionCount(target.userId)).toBeGreaterThanOrEqual(2);
    });

    expectNoSession(await support.get("/api/auth/get-session"));

    // The tenant user's own normal session is not affected.
    const own = await target.client.get("/api/auth/get-session");
    expect(own.status).toBe(200);
    expect(own.body.user.id).toBe(target.userId);
  });

  it("TEN-04 a grant that lapsed (set in SQL, no cleanup ever ran) no longer lets the impersonated cookie read as a session", async () => {
    const target = await newTenantOwner("Pemilik Tenant Sasaran");
    const admin = await newSuperAdmin();
    const grant = await openGrant(admin.userId);
    const support = await impersonate(admin, target);
    expect((await support.get("/api/auth/get-session")).status).toBe(200);

    // The grant lapses while the support session is still open: move its whole
    // window two hours back (the window and MFA checks keep their relations).
    await db.query(
      `UPDATE support_access_grants
          SET started_at = started_at - interval '2 hours',
              expires_at = expires_at - interval '2 hours',
              mfa_verified_at = mfa_verified_at - interval '2 hours'
        WHERE id = $1`,
      [grant.id],
    );
    // Precondition: nothing cleaned the session row.
    expect(await liveSessionCount(target.userId)).toBeGreaterThanOrEqual(2);

    expectNoSession(await support.get("/api/auth/get-session"));

    const own = await target.client.get("/api/auth/get-session");
    expect(own.status).toBe(200);
    expect(own.body.user.id).toBe(target.userId);
  });

  it("TEN-04 normal sessions keep reading get-session, grant or no grant", async () => {
    const target = await newTenantOwner("Pemilik Tenant Sasaran");
    const admin = await newSuperAdmin();

    // The Super Admin's own session, with no grant at all.
    const adminBefore = await admin.client.get("/api/auth/get-session");
    expect(adminBefore.status).toBe(200);
    expect(adminBefore.body.user.id).toBe(admin.userId);

    // A grant for the tenant does not touch the tenant user's normal session.
    await openGrant(admin.userId);
    const own = await target.client.get("/api/auth/get-session");
    expect(own.status).toBe(200);
    expect(own.body.user.id).toBe(target.userId);

    // Stopping the impersonation hands the admin their own session back.
    const support = await impersonate(admin, target);
    const stopped = await support
      .post("/api/auth/admin/stop-impersonating")
      .set(originHeader)
      .send({});
    expect(stopped.status).toBe(200);
    const back = await support.get("/api/auth/get-session");
    expect(back.status).toBe(200);
    expect(back.body.user.id).toBe(admin.userId);
  });
});
