// Support grant revoked / lapsed while a mutation is already in flight
// (bead legend-hqjde, tier K: auth, TEN-04).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka ... dapat dicabut Owner tenant" (PRD v1.7 §3 F4 Support
// Access): once the Owner's revoke is answered 200 (or the grant has lapsed),
// no support mutation may still commit. A request that passed the auth guard
// before the revoke must be refused when it reaches its transaction, and a
// mutation that already holds its grant check must finish BEFORE the revoke is
// answered (serialisation against the same grant row).
//
// Assumptions (spec silent, taken from the brief):
//   - A refused in-flight mutation answers 403 with error.code
//     SUPPORT_ACCESS_REQUIRED and changes nothing.
//   - A NEW request with the cookie of a revoked support session answers 401
//     (the session is gone), so "the next PATCH" accepts 401 or 403, never 2xx.
//   - An expired grant cannot be built by only moving expires_at (DB check
//     expires_at = started_at + duration, mfa_verified_at <= started_at), so
//     the three columns are moved together.
//   - The audit row of a revoke is `support_access.ended`, objectId = grant id.
//   - Case 5 is a unit-level test of the grant re-check inside `withTenant`
//     for a request flagged as a mutation (`mutation: true` on RequestSupport);
//     rejection is a PlatformError with code SUPPORT_ACCESS_REQUIRED.
//   - "No lock for reads" is shown by a read-only withTenant finishing while
//     another connection holds FOR UPDATE on the grant row.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportWriteAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { db as appDb } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  requestContext,
  setRequestSupport,
  type RequestSupport,
} from "../lib/request-context.ts";
import { recordImpersonatedPlatformDenial } from "../services/platform-access-audit.service.ts";
import { withTenantSnapshot } from "../services/metrics-query.service.ts";
import {
  approveSupportAccessRequest,
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
  max: 4,
});
const REASON = "Memperbaiki nama brand tenant atas permintaan pemilik.";
const unique = () => randomBytes(4).toString("hex");

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const brandsToRestore = new Map<string, string>();

type Client = ReturnType<typeof agent>;
type Tenant = {
  client: Client;
  userId: string;
  email: string;
  brandId: string;
};

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

/** A tenant Owner (normal session) who may manage the org structure. */
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
  const brandId = brands.body.data[0].id as string;
  if (!brandsToRestore.has(brandId))
    brandsToRestore.set(brandId, brands.body.data[0].name as string);
  return { client, userId, email, brandId };
}

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

/** read_write grant through the real request + owner approval path. */
async function openWriteGrant(adminUserId: string, approverUserId: string) {
  const now = new Date();
  const request = await requestSupportWriteAccess({
    tenantId,
    actorUserId: adminUserId,
    request: requestSupportWriteAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
      durationMinutes: 30,
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    contextOf(tenantId),
    { userId: approverUserId },
    request.id,
    now,
  );
  expect(approved.grantId).toBeTruthy();
  return { id: approved.grantId as string, requestId: request.id };
}

/** Super Admin with a read_write grant and an impersonated session. */
async function newSupportSession() {
  const tenant = await newTenantOwner();
  const admin = await newSuperAdmin();
  const grant = await openWriteGrant(admin.userId, tenant.userId);
  const started = await admin.client
    .post("/api/auth/admin/impersonate-user")
    .set(originHeader)
    .send({ userId: tenant.userId });
  expect(started.status).toBe(200);
  await verifySessionMfa(tenant.email);
  return { tenant, admin, grant, support: admin.client };
}

function postRevoke(client: Client, grantId: string) {
  return client
    .post(`/api/org/support-access/${grantId}/revoke`)
    .set(originHeader)
    .send({});
}

async function brandName(brandId: string): Promise<string> {
  const result = await db.query<{ name: string }>(
    "SELECT name FROM brands WHERE id = $1",
    [brandId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.name;
}

async function auditRows(action: string, objectId: string) {
  const result = await db.query(
    `SELECT id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenantId, action, objectId],
  );
  return result.rows;
}

async function auditRowsFor(objectId: string) {
  const result = await db.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2`,
    [tenantId, objectId],
  );
  return result.rows.map((row) => row.action);
}

/** Cookie header of the agent's jar, exactly what a browser would send. */
function cookieHeader(client: Client): string {
  const jar = (
    client as unknown as {
      jar: {
        getCookies: (info: object) => Array<{ toValueString(): string }>;
      };
    }
  ).jar;
  const cookies = jar.getCookies({
    domain: "127.0.0.1",
    path: "/",
    secure: false,
    script: false, // script:true would hide HttpOnly session cookies
  });
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.map((cookie) => cookie.toValueString()).join("; ");
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/**
 * Waits until the API has gone quiet in Postgres after `since`: some backend
 * changed state after `since`, and none has for 400 ms. By then the held
 * request has passed requireAuth/permission and waits for its body.
 */
async function waitForApiQuiet(since: Date) {
  await waitFor(async () => {
    const r = await db.query<{ ok: boolean }>(
      `SELECT coalesce(max(state_change) > $1::timestamptz
                AND clock_timestamp() - max(state_change) > interval '400 milliseconds', false) AS ok
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state_change IS NOT NULL`,
      [since.toISOString()],
    );
    return r.rows[0]!.ok;
  }, "API to finish auth for the held request");
}

async function waitingOn(pattern: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE $1`,
    [pattern],
  );
  return r.rows[0]!.n;
}

type RawResponse = { status: number; body: { error?: { code?: string } } };

/** A PATCH whose body arrives in two parts; headers + part one go first. */
function heldPatch(
  server: Server,
  cookie: string,
  brandId: string,
  name: string,
) {
  const full = JSON.stringify({ name });
  const cut = Math.floor(full.length / 2);
  const port = (server.address() as AddressInfo).port;
  let resolveResponse!: (value: RawResponse) => void;
  let rejectResponse!: (reason: unknown) => void;
  const response = new Promise<RawResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: "PATCH",
      path: `/api/org/brands/${brandId}`,
      headers: {
        host: `127.0.0.1:${port}`,
        cookie,
        origin: originHeader.Origin,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(full),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: RawResponse["body"] = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* non-JSON body: leave empty */
        }
        resolveResponse({ status: res.statusCode ?? 0, body });
      });
    },
  );
  req.on("error", rejectResponse);
  return {
    response,
    sendFirstPart: () =>
      new Promise<void>((resolve) =>
        req.write(full.slice(0, cut), () => resolve()),
      ),
    sendRest: () => req.end(full.slice(cut)),
  };
}

let server: Server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Support inflight tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `support-if-${otherTenantId.slice(0, 8)}`, tenantId],
  );
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [brandId, name] of brandsToRestore)
    await db.query("UPDATE brands SET name = $2 WHERE id = $1", [
      brandId,
      name,
    ]);
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
  await db.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await db.end();
});

/** Hold a PATCH after auth, end the grant with `endGrant`, finish the body. */
async function heldPatchAcrossEnd(
  endGrant: (
    ctx: Awaited<ReturnType<typeof newSupportSession>>,
  ) => Promise<void>,
) {
  const ctx = await newSupportSession();
  const before = await brandName(ctx.tenant.brandId);
  const attempted = `Nama sesudah dicabut ${unique()}`;
  const held = heldPatch(
    server,
    cookieHeader(ctx.support),
    ctx.tenant.brandId,
    attempted,
  );
  const sentAt = new Date();
  await held.sendFirstPart();
  await waitForApiQuiet(sentAt);
  await endGrant(ctx);
  held.sendRest();
  const response = await held.response;
  return { ctx, before, attempted, response };
}

describe("legend-hqjde support request in flight when the grant ends", () => {
  it("legend-hqjde-1 PATCH with a delayed body is refused after the Owner revoked", async () => {
    const { ctx, before, response } = await heldPatchAcrossEnd(async (c) => {
      const revoked = await postRevoke(c.tenant.client, c.grant.id);
      expect(revoked.status).toBe(200);
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(await brandName(ctx.tenant.brandId)).toBe(before);
  });

  it("legend-hqjde-2 PATCH with a delayed body is refused after the grant lapsed", async () => {
    const { ctx, before, response } = await heldPatchAcrossEnd(async (c) => {
      // Move the whole window into the past (DB checks tie the columns).
      const lapsed = await db.query(
        `UPDATE support_access_grants
            SET mfa_verified_at = now() - interval '40 minutes',
                started_at = now() - interval '31 minutes',
                expires_at = now() - interval '1 minute'
          WHERE id = $1`,
        [c.grant.id],
      );
      expect(lapsed.rowCount).toBe(1);
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(await brandName(ctx.tenant.brandId)).toBe(before);
  });

  it("legend-hqjde-3 a mutation waiting on a DB lock finishes before the revoke is answered", async () => {
    const ctx = await newSupportSession();
    const original = await brandName(ctx.tenant.brandId);
    const renamed = `Nama dari dukungan ${unique()}`;
    const blocker: PoolClient = await db.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await blocker.query("ROLLBACK");
      blocker.release();
    };
    try {
      // Transaction X holds the brand row, so the support PATCH has to wait.
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM brands WHERE id = $1 FOR UPDATE", [
        ctx.tenant.brandId,
      ]);

      let patchDoneAt = 0;
      let revokeDoneAt = 0;
      const patch = ctx.support
        .patch(`/api/org/brands/${ctx.tenant.brandId}`)
        .set(originHeader)
        .send({ name: renamed })
        .then((res) => {
          patchDoneAt = Date.now();
          return res;
        });
      await waitFor(
        async () => (await waitingOn("%brands%")) >= 1,
        "PATCH to wait on the brand row",
      );

      const revoke = postRevoke(ctx.tenant.client, ctx.grant.id).then((res) => {
        revokeDoneAt = Date.now();
        return res;
      });
      // Either the revoke is blocked behind the PATCH (correct), or it was
      // answered while the PATCH is still pending (the bug).
      await waitFor(
        async () =>
          revokeDoneAt > 0 || (await waitingOn("%support_access_grants%")) >= 1,
        "revoke to block on the grant or finish",
      );
      const answeredEarly = revokeDoneAt > 0;
      expect(
        answeredEarly,
        "revoke answered while a support mutation was still waiting",
      ).toBe(false);
      expect(patchDoneAt).toBe(0);

      await release();
      const [patched, revoked] = await Promise.all([patch, revoke]);
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(revoked.status).toBe(200);
      // The mutation that was ahead of the revoke is complete before it.
      expect(patchDoneAt).toBeLessThanOrEqual(revokeDoneAt);
      expect(await brandName(ctx.tenant.brandId)).toBe(renamed);

      // After the revoke nothing may commit any more.
      const again = await ctx.support
        .patch(`/api/org/brands/${ctx.tenant.brandId}`)
        .set(originHeader)
        .send({ name: `Terlambat ${unique()}` });
      expect([401, 403]).toContain(again.status);
      expect(await brandName(ctx.tenant.brandId)).toBe(renamed);
    } finally {
      await release();
      await db.query("UPDATE brands SET name = $2 WHERE id = $1", [
        ctx.tenant.brandId,
        original,
      ]);
    }
  });

  it("legend-hqjde-4 a refused in-flight PATCH leaves one ended audit row and no brand audit row", async () => {
    const { ctx, response } = await heldPatchAcrossEnd(async (c) => {
      const revoked = await postRevoke(c.tenant.client, c.grant.id);
      expect(revoked.status).toBe(200);
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await auditRows("support_access.ended", ctx.grant.id)).toHaveLength(
      1,
    );
    // No audit row names the brand: the refused mutation wrote nothing.
    expect(await auditRowsFor(ctx.tenant.brandId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- unit level

/** Runs `run` inside the real request-context middleware's async store. */
function inRequestContext<T>(support: object | null, run: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const req = { get: () => undefined } as never;
    const res = { setHeader: () => undefined } as never;
    requestContext(req, res, () => {
      if (support) setRequestSupport(support as RequestSupport);
      run().then(resolve, reject);
    });
  });
}

function supportFor(
  forTenantId: string,
  grant: { id: string; admin: { userId: string }; tenant: { userId: string } },
  extra: { mutation?: boolean; accessMode?: "read_only" | "read_write" } = {},
) {
  return {
    tenantId: forTenantId,
    grantId: grant.id,
    impersonatorUserId: grant.admin.userId,
    impersonatedUserId: grant.tenant.userId,
    accessMode: "read_write",
    reason: REASON,
    ...extra,
  };
}

const touch = (tx: { execute: (q: never) => Promise<unknown> }) =>
  tx.execute("SELECT 1" as never);

describe("legend-hqjde withTenant re-checks the grant for support mutations", () => {
  async function writeGrant() {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    return {
      ...(await openWriteGrant(admin.userId, tenant.userId)),
      admin,
      tenant,
    };
  }

  it("legend-hqjde-5 a mutation passes with an active grant of its own tenant and fails for any other tenant or grant", async () => {
    const own = await writeGrant();
    const foreign = await writeGrant();
    // Turn the second grant (and its approved request) into tenant B's grant.
    const moved = await db.connect();
    try {
      await moved.query("BEGIN");
      await moved.query("SET LOCAL session_replication_role = replica");
      await moved.query(
        "UPDATE support_access_requests SET tenant_id = $2 WHERE id = $1",
        [foreign.requestId, otherTenantId],
      );
      await moved.query(
        "UPDATE support_access_grants SET tenant_id = $2 WHERE id = $1",
        [foreign.id, otherTenantId],
      );
      await moved.query("COMMIT");
    } finally {
      moved.release();
    }

    // Active read_write grant of tenant A in tenant A's context: allowed.
    await expect(
      inRequestContext(supportFor(tenantId, own, { mutation: true }), () =>
        withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).resolves.toBeDefined();

    // Tenant A's grant used in tenant B's context: refused.
    await expect(
      inRequestContext(supportFor(tenantId, own, { mutation: true }), () =>
        withTenant(appDb, contextOf(otherTenantId), (tx) => touch(tx as never)),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    // Tenant B's (active, read_write) grant id used in tenant A's context.
    await expect(
      inRequestContext(supportFor(tenantId, foreign, { mutation: true }), () =>
        withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    // Support claims tenant B for tenant B's grant but acts on tenant A.
    await expect(
      inRequestContext(
        supportFor(otherTenantId, foreign, { mutation: true }),
        () =>
          withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });

    // An ended grant is refused too.
    await db.query(
      "UPDATE support_access_grants SET ended_at = now(), ended_by = 'x' WHERE id = $1",
      [own.id],
    );
    await expect(
      inRequestContext(supportFor(tenantId, own, { mutation: true }), () =>
        withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });

  it("legend-hqjde-6 a read-only request neither locks nor is affected by the grant row", async () => {
    const grant = await writeGrant();
    const holder = await db.connect();
    try {
      // Another connection holds the grant row exclusively, like a revoke.
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM support_access_grants WHERE id = $1 FOR UPDATE",
        [grant.id],
      );
      for (const mutation of [false, undefined]) {
        const outcome = await Promise.race([
          inRequestContext(supportFor(tenantId, grant, { mutation }), () =>
            withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
          ).then(() => "done"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("blocked"), 5_000),
          ),
        ]);
        expect(outcome, `mutation=${String(mutation)}`).toBe("done");
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    // Even with the grant ended, a read-only transaction is not re-checked.
    await db.query(
      "UPDATE support_access_grants SET ended_at = now(), ended_by = 'x' WHERE id = $1",
      [grant.id],
    );
    await expect(
      inRequestContext(supportFor(tenantId, grant, { mutation: false }), () =>
        withTenant(appDb, contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).resolves.toBeDefined();
  });
});

describe("legend-hqjde read-only snapshots and denial audit under a support mutation", () => {
  async function writeGrant() {
    const tenant = await newTenantOwner();
    const admin = await newSuperAdmin();
    return {
      ...(await openWriteGrant(admin.userId, tenant.userId)),
      admin,
      tenant,
    };
  }

  it("legend-hqjde-7 withTenantSnapshot (read-only tx) runs a SELECT for a read_write support mutation and POST /api/reports/run answers 200", async () => {
    const grant = await writeGrant();
    // Before the fix the grant re-check (SELECT ... FOR SHARE) raised
    // "cannot execute SELECT FOR SHARE in a read-only transaction".
    await expect(
      inRequestContext(supportFor(tenantId, grant, { mutation: true }), () =>
        withTenantSnapshot(contextOf(tenantId), (tx) => touch(tx as never)),
      ),
    ).resolves.toBeDefined();

    // Assumption: the report run is a POST, so a support session flags it as a
    // mutation; the impersonated Owner may run the income statement.
    const ctx = await newSupportSession();
    const response = await ctx.support
      .post("/api/reports/run")
      .set(originHeader)
      .send({
        reportCode: "finance.income_statement",
        period: { startDate: "2025-06-01", endDate: "2025-06-30" },
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("legend-hqjde-8 a support mutation for tenant A still writes the platform.access.denied row for tenant B", async () => {
    const own = await writeGrant();
    const foreign = await writeGrant();
    // Tie the impersonator to tenant B through a support grant (same move as
    // legend-hqjde-5): the denial row is only written for a tied tenant.
    const moved = await db.connect();
    try {
      await moved.query("BEGIN");
      await moved.query("SET LOCAL session_replication_role = replica");
      await moved.query(
        "UPDATE support_access_requests SET tenant_id = $2 WHERE id = $1",
        [foreign.requestId, otherTenantId],
      );
      await moved.query(
        "UPDATE support_access_grants SET tenant_id = $2 WHERE id = $1",
        [foreign.id, otherTenantId],
      );
      await moved.query("COMMIT");
    } finally {
      moved.release();
    }

    const written = await inRequestContext(
      supportFor(tenantId, own, { mutation: true }),
      () =>
        recordImpersonatedPlatformDenial({
          tenantId: otherTenantId,
          impersonatedUserId: foreign.tenant.userId,
          impersonatedBy: foreign.admin.userId,
          code: "SUPPORT_ACCESS_REQUIRED",
          method: "POST",
          route: `/api/platform/tenants/${otherTenantId}/usage`,
        }),
    );
    expect(written).toBe(true);
    const rows = await db.query(
      `SELECT id FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'platform.access.denied'
          AND event->>'actorId' = $2`,
      [otherTenantId, foreign.admin.userId],
    );
    expect(rows.rowCount).toBe(1);
  });
});
