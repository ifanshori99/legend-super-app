// A support (impersonation) session cannot revoke login sessions
// (legend-ypwsp, part C). PRD v1.7 §3 F4 Support Access: the Super Admin gets a
// time-boxed, audited window into tenant data; wiping the target's login
// sessions (or the support session itself, which would also dodge the audit
// trail) is not part of it. Contract: DELETE /api/auth/sessions/:sessionId
// (`revokeSession` in packages/shared/src/identity/endpoints.ts).
//
// Assumptions (the spec leaves these open):
//  - The refusal is exactly 403 and the session row is left in place.
//  - The grant is read_write on purpose: a read-only grant is already refused
//    by the generic read-only guard, which would hide a missing session rule.
//  - An ordinary (non-impersonated) revoke answers 204, not 200: that is what
//    identity-session-api.test.ts and impersonation-grant.test.ts assert today
//    for this endpoint.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportWriteAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  requestSupportWriteAccess,
  SUPPORT_ACCESS_WRITE_MAX_MINUTES,
} from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const PASSWORD = "Test-password-123!";
const REASON = "Menelusuri keluhan pelanggan atas sesi login pengguna.";
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Target = {
  client: Client;
  userId: string;
  email: string;
  /** A second login session of the same user (own cookie). */
  secondCookie: string;
  secondSessionId: string;
};

const sessionIdOfClient = async (client: Client) =>
  (await client.get("/api/auth/get-session")).body.session.id as string;

async function sessionExists(id: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 FROM "session" WHERE id = $1`, [id]);
  return (rows.rowCount ?? 0) > 0;
}

/** A tenant owner of the seeded tenant with two login sessions. */
async function newTarget(): Promise<Target> {
  const client = agent(app);
  const email = await signUp(client, "Pengguna Dua Sesi");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  const signedIn = await request(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  const header = signedIn.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const secondCookie = cookies.map((value) => value.split(";")[0]).join("; ");
  const secondSessionId = (
    await request(app).get("/api/auth/get-session").set("Cookie", secondCookie)
  ).body.session.id as string;
  return { client, userId, email, secondCookie, secondSessionId };
}

async function newSuperAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Sesi");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId };
}

/** read_write support access: the admin files it, the tenant owner approves. */
async function openWriteGrant(adminUserId: string, approverUserId: string) {
  const now = new Date();
  const filed = await requestSupportWriteAccess({
    tenantId,
    actorUserId: adminUserId,
    request: requestSupportWriteAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    ),
    { userId: approverUserId },
    filed.id,
    now,
  );
  expect(approved.status).toBe("approved");
}

/** The admin's client turned into an impersonated session of `target`. */
async function impersonate(
  admin: Awaited<ReturnType<typeof newSuperAdmin>>,
  target: Target,
) {
  await openWriteGrant(admin.userId, target.userId);
  const response = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: target.userId });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  await verifySessionMfa(target.email);
  const me = await admin.client.get("/api/auth/get-session");
  expect(me.body.session.impersonatedBy).toBe(admin.userId);
  return admin.client;
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

describe("legend-ypwsp support session cannot delete login sessions", () => {
  it("a support session deleting the target's other login session is refused with 403 and the session stays", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    const support = await impersonate(admin, target);

    const response = await support
      .delete(
        `/api/auth/sessions/${encodeURIComponent(target.secondSessionId)}`,
      )
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await sessionExists(target.secondSessionId)).toBe(true);
    // The target's own cookie still works.
    const still = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", target.secondCookie);
    expect(still.body.session.id).toBe(target.secondSessionId);
  });

  it("a support session deleting its own session is refused with 403 and stays signed in", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    const support = await impersonate(admin, target);
    const supportSessionId = await sessionIdOfClient(support);

    const response = await support
      .delete(`/api/auth/sessions/${encodeURIComponent(supportSessionId)}`)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await sessionExists(supportSessionId)).toBe(true);
    const me = await support.get("/api/auth/get-session");
    expect(me.body.session.impersonatedBy).toBe(admin.userId);
  });

  it("a support session deleting a session id that does not exist is refused, not answered 204", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    const support = await impersonate(admin, target);
    const response = await support
      .delete(`/api/auth/sessions/${randomUUID()}`)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).not.toBe(204);
    expect([403, 404]).toContain(response.status);
  });

  it("an ordinary session still revokes another of its own sessions (204)", async () => {
    const target = await newTarget();

    const response = await target.client
      .delete(
        `/api/auth/sessions/${encodeURIComponent(target.secondSessionId)}`,
      )
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    // An ordinary session is kept with revoked_at set (audit trail) and stops
    // working; only a support session row is deleted.
    const rows = await db.query(
      `SELECT revoked_at FROM "session" WHERE id = $1`,
      [target.secondSessionId],
    );
    expect(rows.rows[0]?.revoked_at).not.toBeNull();
    const after = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", target.secondCookie);
    expect(after.body?.session ?? null).toBeNull();
  });

  it("the tenant user still revokes a support session of their own account (204)", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    const support = await impersonate(admin, target);
    const supportSessionId = await sessionIdOfClient(support);

    const response = await target.client
      .delete(`/api/auth/sessions/${encodeURIComponent(supportSessionId)}`)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await sessionExists(supportSessionId)).toBe(false);
  });
});
