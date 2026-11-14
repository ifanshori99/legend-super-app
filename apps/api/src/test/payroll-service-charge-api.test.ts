// Service-charge pool configuration API (bead legend-gfcr slice F; contract
// `@starter/shared/hris/payroll` endpoints.ts). Runs the real Express app,
// Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend
// tenant (A) and a second tenant (B, reached by its own host name).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletA2] = cafeLegendPlatformFixtures.outlets;
const BASE = "/api/hris/payroll/service-charge-pools";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdPools: string[] = [];
const createdEmployees: string[] = [];

const key = () => `scpool-api-${randomUUID()}`;
const RULE = {
  method: "points",
  minAttendanceDays: 0,
  eligibleEmploymentTypes: ["pkwtt"],
};
/** Far-future months: no other suite writes pools there. */
const body = (
  outletId: string,
  periodStart: string,
  periodEnd: string,
  extra: Record<string, unknown> = {},
) => ({
  outletId,
  periodStart,
  periodEnd,
  amountIdr: 5_000_000,
  rule: RULE,
  idempotencyKey: key(),
  ...extra,
});

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  tenantId: string = tenant.id,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `SC pool api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let adminClient: Client;
let viewerClient: Client;
let strangerClient: Client;

// Tenant B: its own host, brand, legal entity and outlet.
const tenantB = randomUUID();
const brandB = randomUUID();
const domainB = randomUUID();
const entityB = randomUUID();
const outletB = randomUUID();
const hostB = `scpool-${tenantB.slice(0, 8)}.contoh.example`;

async function createEmployee(): Promise<string> {
  const id = randomUUID();
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Pool API', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, `SC-${id.slice(0, 8).toUpperCase()}`, outletA!.id],
    ),
  );
  createdEmployees.push(id);
  return id;
}

beforeAll(async () => {
  const admin = await signedInClient("SC pool admin API");
  await grantRole(admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  const viewer = await signedInClient("SC pool viewer API");
  await grantRole(viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;
  const stranger = await signedInClient("SC pool stranger API");
  await grantRole(stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client;

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'SC pool other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB, `scpool-${tenantB.slice(0, 8)}`, tenant.id],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand SC B')`,
    [brandB, tenantB, `brand-${tenantB.slice(0, 8)}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [domainB, tenantB, brandB, hostB],
  );
  await asTenant(tenantB, async (db) => {
    await db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT SC B', false)`,
      [entityB, tenantB],
    );
    await db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'SC-B', 'Outlet SC B', 'Jl. Uji', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [outletB, tenantB, brandB, entityB],
    );
  });
  // The same admin user holds the payroll rights in tenant B as well, so any
  // 404 below comes from tenant isolation, not from a missing permission.
  await grantRole(admin.userId, ["payroll.view", "payroll.run"], tenantB);
});

afterAll(async () => {
  await asTenant(tenant.id, async (db) => {
    await db.query(
      "DELETE FROM service_charge_allocations WHERE tenant_id = $1 AND pool_id = ANY($2)",
      [tenant.id, createdPools],
    );
    await db.query(
      "DELETE FROM service_charge_pools WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdPools],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'scpool-api-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  });
  await asTenant(tenantB, async (db) => {
    await db.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB,
    ]);
    await db.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
    await db.query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [
      tenantB,
    ]);
    await db.query("DELETE FROM service_charge_pools WHERE tenant_id = $1", [
      tenantB,
    ]);
    // audit_logs is append-only and names outlet B, so tenant B, its outlet and
    // its domain stay behind in the disposable test database.
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

async function createPool(
  outletId: string,
  periodStart: string,
  periodEnd: string,
) {
  const response = await adminClient
    .post(BASE)
    .set(originHeader)
    .send(body(outletId, periodStart, periodEnd));
  if (response.status === 201) createdPools.push(response.body.data.id);
  return response;
}

describe("service-charge pool API: create and list", () => {
  it("creates a draft pool, lists it with filters and pages", async () => {
    const created = await createPool(outletA!.id, "2090-01-01", "2090-01-31");
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: outletA!.id,
      periodStart: "2090-01-01",
      periodEnd: "2090-01-31",
      amountIdr: 5_000_000,
      rule: RULE,
      status: "draft",
      payrollRunId: null,
      approvedBy: null,
      approvedAt: null,
    });

    const second = await createPool(outletA!.id, "2090-02-01", "2090-02-28");
    expect(second.status).toBe(201);

    const list = await viewerClient.get(
      `${BASE}?outletId=${outletA!.id}&status=draft&limit=1`,
    );
    expect(list.status).toBe(200);
    // Newest period first.
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([
      second.body.data.id,
    ]);
    expect(list.body.meta.nextCursor).toBeTruthy();
    const next = await viewerClient.get(
      `${BASE}?outletId=${outletA!.id}&status=draft&limit=1&cursor=${encodeURIComponent(list.body.meta.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).toBe(created.body.data.id);

    const none = await viewerClient.get(`${BASE}?status=distributed`);
    expect(none.status).toBe(200);
    expect(
      none.body.data.filter((p: { id: string }) => createdPools.includes(p.id)),
    ).toEqual([]);
    expect((await viewerClient.get(`${BASE}?cursor=garbage`)).status).toBe(422);
  });

  it("writes an audit row without amounts", async () => {
    const created = await createPool(outletA!.id, "2090-03-01", "2090-03-31");
    expect(created.status).toBe(201);
    const rows = await asTenant(tenant.id, (db) =>
      db.query(
        `SELECT event->>'action' AS action, event::text AS changes FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenant.id, created.body.data.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].action).toBe("payroll.service_charge_pool.created");
    expect(rows.rows[0].changes).not.toContain("5000000");
  });

  it("replays the first 201 for the same key and refuses the key with another body", async () => {
    const payload = body(outletA!.id, "2090-04-01", "2090-04-30");
    const first = await adminClient.post(BASE).set(originHeader).send(payload);
    expect(first.status).toBe(201);
    createdPools.push(first.body.data.id);
    const replay = await adminClient.post(BASE).set(originHeader).send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const other = await adminClient
      .post(BASE)
      .set(originHeader)
      .send({ ...payload, amountIdr: 6_000_000 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("service-charge pool API: permission and input", () => {
  it("[AUTH] answers 401 anonymous, 403 without payroll.run (write) or payroll.view (read)", async () => {
    expect((await agent(app).get(BASE)).status).toBe(401);
    const noRun = await viewerClient
      .post(BASE)
      .set(originHeader)
      .send(body(outletA!.id, "2090-05-01", "2090-05-31"));
    expect(noRun.status).toBe(403);
    expect((await strangerClient.get(BASE)).status).toBe(403);
    expect(
      (await strangerClient.get(`${BASE}/${randomUUID()}/allocations`)).status,
    ).toBe(403);
  });

  it("[TEN-02] rejects a tenantId or unknown key in the body with 422", async () => {
    for (const extra of [{ tenantId: tenant.id }, { status: "approved" }]) {
      const response = await adminClient
        .post(BASE)
        .set(originHeader)
        .send(body(outletA!.id, "2090-05-01", "2090-05-31", extra));
      expect(response.status).toBe(422);
    }
  });

  it("rejects bad input with 422: period order, negative amount, empty rule types, unknown query key", async () => {
    const bad = [
      body(outletA!.id, "2090-05-31", "2090-05-01"),
      body(outletA!.id, "2090-05-01", "2090-05-31", { amountIdr: -1 }),
      body(outletA!.id, "2090-05-01", "2090-05-31", {
        rule: { ...RULE, eligibleEmploymentTypes: [] },
      }),
    ];
    for (const payload of bad) {
      const response = await adminClient
        .post(BASE)
        .set(originHeader)
        .send(payload);
      expect(response.status).toBe(422);
    }
    expect(
      (await viewerClient.get(`${BASE}?tenantId=${tenant.id}`)).status,
    ).toBe(422);
    expect((await viewerClient.get(`${BASE}?status=bogus`)).status).toBe(422);
    expect(
      (await viewerClient.get(`${BASE}/not-a-uuid/allocations`)).status,
    ).toBe(422);
  });

  it("rejects a mutation without Origin with 403", async () => {
    const response = await adminClient
      .post(BASE)
      .send(body(outletA!.id, "2090-05-01", "2090-05-31"));
    expect(response.status).toBe(403);
  });

  it("does not register calculate or approve (engine bead legend-pf9u7)", async () => {
    const id = createdPools[0]!;
    for (const action of ["calculate", "approve"]) {
      const response = await adminClient
        .post(`${BASE}/${id}/${action}`)
        .set(originHeader)
        .send({ idempotencyKey: key() });
      expect(response.status, action).toBe(404);
    }
  });
});

describe("service-charge pool API: outlet and overlap rules", () => {
  it("answers 422 for an outlet that is not in the tenant", async () => {
    const response = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(outletB, "2091-01-01", "2091-01-31"));
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const unknown = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(randomUUID(), "2091-01-01", "2091-01-31"));
    expect(unknown.status).toBe(422);
  });

  it("answers 409 for a live pool of the same outlet with an overlapping period", async () => {
    const first = await createPool(outletA!.id, "2091-02-01", "2091-02-28");
    expect(first.status).toBe(201);
    for (const [from, to] of [
      ["2091-02-01", "2091-02-28"], // identical
      ["2091-02-10", "2091-02-20"], // inside
      ["2091-01-15", "2091-02-01"], // touches the first day
      ["2091-02-28", "2091-03-05"], // touches the last day
      ["2091-01-01", "2091-03-31"], // contains
    ] as const) {
      const clash = await createPool(outletA!.id, from, to);
      expect(clash.status, `${from}..${to}`).toBe(409);
      expect(clash.body.error.code).toBe("CONFLICT");
    }
    // Adjacent period, and the same period of another outlet, are fine.
    expect(
      (await createPool(outletA!.id, "2091-03-01", "2091-03-31")).status,
    ).toBe(201);
    expect(
      (await createPool(outletA2!.id, "2091-02-01", "2091-02-28")).status,
    ).toBe(201);
  });

  it("[state] a cancelled pool frees its period", async () => {
    const first = await createPool(outletA!.id, "2091-04-01", "2091-04-30");
    expect(first.status).toBe(201);
    expect(
      (await createPool(outletA!.id, "2091-04-01", "2091-04-30")).status,
    ).toBe(409);
    await asTenant(tenant.id, (db) =>
      db.query(
        "UPDATE service_charge_pools SET status = 'cancelled' WHERE id = $1",
        [first.body.data.id],
      ),
    );
    const again = await createPool(outletA!.id, "2091-04-10", "2091-04-20");
    expect(again.status).toBe(201);

    const cancelled = await viewerClient.get(
      `${BASE}?outletId=${outletA!.id}&status=cancelled`,
    );
    expect(cancelled.body.data.map((p: { id: string }) => p.id)).toContain(
      first.body.data.id,
    );
  });

  it("lets only one of two concurrent overlapping creates win", async () => {
    const results = await Promise.all([
      createPool(outletA2!.id, "2091-06-01", "2091-06-30"),
      createPool(outletA2!.id, "2091-06-15", "2091-07-15"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe("service-charge pool API: allocations", () => {
  it("lists a pool's allocations by employee with paging, and 404 for an unknown pool", async () => {
    const pool = await createPool(outletA!.id, "2092-01-01", "2092-01-31");
    expect(pool.status).toBe(201);
    const poolId = pool.body.data.id as string;
    const employees = [await createEmployee(), await createEmployee()];
    await asTenant(tenant.id, async (db) => {
      for (const [index, employeeId] of employees.entries())
        await db.query(
          `INSERT INTO service_charge_allocations
             (tenant_id, pool_id, employee_id, points, attendance_days, weight, amount_idr)
           VALUES ($1, $2, $3, '1.5000', 20, 15000, $4)`,
          [tenant.id, poolId, employeeId, 2_500_000 + index],
        );
    });

    const all = await viewerClient.get(`${BASE}/${poolId}/allocations`);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0]).toMatchObject({
      tenantId: tenant.id,
      poolId,
      points: "1.5000",
      attendanceDays: 20,
      weight: 15000,
    });
    expect(
      all.body.data.reduce(
        (sum: number, row: { amountIdr: number }) => sum + row.amountIdr,
        0,
      ),
    ).toBe(5_000_001);
    expect(
      all.body.data.map((row: { employeeId: string }) => row.employeeId),
    ).toEqual([...employees].sort());

    const first = await viewerClient.get(
      `${BASE}/${poolId}/allocations?limit=1`,
    );
    expect(first.body.data).toHaveLength(1);
    const next = await viewerClient.get(
      `${BASE}/${poolId}/allocations?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(next.body.meta.nextCursor).toBeNull();

    // A pool without allocations answers an empty page.
    const empty = await createPool(outletA!.id, "2092-02-01", "2092-02-28");
    const none = await viewerClient.get(
      `${BASE}/${empty.body.data.id}/allocations`,
    );
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);

    const missing = await viewerClient.get(
      `${BASE}/${randomUUID()}/allocations`,
    );
    expect(missing.status).toBe(404);
  });
});

describe("service-charge pool API: tenant isolation", () => {
  it("[TEN-01] tenant B cannot list or read allocations of tenant A's pool (404) and sees none of its pools", async () => {
    const pool = await createPool(outletA!.id, "2093-01-01", "2093-01-31");
    expect(pool.status).toBe(201);
    const poolId = pool.body.data.id as string;

    const asB = (path: string) => adminClient.get(path).set("Host", hostB);
    const allocations = await asB(`${BASE}/${poolId}/allocations`);
    expect(allocations.status).toBe(404);

    const list = await asB(BASE);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    // Tenant B creates its own pool; tenant A does not see it.
    const own = await adminClient
      .post(BASE)
      .set("Host", hostB)
      .set(originHeader)
      .send(body(outletB, "2093-01-01", "2093-01-31"));
    expect(own.status).toBe(201);
    expect(own.body.data.tenantId).toBe(tenantB);
    const mine = await asB(BASE);
    expect(mine.body.data.map((p: { id: string }) => p.id)).toEqual([
      own.body.data.id,
    ]);
    const ownerList = await viewerClient.get(`${BASE}?limit=100`);
    expect(ownerList.body.data.map((p: { id: string }) => p.id)).not.toContain(
      own.body.data.id,
    );
    // A's outlet is a 422 for B as well.
    const crossOutlet = await adminClient
      .post(BASE)
      .set("Host", hostB)
      .set(originHeader)
      .send(body(outletA!.id, "2093-02-01", "2093-02-28"));
    expect(crossOutlet.status).toBe(422);
  });
});
