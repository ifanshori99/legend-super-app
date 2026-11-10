// Audit log viewer API (PRD v1.7 §3 F36; bead legend-zbzr). HTTP tests run the
// real Better Auth, tenant resolver, RBAC resolver, PostgreSQL and RLS. The
// router is mounted on a small express app with the same auth + tenant
// middleware as app.ts.
//
// Assumptions: `audit_logs` is append-only, so rows cannot be removed; every
// test seeds rows with a fresh random object type and filters by it. The
// viewer role is a custom tenant-scope role holding only `audit.log.view`.
// `created_at` is stamped by the database on insert, so date filters are
// tested against far past / far future bounds, not exact days.
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_REDACTED,
  listAuditEventsEndpoint,
  type AuditEventView,
} from "@starter/shared/audit";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { auditEventsRouter } from "../routes/audit-events.routes";
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { agent, signUp } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const LIST = listAuditEventsEndpoint.path;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

function buildApp(tenantId: string): ReturnType<typeof express> {
  const app = express();
  app.use(requestContext);
  app.all("/api/auth/*splat", limitAuthBody, toNodeHandler(auth));
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain: async (hostname) => {
        const resolution = await resolveHostname(hostname);
        return resolution.ok
          ? { tenantId: resolution.tenantId, brandId: resolution.brandId }
          : null;
      },
      verifyCredential: deviceTenantCredential,
      // Test stand-in for the development tenant fallback.
      fallback: async (req) => {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
          query: { disableCookieCache: true },
        });
        return session ? { tenantId, brandId: null, source: "session" } : null;
      },
    }),
  );
  app.use("/api/audit", auditEventsRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const appA = buildApp(tenantA);
const appB = buildApp(tenantB);

type Person = {
  client: ReturnType<typeof agent>;
  userId: string;
  name: string;
};

async function signedIn(app: express.Express, name: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string, name };
}

async function viewer(app: express.Express, tenantId: string) {
  const person = await signedIn(app, "Audit Viewer");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Audit viewer test ${roleId.slice(0, 8)}`,
      JSON.stringify(["audit.log.view"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, person.userId, roleId],
  );
  return person;
}

type Seed = {
  tenantId?: string;
  outletId?: string | null;
  actorType?: string;
  actorId?: string | null;
  deviceId?: string | null;
  action?: string;
  objectType: string;
  before?: unknown;
  after?: unknown;
};

/** Inserts one audit row as the table owner; ULIDs rise with `offset`. */
async function seed(offset: number, row: Seed): Promise<string> {
  const tenantId = row.tenantId ?? tenantA;
  const ulid = createUlid(Date.now() + offset);
  const event = {
    id: ulid,
    tenantId,
    outletId: row.outletId ?? null,
    actorType: row.actorType ?? "system",
    actorId: row.actorId ?? null,
    deviceId: row.deviceId ?? null,
    action: row.action ?? "settings.updated",
    objectType: row.objectType,
    objectId: null,
    reason: null,
    maskedChanges: { before: row.before ?? null, after: row.after ?? null },
    ipHash: null,
    sensitiveAccess: false,
    retentionClass: "audit_2y",
    createdAt: new Date().toISOString(),
  };
  await owner.query(
    `INSERT INTO audit_logs (tenant_id, id, outlet_id, event, retention_class)
     VALUES ($1, $2, $3, $4, 'audit_2y')`,
    [tenantId, ulidToUuid(ulid), event.outletId, JSON.stringify(event)],
  );
  return ulid;
}

const token = () => `zbzr_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

async function list(who: Person, query: Record<string, string | number>) {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]): [string, string] => [
      key,
      String(value),
    ]),
  );
  return who.client.get(`${LIST}?${search.toString()}`);
}

function parsePage(body: unknown) {
  return listAuditEventsEndpoint.response.parse(body);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Audit events tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `audit-ev-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
});

afterAll(async () => {
  // Tenant B keeps its audit rows (append-only, no FK to tenants); roles and
  // the tenant row go. Each delete runs on its own so one failure is reported.
  const failures: unknown[] = [];
  for (const sql of [
    "DELETE FROM role_assignments WHERE tenant_id = $1",
    "DELETE FROM roles WHERE tenant_id = $1",
    "DELETE FROM tenants WHERE id = $1",
  ]) {
    try {
      await owner.query(sql, [tenantB]);
    } catch (error) {
      failures.push(error);
    }
  }
  await owner.end();
  if (failures.length > 0) throw failures[0];
});

describe("legend-zbzr GET /api/audit/events", () => {
  it("1. anonymous gets 401 and a signed-in user without audit.log.view gets 403", async () => {
    const anonymous = await agent(appA).get(LIST);
    expect(anonymous.status).toBe(401);
    const nobody = await signedIn(appA, "Audit Nobody");
    expect((await nobody.client.get(LIST)).status).toBe(403);
  });

  it("2. returns newest first and pages by cursor without gaps or repeats", async () => {
    const who = await viewer(appA, tenantA);
    const objectType = token();
    const ulids: string[] = [];
    for (let index = 0; index < 5; index += 1)
      ulids.push(await seed(index, { objectType }));

    const first = await list(who, { objectType, limit: 2 });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toContain("no-store");
    const page1 = parsePage(first.body);
    expect(page1.data.map((row) => row.event.id)).toEqual([ulids[4], ulids[3]]);
    expect(page1.meta.nextCursor).not.toBeNull();

    const second = parsePage(
      (
        await list(who, {
          objectType,
          limit: 2,
          cursor: page1.meta.nextCursor!,
        })
      ).body,
    );
    expect(second.data.map((row) => row.event.id)).toEqual([
      ulids[2],
      ulids[1],
    ]);

    const third = parsePage(
      (
        await list(who, {
          objectType,
          limit: 2,
          cursor: second.meta.nextCursor!,
        })
      ).body,
    );
    expect(third.data.map((row) => row.event.id)).toEqual([ulids[0]]);
    expect(third.meta.nextCursor).toBeNull();
  });

  it("3. rejects a tampered cursor and an inverted date range with 422", async () => {
    const who = await viewer(appA, tenantA);
    expect((await list(who, { cursor: "bukan-cursor" })).status).toBe(422);
    expect(
      (await list(who, { from: "2026-11-05", to: "2026-11-01" })).status,
    ).toBe(422);
  });

  it("4. filters by actor type, action, outlet and business date", async () => {
    const who = await viewer(appA, tenantA);
    const objectType = token();
    const outlet = await owner.query(
      "SELECT id FROM outlets WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantA],
    );
    const outletId = outlet.rows[0].id as string;
    const bySystem = await seed(0, { objectType, action: "role.updated" });
    const byOutlet = await seed(1, {
      objectType,
      action: "settings.updated",
      outletId,
    });

    const ids = async (query: Record<string, string | number>) =>
      parsePage((await list(who, { objectType, ...query })).body).data.map(
        (row) => row.event.id,
      );
    expect(await ids({ action: "role.updated" })).toEqual([bySystem]);
    expect(await ids({ outletId })).toEqual([byOutlet]);
    expect(await ids({ actorType: "system" })).toEqual([byOutlet, bySystem]);
    expect(await ids({ actorType: "ai" })).toEqual([]);
    expect(await ids({ from: "2000-01-01", to: "2999-12-31" })).toHaveLength(2);
    expect(await ids({ from: "2999-01-01" })).toEqual([]);
    expect(await ids({ to: "2000-01-01" })).toEqual([]);
  });

  it("5. resolves actor and outlet display names", async () => {
    const who = await viewer(appA, tenantA);
    const objectType = token();
    const outlet = await owner.query(
      "SELECT id, name, timezone FROM outlets WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantA],
    );
    const { id: outletId, name, timezone } = outlet.rows[0];
    await seed(0, {
      objectType,
      actorType: "user",
      actorId: who.userId,
      outletId,
    });
    await seed(1, { objectType, actorType: "system" });

    const rows = parsePage((await list(who, { objectType })).body).data;
    const bySystem = rows[0] as AuditEventView;
    const byUser = rows[1] as AuditEventView;
    expect(byUser).toMatchObject({
      actorName: who.name,
      outletName: name,
      outletTimeZone: timezone,
    });
    expect(bySystem).toMatchObject({
      actorName: null,
      outletName: null,
      outletTimeZone: null,
      deviceName: null,
    });
  });

  it("6. masks a stored row that skipped the masker", async () => {
    const who = await viewer(appA, tenantA);
    const objectType = token();
    await seed(0, {
      objectType,
      before: { email: "budi@example.com", status: "aktif" },
      after: { phone: "081234567890" },
    });
    const response = await list(who, { objectType });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("budi@example.com");
    expect(JSON.stringify(response.body)).not.toContain("081234567890");
    const [row] = parsePage(response.body).data;
    expect(row?.event.maskedChanges.before).toMatchObject({
      email: AUDIT_REDACTED,
    });
    expect(row?.event.maskedChanges.after).toMatchObject({
      phone: AUDIT_REDACTED,
    });
  });

  it("7. a stored row that cannot be read is skipped and the page still answers", async () => {
    const who = await viewer(appA, tenantA);
    const objectType = token();
    const before = await seed(0, { objectType });
    // Valid JSON that passes the table's own check, but is not an audit event
    // any more (legacy shape).
    const brokenUlid = createUlid(Date.now() + 1);
    const brokenEvent = {
      id: brokenUlid,
      tenantId: tenantA,
      outletId: null,
      objectType,
      retentionClass: "audit_2y",
      legacy: true,
    };
    await owner.query(
      `INSERT INTO audit_logs (tenant_id, id, outlet_id, event, retention_class)
       VALUES ($1, $2, NULL, $3, 'audit_2y')`,
      [tenantA, ulidToUuid(brokenUlid), JSON.stringify(brokenEvent)],
    );
    const after = await seed(2, { objectType });

    const response = await list(who, { objectType });
    expect(response.status).toBe(200);
    expect(parsePage(response.body).data.map((row) => row.event.id)).toEqual([
      after,
      before,
    ]);
    expect(JSON.stringify(response.body)).not.toContain(brokenUlid);
  });

  it("8. one tenant never sees another tenant's rows (RLS)", async () => {
    const objectType = token();
    await seed(0, { objectType, tenantId: tenantA });
    const idB = await seed(1, { objectType, tenantId: tenantB });
    const viewerA = await viewer(appA, tenantA);
    const viewerB = await viewer(appB, tenantB);

    const seenByB = parsePage((await list(viewerB, { objectType })).body).data;
    expect(seenByB.map((row) => row.event.id)).toEqual([idB]);
    expect(seenByB.every((row) => row.event.tenantId === tenantB)).toBe(true);
    const seenByA = parsePage((await list(viewerA, { objectType })).body).data;
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.event.tenantId).toBe(tenantA);
  });
});
