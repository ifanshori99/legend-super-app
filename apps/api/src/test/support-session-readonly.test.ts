// Support session read-only (legend-cg071, TEN-04, tier K: auth).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka ... read-only secara default" (PRD v1.7 §3 F4 Support Access).
//
// Policy under test (docs/briefs/sub-support-readonly.md): a request made with a
// Better Auth impersonated session (a Super Admin acting as a tenant user) is a
// "support session". It needs an active grant for that tenant, a read_only grant
// only allows safe methods, a read_write grant allows tenant mutations, and the
// Better Auth credential endpoints stay closed except the exits. Normal tenant
// sessions are unaffected.
//
// Endpoint pair used (a real /kelola surface the tenant Owner may use):
//   GET    /api/org/domains          list
//   POST   /api/org/domains          create
//   DELETE /api/org/domains/:id      remove
//   PATCH  /api/access/roles/:id     edit a custom role
//
// Assumptions (spec silent): refusals are HTTP 403 with
// body.error.code = "SUPPORT_ACCESS_REQUIRED" | "SUPPORT_ACCESS_READ_ONLY";
// "nothing changed" is checked through the same public list endpoints, read by
// the normal (non-impersonated) tenant session.
// legend-rzirp: starting an impersonation is itself gated by an active grant
// (see impersonation-grant.test.ts). The no-grant and other-tenant cases here
// therefore expect the impersonate call to be refused (403); the post-start
// guard of legend-cg071 stays tested through grants that end or lapse AFTER
// the session started.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
  type RequestSupportAccessInput,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  endSupportAccess,
  requestSupportAccess,
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
const otherTenantId = randomUUID();
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas pengaturan domain tenant.";
const unique = () => randomBytes(4).toString("hex");

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const createdRoleIds: string[] = [];
const domainsToClean: Array<{ client: ReturnType<typeof agent>; id: string }> =
  [];

type Client = ReturnType<typeof agent>;
type Tenant = {
  client: Client;
  userId: string;
  email: string;
  brandId: string;
  roleId: string;
  roleName: string;
};

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

  const brands = await client.get("/api/org/brands");
  expect(brands.status).toBe(200);
  const roleName = `Peran dukungan ${unique()}`;
  const role = await client
    .post("/api/access/roles")
    .set(originHeader)
    .send({
      name: roleName,
      permissions: ["access.role.view"],
      allowedScopeTypes: ["tenant"],
    });
  expect(role.status).toBe(201);
  createdRoleIds.push(role.body.data.id);
  return {
    client,
    userId,
    email,
    brandId: brands.body.data[0].id as string,
    roleId: role.body.data.id as string,
    roleName,
  };
}

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Dukungan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
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

/**
 * read_write support access needs the tenant owner's approval (legend-c9kbk,
 * founder Q37/Q38): the Super Admin files a request, then a real owner of the
 * tenant approves it, which is what creates the read_write grant. Returns the
 * created grant's id. Assumption: the approval service takes the tenant
 * context, the approving owner's user id and the request id.
 */
async function openWriteGrant(
  forTenantId: string,
  adminUserId: string,
  approverUserId: string,
  durationMinutes: number = SUPPORT_ACCESS_WRITE_MAX_MINUTES,
  now: Date = new Date(),
) {
  const request = await requestSupportWriteAccess({
    tenantId: forTenantId,
    actorUserId: adminUserId,
    request: requestSupportWriteAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: forTenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: approverUserId },
    request.id,
    now,
  );
  expect(approved.status).toBe("approved");
  expect(approved.grantId).toBeTruthy();
  return { id: approved.grantId as string };
}

/** Asks to start an impersonation and returns the raw response. */
function tryImpersonate(
  admin: Awaited<ReturnType<typeof newSuperAdmin>>,
  tenant: Tenant,
) {
  return admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: tenant.userId });
}

/** The Super Admin's client turned into an impersonated tenant-user session. */
async function impersonate(
  admin: Awaited<ReturnType<typeof newSuperAdmin>>,
  tenant: Tenant,
) {
  const response = await tryImpersonate(admin, tenant);
  expect(response.status).toBe(200);
  // The impersonated session belongs to the tenant user; /api/org and
  // /api/access are closed until that session verified a second factor
  // (AUTH-05), so stamp it the way the other API suites do.
  await verifySessionMfa(tenant.email);
  return admin.client;
}

async function listDomains(client: Client): Promise<string[]> {
  const response = await client.get("/api/org/domains");
  expect(response.status).toBe(200);
  return response.body.data.map((row: { hostname: string }) => row.hostname);
}

async function createDomain(tenant: Tenant, hostname: string) {
  const response = await tenant.client
    .post("/api/org/domains")
    .set(originHeader)
    .send({ brandId: tenant.brandId, hostname });
  expect(response.status).toBe(201);
  domainsToClean.push({ client: tenant.client, id: response.body.data.id });
  return response.body.data.id as string;
}

const newHostname = () => `dukungan-${unique()}.example.com`;

async function roleNameOf(tenant: Tenant): Promise<string | undefined> {
  const roles = await tenant.client.get("/api/access/roles");
  expect(roles.status).toBe(200);
  return roles.body.data.find((r: { id: string }) => r.id === tenant.roleId)
    ?.name;
}

function expectCode(
  response: { status: number; body: { error?: { code?: string } } },
  code: "SUPPORT_ACCESS_REQUIRED" | "SUPPORT_ACCESS_READ_ONLY",
) {
  expect(response.status).toBe(403);
  expect(response.body.error?.code).toBe(code);
}

beforeAll(async () => {
  // A second, throwaway tenant for the cross-tenant case.
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Support session tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `support-ro-${otherTenantId.slice(0, 8)}`, tenantId],
  );
});

afterAll(async () => {
  for (const { client, id } of domainsToClean)
    await client
      .delete(`/api/org/domains/${id}`)
      .set(originHeader)
      .catch(() => undefined);
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

describe("legend-cg071 TEN-04 support session read-only", () => {
  it("TEN-04 read_only grant: reads pass, every mutation is refused and nothing changes", async () => {
    const tenant = await newTenantOwner();
    const existing = newHostname();
    const existingId = await createDomain(tenant, existing);
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    const list = await support.get("/api/org/domains");
    expect(list.status).toBe(200);
    expect(
      list.body.data.map((row: { hostname: string }) => row.hostname),
    ).toContain(existing);

    const attempted = newHostname();
    expectCode(
      await support
        .post("/api/org/domains")
        .set(originHeader)
        .send({ brandId: tenant.brandId, hostname: attempted }),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    expectCode(
      await support
        .patch(`/api/access/roles/${tenant.roleId}`)
        .set(originHeader)
        .send({ name: `Diubah dukungan ${unique()}` }),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    expectCode(
      await support.delete(`/api/org/domains/${existingId}`).set(originHeader),
      "SUPPORT_ACCESS_READ_ONLY",
    );

    // Nothing changed, as the tenant sees it.
    const after = await listDomains(tenant.client);
    expect(after).toContain(existing);
    expect(after).not.toContain(attempted);
    expect(await roleNameOf(tenant)).toBe(tenant.roleName);
  });

  it("TEN-04 no grant: the impersonation itself is refused and the admin stays themself", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const refused = await tryImpersonate(admin, tenant);
    expect(refused.status).toBe(403);
    const me = await admin.client.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(admin.userId);
  });

  it("TEN-04 a grant for another tenant does not open this tenant", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(otherTenantId, admin.userId);
    const refused = await tryImpersonate(admin, tenant);
    expect(refused.status).toBe(403);
    const me = await admin.client.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(admin.userId);
  });

  it("TEN-04 read_write grant: tenant mutations are allowed", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openWriteGrant(tenantId, admin.userId, tenant.userId);
    const support = await impersonate(admin, tenant);

    const hostname = newHostname();
    const created = await support
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId: tenant.brandId, hostname });
    expect(created.status).toBe(201);
    domainsToClean.push({ client: tenant.client, id: created.body.data.id });
    expect(await listDomains(tenant.client)).toContain(hostname);

    const renamed = `Diubah dukungan ${unique()}`;
    const patched = await support
      .patch(`/api/access/roles/${tenant.roleId}`)
      .set(originHeader)
      .send({ name: renamed });
    expect(patched.status).toBe(200);
    expect(await roleNameOf(tenant)).toBe(renamed);

    const removed = await support
      .delete(`/api/org/domains/${created.body.data.id}`)
      .set(originHeader);
    expect(removed.status).toBe(204);

    // Support never changes a user's credentials, even in read_write.
    expectCode(
      await support
        .post("/api/auth/update-user")
        .set(originHeader)
        .send({ name: "Nama Diganti Dukungan" }),
      "SUPPORT_ACCESS_READ_ONLY",
    );
  });

  it("TEN-04 the same user on a normal session keeps full write access", async () => {
    const tenant = await newTenantOwner();
    // A Super Admin holds an open read_only grant for this tenant; it must not
    // touch the tenant user's own session.
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);

    const hostname = newHostname();
    const id = await createDomain(tenant, hostname);
    expect(await listDomains(tenant.client)).toContain(hostname);
    const patched = await tenant.client
      .patch(`/api/access/roles/${tenant.roleId}`)
      .set(originHeader)
      .send({ name: `Diubah pemilik ${unique()}` });
    expect(patched.status).toBe(200);
    const removed = await tenant.client
      .delete(`/api/org/domains/${id}`)
      .set(originHeader);
    expect(removed.status).toBe(204);
  });

  it("TEN-04 the exits still work under read_only; changing credentials does not", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);
    const impersonated = await support.get("/api/auth/get-session");
    expect(impersonated.body.user.id).toBe(tenant.userId);

    expectCode(
      await support
        .post("/api/auth/update-user")
        .set(originHeader)
        .send({ name: "Nama Diganti Dukungan" }),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    const profile = await tenant.client.get("/api/auth/get-session");
    expect(profile.body.user.name).toBe("Pemilik Tenant");

    const stopped = await support
      .post("/api/auth/admin/stop-impersonating")
      .set(originHeader)
      .send({});
    expect(stopped.status).toBe(200);
    const back = await support.get("/api/auth/get-session");
    expect(back.body.user.id).toBe(admin.userId);
  });

  it("TEN-04 signing out ends an impersonated read_only session", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    const out = await support
      .post("/api/auth/sign-out")
      .set(originHeader)
      .send({});
    expect(out.status).toBe(200);
    expect((await support.get("/api/me/access")).status).toBe(401);
  });

  it("TEN-04 an ended grant no longer opens the tenant", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);
    expect((await support.get("/api/org/domains")).status).toBe(200);

    await endSupportAccess({
      tenantId,
      grantId: grant.id,
      actorUserId: admin.userId,
    });
    expectCode(
      await support.get("/api/org/domains"),
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("TEN-04 an expired grant no longer opens the tenant", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId, {
      durationMinutes: 60,
    });
    const support = await impersonate(admin, tenant);
    expect((await support.get("/api/org/domains")).status).toBe(200);

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
    expectCode(
      await support.get("/api/org/domains"),
      "SUPPORT_ACCESS_REQUIRED",
    );
  });

  it("TEN-04 /api/me/access exposes the support session only while impersonating", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    const under = await support.get("/api/me/access");
    expect(under.status).toBe(200);
    expect(under.body.data.supportSession.accessMode).toBe("read_only");
    expect(Date.parse(under.body.data.supportSession.expiresAt)).toBe(
      Date.parse(grant.expiresAt),
    );

    const normal = await tenant.client.get("/api/me/access");
    expect(normal.status).toBe(200);
    expect(normal.body.data.supportSession).toBeNull();
  });

  // Round 2 (R1/R2 review fixes). Assumptions (spec silent): the whole
  // /api/auth/* surface is closed to an impersonated session except
  // get-session, sign-out, admin/stop-impersonating and the idle keep-alive
  // sessions/current/activity; lasting credentials (MCP authorize) stay closed
  // even with read_write; an impersonated session is never a platform admin.
  // The KDS socket path (R2) is not covered here: its fixtures (station,
  // ticket, upgraded WebSocket) live inside kds-realtime.test.ts and are not
  // shared helpers, so it belongs in that suite.

  it("TEN-04 login challenges are closed to an impersonated session, in read_only and read_write", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    expectCode(
      await support
        .post("/api/auth/login-challenges/whatsapp")
        .set(originHeader)
        .send({}),
      "SUPPORT_ACCESS_READ_ONLY",
    );

    const writer = await newSuperAdmin();
    await openWriteGrant(tenantId, writer.userId, tenant.userId);
    const writeSupport = await impersonate(writer, tenant);
    expectCode(
      await writeSupport
        .post("/api/auth/login-challenges/whatsapp")
        .set(originHeader)
        .send({}),
      "SUPPORT_ACCESS_READ_ONLY",
    );
  });

  it("TEN-04 Better Auth reads are closed except get-session", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    expectCode(
      await support.get("/api/auth/list-sessions"),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    const session = await support.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.body.user.id).toBe(tenant.userId);
  });

  it("TEN-04 the idle keep-alive is not refused under a read_only grant", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    const response = await support
      .post("/api/auth/sessions/current/activity")
      .set(originHeader)
      .send({});
    // The support guard lets it through. The handler itself may still refuse
    // (a signed-up test session is not a staff session: FORBIDDEN), so only a
    // SUPPORT_ACCESS_* refusal would mean the guard blocked it.
    expect(response.body?.error?.code ?? "").not.toMatch(/^SUPPORT_ACCESS_/);
    expect(response.status).toBeLessThan(500);
  });

  it("TEN-04 an impersonated session is never a platform admin, even when the user is one", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const support = await impersonate(admin, tenant);

    // legend-rzirp: a platform admin cannot be impersonated, so the tenant
    // user only becomes a platform admin AFTER the support session started.
    await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      tenant.userId,
    ]);
    platformAdminIds.push(tenant.userId);

    // Control: the user's own normal session may use the platform API.
    expect(
      (await tenant.client.get("/api/platform/support-access")).status,
    ).toBe(200);

    // Tenant routes still work (the grant is open), so the refusal below comes
    // from the platform check and not from the missing grant.
    expect((await support.get("/api/org/domains")).status).toBe(200);
    const refused = await support.get("/api/platform/support-access");
    expect(refused.status).toBe(403);
  });

  it("TEN-04 minting an MCP authorization is refused under a read_write grant", async () => {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openWriteGrant(tenantId, admin.userId, tenant.userId);
    const support = await impersonate(admin, tenant);

    // Ordinary tenant writes are allowed, a lasting credential is not.
    const hostname = newHostname();
    const created = await support
      .post("/api/org/domains")
      .set(originHeader)
      .send({ brandId: tenant.brandId, hostname });
    expect(created.status).toBe(201);
    domainsToClean.push({ client: tenant.client, id: created.body.data.id });

    expectCode(
      await support
        .post("/api/ai/mcp/authorize")
        .set(originHeader)
        .send({
          clientId: `support-${unique()}`,
          redirectUri: "http://localhost:8123/callback",
          scopes: [],
          codeChallenge: "x".repeat(43),
          codeChallengeMethod: "S256",
        }),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    // Edge-node link credentials (create, rotate) are lasting credentials too,
    // refused before validation, so the bodies do not matter. Mixed case and a
    // doubled slash reach the same Express handler and must hit the same rule.
    expectCode(
      await support.post("/api/edge-nodes").set(originHeader).send({}),
      "SUPPORT_ACCESS_READ_ONLY",
    );
    expectCode(
      await support
        .post(`/api/Edge-Nodes/${randomUUID()}/rotate-credential`)
        .set(originHeader)
        .send({}),
      "SUPPORT_ACCESS_READ_ONLY",
    );
  });
});
