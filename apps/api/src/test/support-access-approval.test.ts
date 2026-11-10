// Support read_write access needs the tenant owner's approval
// (legend-c9kbk, TEN-04, tier K: auth + personal data; founder Q37/Q38).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka ... read-only secara default" (PRD v1.7 §3 F4 Support Access).
//
// Policy under test (docs/briefs/sub-support-rw-owner-approval.md):
//   - read_only grants are unchanged (MFA + notify, effective at once).
//   - read_write: a Super Admin files a REQUEST. Until an owner of THAT tenant
//     approves it, no grant exists, so the guard and the impersonation see "no
//     grant". On approval the grant starts at the approval time and lasts the
//     requested duration (15 or 30 min).
//   - Only an owner (permission org.support_access.approve AND an active
//     owner-template assignment in that tenant) with a second-factor-verified,
//     non-impersonated session, who is not the requesting admin, may decide.
//   - A request left undecided for 24 h expires. Each step is audited (TEN-04).
//
// Assumptions (spec silent):
//   - Service-level cases inject `now`; the clock is never slept on.
//   - Refusals of Express routes are HTTP 403/404/409 with body.error.code;
//     Better Auth refusals (impersonation) use body.code (APIError shape).
//   - A request of another tenant answers 404 or 403 to a foreign owner.
//   - An owner session without a verified second factor is refused with 403
//     (the exact code, MFA_REQUIRED, is not asserted: AUTH-05 may close the
//     route earlier with another 403 code).
//   - The outbox event is found by name and payload.requestId, not by its
//     aggregate type.
//   - Audit objectId of requested/approved/rejected/request_expired is the
//     request id; support_access.granted keeps the grant id.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  type RequestSupportAccessInput,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  assertSupportAccess,
  expireDueSupportAccessGrants,
  listSupportAccessRequests,
  rejectSupportAccessRequest,
  requestSupportAccess,
  requestSupportWriteAccess,
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
const REASON = "Memperbaiki pengaturan peran tenant atas permintaan pemilik.";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const customRoleIds: string[] = [];

type Client = ReturnType<typeof agent>;
type TenantUser = { client: Client; userId: string; email: string };
type Admin = TenantUser;

function contextOf(forTenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(forTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A tenant user holding the given role template (normal session). */
async function newTenantUser(
  templateKey: "owner" | "finance",
  options: { verifyMfa?: boolean } = {},
): Promise<TenantUser> {
  const client = agent(app);
  const email = await signUp(client, `Anggota ${templateKey}`);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  await assignTemplate(userId, templateKey);
  if (options.verifyMfa !== false) await verifySessionMfa(email);
  return { client, userId, email };
}

async function assignTemplate(userId: string, templateKey: string) {
  const { rowCount } = await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2,
            now() - interval '1 day' FROM roles
     WHERE tenant_id = $1 AND template_key = $3`,
    [tenantId, userId, templateKey],
  );
  expect(rowCount).toBe(1);
}

const newOwner = () => newTenantUser("owner");

/** A Super Admin: Better Auth `admin` role plus a platform_admins row. */
async function newSuperAdmin(
  options: { alsoTenantOwner?: boolean } = {},
): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Persetujuan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  if (options.alsoTenantOwner) {
    tenantUserIds.push(userId);
    await assignTemplate(userId, "owner");
    await verifySessionMfa(email);
  }
  return { client, userId, email };
}

/** Legacy read_only path (read_write is refused there since legend-c9kbk). */
function openReadOnlyGrant(
  forTenantId: string,
  adminUserId: string,
  now: Date = new Date(),
) {
  return requestSupportAccess({
    tenantId: tenantIdSchema.parse(forTenantId),
    actorUserId: adminUserId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** The pre-change way to open write access, used only by the repro test. */
function openLegacyReadWriteGrant(adminUserId: string) {
  const now = new Date();
  const request: RequestSupportAccessInput =
    requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      accessMode: "read_write",
      durationMinutes: 30,
    });
  return requestSupportAccess({
    tenantId,
    actorUserId: adminUserId,
    request,
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

function requestWrite(
  forTenantId: string,
  adminUserId: string,
  durationMinutes: 15 | 30 = 30,
  now: Date = new Date(),
) {
  return requestSupportWriteAccess({
    tenantId: tenantIdSchema.parse(forTenantId),
    actorUserId: adminUserId,
    request: { reason: REASON, durationMinutes, mfaCode: "123456" },
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

const approve = (
  owner: TenantUser,
  requestId: string,
  now?: Date,
  forTenantId: string = tenantId,
) =>
  approveSupportAccessRequest(
    contextOf(forTenantId),
    { userId: owner.userId },
    requestId,
    now,
  );

const reject = (owner: TenantUser, requestId: string, now?: Date) =>
  rejectSupportAccessRequest(
    contextOf(tenantId),
    { userId: owner.userId },
    requestId,
    now,
  );

function tryImpersonate(admin: Admin, targetUserId: string) {
  return admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: targetUserId });
}

async function expectImpersonationRefused(admin: Admin, targetUserId: string) {
  const refused = await tryImpersonate(admin, targetUserId);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe("SUPPORT_ACCESS_REQUIRED");
  const me = await admin.client.get("/api/auth/get-session");
  expect(me.body.user.id).toBe(admin.userId);
  expect(me.body.session.impersonatedBy ?? null).toBeNull();
  const rows = await db.query(
    `SELECT 1 FROM "session" WHERE impersonated_by = $1`,
    [admin.userId],
  );
  expect(rows.rowCount).toBe(0);
}

async function expectGuardRefuses(adminUserId: string) {
  for (const intent of ["read", "write"] as const)
    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: adminUserId,
        dataClass: "personal",
        intent,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
}

async function grantCount(adminUserId: string, forTenantId: string = tenantId) {
  const result = await db.query(
    `SELECT 1 FROM support_access_grants
      WHERE tenant_id = $1 AND super_admin_user_id = $2`,
    [forTenantId, adminUserId],
  );
  return result.rowCount ?? 0;
}

async function requestRow(requestId: string) {
  const result = await db.query<{
    status: string;
    decided_at: Date | null;
    decided_by: string | null;
    grant_id: string | null;
    approval_expires_at: Date;
  }>(
    `SELECT status, decided_at, decided_by, grant_id, approval_expires_at
       FROM support_access_requests WHERE id = $1`,
    [requestId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

async function grantRow(grantId: string) {
  const result = await db.query<{
    started_at: Date;
    expires_at: Date;
    access_mode: string;
    super_admin_user_id: string;
  }>(
    `SELECT started_at, expires_at, access_mode, super_admin_user_id
       FROM support_access_grants WHERE id = $1`,
    [grantId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

type AuditEvent = {
  action: string;
  actorType: string;
  actorId: string | null;
  objectType: string | null;
  objectId: string | null;
  reason: string | null;
  sensitiveAccess: boolean;
};

async function auditRows(
  forTenantId: string,
  action: string,
  objectId: string,
) {
  const result = await db.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event->>'objectId' = $3
      ORDER BY created_at, id`,
    [forTenantId, action, objectId],
  );
  return result.rows.map((row) => row.event);
}

async function outboxRequested(forTenantId: string, requestId: string) {
  const result = await db.query<{
    destination: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'support_access.requested'
        AND event->'payload'->>'requestId' = $2`,
    [forTenantId, requestId],
  );
  return result.rows;
}

const approvePath = (requestId: string) =>
  `/api/org/support-access/requests/${requestId}/approve`;
const rejectPath = (requestId: string) =>
  `/api/org/support-access/requests/${requestId}/reject`;

function postDecision(client: Client, path: string) {
  return client.post(path).set(originHeader).send({});
}

beforeAll(async () => {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Support approval tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `support-appr-${otherTenantId.slice(0, 8)}`, tenantId],
  );
});

afterAll(async () => {
  // Requests and grants reference each other (grant_id, approval_request_id)
  // and decided rows cannot be updated, so delete both in one statement
  // (NO ACTION foreign keys are checked at the end of the statement).
  await db.query(
    `WITH gone AS (
       DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])
     )
     DELETE FROM support_access_requests WHERE super_admin_user_id = ANY($1::text[])`,
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
  await db.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
    customRoleIds,
  ]);
  await db.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await db.end();
});

describe("legend-c9kbk TEN-04 repro: read_write is not open before owner approval", () => {
  // Uses only APIs that exist on the base commit. On base the grant is
  // created at once and the impersonation succeeds, so this fails there.
  it("legend-c9kbk TEN-04 a read_write grant filed by a super admin gives no access before any owner approval", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();

    // New behaviour refuses the direct grant (409); base opens it. Either
    // way, the assertions below must hold.
    await openLegacyReadWriteGrant(admin.userId).catch(() => undefined);

    await expectImpersonationRefused(admin, owner.userId);
    await expectGuardRefuses(admin.userId);
    expect(await grantCount(admin.userId)).toBe(0);
  });
});

describe("legend-c9kbk TEN-04 pending request", () => {
  it("legend-c9kbk TEN-04 requestSupportAccess with read_write is refused with 409 and creates no grant", async () => {
    const admin = await newSuperAdmin();
    await expect(openLegacyReadWriteGrant(admin.userId)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED",
    });
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 a pending request gives no access: guard and impersonation refuse and no grant row exists", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    expect(request).toMatchObject({
      tenantId,
      superAdminUserId: admin.userId,
      accessMode: "read_write",
      durationMinutes: 30,
      reason: REASON,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      grantId: null,
    });
    expect(
      Date.parse(request.approvalExpiresAt) - Date.parse(request.requestedAt),
    ).toBe(24 * HOUR_MS);

    await expectGuardRefuses(admin.userId);
    await expectImpersonationRefused(admin, owner.userId);
    expect(await grantCount(admin.userId)).toBe(0);
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("legend-c9kbk TEN-04 a second request while one is pending is refused with 409", async () => {
    const admin = await newSuperAdmin();
    await requestWrite(tenantId, admin.userId);
    await expect(requestWrite(tenantId, admin.userId)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_REQUEST_PENDING",
    });
  });
});

describe("legend-c9kbk TEN-04 owner approves", () => {
  it("legend-c9kbk TEN-04 approval starts the grant at approval time, impersonation works and the session is bounded by the grant end", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    // Requested 10 minutes ago; the 30 minutes count from the approval.
    const requestedAt = new Date(Date.now() - 10 * MINUTE_MS);
    const request = await requestWrite(tenantId, admin.userId, 30, requestedAt);

    const approvedAt = new Date();
    const approved = await approve(owner, request.id, approvedAt);
    expect(approved).toMatchObject({
      id: request.id,
      status: "approved",
      decidedBy: owner.userId,
      decidedAt: approvedAt.toISOString(),
    });
    expect(approved.grantId).toEqual(expect.any(String));

    const grant = await grantRow(approved.grantId!);
    expect(grant).toMatchObject({
      access_mode: "read_write",
      super_admin_user_id: admin.userId,
    });
    expect(grant.started_at.getTime()).toBe(approvedAt.getTime());
    expect(grant.expires_at.getTime()).toBe(
      approvedAt.getTime() + 30 * MINUTE_MS,
    );
    const row = await requestRow(request.id);
    expect(row).toMatchObject({
      status: "approved",
      decided_by: owner.userId,
      grant_id: approved.grantId,
    });

    // The guard now lets the admin write in this tenant.
    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        dataClass: "personal",
        intent: "write",
      }),
    ).resolves.toMatchObject({
      id: approved.grantId,
      accessMode: "read_write",
    });

    // Impersonation works and its session never outlives the grant.
    const started = await tryImpersonate(admin, owner.userId);
    expect(started.status).toBe(200);
    const session = await db.query<{ expires_at: Date }>(
      `SELECT expires_at FROM "session" WHERE impersonated_by = $1`,
      [admin.userId],
    );
    expect(session.rowCount).toBe(1);
    const sessionEnd = session.rows[0]!.expires_at.getTime();
    expect(sessionEnd).toBeLessThanOrEqual(grant.expires_at.getTime());
    expect(sessionEnd).toBeGreaterThan(Date.now() + 20 * MINUTE_MS);
  });

  it("legend-c9kbk TEN-04 the duration counts from the approval, even when approved hours after the request", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const requestedAt = new Date();
    const request = await requestWrite(tenantId, admin.userId, 15, requestedAt);
    const approvedAt = new Date(requestedAt.getTime() + 23 * HOUR_MS);
    const approved = await approve(owner, request.id, approvedAt);

    const grant = await grantRow(approved.grantId!);
    expect(grant.started_at.getTime()).toBe(approvedAt.getTime());
    expect(grant.expires_at.getTime()).toBe(
      approvedAt.getTime() + 15 * MINUTE_MS,
    );
  });

  it("legend-c9kbk TEN-04 a decided request cannot be approved again (409)", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);
    await approve(owner, request.id);
    await expect(approve(owner, request.id)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_REQUEST_NOT_PENDING",
    });
    expect(await grantCount(admin.userId)).toBe(1);
  });
});

describe("legend-c9kbk TEN-04 owner rejects", () => {
  it("legend-c9kbk TEN-04 a rejected request never gives access and approving it afterwards is 409", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const rejected = await reject(owner, request.id);
    expect(rejected).toMatchObject({
      id: request.id,
      status: "rejected",
      decidedBy: owner.userId,
      grantId: null,
    });
    expect(rejected.decidedAt).toEqual(expect.any(String));

    await expectGuardRefuses(admin.userId);
    await expectImpersonationRefused(admin, owner.userId);
    expect(await grantCount(admin.userId)).toBe(0);

    await expect(approve(owner, request.id)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_REQUEST_NOT_PENDING",
    });
    expect(await grantCount(admin.userId)).toBe(0);
    expect((await requestRow(request.id)).status).toBe("rejected");

    // After a rejection the admin may file a new request.
    const again = await requestWrite(tenantId, admin.userId);
    expect(again.status).toBe("pending");
  });

  it("legend-c9kbk TEN-04 an owner rejects over HTTP and the approve route then answers 409", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const rejected = await postDecision(owner.client, rejectPath(request.id));
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({
      id: request.id,
      status: "rejected",
      decidedBy: owner.userId,
    });

    const late = await postDecision(owner.client, approvePath(request.id));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("SUPPORT_ACCESS_REQUEST_NOT_PENDING");
    expect(await grantCount(admin.userId)).toBe(0);
  });
});

describe("legend-c9kbk TEN-04 24 hours without an answer", () => {
  it("legend-c9kbk TEN-04 the sweep expires an unanswered request, approving is 409 and the expiry is audited", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    // Filed 25 hours ago: the window lapsed an hour ago.
    const request = await requestWrite(
      tenantId,
      admin.userId,
      30,
      new Date(Date.now() - 25 * HOUR_MS),
    );

    // The returned count is not asserted: the brief does not say whether it
    // counts requests or only grants.
    await expireDueSupportAccessGrants(contextOf(tenantId), new Date());

    const row = await requestRow(request.id);
    expect(row.status).toBe("expired");
    expect(row.decided_by).toBeNull();
    expect(row.grant_id).toBeNull();
    expect(row.decided_at!.getTime()).toBeGreaterThanOrEqual(
      row.approval_expires_at.getTime(),
    );

    const audit = await auditRows(
      tenantId,
      "support_access.request_expired",
      request.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      objectType: "support_access_request",
    });

    await expect(approve(owner, request.id)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_REQUEST_NOT_PENDING",
    });
    expect(await grantCount(admin.userId)).toBe(0);
    await expectGuardRefuses(admin.userId);
  });

  it("legend-c9kbk TEN-04 approving after 24 hours is refused even when no sweep ran", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const requestedAt = new Date();
    const request = await requestWrite(tenantId, admin.userId, 30, requestedAt);

    await expect(
      approve(
        owner,
        request.id,
        new Date(requestedAt.getTime() + 24 * HOUR_MS + 1000),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_ACCESS_REQUEST_NOT_PENDING",
    });
    expect(await grantCount(admin.userId)).toBe(0);
    expect((await requestRow(request.id)).status).not.toBe("approved");
  });
});

describe("legend-c9kbk TEN-04 who may decide (HTTP)", () => {
  it("legend-c9kbk TEN-04 an owner approves over HTTP and the tenant lists the request", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const listed = await owner.client.get("/api/org/support-access/requests");
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(
      request.id,
    );

    const approved = await postDecision(owner.client, approvePath(request.id));
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: request.id,
      status: "approved",
      decidedBy: owner.userId,
    });
    expect(approved.body.data.grantId).toEqual(expect.any(String));
    expect(await grantCount(admin.userId)).toBe(1);
  });

  it("legend-c9kbk TEN-04 a tenant member without the permission gets 403 and the request stays pending", async () => {
    const finance = await newTenantUser("finance");
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    for (const path of [approvePath(request.id), rejectPath(request.id)]) {
      const response = await postDecision(finance.client, path);
      expect(response.status).toBe(403);
    }
    const listed = await finance.client.get("/api/org/support-access/requests");
    expect(listed.status).toBe(403);

    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 an owner whose session has not passed 2FA gets 403 and the request stays pending", async () => {
    const owner = await newTenantUser("owner", { verifyMfa: false });
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const response = await postDecision(owner.client, approvePath(request.id));
    expect(response.status).toBe(403);
    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 a super admin who is also an owner cannot approve their own request (403 SUPPORT_SELF_APPROVAL)", async () => {
    const admin = await newSuperAdmin({ alsoTenantOwner: true });
    const request = await requestWrite(tenantId, admin.userId);

    const response = await postDecision(admin.client, approvePath(request.id));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SUPPORT_SELF_APPROVAL");

    // Service level: same refusal, and rejecting one's own request is refused too.
    await expect(approve({ ...admin }, request.id)).rejects.toMatchObject({
      status: 403,
      code: "SUPPORT_SELF_APPROVAL",
    });

    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(admin.userId)).toBe(0);
    await expectGuardRefuses(admin.userId);
  });

  it("legend-c9kbk TEN-04 an owner of another tenant cannot decide a request of this tenant", async () => {
    // The request belongs to tenant B; the only owner here owns tenant A.
    const foreignOwner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(otherTenantId, admin.userId);

    // Express route resolves the owner's own tenant; the request is invisible.
    const response = await postDecision(
      foreignOwner.client,
      approvePath(request.id),
    );
    expect([403, 404]).toContain(response.status);

    // Service level: the owner of tenant A addressed at tenant B has no
    // owner assignment there.
    const refused = await approve(
      foreignOwner,
      request.id,
      undefined,
      otherTenantId,
    ).then(
      () => null,
      (error: { status?: number }) => error,
    );
    expect([403, 404]).toContain(refused?.status);

    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(admin.userId, otherTenantId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 an impersonated session cannot approve, even for an owner target", async () => {
    const owner = await newOwner();
    const requester = await newSuperAdmin();
    const request = await requestWrite(tenantId, requester.userId);

    // A second admin holds an approved read_write grant, so the support guard
    // lets the impersonated session reach the route; only the impersonation
    // rule can refuse it.
    const supporter = await newSuperAdmin();
    const writeRequest = await requestWrite(tenantId, supporter.userId);
    await approve(owner, writeRequest.id);
    const started = await tryImpersonate(supporter, owner.userId);
    expect(started.status).toBe(200);
    await verifySessionMfa(owner.email);

    const response = await postDecision(
      supporter.client,
      approvePath(request.id),
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("IMPERSONATION_NOT_ALLOWED");

    const rejected = await postDecision(
      supporter.client,
      rejectPath(request.id),
    );
    expect(rejected.status).toBe(403);

    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(requester.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 a user who is not a platform admin cannot file a write request over HTTP", async () => {
    const owner = await newOwner();
    const response = await owner.client
      .post(`/api/platform/tenants/${tenantId}/support-access-requests`)
      .set(originHeader)
      .send({ reason: REASON, durationMinutes: 30, mfaCode: "123456" });
    expect(response.status).toBe(403);
  });

  it("legend-c9kbk TEN-04 filing a write request without a reason is a 422 and files nothing", async () => {
    const admin = await newSuperAdmin();
    await verifySessionMfa(admin.email);
    const response = await admin.client
      .post(`/api/platform/tenants/${tenantId}/support-access-requests`)
      .set(originHeader)
      .send({ durationMinutes: 30, mfaCode: "123456" });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const rows = await db.query(
      "SELECT 1 FROM support_access_requests WHERE super_admin_user_id = $1",
      [admin.userId],
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe("legend-c9kbk TEN-04 read_only is unchanged", () => {
  it("legend-c9kbk TEN-04 a read_only grant works immediately without any request or approval", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const grant = await openReadOnlyGrant(tenantId, admin.userId);
    expect(grant.accessMode).toBe("read_only");

    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).resolves.toMatchObject({ id: grant.id });

    const started = await tryImpersonate(admin, owner.userId);
    expect(started.status).toBe(200);

    const requests = await db.query(
      "SELECT 1 FROM support_access_requests WHERE super_admin_user_id = $1",
      [admin.userId],
    );
    expect(requests.rowCount).toBe(0);
  });
});

describe("legend-c9kbk TEN-04 audit trail and notification event", () => {
  it("legend-c9kbk TEN-04 requested, approved and granted are audited and requested reaches the notification outbox", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const requested = await auditRows(
      tenantId,
      "support_access.requested",
      request.id,
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      actorId: admin.userId,
      objectType: "support_access_request",
      reason: REASON,
      sensitiveAccess: true,
    });

    const events = await outboxRequested(tenantId, request.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.destination).toBe("notification");
    expect(events[0]?.event.payload).toMatchObject({
      requestId: request.id,
      superAdminUserId: admin.userId,
      reason: REASON,
      durationMinutes: 30,
      approvalExpiresAt: request.approvalExpiresAt,
    });

    const approved = await approve(owner, request.id);
    const approvedAudit = await auditRows(
      tenantId,
      "support_access.approved",
      request.id,
    );
    expect(approvedAudit).toHaveLength(1);
    expect(approvedAudit[0]).toMatchObject({
      actorId: owner.userId,
      objectType: "support_access_request",
      sensitiveAccess: true,
    });
    const granted = await auditRows(
      tenantId,
      "support_access.granted",
      approved.grantId!,
    );
    expect(granted).toHaveLength(1);
    // Assumption: the actor of the grant audit is the admin or the approving
    // owner (the brief only says approval "additionally writes" it).
    expect(granted[0]).toMatchObject({ objectType: "support_access_grant" });
    expect([admin.userId, owner.userId]).toContain(granted[0]?.actorId);
  });

  it("legend-c9kbk TEN-04 a rejection is audited with the deciding owner and no grant audit exists", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);
    await reject(owner, request.id);

    const rejected = await auditRows(
      tenantId,
      "support_access.rejected",
      request.id,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      actorId: owner.userId,
      objectType: "support_access_request",
    });
    const granted = await db.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'support_access.granted'
          AND event->>'actorId' = $2`,
      [tenantId, admin.userId],
    );
    expect(granted.rowCount).toBe(0);
  });
});

/** A non-owner holding a custom tenant-scope role with the approve permission. */
async function newCustomApprover(): Promise<TenantUser> {
  const client = agent(app);
  const email = await signUp(client, "Pemegang izin kustom");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  const roleId = randomUUID();
  customRoleIds.push(roleId);
  await db.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $4, false, $3::jsonb, '["tenant"]'::jsonb)`,
    [
      roleId,
      tenantId,
      JSON.stringify(["org.support_access.approve"]),
      `Penyetuju dukungan ${roleId}`,
    ],
  );
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** Rewrites who assigned an owner's role and when (assigned_at is a column). */
async function restampOwnerAssignment(
  owner: TenantUser,
  assignedBy: string,
  assignedAt: Date,
) {
  const { rowCount } = await db.query(
    `UPDATE role_assignments SET assigned_by = $3, assigned_at = $4
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, owner.userId, assignedBy, assignedAt.toISOString()],
  );
  expect(rowCount).toBe(1);
}

async function expectNotIndependent(
  owner: TenantUser,
  requestId: string,
  adminUserId: string,
) {
  const response = await postDecision(owner.client, approvePath(requestId));
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe("SUPPORT_APPROVER_NOT_INDEPENDENT");
  await expect(approve(owner, requestId)).rejects.toMatchObject({
    status: 403,
    code: "SUPPORT_APPROVER_NOT_INDEPENDENT",
  });
  expect((await requestRow(requestId)).status).toBe("pending");
  expect(await grantCount(adminUserId)).toBe(
    await grantCountBefore.get(requestId),
  );
}
const grantCountBefore = new Map<string, number>();

describe("legend-c9kbk TEN-04 the approving owner is independent of the requesting admin", () => {
  // Assumption: "grant window" is started_at..expires_at of any grant of that
  // admin in the tenant, including a window that has already ended.
  async function filed(adminUserId: string) {
    const request = await requestWrite(tenantId, adminUserId);
    grantCountBefore.set(request.id, await grantCount(adminUserId));
    return request;
  }

  it("legend-c9kbk TEN-04 an owner whose role was assigned by the requesting admin cannot approve (403 SUPPORT_APPROVER_NOT_INDEPENDENT)", async () => {
    const admin = await newSuperAdmin();
    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      admin.userId,
      new Date(Date.now() - 2 * HOUR_MS),
    );
    const request = await filed(admin.userId);
    await expectNotIndependent(insider, request.id, admin.userId);
    await expectGuardRefuses(admin.userId);
  });

  it("legend-c9kbk TEN-04 an owner assigned while the admin held a read_only grant cannot approve", async () => {
    const admin = await newSuperAdmin();
    const grant = await openReadOnlyGrant(tenantId, admin.userId);
    const window = await grantRow(grant.id);
    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      insider.userId,
      new Date(window.started_at.getTime() + MINUTE_MS),
    );
    const request = await filed(admin.userId);
    await expectNotIndependent(insider, request.id, admin.userId);
  });

  it("legend-c9kbk TEN-04 an owner assigned while the admin held an approved read_write grant cannot approve the next request", async () => {
    const admin = await newSuperAdmin();
    const firstApprover = await newOwner();
    const first = await requestWrite(tenantId, admin.userId);
    const approved = await approve(firstApprover, first.id);
    const window = await grantRow(approved.grantId!);
    expect(window.access_mode).toBe("read_write");

    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      insider.userId,
      new Date(window.started_at.getTime() + MINUTE_MS),
    );
    const next = await filed(admin.userId);
    await expectNotIndependent(insider, next.id, admin.userId);
  });

  it("legend-c9kbk TEN-04 an owner assigned inside a grant window that has already ended cannot approve", async () => {
    const admin = await newSuperAdmin();
    const earlier = new Date(Date.now() - 3 * HOUR_MS);
    const grant = await openReadOnlyGrant(tenantId, admin.userId, earlier);
    const window = await grantRow(grant.id);
    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      insider.userId,
      new Date(window.started_at.getTime() + MINUTE_MS),
    );
    const request = await filed(admin.userId);
    await expectNotIndependent(insider, request.id, admin.userId);
  });

  it("legend-c9kbk TEN-04 an owner assigned before any grant of the admin can still approve", async () => {
    const admin = await newSuperAdmin();
    const independent = await newOwner();
    await restampOwnerAssignment(
      independent,
      independent.userId,
      new Date(Date.now() - 5 * HOUR_MS),
    );
    // Assumption: a still-open grant of the admin blocks approving another one
    // (409 SUPPORT_ACCESS_ALREADY_OPEN), so the earlier grant is ended first.
    const earlier = await openReadOnlyGrant(
      tenantId,
      admin.userId,
      new Date(Date.now() - 3 * HOUR_MS),
    );
    await db.query(
      "UPDATE support_access_grants SET ended_at = now(), ended_by = $2 WHERE id = $1",
      [earlier.id, admin.userId],
    );
    const request = await requestWrite(tenantId, admin.userId);

    const response = await postDecision(
      independent.client,
      approvePath(request.id),
    );
    expect(response.body.error?.code).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: request.id,
      status: "approved",
      decidedBy: independent.userId,
    });
  });
});

describe("legend-c9kbk TEN-04 listing and deciding requests is for owners only", () => {
  const LIST = "/api/org/support-access/requests";

  it("legend-c9kbk TEN-04 an owner whose session has not passed 2FA cannot list requests (403)", async () => {
    const owner = await newTenantUser("owner", { verifyMfa: false });
    const response = await owner.client.get(LIST);
    expect(response.status).toBe(403);
  });

  it("legend-c9kbk TEN-04 an impersonated session cannot list requests (403 IMPERSONATION_NOT_ALLOWED)", async () => {
    const owner = await newOwner();
    const requester = await newSuperAdmin();
    await requestWrite(tenantId, requester.userId);

    // The supporter holds an approved read_write grant so the support guard
    // lets the impersonated session reach the route; only the impersonation
    // rule can refuse it.
    const supporter = await newSuperAdmin();
    const writeRequest = await requestWrite(tenantId, supporter.userId);
    await approve(owner, writeRequest.id);
    const started = await tryImpersonate(supporter, owner.userId);
    expect(started.status).toBe(200);
    await verifySessionMfa(owner.email);

    const response = await supporter.client.get(LIST);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("IMPERSONATION_NOT_ALLOWED");
  });

  it("legend-c9kbk TEN-04 a non-owner with the approve permission in a custom role gets 403 OWNER_REQUIRED on list, approve and reject", async () => {
    const custom = await newCustomApprover();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    const listed = await custom.client.get(LIST);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe("OWNER_REQUIRED");

    const approved = await postDecision(custom.client, approvePath(request.id));
    expect(approved.status).toBe(403);
    expect(approved.body.error.code).toBe("OWNER_REQUIRED");
    const rejected = await postDecision(custom.client, rejectPath(request.id));
    expect(rejected.status).toBe(403);

    // Service level: the same audience rule applies without HTTP.
    await expect(
      listSupportAccessRequests(
        contextOf(tenantId),
        { userId: custom.userId },
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
    await expect(approve(custom, request.id)).rejects.toMatchObject({
      status: 403,
      code: "OWNER_REQUIRED",
    });

    expect((await requestRow(request.id)).status).toBe("pending");
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 an owner lists requests at the service level", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);
    const listed = await listSupportAccessRequests(
      contextOf(tenantId),
      { userId: owner.userId },
      { limit: 100 },
    );
    expect(listed.data.map((row) => row.id)).toContain(request.id);
  });
});

describe("legend-c9kbk TEN-04 requester revoked before the decision", () => {
  // Assumption: revoking a platform admin sets platform_admins.revoked_at; a
  // request filed before the revocation then cannot be approved into a grant.
  it("legend-c9kbk TEN-04 approving a request whose admin was revoked meanwhile is 409 SUPPORT_REQUESTER_NOT_ADMIN and creates no grant", async () => {
    const owner = await newOwner();
    const admin = await newSuperAdmin();
    const request = await requestWrite(tenantId, admin.userId);

    await db.query(
      "UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1",
      [admin.userId],
    );

    const response = await postDecision(owner.client, approvePath(request.id));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SUPPORT_REQUESTER_NOT_ADMIN");
    await expect(approve(owner, request.id)).rejects.toMatchObject({
      status: 409,
      code: "SUPPORT_REQUESTER_NOT_ADMIN",
    });

    expect(await grantCount(admin.userId)).toBe(0);
    expect((await requestRow(request.id)).status).not.toBe("approved");
    await expectGuardRefuses(admin.userId);
  });
});

describe("legend-c9kbk TEN-04 re-review fixes", () => {
  const LIST = "/api/org/support-access/requests";

  it("legend-c9kbk TEN-04 an owner who is not independent of the requester can still reject", async () => {
    const admin = await newSuperAdmin();
    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      admin.userId,
      new Date(Date.now() - 2 * HOUR_MS),
    );
    const request = await requestWrite(tenantId, admin.userId);
    const rejected = await reject(insider, request.id);
    expect(rejected.status).toBe("rejected");
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 the database refuses an open read_write grant without an approved request", async () => {
    const admin = await newSuperAdmin();
    await expect(
      db.query(
        `INSERT INTO support_access_grants
           (tenant_id, super_admin_user_id, reason, access_mode, duration_minutes,
            started_at, expires_at, mfa_verified_at)
         VALUES ($1, $2, $3, 'read_write', 30, now(), now() + interval '30 minutes', now())`,
        [tenantId, admin.userId, REASON],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "support_access_grant_write_approved_check",
    });
    expect(await grantCount(admin.userId)).toBe(0);
  });

  it("legend-c9kbk TEN-04 a legacy read_write grant without a request can still be closed", async () => {
    // Shape of a write grant opened before migration 0160: ending it must not
    // trip the approval check (NOT VALID still checks every UPDATE).
    const admin = await newSuperAdmin();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO support_access_grants
         (tenant_id, super_admin_user_id, reason, access_mode, duration_minutes,
          started_at, expires_at, mfa_verified_at, ended_at, ended_by)
       VALUES ($1, $2, $3, 'read_write', 30, now() - interval '5 minutes',
               now() + interval '25 minutes', now() - interval '6 minutes', now(), $2)
       RETURNING id`,
      [tenantId, admin.userId, REASON],
    );
    expect(rows).toHaveLength(1);
    expect(await grantCount(admin.userId)).toBe(1);
  });

  it("legend-c9kbk TEN-04 a cursor whose id is not a uuid is a 422, not a 500", async () => {
    const owner = await newOwner();
    const cursor = Buffer.from(
      JSON.stringify([new Date().toISOString(), "not-a-uuid"]),
    ).toString("base64url");
    const response = await owner.client.get(
      `${LIST}?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(422);
  });
});

// legend-w1due (architect review): an Owner assignment made by a support
// request that passed the guard just before the grant ended commits a moment
// after the end. Such an assignment must not count as independent.
describe("legend-w1due TEN-04 independence keeps a grace margin after a grant ends", () => {
  it("legend-w1due TEN-04 an owner assigned seconds after the admin's grant ended cannot approve", async () => {
    const admin = await newSuperAdmin();
    const grant = await openReadOnlyGrant(
      tenantId,
      admin.userId,
      new Date(Date.now() - 30 * MINUTE_MS),
    );
    const endedAt = new Date(Date.now() - 10 * MINUTE_MS);
    await db.query(
      "UPDATE support_access_grants SET ended_at = $3, ended_by = $2 WHERE id = $1",
      [grant.id, admin.userId, endedAt.toISOString()],
    );
    const insider = await newOwner();
    await restampOwnerAssignment(
      insider,
      insider.userId,
      new Date(endedAt.getTime() + 1000),
    );
    const request = await requestWrite(tenantId, admin.userId);
    grantCountBefore.set(request.id, await grantCount(admin.userId));
    await expectNotIndependent(insider, request.id, admin.userId);
  });
});
