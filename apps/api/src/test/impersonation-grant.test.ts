// Impersonation needs a grant, lasts at most 60 minutes, and is audited
// (legend-rzirp, legend-6yfhc, TEN-04, tier K: auth).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka ... read-only secara default" (PRD v1.7 §3 F4 Support Access).
//
// Policy under test (docs/briefs/sub-impersonate-grant.md):
//   - Better Auth `POST /api/auth/admin/impersonate-user` is refused (403, no
//     session created) unless the caller is a platform admin, the target is not
//     a platform admin (nor the caller), and the caller holds an active support
//     grant in a tenant where the target has an active role assignment.
//   - An impersonated session never lives longer than 60 minutes.
//   - Start and end of an impersonation are audited in every matched tenant;
//     writes made during a support session are attributed to the impersonating
//     admin, tagged `support`, and marked sensitive.
//
// Assumptions (spec silent):
//   - Refusals are HTTP 403 with body.code = "SUPPORT_ACCESS_REQUIRED" or
//     "IMPERSONATION_NOT_ALLOWED" (Better Auth APIError body shape).
//   - Audit rows keep the audit event in audit_logs.event (jsonb): top level
//     `action`, `actorId`, `objectId`, `reason`, `sensitiveAccess`, `support`;
//     the `after` data of the brief is event.maskedChanges.after.
//   - The 60 minute bound is checked against the API clock (same process as the
//     test), never against the database clock, so clock skew cannot fail it.
//   - Writes are attributed by `PATCH /api/access/roles/:id`, which audits
//     `role.updated` with objectId = role id (see access-audit.test.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  type RequestSupportAccessInput,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  endSupportAccess,
  requestSupportAccess,
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
const otherTenantId = randomUUID();
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas pengaturan peran tenant.";
const unique = () => randomBytes(4).toString("hex");
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const createdRoleIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Tenant = {
  client: Client;
  userId: string;
  email: string;
  roleId: string;
};
type Admin = { client: Client; userId: string; email: string };

/** A tenant Owner (normal session) who also owns one custom role to edit. */
async function newTenantOwner(): Promise<Tenant> {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Tenant");
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
  await verifySessionMfa(email);
  const role = await client
    .post("/api/access/roles")
    .set(originHeader)
    .send({
      name: `Peran impersonasi ${unique()}`,
      permissions: ["access.role.view"],
      allowedScopeTypes: ["tenant"],
    });
  expect(role.status).toBe(201);
  createdRoleIds.push(role.body.data.id);
  return { client, userId, email, roleId: role.body.data.id as string };
}

/** A user with no role in any tenant. */
async function newOutsider() {
  const client = agent(app);
  const email = await signUp(client, "Bukan Anggota Tenant");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  return { client, userId, email };
}

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Impersonasi");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId, email };
}

/** Better Auth `admin` role but no platform_admins row. */
async function newPlainBetterAuthAdmin(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Admin Tanpa Platform");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  return { client, userId, email };
}

function grantBody(
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
) {
  return requestSupportAccessInputSchema.parse({
    reason: REASON,
    mfaCode: "123456",
    ...input,
  });
}

function openGrant(
  forTenantId: string,
  adminUserId: string,
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
  now: Date = new Date(),
) {
  return requestSupportAccess({
    tenantId: forTenantId,
    actorUserId: adminUserId,
    request: grantBody(input),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

function tryImpersonate(admin: Admin, targetUserId: string) {
  return admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: targetUserId });
}

/** The admin's client turned into an impersonated tenant-user session. */
async function impersonate(admin: Admin, tenant: Tenant) {
  const response = await tryImpersonate(admin, tenant.userId);
  expect(response.status).toBe(200);
  // The impersonated session belongs to the tenant user; /api/access is closed
  // until that session verified a second factor (AUTH-05).
  await verifySessionMfa(tenant.email);
  return admin.client;
}

async function expectRefusedAndStillAdmin(
  admin: Admin,
  targetUserId: string,
  code: "SUPPORT_ACCESS_REQUIRED" | "IMPERSONATION_NOT_ALLOWED",
) {
  const refused = await tryImpersonate(admin, targetUserId);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe(code);
  // No session was created: the client is still the admin itself, and no
  // session row names the admin as impersonator.
  const me = await admin.client.get("/api/auth/get-session");
  expect(me.body.user.id).toBe(admin.userId);
  expect(me.body.session.impersonatedBy ?? null).toBeNull();
  const rows = await db.query(
    `SELECT 1 FROM "session" WHERE impersonated_by = $1`,
    [admin.userId],
  );
  expect(rows.rowCount).toBe(0);
}

type AuditEvent = {
  action: string;
  actorId: string | null;
  objectId: string | null;
  reason: string | null;
  sensitiveAccess: boolean;
  support?: {
    grantId: string;
    impersonatorUserId: string;
    impersonatedUserId: string;
    accessMode: string;
  };
  maskedChanges: { after: Record<string, unknown> | null };
};

async function auditRows(
  forTenantId: string,
  action: string,
  filter: { actorId?: string; objectId?: string },
) {
  const result = await db.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND ($3::text IS NULL OR event->>'actorId' = $3)
        AND ($4::text IS NULL OR event->>'objectId' = $4)
      ORDER BY created_at, id`,
    [forTenantId, action, filter.actorId ?? null, filter.objectId ?? null],
  );
  return result.rows.map((row) => row.event);
}

async function sessionExpiry(
  adminUserId: string,
): Promise<{ expiresAt: Date }> {
  const result = await db.query<{ expires_at: Date }>(
    `SELECT expires_at FROM "session" WHERE impersonated_by = $1`,
    [adminUserId],
  );
  expect(result.rowCount).toBe(1);
  return { expiresAt: result.rows[0]!.expires_at };
}

beforeAll(async () => {
  // A second, throwaway tenant for the cross-tenant cases.
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Impersonation grant tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `imp-grant-${otherTenantId.slice(0, 8)}`, tenantId],
  );
});

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
  await db.query(
    "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdRoleIds],
  );
  await db.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await db.end();
});

describe("legend-rzirp TEN-04 impersonation needs a grant", () => {
  it("legend-rzirp TEN-04 without a grant the impersonation is refused and no session is created", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await expectRefusedAndStillAdmin(
      admin,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("legend-rzirp TEN-04 a platform admin cannot be impersonated, even with a grant in a tenant where they hold a role", async () => {
    const target = await newTenantOwner();
    await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      target.userId,
    ]);
    platformAdminIds.push(target.userId);
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);

    await expectRefusedAndStillAdmin(
      admin,
      target.userId,
      "IMPERSONATION_NOT_ALLOWED",
    );
  });

  it("legend-rzirp TEN-04 an admin cannot impersonate themself", async () => {
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const refused = await tryImpersonate(admin, admin.userId);
    expect(refused.status).toBe(403);
    const me = await admin.client.get("/api/auth/get-session");
    expect(me.body.session.impersonatedBy ?? null).toBeNull();
  });

  it("legend-rzirp TEN-04 an expired grant does not allow impersonation", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    // Opened two hours ago for 60 minutes: lapsed an hour ago.
    await openGrant(
      tenantId,
      admin.userId,
      { durationMinutes: 60 },
      new Date(Date.now() - 2 * SIXTY_MINUTES_MS),
    );
    await expectRefusedAndStillAdmin(
      admin,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("legend-rzirp TEN-04 an ended grant does not allow impersonation", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    await endSupportAccess({
      tenantId,
      grantId: grant.id,
      actorUserId: admin.userId,
    });
    await expectRefusedAndStillAdmin(
      admin,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("legend-rzirp TEN-04 a grant for another tenant does not open a user of this tenant, nor a user without a role", async () => {
    const tenant = await newTenantOwner();
    const outsider = await newOutsider();
    const admin = await newSuperAdmin();
    await openGrant(otherTenantId, admin.userId);
    await expectRefusedAndStillAdmin(
      admin,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );

    // A grant for the seeded tenant does not reach a user who holds no role
    // there either.
    await openGrant(tenantId, admin.userId);
    await expectRefusedAndStillAdmin(
      admin,
      outsider.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("legend-rzirp TEN-04 a caller who is not a platform admin is refused", async () => {
    const tenant = await newTenantOwner();

    // Better Auth `admin` role, never a platform admin.
    const plain = await newPlainBetterAuthAdmin();
    await expectRefusedAndStillAdmin(
      plain,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );

    // A former platform admin whose grant is still open.
    const former = await newSuperAdmin();
    await openGrant(tenantId, former.userId);
    await db.query("DELETE FROM platform_admins WHERE user_id = $1", [
      former.userId,
    ]);
    await expectRefusedAndStillAdmin(
      former,
      tenant.userId,
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("legend-rzirp TEN-04 with a grant the impersonation works and the session lasts at most 60 minutes, also after activity", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);

    const started = await tryImpersonate(admin, tenant.userId);
    expect(started.status).toBe(200);
    const upperBound = Date.now() + SIXTY_MINUTES_MS;
    await verifySessionMfa(tenant.email);

    const me = await admin.client.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(tenant.userId);
    expect(me.body.session.impersonatedBy).toBe(admin.userId);

    const { expiresAt: first } = await sessionExpiry(admin.userId);
    expect(first.getTime()).toBeGreaterThan(Date.now());
    expect(first.getTime()).toBeLessThanOrEqual(upperBound);

    // Activity and ordinary tenant requests must never push the deadline out.
    // The keep-alive may itself be refused for a test session; only the
    // deadline matters here.
    await admin.client
      .post("/api/auth/sessions/current/activity")
      .set(originHeader)
      .send({});
    expect((await admin.client.get("/api/access/roles")).status).toBe(200);
    expect((await admin.client.get("/api/auth/get-session")).status).toBe(200);

    const { expiresAt: later } = await sessionExpiry(admin.userId);
    expect(later.getTime()).toBeLessThanOrEqual(first.getTime());
  });
});

describe("legend-rzirp TEN-04 impersonation start and end are audited", () => {
  it("legend-rzirp TEN-04 start and stop write sensitive audit rows in the granted tenant only", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    // The admin also holds a grant in the other tenant, where the target has no
    // role: that tenant must see nothing.
    await openGrant(otherTenantId, admin.userId);

    await impersonate(admin, tenant);

    const started = await auditRows(
      tenantId,
      "support_access.impersonation_started",
      { actorId: admin.userId },
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actorId: admin.userId,
      objectId: grant.id,
      reason: REASON,
      sensitiveAccess: true,
    });
    expect(started[0]!.maskedChanges.after).toMatchObject({
      impersonatedUserId: tenant.userId,
      accessMode: "read_only",
    });
    expect(
      Date.parse(String(started[0]!.maskedChanges.after?.grantExpiresAt)),
    ).toBe(Date.parse(grant.expiresAt));
    expect(
      Date.parse(String(started[0]!.maskedChanges.after?.impersonationEndsAt)),
    ).toBeLessThanOrEqual(Date.now() + SIXTY_MINUTES_MS);

    const stopped = await admin.client
      .post("/api/auth/admin/stop-impersonating")
      .set(originHeader)
      .send({});
    expect(stopped.status).toBe(200);

    const ended = await auditRows(
      tenantId,
      "support_access.impersonation_ended",
      { actorId: admin.userId },
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actorId: admin.userId,
      objectId: grant.id,
      reason: REASON,
      sensitiveAccess: true,
    });
    expect(ended[0]!.maskedChanges.after).toMatchObject({
      impersonatedUserId: tenant.userId,
      cause: "stopped",
    });
    // Start and end rows pair on the same impersonation id.
    expect(started[0]!.maskedChanges.after?.impersonationId).toEqual(
      expect.any(String),
    );
    expect(ended[0]!.maskedChanges.after?.impersonationId).toBe(
      started[0]!.maskedChanges.after?.impersonationId,
    );

    for (const action of [
      "support_access.impersonation_started",
      "support_access.impersonation_ended",
    ])
      expect(
        await auditRows(otherTenantId, action, { actorId: admin.userId }),
      ).toHaveLength(0);
  });

  it("legend-rzirp TEN-04 signing out of the support session is audited as signed_out", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    await impersonate(admin, tenant);

    const out = await admin.client
      .post("/api/auth/sign-out")
      .set(originHeader)
      .send({});
    expect(out.status).toBe(200);

    const ended = await auditRows(
      tenantId,
      "support_access.impersonation_ended",
      { actorId: admin.userId, objectId: grant.id },
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]!.maskedChanges.after).toMatchObject({
      cause: "signed_out",
    });
  });

  it("legend-rzirp TEN-04 the tenant user revoking the support session ends it and is audited as revoked", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);
    const supportSessionId = (await support.get("/api/auth/get-session")).body
      .session.id as string;

    const revoked = await tenant.client
      .delete(`/api/auth/sessions/${encodeURIComponent(supportSessionId)}`)
      .set(originHeader);
    expect(revoked.status).toBe(204);

    // The support session is gone, not kept as a revoked row.
    const rows = await db.query(`SELECT 1 FROM "session" WHERE id = $1`, [
      supportSessionId,
    ]);
    expect(rows.rowCount).toBe(0);
    const ended = await auditRows(
      tenantId,
      "support_access.impersonation_ended",
      { actorId: admin.userId, objectId: grant.id },
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]!.maskedChanges.after).toMatchObject({
      impersonatedUserId: tenant.userId,
      impersonationId: supportSessionId,
      cause: "revoked",
    });
  });

  it("legend-rzirp TEN-04 a refused impersonation writes no start audit row", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await tryImpersonate(admin, tenant.userId);
    expect(
      await auditRows(tenantId, "support_access.impersonation_started", {
        actorId: admin.userId,
      }),
    ).toHaveLength(0);
  });
});

describe("legend-6yfhc TEN-04 writes during a support session are attributed to the admin", () => {
  it("legend-6yfhc TEN-04 a read_write mutation is audited as the admin with a support tag; the tenant's own session is not", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId, {
      accessMode: "read_write",
      durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
    });
    const support = await impersonate(admin, tenant);

    const bySupport = await support
      .patch(`/api/access/roles/${tenant.roleId}`)
      .set(originHeader)
      .send({ name: `Diubah dukungan ${unique()}` });
    expect(bySupport.status).toBe(200);

    const byTenant = await tenant.client
      .patch(`/api/access/roles/${tenant.roleId}`)
      .set(originHeader)
      .send({ name: `Diubah pemilik ${unique()}` });
    expect(byTenant.status).toBe(200);

    const rows = await auditRows(tenantId, "role.updated", {
      objectId: tenant.roleId,
    });
    expect(rows).toHaveLength(2);
    const [supportRow, tenantRow] = rows;

    expect(supportRow).toMatchObject({
      actorId: admin.userId,
      sensitiveAccess: true,
      support: {
        grantId: grant.id,
        impersonatorUserId: admin.userId,
        impersonatedUserId: tenant.userId,
        accessMode: "read_write",
      },
    });
    expect(supportRow!.reason?.trim()).toBeTruthy();

    expect(tenantRow!.actorId).toBe(tenant.userId);
    expect(tenantRow!.support).toBeUndefined();
    expect(tenantRow!.sensitiveAccess).toBe(false);
  });
});
