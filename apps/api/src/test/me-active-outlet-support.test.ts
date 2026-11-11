// PUT /api/me/active-outlet under a support session (TEN-04, PRD v1.7 §3 F4
// Support Access: "read-only secara default"). Pinning the active outlet writes
// a session_active_outlets row, so it is a mutation: a Super Admin acting as a
// tenant user with a read_only grant must be refused, and the refusal must leave
// no row behind.
//
// Written from docs/briefs/sub-support-readonly.md and the sibling suite
// support-session-readonly.test.ts, not from the route code.
// ASSUMPTIONS:
//  - Refusal is HTTP 403 with body.error.code "SUPPORT_ACCESS_READ_ONLY"
//    (same contract as the sibling suite).
//  - The row is keyed by the impersonated session id (session_id column,
//    from the committed migration). The suite reads it with a plain pool; the
//    control case proves that pool can see a pin row, so "no row" is not vacuous.
//  - Control: under a read_write grant the support guard lets the PUT through
//    (200). That the tenant owner may reach the outlet is a precondition.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
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
const outletId = cafeLegendPlatformFixtures.outlets[0].id as string;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas pilihan outlet aktif tenant.";
const unique = () => randomBytes(4).toString("hex");

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const sessionIds: string[] = [];

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
  sessionIds.push(sessionId);
  return { client: admin.client as Client, sessionId };
}

const pinRows = async (sessionId: string) =>
  (
    await db.query(
      "SELECT outlet_id FROM session_active_outlets WHERE session_id = $1",
      [sessionId],
    )
  ).rows as { outlet_id: string }[];

const pin = (client: Client) =>
  client.put("/api/me/active-outlet").set(originHeader).send({ outletId });

afterAll(async () => {
  await db.query(
    "DELETE FROM session_active_outlets WHERE session_id = ANY($1::text[])",
    [sessionIds],
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

describe("legend-6vgv TEN-04 PUT /api/me/active-outlet in a support session", () => {
  it("TEN-04 read_only grant: pinning the active outlet is refused and no pin row is written", async () => {
    const tenantUser = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openReadOnlyGrant(admin.userId);
    const { client, sessionId } = await impersonate(admin, tenantUser);

    expect(await pinRows(sessionId)).toEqual([]);

    const refused = await pin(client);
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("SUPPORT_ACCESS_READ_ONLY");

    // Nothing was stored for the support session.
    expect(await pinRows(sessionId)).toEqual([]);
  });

  it("TEN-04 read_write grant (control): the same PUT is allowed and stores the pin", async () => {
    const tenantUser = await newTenantOwner();
    const admin = await newSuperAdmin();
    await openWriteGrant(admin.userId, tenantUser.userId);
    const { client, sessionId } = await impersonate(admin, tenantUser);

    const res = await pin(client);
    expect(res.status).toBe(200);
    expect(res.body.data.activeOutletId).toBe(outletId);
    // Proves the pool can see pin rows, so the read_only "no row" check bites.
    expect((await pinRows(sessionId)).map((r) => r.outlet_id)).toEqual([
      outletId,
    ]);
  });
});
