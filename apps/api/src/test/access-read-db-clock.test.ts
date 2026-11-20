// sub-1201 (tier K, access). READING a permission must use the DATABASE clock,
// the same clock that stamps role_assignments.valid_from / valid_until on write
// (legend-hzdy5). Before this change the read path compared validity with the
// application clock (`new Date()`): with the DB ahead of the app, a freshly
// granted role was not active yet and a revoked one was still active.
// Expected behavior comes from the brief (docs/briefs/sub-1201-akses-jam-db.md,
// "Bukti selesai") and PRD v1.7 §3.7 / TEN-03 (grant and end take effect at once).
//
// Both read paths are driven through HTTP:
//  - the requireTenantPermission middleware path: GET /api/menu/categories
//    (tenant data behind menu.item.view);
//  - GET /api/me/access (permissions list the web guard reads).
//
// sub-1201 round 2 (pattern C, money): the two readers that decide "is this user
// an Owner" in SQL on their own, profit-share recipient reconciliation
// (assertTenantOwner: GET list and POST resolve under
// /api/tenant/profit-share/recipient-reconciliation) and the edge people
// snapshot (GET /api/edge-sync/people-snapshot, role assignments shipped to an
// outlet), must also compare validity with the DB clock.
//
// Assumptions:
//  - Proof of the clock source: the application `Date` is faked 60 s BEHIND the
//    database while the requests run (pattern of platform-tenant-owner-db-clock).
//    No skew tolerance is used anywhere: every time comparison is a DB timestamp.
//  - Setup (sign-up, sessions, inserts) runs with the real clock; only the
//    request itself runs with the faked Date. The session is not MFA-bound: the
//    custom role has mfa_required = false so the MFA stamp is not part of this test.
//  - "Active" = the middleware route answers 200 and /api/me/access lists the
//    permission; "inactive" = the route answers 403 and the permission is absent.
//  - (c) grants valid_until 1 s ahead of the DB clock; the "still active" phase is
//    retried (checked against the DB clock) so a slow request cannot make the test
//    flaky; then the test waits, in real time, until the DB clock passed it.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cafeLegendFixtures,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EdgePeopleSnapshot } from "@starter/shared/edge/people-snapshot";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { hashStaffPin } from "../services/device-pin-hash";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const APP_CLOCK_SKEW_MS = 60_000;
const PERMISSION = "menu.item.view";
const ROUTE = "/api/menu/categories?limit=1";

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

afterAll(async () => {
  vi.useRealTimers();
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  await owner.end();
});

async function viewRole(): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji jam DB ${roleId.slice(0, 8)}`,
      JSON.stringify([PERMISSION]),
      JSON.stringify(["tenant"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

async function member(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

/** Insert a tenant-scope assignment with DB-clock expressions for the bounds. */
async function assign(
  userId: string,
  roleId: string,
  validFromSql: string,
  validUntilSql: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', ${validFromSql}, ${validUntilSql}, $2)
     RETURNING id`,
    [tenantId, userId, roleId],
  );
  return rows[0]!.id;
}

/** Run `fn` with only the app `Date` faked 60 s behind the real clock. */
async function withAppClockBehindDb<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(Date.now() - APP_CLOCK_SKEW_MS));
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Run `fn` with only the app `Date` faked 60 s AHEAD of the real clock. */
async function withAppClockAheadOfDb<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(Date.now() + APP_CLOCK_SKEW_MS));
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

type Client = ReturnType<typeof agent>;
type Seen = {
  routeStatus: number;
  routeBody: unknown;
  accessStatus: number;
  permissions: string[];
};

/** Hit the middleware path and /api/me/access with the app clock skewed. */
async function seen(client: Client): Promise<Seen> {
  return withAppClockBehindDb(async () => {
    const route = await client.get(ROUTE);
    const access = await client.get("/api/me/access");
    return {
      routeStatus: route.status,
      routeBody: route.body,
      accessStatus: access.status,
      permissions: (access.body?.data?.permissions ?? []) as string[],
    };
  });
}

function expectActive(result: Seen) {
  expect(result.routeStatus, JSON.stringify(result.routeBody)).toBe(200);
  expect(result.accessStatus).toBe(200);
  expect(result.permissions).toContain(PERMISSION);
}

function expectInactive(result: Seen) {
  expect(result.routeStatus, JSON.stringify(result.routeBody)).toBe(403);
  expect(result.accessStatus).toBe(200);
  expect(result.permissions).not.toContain(PERMISSION);
}

async function dbReached(until: string): Promise<boolean> {
  const { rows } = await owner.query<{ reached: boolean }>(
    "SELECT clock_timestamp() >= $1::timestamptz AS reached",
    [until],
  );
  return rows[0]!.reached;
}

describe("sub-1201 permission reads use the DB clock", () => {
  it("sub-1201 control: with the clocks in step an old grant is active and no grant is not", async () => {
    // Failure here is setup (role, route, tenant), not the clock source.
    const roleId = await viewRole();
    const granted = await member("Jam Kontrol Aktif");
    await assign(
      granted.userId,
      roleId,
      "now() - interval '10 minutes'",
      "NULL",
    );
    const route = await granted.client.get(ROUTE);
    expect(route.status, JSON.stringify(route.body)).toBe(200);
    const access = await granted.client.get("/api/me/access");
    expect(access.body.data.permissions).toContain(PERMISSION);

    const none = await member("Jam Kontrol Tanpa Role");
    const denied = await none.client.get(ROUTE);
    expect(denied.status).toBe(403);
    const noAccess = await none.client.get("/api/me/access");
    expect(noAccess.body.data.permissions).not.toContain(PERMISSION);
  });

  it("sub-1201 (a) a grant stamped valid_from = DB now is active at once although the app clock is 60 s behind", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Grant Baru");
    await assign(who.userId, roleId, "clock_timestamp()", "NULL");

    expectActive(await seen(who.client));
  });

  it("sub-1201 (b) a revoke stamped valid_until = DB now is inactive at once although the app clock is 60 s behind", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Cabut Akses");
    const assignmentId = await assign(
      who.userId,
      roleId,
      "now() - interval '10 minutes'",
      "NULL",
    );
    // Active before the revoke (proves the revoke is what changes the answer).
    expectActive(await seen(who.client));

    await owner.query(
      "UPDATE role_assignments SET valid_until = clock_timestamp() WHERE id = $1",
      [assignmentId],
    );

    expectInactive(await seen(who.client));
  });

  it("sub-1201 (c) a grant with valid_until 1 s ahead of the DB clock is active until the DB clock passes it, then inactive", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Grant Berbatas");
    const assignmentId = await assign(
      who.userId,
      roleId,
      "now() - interval '10 minutes'",
      "clock_timestamp() + interval '1 second'",
    );

    // Active phase: retry with a fresh 1 s window until a whole round of requests
    // finished before the DB clock reached valid_until.
    let activeResult: Seen | null = null;
    for (let attempt = 0; attempt < 5 && !activeResult; attempt += 1) {
      const result = await seen(who.client);
      const { rows } = await owner.query<{ inside: boolean }>(
        "SELECT clock_timestamp() < valid_until AS inside FROM role_assignments WHERE id = $1",
        [assignmentId],
      );
      if (rows[0]!.inside) activeResult = result;
      else
        await owner.query(
          `UPDATE role_assignments
              SET valid_until = clock_timestamp() + interval '1 second'
            WHERE id = $1`,
          [assignmentId],
        );
    }
    expect(
      activeResult,
      "could not fit a request round into 1 s",
    ).not.toBeNull();
    expectActive(activeResult!);

    // Wait in real time until the DB clock passed valid_until.
    const { rows } = await owner.query<{ until: string }>(
      "SELECT valid_until::text AS until FROM role_assignments WHERE id = $1",
      [assignmentId],
    );
    for (let i = 0; i < 300 && !(await dbReached(rows[0]!.until)); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await dbReached(rows[0]!.until)).toBe(true);

    expectInactive(await seen(who.client));
  });
});

// legend-7zwmv (P3-5 of the 1201 second opinion): the app clock AHEAD of the DB.
// The DB clock decides: a grant whose valid_from is still in the DB's future is
// not active (the app must not activate it early), and a grant whose valid_until
// the app clock already passed is still active until the DB clock passes it.
describe("legend-7zwmv permission reads with the app clock ahead of the DB", () => {
  async function seenAhead(client: Client): Promise<Seen> {
    return withAppClockAheadOfDb(async () => {
      const route = await client.get(ROUTE);
      const access = await client.get("/api/me/access");
      return {
        routeStatus: route.status,
        routeBody: route.body,
        accessStatus: access.status,
        permissions: (access.body?.data?.permissions ?? []) as string[],
      };
    });
  }

  it("a grant stamped valid_from = DB now is active", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Depan Grant Baru");
    await assign(who.userId, roleId, "clock_timestamp()", "NULL");

    expectActive(await seenAhead(who.client));
  });

  it("a grant whose valid_from is 30 s in the DB's future is NOT active although the app clock is 60 s ahead", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Depan Grant Masa Depan");
    await assign(
      who.userId,
      roleId,
      "clock_timestamp() + interval '30 seconds'",
      "NULL",
    );

    expectInactive(await seenAhead(who.client));
  });

  it("a grant with valid_until 30 s ahead of the DB clock is still active although the app clock is 60 s ahead", async () => {
    const roleId = await viewRole();
    const who = await member("Jam Depan Grant Berbatas");
    await assign(
      who.userId,
      roleId,
      "now() - interval '10 minutes'",
      "clock_timestamp() + interval '30 seconds'",
    );

    expectActive(await seenAhead(who.client));
  });
});

// ---------------------------------------------------------------------------
// Round 2, pattern C: Owner checks that read role_assignments directly.
// ---------------------------------------------------------------------------

const RECON = "/api/tenant/profit-share/recipient-reconciliation";
const MANAGE = "profit_share.registry.manage";

/** Sign in, with the session marked MFA-verified 90 s ago (see assumptions). */
async function mfaMember(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  // Stamped 90 s in the past so that, with the app Date faked 60 s behind, the
  // verification is still 30 s old (never "in the future") for the request.
  await owner.query(
    `UPDATE "session" SET mfa_verified_at = $2
      WHERE revoked_at IS NULL AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
    [email, new Date(Date.now() - 90_000)],
  );
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function manageRole(userId: string) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji jam DB kelola ${roleId.slice(0, 8)}`,
      JSON.stringify([MANAGE]),
      JSON.stringify(["tenant"]),
    ],
  );
  createdRoleIds.push(roleId);
  // Always valid: only the Owner assignment below changes between phases.
  await assign(userId, roleId, "now() - interval '10 minutes'", "NULL");
}

async function ownerAssignment(
  userId: string,
  validFromSql: string,
  validUntilSql: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     SELECT $1, $2, id, 'tenant', ${validFromSql}, ${validUntilSql}, $2
       FROM roles WHERE tenant_id = $1 AND template_key = 'owner'
     RETURNING id`,
    [tenantId, userId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

type Statuses = { list: number; resolve: number; body: unknown };

/**
 * The Owner-only reads, with the app clock behind. `resolve` targets a line that
 * does not exist: an Owner gets 404, a non-Owner gets 403 (assumption: the Owner
 * check comes before the line lookup, as for a real line in
 * profit-share-recipient-reconcile.test.ts case 3).
 */
async function reconciliationAs(who: { client: Client }): Promise<Statuses> {
  return withAppClockBehindDb(async () => {
    const list = await who.client.get(RECON);
    const resolve = await who.client
      .post(`${RECON}/${randomUUID()}/resolve`)
      .set(originHeader)
      .send({ recipientUserId: null, note: "Uji jam DB." });
    return {
      list: list.status,
      resolve: resolve.status,
      body: { list: list.body, resolve: resolve.body },
    };
  });
}

describe("sub-1201 round 2 (C) profit-share assertTenantOwner uses the DB clock", () => {
  it("sub-1201 C control: with the clocks in step an Owner is accepted and a manager-only member is refused", async () => {
    const real = await mfaMember("Jam Owner Kontrol");
    await manageRole(real.userId);
    await ownerAssignment(real.userId, "now() - interval '10 minutes'", "NULL");
    const list = await real.client.get(RECON);
    expect(list.status, JSON.stringify(list.body)).toBe(200);

    const manager = await mfaMember("Jam Manajer Kontrol");
    await manageRole(manager.userId);
    const refused = await manager.client.get(RECON);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });

  it("sub-1201 C an Owner whose assignment valid_until = DB now is refused at once, with the app clock 60 s behind", async () => {
    // Ended Owner: active first (proves the end is what changes the answer).
    const ended = await mfaMember("Jam Owner Dicabut");
    await manageRole(ended.userId);
    const endedId = await ownerAssignment(
      ended.userId,
      "now() - interval '10 minutes'",
      "NULL",
    );
    const before = await reconciliationAs(ended);
    expect(before.list, JSON.stringify(before.body)).toBe(200);
    expect(before.resolve, JSON.stringify(before.body)).toBe(404);

    await owner.query(
      "UPDATE role_assignments SET valid_until = clock_timestamp() WHERE id = $1",
      [endedId],
    );
    const after = await reconciliationAs(ended);
    expect(after.list, JSON.stringify(after.body)).toBe(403);
    expect(after.resolve, JSON.stringify(after.body)).toBe(403);
  });

  it("sub-1201 C a grant with valid_from = DB now counts as Owner at once, with the app clock 60 s behind", async () => {
    // valid_from stamped by the DB clock, request right after.
    const fresh = await mfaMember("Jam Owner Baru");
    await manageRole(fresh.userId);
    await ownerAssignment(fresh.userId, "clock_timestamp()", "NULL");
    const granted = await reconciliationAs(fresh);
    expect(granted.list, JSON.stringify(granted.body)).toBe(200);
    expect(granted.resolve, JSON.stringify(granted.body)).toBe(404);
  });
});

describe("sub-1201 round 2 (C) edge people snapshot role assignments use the DB clock", () => {
  const outlets = cafeLegendFixtures.outlets;
  const actor = randomUUID();
  const edgeUserIds: string[] = [];
  let outletId = "";
  let credential = "";
  let edgeRoleId = "";
  const assignments: Record<"control" | "ended" | "fresh", string> = {
    control: "",
    ended: "",
    fresh: "",
  };

  // Same row-level-security wrapper as edge-people-snapshot.test.ts.
  async function asOwner(text: string, params: unknown[] = []) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const result = await client.query(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function pinUser(label: string): Promise<string> {
    const id = randomUUID();
    await asOwner(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, `Staf Jam DB ${label}`, `jamdb-${id.slice(0, 8)}@example.test`],
    );
    edgeUserIds.push(id);
    createdUserIds.push(id);
    const hashed = await hashStaffPin({
      pepper: staffPinPepper(tenantId, outletId),
      binding: { tenantId, outletId, userId: id },
      pin: "482916",
    });
    const at = new Date();
    await asOwner(
      `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
          pepper_version, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $4, $11, $11, $11, $11)`,
      [
        randomUUID(),
        tenantId,
        outletId,
        id,
        hashed.pinHash,
        hashed.salt,
        hashed.params.N,
        hashed.params.r,
        hashed.params.p,
        currentStaffPinPepperVersion(),
        at,
      ],
    );
    return id;
  }

  async function edgeAssign(
    userId: string,
    validFromSql: string,
    validUntilSql: string,
  ): Promise<string> {
    const { rows } = await asOwner(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, ${validFromSql}, ${validUntilSql}, $2)
       RETURNING id`,
      [tenantId, userId, edgeRoleId],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    setAuditWriter(coreAuditWriter);
    // server.ts installs the edge registry verifier; createApp() does not.
    setEdgeCredentialVerifier(verifyEdgeNodeCredential);

    outletId = randomUUID();
    await asOwner(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $4, address, timezone, opening_hours, status
         FROM outlets WHERE id = $3`,
      [
        outletId,
        `JD${outletId.slice(0, 8)}`.toUpperCase(),
        outlets[0].id,
        "Outlet uji jam DB",
      ],
    );
    const scope: ScopedTenantContext = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
    );
    const registered = await registerEdgeNode(scope, actor, {
      outletId,
      role: "primary",
      label: "Mini PC uji jam DB",
    });
    credential = registered.credential;

    const { rows } = await asOwner(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, false, NULL, '["self.attendance.clock"]'::jsonb, false, '["tenant"]'::jsonb)
       RETURNING id`,
      [tenantId, `Peran jam DB ${outletId.slice(0, 8)}`],
    );
    edgeRoleId = rows[0].id as string;
    createdRoleIds.push(edgeRoleId);

    // Three staff with a PIN at the outlet, so the snapshot ships their
    // assignments; only the assignment window differs.
    assignments.control = await edgeAssign(
      await pinUser("kontrol"),
      "now() - interval '10 minutes'",
      "NULL",
    );
    assignments.ended = await edgeAssign(
      await pinUser("berakhir"),
      "now() - interval '10 minutes'",
      "clock_timestamp()",
    );
    assignments.fresh = await edgeAssign(
      await pinUser("baru"),
      "clock_timestamp()",
      "NULL",
    );
  }, 120_000);

  afterAll(async () => {
    setAuditWriter(null);
    setEdgeCredentialVerifier(null);
    // Best effort, as in edge-people-snapshot.test.ts: every row is private.
    const run = async (text: string, params: unknown[]) => {
      try {
        await asOwner(text, params);
      } catch {
        // leave rows behind; harmless for other files
      }
    };
    await run("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      edgeUserIds,
    ]);
    await run("DELETE FROM staff_pins WHERE outlet_id = $1", [outletId]);
    await run("DELETE FROM edge_nodes WHERE outlet_id = $1", [outletId]);
    await run("DELETE FROM attendance_qr_secrets WHERE outlet_id = $1", [
      outletId,
    ]);
    await run('DELETE FROM "user" WHERE id = ANY($1::text[])', [edgeUserIds]);
    await run("DELETE FROM outlets WHERE id = $1", [outletId]);
  });

  async function shippedIds(): Promise<string[]> {
    const response = await withAppClockBehindDb(() =>
      request(app)
        .get("/api/edge-sync/people-snapshot")
        .set("Authorization", `Bearer ${credential}`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as EdgePeopleSnapshot).roleAssignments.map(
      (entry) => entry.id,
    );
  }

  it("sub-1201 C edge snapshot: an assignment with valid_until = DB now is not shipped, with the app clock 60 s behind", async () => {
    const shipped = await shippedIds();
    // Control: an open-ended old assignment is shipped (setup is sound).
    expect(shipped).toContain(assignments.control);
    // Ended by the DB clock: gone at once.
    expect(shipped).not.toContain(assignments.ended);
  });

  it("sub-1201 C edge snapshot: an assignment with valid_from = DB now is shipped at once, with the app clock 60 s behind", async () => {
    const shipped = await shippedIds();
    expect(shipped).toContain(assignments.control);
    expect(shipped).toContain(assignments.fresh);
  });
});
