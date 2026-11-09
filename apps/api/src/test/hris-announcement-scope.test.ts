// Announcement feed surface vs. grant scope (bead legend-dak5, P3). The feed is
// shared by managers (back office) and staff (employee surface). The surface
// was picked by the flat union `permissions.includes("hr.announcement.manage")`, so a
// user holding the manage code ONLY at a station (no outlet reach: a station
// grant contributes no outlet-wide reach) was routed through the back-office
// gate. The surface now follows the real reach of the manage code.
//
// Real app, Better Auth, PostgreSQL and RLS. Every denial has a positive
// control first.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { feedSurfaceOf } from "../routes/hris-announcement.routes.ts";
import { resolveHrisLearningContext } from "../routes/hris-sop-gate.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const run = randomUUID().slice(0, 8);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdStations: string[] = [];

type Scope =
  | { type: "tenant" }
  | { type: "outlet"; id: string }
  | { type: "station"; id: string };

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const tenantScope = establishScopedTenantContext(tenant, { kind: "tenant" });

async function asOwner<T>(
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createStation(outletId: string): Promise<string> {
  const result = await asOwner((client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'coffee_bar') RETURNING id`,
      [tenantId, outletId, `AnnScope ${randomUUID().slice(0, 8)}`],
    ),
  );
  createdStations.push(result.rows[0].id);
  return result.rows[0].id;
}

async function grantRole(userId: string, permissions: string[], scope: Scope) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `AnnScope ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "tenant" ? null : scope.id,
      ],
    );
  });
}

async function signedIn(
  name: string,
  grants: { permissions: string[]; scope: Scope }[],
  employeeOutlet: string | null,
) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  for (const grant of grants)
    await grantRole(userId, grant.permissions, grant.scope);
  if (employeeOutlet !== null) {
    const id = randomUUID();
    createdEmployees.push(id);
    await asOwner((c) =>
      c.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
        [
          id,
          tenantId,
          userId,
          `AS-${id.slice(0, 8).toUpperCase()}`,
          `AnnScope-${run} ${name}`,
          employeeOutlet,
        ],
      ),
    );
  }
  return { client, userId };
}

/** The caller's real access snapshot, as loadRequestAccess builds it. */
async function snapshotOf(userId: string) {
  const data = await loadTenantAccess(tenantScope, userId);
  return resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
}

let stationA: string;
let publisher: Awaited<ReturnType<typeof signedIn>>;
let stationOnly: Awaited<ReturnType<typeof signedIn>>;
let outletManager: Awaited<ReturnType<typeof signedIn>>;
let tenantManager: Awaited<ReturnType<typeof signedIn>>;
let idAll: string;
let idOutletA: string;
let idOutletB: string;

async function publish(audience: unknown, title: string): Promise<string> {
  const created = await publisher.client
    .post("/api/hris/announcements")
    .set(originHeader)
    .send({
      title: `${title} ${run}`,
      body: "Uji lingkup.",
      audience,
      requiresReceipt: false,
      expiresAt: null,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.data.id as string;
}

const feedIds = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((item) => item.id);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  stationA = await createStation(outletA);
  publisher = await signedIn(
    "Publisher",
    [{ permissions: ["hr.announcement.manage"], scope: { type: "tenant" } }],
    null,
  );
  // Staff of outlet A who also hold the manage code ONLY at a station.
  stationOnly = await signedIn(
    "StationOnly",
    [
      {
        permissions: ["self.sop.read"],
        scope: { type: "outlet", id: outletA },
      },
      {
        permissions: ["hr.announcement.manage"],
        scope: { type: "station", id: stationA },
      },
    ],
    outletA,
  );
  // A real outlet manager (no employee row, so only the manager feed shows).
  outletManager = await signedIn(
    "OutletManager",
    [
      {
        permissions: ["hr.announcement.manage"],
        scope: { type: "outlet", id: outletA },
      },
    ],
    null,
  );
  tenantManager = await signedIn(
    "TenantManager",
    [{ permissions: ["hr.announcement.manage"], scope: { type: "tenant" } }],
    null,
  );
  idAll = await publish({ kind: "all" }, "Semua");
  idOutletA = await publish({ kind: "outlets", outletIds: [outletA] }, "A");
  idOutletB = await publish({ kind: "outlets", outletIds: [outletB] }, "B");
});

afterAll(async () => {
  await asOwner(async (client) => {
    const mine = "tenant_id = $1 AND published_by = ANY($2)";
    await client.query(
      `DELETE FROM announcement_receipts WHERE tenant_id = $1 AND announcement_id IN
         (SELECT id FROM announcements WHERE ${mine})`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM hris_announcement_outlets WHERE tenant_id = $1 AND announcement_id IN
         (SELECT id FROM announcements WHERE ${mine})`,
      [tenantId, createdUsers],
    );
    await client.query(`DELETE FROM announcements WHERE ${mine}`, [
      tenantId,
      createdUsers,
    ]);
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
    await client.query("DELETE FROM stations WHERE id = ANY($1)", [
      createdStations,
    ]);
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-dak5 announcement feed surface follows the reach of the manage code", () => {
  it("legend-dak5 a tenant manager and an outlet manager have manage reach (positive control)", async () => {
    for (const actor of [tenantManager, outletManager]) {
      const snapshot = await snapshotOf(actor.userId);
      const context = await resolveHrisLearningContext(
        snapshot,
        tenant,
        actor.userId,
        ["hr.announcement.manage"],
      );
      expect(context).not.toBeNull();
    }
    const outlet = await resolveHrisLearningContext(
      await snapshotOf(outletManager.userId),
      tenant,
      outletManager.userId,
      ["hr.announcement.manage"],
    );
    expect(outlet?.outletScope).toMatchObject({
      kind: "outlets",
      outletIds: [outletA],
    });
  });

  it("legend-dak5 a station-only manage grant is in the flat union but has no manage reach", async () => {
    const snapshot = await snapshotOf(stationOnly.userId);
    // The old surface test: true, although the grant reaches no outlet.
    expect(snapshot.permissions.includes("hr.announcement.manage")).toBe(true);
    expect(
      await resolveHrisLearningContext(snapshot, tenant, stationOnly.userId, [
        "hr.announcement.manage",
      ]),
    ).toBeNull();
    // Their self reach is intact.
    expect(
      await resolveHrisLearningContext(snapshot, tenant, stationOnly.userId, [
        "self.sop.read",
      ]),
    ).not.toBeNull();
  });

  it("legend-dak5 the feed picks back office for real managers and the employee surface for a station-only manage grant", async () => {
    for (const actor of [tenantManager, outletManager])
      expect(
        await feedSurfaceOf(
          await snapshotOf(actor.userId),
          tenant,
          actor.userId,
        ),
      ).toBe("back_office");
    expect(
      await feedSurfaceOf(
        await snapshotOf(stationOnly.userId),
        tenant,
        stationOnly.userId,
      ),
    ).toBe("hris");
  });

  it("legend-dak5 the outlet manager still gets the manager feed over HTTP (positive control)", async () => {
    const feed = await outletManager.client.get(
      "/api/hris/announcements?limit=100",
    );
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const ids = feedIds(feed);
    expect(ids).toEqual(expect.arrayContaining([idAll, idOutletA]));
    expect(ids).not.toContain(idOutletB);
  });

  it("legend-dak5 the station-only manager gets exactly the self feed over HTTP", async () => {
    const feed = await stationOnly.client.get(
      "/api/hris/announcements?limit=100",
    );
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const ids = feedIds(feed);
    expect(ids).toEqual(expect.arrayContaining([idAll, idOutletA]));
    expect(ids).not.toContain(idOutletB);
    // The back-office routes stay closed to them.
    const publishAttempt = await stationOnly.client
      .post("/api/hris/announcements")
      .set(originHeader)
      .send({
        title: "x",
        body: "x",
        audience: { kind: "all" },
        requiresReceipt: false,
        expiresAt: null,
      });
    expect(publishAttempt.status).toBe(403);
  });
});
