// 1272 K5 review: PUT /api/org/integrations and the platform-only fee caps
// (`maxFee*`). A plain tenant owner cannot change a cap (403
// DUITKU_FEE_CAP_PLATFORM_ONLY); a support session with a read_write grant can;
// a read_only grant is refused by the support guard and writes nothing.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
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
const tenantId = cafeLegendPlatformFixtures.tenant.id as string;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas batas biaya gateway tenant.";
const unique = () => randomBytes(4).toString("hex");

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
let originalProviders: unknown;

type Client = ReturnType<typeof agent>;

async function newTenantOwner() {
  const client = agent(app);
  const email = await signUp(client, "Pemilik Outlet Dukungan");
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
  return { client, userId, email };
}

async function newSuperAdmin() {
  const client = agent(app);
  const email = await signUp(client, `Super Admin Outlet ${unique()}`);
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId };
}

async function openReadOnlyGrant(adminUserId: string) {
  const now = new Date();
  return requestSupportAccess({
    tenantId,
    actorUserId: adminUserId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

async function openWriteGrant(adminUserId: string, approverUserId: string) {
  const now = new Date();
  const request = await requestSupportWriteAccess({
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
    request.id,
    now,
  );
  expect(approved.status).toBe("approved");
}

/** Turns the admin's client into an impersonated session; returns its id. */
async function impersonate(
  admin: Awaited<ReturnType<typeof newSuperAdmin>>,
  tenantUser: Awaited<ReturnType<typeof newTenantOwner>>,
) {
  const response = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: tenantUser.userId });
  expect(response.status).toBe(200);
  await verifySessionMfa(tenantUser.email);
  const session = await admin.client.get("/api/auth/get-session");
  expect(session.body.user.id).toBe(tenantUser.userId);
  const sessionId = session.body.session.id as string;
  return { client: admin.client as Client, sessionId };
}

const CAPS = { maxFeeBps_va: 0, maxFeeFlatIdr_va: 5_000 };
const body = (caps: Record<string, number>) => ({
  outletId: null,
  provider: "duitku",
  config: {
    environment: "sandbox",
    notificationEmail: "kas@cafe.test",
    ...caps,
  },
});
const put = (client: Client, caps: Record<string, number>) =>
  client.put("/api/org/integrations").set(originHeader).send(body(caps));
const storedCaps = async () =>
  (
    await db.query<{ config: Record<string, number> }>(
      "SELECT config FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
      [tenantId],
    )
  ).rows[0]?.config.maxFeeFlatIdr_va;

beforeAll(async () => {
  const flags = await db.query<{ providers: unknown }>(
    "SELECT feature_flags->'integrationProviders' AS providers FROM tenants WHERE id = $1",
    [tenantId],
  );
  originalProviders = flags.rows[0]?.providers;
  await db.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
              (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
      WHERE id = $1
        AND NOT (feature_flags->'integrationProviders') ? 'duitku'`,
    [tenantId],
  );
  await db.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
    [tenantId],
  );
  // The platform wrote the caps (no API path does yet).
  await db.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config)
     VALUES ($1, 'duitku', $2::jsonb)`,
    [
      tenantId,
      JSON.stringify({
        environment: "sandbox",
        notificationEmail: "kas@cafe.test",
        ...CAPS,
      }),
    ],
  );
});

afterAll(async () => {
  await db.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
    [tenantId],
  );
  await db.query(
    "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1",
    [tenantId, JSON.stringify(originalProviders)],
  );
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

describe("PUT /api/org/integrations fee caps (1272 K5)", () => {
  it("a plain tenant owner cannot change a cap, but can save it unchanged", async () => {
    const owner = await newTenantOwner();
    const raised = await put(owner.client, {
      ...CAPS,
      maxFeeFlatIdr_va: 9_000,
    });
    expect(raised.status).toBe(403);
    expect(raised.body.error?.code).toBe("DUITKU_FEE_CAP_PLATFORM_ONLY");
    expect(await storedCaps()).toBe(5_000);
    expect((await put(owner.client, CAPS)).status).toBe(200);
  });

  it("a read_only support grant cannot change a cap", async () => {
    const tenantUser = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openReadOnlyGrant(admin.userId);
    const { client } = await impersonate(admin, tenantUser);
    const res = await put(client, { ...CAPS, maxFeeFlatIdr_va: 7_000 });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("SUPPORT_ACCESS_READ_ONLY");
    expect(await storedCaps()).toBe(5_000);
  });

  it("a read_write support grant can change a cap", async () => {
    const tenantUser = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openWriteGrant(admin.userId, tenantUser.userId);
    const { client } = await impersonate(admin, tenantUser);
    const res = await put(client, { ...CAPS, maxFeeFlatIdr_va: 7_000 });
    expect(res.status).toBe(200);
    expect(await storedCaps()).toBe(7_000);
  });
});
