// Global support-access lookup without scanning every tenant (bead legend-ca4l,
// TEN-04). A Super Admin lists support access across tenants, ends a grant by
// its id alone, and impersonation finds the admin's active grants; none of
// that may open tenants that have no grant. A SECURITY DEFINER function
// `app.support_access_grant_tenants(p_grant_id, p_admin_user_id, p_at)` returns
// tenant ids only; rows are still read per tenant under RLS.
//
// Assumptions (the brief, not the implementation):
//   - The function returns SETOF uuid (tenant ids), each tenant once even when
//     several grants match, and is executable by legend_app but not PUBLIC.
//   - "Visited" tenants are observed by wrapping withTenant (db/tenant.ts) and
//     recording the tenant id of the context. Only throwaway tenants that never
//     get a grant (tenantEmptyA/B) are asserted as never visited; the seeded
//     tenant and other suites' tenants are not asserted on.
//   - p_at semantics: started_at <= at < expires_at and (ended_at is null or
//     ended_at > at).
//   - Platform admin sessions need a verified second factor for /api/platform.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const visited = vi.hoisted(() => [] as string[]);

vi.mock("../db/tenant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/tenant.ts")>();
  const wrapped = ((...args: unknown[]) => {
    const context = args[1] as
      { tenant?: { tenantId?: string } } | string | undefined;
    const id =
      typeof context === "string" ? context : context?.tenant?.tenantId;
    if (id) visited.push(id);
    return (actual.withTenant as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.withTenant;
  return { ...actual, withTenant: wrapped };
});

import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
  type RequestSupportAccessInput,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  endSupportAccess,
  requestSupportAccess,
} from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantEmptyA = randomUUID();
const tenantEmptyB = randomUUID();
const allTenants = [tenantA, tenantB, tenantEmptyA, tenantEmptyB];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appRole = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const REASON = "Menelusuri keluhan pelanggan atas transaksi ganda di tenant.";
const MINUTE = 60_000;

const adminIds: string[] = [];
const ownerIds: string[] = [];

type Admin = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

async function newAdmin(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Pencarian Global");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    userId,
  ]);
  adminIds.push(userId);
  await verifySessionMfa(email);
  return { client, userId, email };
}

function open(
  tenantId: string,
  admin: Admin,
  now: Date = new Date(),
  input: Partial<Omit<RequestSupportAccessInput, "mfaCode">> = {},
) {
  return requestSupportAccess({
    tenantId,
    actorUserId: admin.userId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      ...input,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** A real owner of the throwaway tenant (target of an impersonation). */
async function tenantOwnerOf(tenantId: string): Promise<string> {
  const client = agent(app);
  await signUp(client, "Pemilik Tenant Pencarian");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  ownerIds.push(userId);
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
    [tenantId, userId, roleId],
  );
  return userId;
}

/** Runs the function as the restricted app role WITHOUT any tenant context. */
async function grantTenants(args: {
  grantId?: string;
  adminUserId?: string;
  at?: Date;
}): Promise<string[]> {
  const client = await appRole.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    const result = await client.query<{ tenant_id: string }>(
      `SELECT app.support_access_grant_tenants(
         p_grant_id => $1, p_admin_user_id => $2, p_at => $3
       ) AS tenant_id`,
      [
        args.grantId ?? null,
        args.adminUserId ?? null,
        args.at?.toISOString() ?? null,
      ],
    );
    return result.rows.map((row) => row.tenant_id);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const tenantId of allTenants)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Support lookup tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenantId, `lookup-${tenantId.slice(0, 8)}`, seededTenantId],
    );
});

beforeEach(() => {
  visited.length = 0;
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM support_access_grants WHERE tenant_id = ANY($1::uuid[])",
    [allTenants],
  );
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [adminIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[])",
    [allTenants],
  );
  await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
    allTenants,
  ]);
  await owner.end();
  await appRole.end();
});

describe("TEN-04 app.support_access_grant_tenants (legend-ca4l)", () => {
  it("TEN-04 is SECURITY DEFINER with a locked search_path, returns tenant ids only, runs for the app role and not for PUBLIC", async () => {
    const result = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      result_type: string;
      app_execute: boolean;
      public_execute: boolean;
    }>(
      `SELECT p.prosecdef, p.provolatile, p.proconfig,
              pg_get_function_result(p.oid) AS result_type,
              has_function_privilege('legend_app', p.oid, 'EXECUTE') AS app_execute,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'support_access_grant_tenants'`,
    );
    expect(result.rowCount).toBe(1);
    const fn = result.rows[0]!;
    expect(fn.prosecdef).toBe(true);
    expect(fn.provolatile).toBe("s");
    expect(
      fn.proconfig?.some((entry) => entry.startsWith("search_path=")),
    ).toBe(true);
    expect(fn.result_type).toBe("SETOF uuid");
    expect(fn.app_execute).toBe(true);
    expect(fn.public_execute).toBe(false);
  });

  it("TEN-04 with no arguments it returns every tenant that has a grant, once each, and no tenant without one", async () => {
    const admin1 = await newAdmin();
    const admin2 = await newAdmin();
    await open(tenantA, admin1);
    await open(tenantA, admin2); // two grants in A: A must still appear once
    await open(tenantB, admin1);

    const ids = await grantTenants({});
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    expect(ids).not.toContain(tenantEmptyA);
    expect(ids).not.toContain(tenantEmptyB);
    expect(ids.filter((id) => id === tenantA)).toHaveLength(1);
  });

  it("TEN-04 a grant id resolves to exactly its tenant; an unknown id to nothing", async () => {
    const admin = await newAdmin();
    const grant = await open(tenantB, admin);
    expect(await grantTenants({ grantId: grant.id })).toEqual([tenantB]);
    expect(await grantTenants({ grantId: randomUUID() })).toEqual([]);
  });

  it("TEN-04 an admin and a time resolve to the tenants where that admin has an active grant at that time", async () => {
    const admin = await newAdmin();
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * MINUTE);
    // B: opened 10 minutes ago, then ended now. A: opened now, still active.
    const inB = await open(tenantB, admin, tenMinutesAgo);
    await open(tenantA, admin, now);
    await endSupportAccess({
      tenantId: tenantB,
      grantId: inB.id,
      actorUserId: admin.userId,
    });

    const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
    // Now (after A started, after B ended): only A.
    expect(
      await grantTenants({ adminUserId: admin.userId, at: at(MINUTE) }),
    ).toEqual([tenantA]);
    // Five minutes ago: B was active, A had not started.
    expect(
      await grantTenants({ adminUserId: admin.userId, at: at(-5 * MINUTE) }),
    ).toEqual([tenantB]);
    // Long ago and after both expiries: nothing.
    expect(
      await grantTenants({
        adminUserId: admin.userId,
        at: at(-24 * 60 * MINUTE),
      }),
    ).toEqual([]);
    expect(
      await grantTenants({
        adminUserId: admin.userId,
        at: at(3 * 60 * MINUTE),
      }),
    ).toEqual([]);
    // Another admin sees nothing of this admin's grants.
    const other = await newAdmin();
    expect(
      await grantTenants({ adminUserId: other.userId, at: at(MINUTE) }),
    ).toEqual([]);
  });
});

describe("TEN-04 global support-access reads open only tenants that have a grant (legend-ca4l)", () => {
  it("TEN-04 listing without a tenantId returns grants of several tenants and never opens tenants without a grant", async () => {
    const admin = await newAdmin();
    const grantA = await open(tenantA, admin);
    const grantB = await open(tenantB, admin);
    visited.length = 0;

    const listed = await admin.client.get(
      "/api/platform/support-access?limit=100",
    );
    expect(listed.status).toBe(200);
    const rows = listed.body.data as {
      id: string;
      tenantId: string;
      startedAt: string;
    }[];
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([grantA.id, grantB.id]),
    );
    expect(rows.find((row) => row.id === grantA.id)?.tenantId).toBe(tenantA);
    expect(rows.find((row) => row.id === grantB.id)?.tenantId).toBe(tenantB);
    expect(rows.some((row) => row.tenantId === tenantEmptyA)).toBe(false);
    const started = rows.map((row) => Date.parse(row.startedAt));
    expect(started).toEqual([...started].sort((a, b) => b - a));

    expect(visited).not.toContain(tenantEmptyA);
    expect(visited).not.toContain(tenantEmptyB);
  });

  it("TEN-04 ending a grant by its id alone ends it in its own tenant and opens no tenant without a grant", async () => {
    const admin = await newAdmin();
    const grant = await open(tenantB, admin);
    visited.length = 0;

    const ended = await admin.client
      .post(`/api/platform/support-access/${grant.id}/end`)
      .set(originHeader);
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({
      id: grant.id,
      tenantId: tenantB,
      endedBy: admin.userId,
    });
    expect(ended.body.data.endedAt).not.toBeNull();
    expect(visited).toContain(tenantB);
    expect(visited).not.toContain(tenantEmptyA);
    expect(visited).not.toContain(tenantEmptyB);

    // An id that exists nowhere is a 404, still without scanning empty tenants.
    visited.length = 0;
    const missing = await admin.client
      .post(`/api/platform/support-access/${randomUUID()}/end`)
      .set(originHeader);
    expect(missing.status).toBe(404);
    expect(visited).not.toContain(tenantEmptyA);
    expect(visited).not.toContain(tenantEmptyB);
  });

  it("TEN-04 impersonation still matches the admin's active grant for the target's tenant and opens no tenant without a grant", async () => {
    const admin = await newAdmin();
    const targetA = await tenantOwnerOf(tenantA);
    const targetB = await tenantOwnerOf(tenantB);
    await open(tenantA, admin);
    visited.length = 0;

    // Grant in A: impersonating A's owner is allowed.
    const allowed = await admin.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: targetA });
    expect(allowed.status).toBe(200);
    expect(visited).not.toContain(tenantEmptyA);
    expect(visited).not.toContain(tenantEmptyB);
    await admin.client
      .post("/api/auth/admin/stop-impersonating")
      .set(originHeader)
      .send({});

    // No grant in B: impersonating B's owner is refused.
    const refused = await admin.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: targetB });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(visited).not.toContain(tenantEmptyA);
    expect(visited).not.toContain(tenantEmptyB);
  });
});
