// legend-xqkr7 (CTO decision, 15 Nov): a support (impersonation) session is
// limited to the tenants the Super Admin holds a grant for, for BOTH the alarm
// device list and the login-session list. Least privilege on personal data.
// Written from the card + shared contract (packages/shared identity endpoints),
// not from the implementation.
//
// ASSUMPTIONS (card/spec leave open):
//  - The card names GET /api/identity/sessions, but the shared contract
//    (`listSessions` in packages/shared/src/identity/endpoints.ts) defines the
//    session list at GET /api/auth/sessions -> 200 { data: [{ session, current }] }.
//    This test calls the contract path.
//  - A "session of tenant X" is a login session whose session.tenant_id = X
//    (set directly, as identity-session-api.test.ts does). A session with no
//    tenant (tenant_id NULL), including the impersonated session itself, is NOT
//    asserted either way: the decision only speaks about tenants outside the grant.
//  - A device belongs to the tenant of its push_subscriptions.tenant_id.
//  - The scope follows live grants: ending the grant of tenant B while the
//    grant of tenant A stays open removes B rows from the support session.
//  - ROOT CAUSE of the earlier 403s: the support guard (middleware/support-session.ts)
//    is deliberate. Rule 4 fails closed for an impersonated session with no
//    resolved tenant, so the support client sends tenant A's Host (its grant
//    covers A). Rule 6 refuses every /api/auth/* path except a short allowlist
//    that excludes GET /api/auth/sessions, so a support session can never read
//    the login-session list over HTTP. The session filter is therefore asserted
//    on the service pair the route uses (supportGrantedTenantIds + listOwnSessions),
//    and the HTTP refusal is asserted separately.
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestSupportAccessInputSchema } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { listOwnSessions } from "../services/identity-session.service.ts";
import {
  endSupportAccess,
  requestSupportAccess,
  supportGrantedTenantIds,
} from "../services/platform-support.service.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const PUSH = "/api/identity/push-devices";
const SESSIONS = "/api/auth/sessions";
const REASON =
  "Menelusuri keluhan pelanggan atas perangkat alarm dan sesi login.";
const app = createApp();
const unique = () => randomBytes(4).toString("hex");

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
const userIds: string[] = [];
const adminIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Target = {
  client: Client;
  userId: string;
  email: string;
  labelA: string;
  labelB: string;
  deviceA: string;
  deviceB: string;
  /** Login sessions of the target pinned to tenant A and tenant B. */
  sessionA: string;
  sessionB: string;
};
type Admin = { client: Client; userId: string };

const sessionIdOf = async (client: Client) =>
  (await client.get("/api/auth/get-session")).body.session.id as string;

/** A registered alarm device (v2 registration) of `userId` inside `tenant`. */
async function seedDevice(
  tenant: IsolatedTenant,
  userId: string,
  label: string,
): Promise<string> {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const sealed = await createPushSubscriptionProtector().seal(
    {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    },
    tenant.tenantId,
    userId,
  );
  const id = randomUUID();
  const now = new Date();
  await owner.query(
    `INSERT INTO push_subscriptions
       (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version,
        outlet_id, device_label, session_id, created_at, registered_at,
        device_id, device_token_issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9, NULL, NULL)`,
    [
      tenant.tenantId,
      id,
      userId,
      sealed.endpointHash,
      sealed.ciphertext,
      sealed.keyVersion,
      tenant.outletId,
      label,
      now,
    ],
  );
  return id;
}

/**
 * A user who is a member of tenants A and B, owns one alarm device and one
 * pinned login session in each, plus their own ordinary (tenant-less) session.
 */
async function newTarget(): Promise<Target> {
  const client = agent(app);
  const email = await signUp(client, "Pengguna Dua Tenant");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  userIds.push(userId);
  for (const tenant of [tenantA, tenantB]) {
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, tenant.roleId],
    );
  }

  const labelA = `HP-A-${unique()}`;
  const labelB = `HP-B-${unique()}`;
  const deviceA = await seedDevice(tenantA, userId, labelA);
  const deviceB = await seedDevice(tenantB, userId, labelB);

  const pinnedSession = async (tenant: IsolatedTenant) => {
    const other = agent(app);
    const response = await other
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email, password: "Test-password-123!" });
    expect(response.status).toBe(200);
    const id = await sessionIdOf(other);
    await owner.query(`UPDATE "session" SET tenant_id = $1 WHERE id = $2`, [
      tenant.tenantId,
      id,
    ]);
    return id;
  };
  const sessionA = await pinnedSession(tenantA);
  const sessionB = await pinnedSession(tenantB);
  return {
    client,
    userId,
    email,
    labelA,
    labelB,
    deviceA,
    deviceB,
    sessionA,
    sessionB,
  };
}

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Dukungan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    userId,
  ]);
  adminIds.push(userId);
  return { client, userId };
}

function openGrant(tenant: IsolatedTenant, admin: Admin) {
  const now = new Date();
  return requestSupportAccess({
    tenantId: tenant.tenantId,
    actorUserId: admin.userId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** The admin's client turned into an impersonated session of the target. */
async function impersonate(admin: Admin, target: Target): Promise<Client> {
  const response = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: target.userId });
  expect(response.status).toBe(200);
  // Same as impersonation-grant.test.ts: the impersonated session starts
  // without a second factor, which would otherwise close tenant routes.
  await verifySessionMfa(target.email);
  const me = await admin.client.get("/api/auth/get-session");
  expect(me.body.user.id).toBe(target.userId);
  expect(me.body.session.impersonatedBy).toBe(admin.userId);
  return admin.client;
}

/** Support clients call as tenant A's host (rule 4 needs a resolved tenant). */
const asSupport = (client: Client) =>
  client.get(PUSH).set("Host", tenantA.hostname).set(originHeader);
const asOwn = (client: Client) => client.get(PUSH).set(originHeader);
const deviceLabels = async (client: Client, support = true) => {
  const response = await (support ? asSupport(client) : asOwn(client));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { deviceLabel: string | null }[]).map(
    (device) => device.deviceLabel,
  );
};
const deviceIds = async (client: Client, support = true) => {
  const response = await (support ? asSupport(client) : asOwn(client));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { id: string }[]).map((device) => device.id);
};
/** What the GET /api/auth/sessions handler computes for a support session. */
const supportSessionIds = async (admin: Admin, target: Target) => {
  const views = await listOwnSessions({
    userId: target.userId,
    currentSessionId: "unused",
    onlyTenantIds: await supportGrantedTenantIds({
      adminUserId: admin.userId,
      targetUserId: target.userId,
    }),
  });
  return views.map((view) => view.session.id);
};
const ownSessionIds = async (client: Client) => {
  const response = await client.get(SESSIONS).set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { session: { id: string } }[]).map(
    (view) => view.session.id,
  );
};

beforeAll(async () => {
  tenantA = await createIsolatedTenant(`sua-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`sub-${randomUUID().slice(0, 6)}`);
}, 90_000);

afterAll(async () => {
  const tenantIds = [tenantA.tenantId, tenantB.tenantId];
  await owner.query(
    `DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])`,
    [adminIds],
  );
  await owner.query(`DELETE FROM "session" WHERE tenant_id = ANY($1::uuid[])`, [
    tenantIds,
  ]);
  await owner.query(`DELETE FROM "session" WHERE user_id = ANY($1::text[])`, [
    [...userIds, ...adminIds],
  ]);
  await owner.query(
    `DELETE FROM push_subscriptions WHERE tenant_id = ANY($1::uuid[])`,
    [tenantIds],
  );
  await owner.query(`DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])`, [
    tenantIds,
  ]);
  await owner.query(
    `DELETE FROM platform_admins WHERE user_id = ANY($1::text[])`,
    [adminIds],
  );
  for (const tenant of [tenantA, tenantB]) await dropIsolatedTenant(tenant);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    [...userIds, ...adminIds],
  ]);
  await owner.end();
});

describe("legend-xqkr7 support session is limited to granted tenants", () => {
  it("legend-xqkr7 a support session with a grant only on tenant A lists only tenant A's alarm devices", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    await openGrant(tenantA, admin);
    const support = await impersonate(admin, target);

    const ids = await deviceIds(support);
    expect(ids).toContain(target.deviceA);
    expect(ids).not.toContain(target.deviceB);

    // The tenant B label must not leak anywhere in the payload either.
    const raw = JSON.stringify((await asSupport(support)).body);
    expect(raw).toContain(target.labelA);
    expect(raw).not.toContain(target.labelB);
    expect(await deviceLabels(support)).not.toContain(target.labelB);
  });

  it("legend-xqkr7 a support session with a grant only on tenant A lists only tenant A's login sessions", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    await openGrant(tenantA, admin);
    const support = await impersonate(admin, target);

    const ids = await supportSessionIds(admin, target);
    expect(ids).toContain(target.sessionA);
    expect(ids).not.toContain(target.sessionB);

    // Over HTTP the support session cannot list sessions at all (rule 6).
    const refused = await support.get(SESSIONS).set(originHeader);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });

  it("legend-xqkr7 an ordinary (non-support) session of the same user still sees tenants A and B", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    await openGrant(tenantA, admin);
    await impersonate(admin, target);

    // The user's own login, untouched by the support session next to it.
    const devices = await deviceIds(target.client, false);
    expect(devices).toContain(target.deviceA);
    expect(devices).toContain(target.deviceB);
    const sessions = await ownSessionIds(target.client);
    expect(sessions).toContain(target.sessionA);
    expect(sessions).toContain(target.sessionB);
  });

  it("legend-xqkr7 a support session with grants on tenants A and B sees both", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    await openGrant(tenantA, admin);
    await openGrant(tenantB, admin);
    const support = await impersonate(admin, target);

    const devices = await deviceIds(support);
    expect(devices).toContain(target.deviceA);
    expect(devices).toContain(target.deviceB);
    const sessions = await supportSessionIds(admin, target);
    expect(sessions).toContain(target.sessionA);
    expect(sessions).toContain(target.sessionB);
  });

  it("legend-xqkr7 ending the grant of tenant B closes tenant B rows for the support session while tenant A stays", async () => {
    const target = await newTarget();
    const admin = await newSuperAdmin();
    await openGrant(tenantA, admin);
    const grantB = await openGrant(tenantB, admin);
    const support = await impersonate(admin, target);
    expect(await deviceIds(support)).toContain(target.deviceB);

    await endSupportAccess({
      tenantId: tenantB.tenantId,
      grantId: grantB.id,
      actorUserId: admin.userId,
    });

    const devices = await deviceIds(support);
    expect(devices).toContain(target.deviceA);
    expect(devices).not.toContain(target.deviceB);
    const sessions = await supportSessionIds(admin, target);
    expect(sessions).toContain(target.sessionA);
    expect(sessions).not.toContain(target.sessionB);
  });
});
