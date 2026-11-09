// Support access sessions (PRD v1.7 §3 F4 "Support Access", §6 A
// support_access_grants, TEN-04; beads legend-33f + legend-bd95).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka (default 60 menit) dengan alasan wajib, read-only secara
// default, tercatat di audit log, dan memicu notifikasi ke admin tenant."
//
// Runs the real services, Express app, audit writer and PostgreSQL (RLS) on
// two throwaway tenants so the seeded tenant's outbox stays untouched.
import { randomUUID } from "node:crypto";
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
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  assertSupportAccess,
  endSupportAccess,
  expireDueSupportAccessGrants,
  listSupportAccess,
  requestSupportAccess,
  requestSupportWriteAccess,
  SUPPORT_ACCESS_WRITE_MAX_MINUTES,
} from "../services/platform-support.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

// createApp installs the core audit writer (recordAudit fails closed without).
const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appRole = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 1,
});
const admins: string[] = [];
const tenantOwners = new Map<string, string>();

const REASON = "Menelusuri keluhan pelanggan atas transaksi ganda di tenant.";

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function newAdmin(): Promise<string> {
  const userId = randomUUID();
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    userId,
  ]);
  admins.push(userId);
  return userId;
}

function body(
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
): RequestSupportAccessInput {
  return requestSupportAccessInputSchema.parse({
    reason: REASON,
    mfaCode: "123456",
    ...input,
  });
}

async function open(
  tenantId: string,
  actorUserId: string,
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
  now: Date = new Date(),
) {
  return requestSupportAccess({
    tenantId,
    actorUserId,
    request: body(input),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/**
 * A real owner of the throwaway tenant: a signed-up user holding an owner
 * template role there (a copy of the seeded tenant's owner role). One owner
 * per tenant, created on first use.
 */
async function tenantOwnerOf(tenantId: string): Promise<string> {
  const existing = tenantOwners.get(tenantId);
  if (existing) return existing;
  const client = agent(app);
  await signUp(client, "Pemilik Tenant Dukungan");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'owner'`,
    [roleId, tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 day', $2, now() - interval '1 day')`,
    // The tenant's Owner predates every support window of the test (c9kbk
    // independence, with the legend-w1due grace margin after a window ends).
    [tenantId, userId, roleId],
  );
  tenantOwners.set(tenantId, userId);
  return userId;
}

/**
 * read_write support access needs the tenant owner's approval (legend-c9kbk,
 * founder Q37/Q38): the Super Admin files a request, a real owner of the
 * tenant approves it, and approval creates the grant. Returns the grant row.
 * Assumption: the approval service takes the tenant context, the approving
 * owner's user id and the request id.
 */
async function openWrite(
  tenantId: string,
  actorUserId: string,
  durationMinutes: number = SUPPORT_ACCESS_WRITE_MAX_MINUTES,
  now: Date = new Date(),
) {
  const request = await requestSupportWriteAccess({
    tenantId,
    actorUserId,
    request: requestSupportWriteAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    contextOf(tenantId),
    { userId: await tenantOwnerOf(tenantId) },
    request.id,
    now,
  );
  expect(approved.status).toBe("approved");
  expect(approved.grantId).toBeTruthy();
  return { id: approved.grantId as string };
}

async function auditRows(tenantId: string, action: string, objectId?: string) {
  const result = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2
       AND ($3::text IS NULL OR event->>'objectId' = $3)`,
    [tenantId, action, objectId ?? null],
  );
  return result.rows.map((row) => row.event);
}

async function outboxRows(tenantId: string, grantId: string) {
  const result = await owner.query<{
    destination: string;
    sequence: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT destination, sequence, event FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'support_access' AND aggregate_id = $2
     ORDER BY sequence`,
    [tenantId, grantId],
  );
  return result.rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Copy the seeded tenant's plan/flags/limits so the platform tenant list
  // (validated against tenantSchema) stays valid for other suites.
  for (const tenantId of [tenantA, tenantB])
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Support access tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenantId, `support-${tenantId.slice(0, 8)}`, seededTenantId],
    );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM support_access_grants WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  );
  await owner.query(
    "DELETE FROM support_access_requests WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [admins],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  );
  await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
    [tenantA, tenantB],
  ]);
  await owner.end();
  await appRole.end();
});

describe("TEN-04 support access sessions", () => {
  it("TEN-04 opens a read-only 60-minute session by default, audits it and queues the tenant-admin notification", async () => {
    const admin = await newAdmin();
    const grant = await open(tenantA, admin);
    expect(grant).toMatchObject({
      tenantId: tenantA,
      superAdminUserId: admin,
      accessMode: "read_only",
      durationMinutes: 60,
      reason: REASON,
      endedAt: null,
    });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.startedAt)).toBe(
      60 * 60_000,
    );
    expect(grant.tenantAdminNotifiedAt).toBe(grant.startedAt);

    // legend-bd95: recordAudit in the same tenant transaction.
    const [audit] = await auditRows(
      tenantA,
      "support_access.granted",
      grant.id,
    );
    expect(audit).toMatchObject({
      tenantId: tenantA,
      actorType: "user",
      actorId: admin,
      objectType: "support_access_grant",
      objectId: grant.id,
      reason: REASON,
      sensitiveAccess: true,
    });

    // Transactional outbox → notification consumer → tenant admin.
    const events = await outboxRows(tenantA, grant.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ destination: "notification" });
    expect(Number(events[0]?.sequence)).toBe(1);
    expect(events[0]?.event.name).toBe("support_access.granted");
    expect(events[0]?.event.payload).toMatchObject({
      grantId: grant.id,
      superAdminUserId: admin,
      accessMode: "read_only",
      expiresAt: grant.expiresAt,
    });

    await endSupportAccess({
      tenantId: tenantA,
      grantId: grant.id,
      actorUserId: admin,
    });
  });

  it("TEN-04 refuses a session without a reason (mandatory reason)", async () => {
    expect(
      requestSupportAccessInputSchema.safeParse({ mfaCode: "123456" }).success,
    ).toBe(false);
    expect(
      requestSupportAccessInputSchema.safeParse({
        reason: "   ",
        mfaCode: "123456",
      }).success,
    ).toBe(false);

    const client = agent(app);
    const email = await signUp(client, "Super Admin Tanpa Alasan");
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      userId,
    ]);
    admins.push(userId);
    await verifySessionMfa(email);
    const response = await client
      .post(`/api/platform/tenants/${tenantA}/support-access`)
      .set(originHeader)
      .send({ durationMinutes: 60, mfaCode: "123456" });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const rows = await owner.query(
      "SELECT 1 FROM support_access_grants WHERE super_admin_user_id = $1",
      [userId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("TEN-04 refuses a session when MFA is missing or stale and audits the refusal", async () => {
    const admin = await newAdmin();
    await expect(
      requestSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        request: body(),
        mfaVerifiedAt: null,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      requestSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        request: body(),
        mfaVerifiedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    const opened = await owner.query(
      "SELECT 1 FROM support_access_grants WHERE super_admin_user_id = $1",
      [admin],
    );
    expect(opened.rowCount).toBe(0);
    const denied = (await auditRows(tenantA, "support_access.denied")).filter(
      (event) => event.actorId === admin,
    );
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ reason: REASON, objectId: null });
  });

  it("TEN-04 write access needs the explicit read_write flag and a shorter cap", async () => {
    const admin = await newAdmin();
    await expect(
      open(tenantA, admin, { accessMode: "read_write", durationMinutes: 60 }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    const readOnly = await open(tenantA, admin, { durationMinutes: 15 });
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "financial",
        intent: "write",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_READ_ONLY" });
    await endSupportAccess({ grantId: readOnly.id, actorUserId: admin });

    const write = await openWrite(tenantA, admin);
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "financial",
        intent: "write",
      }),
    ).resolves.toMatchObject({ id: write.id, accessMode: "read_write" });
    await endSupportAccess({ grantId: write.id, actorUserId: admin });
  });

  it("TEN-04 POST support-access with accessMode read_write is refused with 409 SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED and opens no grant", async () => {
    // legend-c9kbk: a Super Admin cannot open write access directly, only
    // request it for the tenant owner to approve.
    const client = agent(app);
    const email = await signUp(client, "Super Admin Tulis Langsung");
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      userId,
    ]);
    admins.push(userId);
    await verifySessionMfa(email);
    const response = await client
      .post(`/api/platform/tenants/${tenantA}/support-access`)
      .set(originHeader)
      .send({
        reason: REASON,
        accessMode: "read_write",
        durationMinutes: SUPPORT_ACCESS_WRITE_MAX_MINUTES,
        mfaCode: "123456",
      });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(
      "SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED",
    );
    const rows = await owner.query(
      "SELECT 1 FROM support_access_grants WHERE super_admin_user_id = $1",
      [userId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("TEN-04 blocks personal and financial reads without an active grant", async () => {
    const admin = await newAdmin();
    for (const dataClass of ["personal", "financial"] as const)
      await expect(
        assertSupportAccess({
          tenantId: tenantA,
          actorUserId: admin,
          dataClass,
          intent: "read",
        }),
      ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
    // Non-gated platform data needs only the platform role.
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "usage",
        intent: "read",
      }),
    ).resolves.toBeNull();

    const grant = await open(tenantA, admin);
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "personal",
        intent: "read",
      }),
    ).resolves.toMatchObject({ id: grant.id });

    // A revoked Super Admin's open grant no longer counts.
    await owner.query(
      "UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1",
      [admin],
    );
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });

  it("TEN-04 keeps one active session per Super Admin and tenant, even under concurrent requests", async () => {
    const admin = await newAdmin();
    const results = await Promise.allSettled([
      open(tenantA, admin),
      open(tenantA, admin),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "SUPPORT_ACCESS_ALREADY_ACTIVE",
    });
    // Another tenant is independent.
    const other = await open(tenantB, admin);
    expect(other.tenantId).toBe(tenantB);
  });

  it("TEN-04 expiry: a lapsed session stops at read time and the sweep records it exactly once", async () => {
    const admin = await newAdmin();
    const past = new Date(Date.now() - 20 * 60_000);
    const grant = await open(tenantA, admin, { durationMinutes: 15 }, past);

    // Expired at read time, before any sweep ran.
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: admin,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    expect(
      await expireDueSupportAccessGrants(contextOf(tenantA)),
    ).toBeGreaterThanOrEqual(1);
    expect(await expireDueSupportAccessGrants(contextOf(tenantA))).toBe(0);

    const expired = await auditRows(
      tenantA,
      "support_access.expired",
      grant.id,
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ actorType: "system", actorId: null });
    const events = await outboxRows(tenantA, grant.id);
    expect(events.map((row) => row.event.name)).toEqual([
      "support_access.granted",
      "support_access.ended",
    ]);
    expect(events[1]?.event.payload).toMatchObject({
      grantId: grant.id,
      cause: "expired",
      endedAt: grant.expiresAt,
    });

    // Ending a lapsed session is a no-op; a new session may open.
    const ended = await endSupportAccess({
      grantId: grant.id,
      actorUserId: admin,
    });
    expect(ended.endedAt).toBeNull();
    expect(
      await auditRows(tenantA, "support_access.expired", grant.id),
    ).toHaveLength(1);
    const next = await open(tenantA, admin);
    expect(next.id).not.toBe(grant.id);
  });

  it("TEN-04 expiry not yet swept is recorded before the next session opens", async () => {
    const admin = await newAdmin();
    const lapsed = await open(
      tenantA,
      admin,
      { durationMinutes: 15 },
      new Date(Date.now() - 30 * 60_000),
    );
    const next = await open(tenantA, admin);
    expect(next.id).not.toBe(lapsed.id);
    expect(
      await auditRows(tenantA, "support_access.expired", lapsed.id),
    ).toHaveLength(1);
  });

  it("TEN-04 ending a session is idempotent and audited once", async () => {
    const client = agent(app);
    const email = await signUp(client, "Super Admin Akhiri");
    const userId = (await client.get("/api/auth/get-session")).body.user
      .id as string;
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      userId,
    ]);
    admins.push(userId);
    await verifySessionMfa(email);
    const grant = await open(tenantA, userId);

    // The contract carries only the grant id (no tenant).
    const first = await client
      .post(`/api/platform/support-access/${grant.id}/end`)
      .set(originHeader);
    expect(first.status).toBe(200);
    expect(first.body.data.endedBy).toBe(userId);
    const second = await client
      .post(`/api/platform/support-access/${grant.id}/end`)
      .set(originHeader);
    expect(second.status).toBe(200);
    expect(second.body.data.endedAt).toBe(first.body.data.endedAt);

    expect(
      await auditRows(tenantA, "support_access.ended", grant.id),
    ).toHaveLength(1);
    const events = await outboxRows(tenantA, grant.id);
    expect(events.map((row) => row.event.name)).toEqual([
      "support_access.granted",
      "support_access.ended",
    ]);
    expect(events[1]?.event.payload).toMatchObject({
      cause: "ended_by_super_admin",
    });
    await expect(
      assertSupportAccess({
        tenantId: tenantA,
        actorUserId: userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    // Platform list: filtered to one tenant, newest first.
    const listed = await client.get(
      `/api/platform/support-access?tenantId=${tenantA}&limit=100`,
    );
    expect(listed.status).toBe(200);
    const ids = listed.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(grant.id);
    expect(
      listed.body.data.every(
        (row: { tenantId: string }) => row.tenantId === tenantA,
      ),
    ).toBe(true);
    const started = listed.body.data.map((row: { startedAt: string }) =>
      Date.parse(row.startedAt),
    );
    expect(started).toEqual([...started].sort((a, b) => b - a));
    const all = await client.get("/api/platform/support-access?limit=5");
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeLessThanOrEqual(5);
  });

  it("TEN-04 cross-tenant denial: a grant for tenant A opens nothing in tenant B", async () => {
    const admin = await newAdmin();
    const grant = await open(tenantA, admin);

    await expect(
      assertSupportAccess({
        tenantId: tenantB,
        actorUserId: admin,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    // Tenant B's admin view never lists tenant A's sessions.
    const viewB = await listSupportAccess(contextOf(tenantB), { limit: 100 });
    expect(viewB.data.map((row) => row.id)).not.toContain(grant.id);
    const viewA = await listSupportAccess(contextOf(tenantA), { limit: 100 });
    expect(viewA.data.map((row) => row.id)).toContain(grant.id);

    // The grant id cannot be ended through the wrong tenant.
    await expect(
      endSupportAccess({
        tenantId: tenantB,
        grantId: grant.id,
        actorUserId: admin,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // RLS: the application role in tenant B's context sees and changes nothing.
    const client = await appRole.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantB],
      );
      expect(
        (
          await client.query(
            "SELECT id FROM support_access_grants WHERE id = $1",
            [grant.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE support_access_grants SET reason = 'diambil alih lintas tenant' WHERE id = $1",
            [grant.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await endSupportAccess({ grantId: grant.id, actorUserId: admin });
  });
});
