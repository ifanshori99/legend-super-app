// KPI definitions, review cycle, system actuals and submit over HTTP (PRD
// v1.7 §3 F29 "KPI per jabatan"; HR-01; TEN-01/02/03; bead legend-ovxw;
// DECISIONS 2026-11-10 "WS-10 lifecycle" point 3). Runs the real Express app,
// Better Auth, the RBAC resolver, the metric engine and PostgreSQL against the
// seeded Cafe Legend tenant plus a throwaway second tenant. Expected behaviour
// comes from the brief (docs/briefs/299-hr-lifecycle-kpi.md) and the shared
// contract (packages/shared/src/hris/performance.ts), not from the service.
//
// Assumptions (the brief leaves these open):
//  - A body or query with an unknown key or a client-sent tenantId is 422.
//  - A manager outside the employee's home outlet gets 404; a caller without
//    any KPI or HRIS read code gets 403. Writing a definition needs
//    `hr.kpi.manage` held tenant-wide: an outlet-scoped manager gets 403.
//  - Catalog refusals are 422 with `KPI_METRIC_UNKNOWN`,
//    `KPI_METRIC_NOT_PER_EMPLOYEE` and `KPI_METRIC_UNIT_MISMATCH`.
//  - A partial period is 422 `KPI_PERIOD_INVALID`; a second review for the
//    same employee, cycle and start is 409 `KPI_REVIEW_EXISTS`.
//  - An available system actual is copied to `actual` (source `system`) and a
//    manual value for it is 422 `KPI_ACTUAL_SYSTEM`; an unavailable one stores
//    null with its reason and accepts a manual actual.
//  - Submit: incomplete scores 422 `KPI_SCORES_INCOMPLETE`, reviewer is the
//    subject's own account 403 `KPI_SELF_REVIEW`; after it, scores, refresh
//    and submit are 409 `KPI_REVIEW_SUBMITTED`. The overall score is the mean.
//  - Reviews are visible as drafts only to managers; a submitted review is also
//    visible to HRIS readers of the outlet and to the employee themself.
//  - Dates are in 2034 so the rows cannot collide with seeded data.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema, outletIdsForQuery } from "@starter/shared/core";
import { reportMetricByCode } from "@starter/shared/dashboard";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  evaluateMetrics,
  withTenantSnapshot,
} from "../services/metrics-query.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  asTenant as asRlsTenant,
  createAppPool,
  createSecondTenant,
  removeSecondTenant,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = createAppPool();

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let tenantB: SecondTenant | null = null;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

type Client = ReturnType<typeof agent>;

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `KPI API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    if (scope.type === "tenant")
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId],
      );
    else
      for (const outletId of scope.outletIds)
        await client.query(
          `INSERT INTO role_assignments
             (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
           VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
          [tenant.id, userId, roleId, outletId],
        );
  });
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. KPI', 'Asia/Jakarta', '{}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `KP-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet KPI ${label}`,
      ],
    ),
  );
  return id;
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  positionId: string;
}) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              position_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan KPI API', $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        input.userId,
        `KP-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
        input.positionId,
      ],
    ),
  );
  return id;
}

const post = (client: Client, path: string, body: unknown = {}) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const patch = (client: Client, path: string, body: unknown) =>
  client
    .patch(path)
    .set(originHeader)
    .send(body as object);

// ---- metric rows ------------------------------------------------------------

const VOID = reportMetricByCode.get("void_amount")!;
const WITHOUT_EMPLOYEE = [...reportMetricByCode.values()].find(
  (metric) => !metric.dimensions.includes("employee"),
)!;

/** One metrics_daily row as the job would write it: void amount per employee. */
async function voidRow(
  outletId: string,
  date: string,
  employeeUserId: string,
  amount: number,
) {
  await owner.query(
    `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code, definition_id, definition_version,
       dimension_key, dimension_value, unit, value_int, finality, computed_at)
     VALUES ($1, $2, $3, 'void_amount', $4, $5, 'employee', $6, 'idr', $7, 'final', now())`,
    [tenant.id, outletId, date, VOID.id, VOID.version, employeeUserId, amount],
  );
}

/** What the metric engine answers for one employee and period. */
async function engineVoid(userId: string, start: string, end: string) {
  const context = tenantContext(tenant.id);
  const evaluated = await withTenantSnapshot(context, (tx) =>
    evaluateMetrics(
      tx,
      context,
      {
        metricCodes: ["void_amount"],
        period: {
          start: businessDateSchema.parse(start),
          end: businessDateSchema.parse(end),
        },
        bucket: "total",
        outletFilter: outletIdsForQuery(context.outletScope),
        groupBy: ["employee"],
        filters: [{ key: "employee", values: [userId] }],
        comparePrevious: false,
        viewer: "full",
      },
      new Date(),
    ),
  );
  const value = evaluated.series.find((series) =>
    series.dimensions.some((dimension) => dimension.value === userId),
  )?.points[0]?.value;
  if (!value || value.unit !== "idr") throw new Error("No engine value");
  return value.valueIdr as number;
}

// ---- fixtures ---------------------------------------------------------------

let jkt = "";
let otherOutlet = "";
let positionId = "";
let mgr: Client; // hr.kpi.manage, tenant-wide
let mgrUserId = "";
let mgrJkt: Client; // hr.kpi.manage at jkt only
let mgrOther: Client; // hr.kpi.manage at the other outlet only
let selfMgr: Client; // hr.kpi.manage tenant-wide, and an employee row
let subject: Client; // self.profile.view
let subjectUserId = "";
let hrReader: Client; // hr.employee.view at jkt
let nobody: Client; // self.profile.view, no employee row
let empSubject = "";
let empNoUser = "";
let empOther = "";
let empSelf = "";
let defVoid = "";
let defManager = "";

type Score = {
  kpiDefinitionId: string;
  actual: string | null;
  score: number | null;
  systemActual: string | null;
  systemAvailability: string | null;
  actualSource: string | null;
  comment: string | null;
};
type Review = {
  id: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  cycle: string;
  status: string;
  reviewerId: string | null;
  submittedAt: string | null;
  note: string | null;
  overallScore: number | null;
  scores: Score[];
};
const scoreOf = (review: Review, definitionId: string) =>
  review.scores.find((score) => score.kpiDefinitionId === definitionId)!;

async function createDefinition(body: Record<string, unknown>) {
  return post(mgr, "/api/hris/kpi-definitions", {
    positionId,
    metricCode: null,
    target: null,
    ...body,
  });
}

async function openReview(
  client: Client,
  employeeId: string,
  periodStart: string,
  cycle = "monthly",
) {
  const response = await post(client, "/api/hris/kpi-reviews", {
    employeeId,
    cycle,
    periodStart,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as Review;
}

beforeAll(async () => {
  jkt = await seedOutlet("jkt");
  otherOutlet = await seedOutlet("lain");
  positionId = randomUUID();
  await asTenant((client) =>
    client.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, 'Kasir KPI API')",
      [positionId, tenant.id],
    ),
  );

  const manager = await signedInClient("Manajer KPI API", { mfa: true });
  await grantRole(manager.userId, ["hr.kpi.manage"], { type: "tenant" });
  mgr = manager.client;
  mgrUserId = manager.userId;

  const jktManager = await signedInClient("Manajer KPI Jkt API", {
    mfa: true,
  });
  await grantRole(jktManager.userId, ["hr.kpi.manage"], {
    type: "outlet",
    outletIds: [jkt],
  });
  mgrJkt = jktManager.client;

  const otherManager = await signedInClient("Manajer KPI Lain API", {
    mfa: true,
  });
  await grantRole(otherManager.userId, ["hr.kpi.manage"], {
    type: "outlet",
    outletIds: [otherOutlet],
  });
  mgrOther = otherManager.client;

  const selfManager = await signedInClient("Manajer Menilai Diri API", {
    mfa: true,
  });
  await grantRole(selfManager.userId, ["hr.kpi.manage"], { type: "tenant" });
  selfMgr = selfManager.client;

  const staff = await signedInClient("Staf KPI API");
  await grantRole(staff.userId, ["self.profile.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  subject = staff.client;
  subjectUserId = staff.userId;

  const reader = await signedInClient("Pembaca KPI API", { mfa: true });
  await grantRole(reader.userId, ["hr.employee.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  hrReader = reader.client;

  const none = await signedInClient("Tanpa Izin KPI API");
  await grantRole(none.userId, ["self.profile.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  nobody = none.client;

  empSubject = await seedEmployee({
    userId: subjectUserId,
    outletId: jkt,
    positionId,
  });
  empNoUser = await seedEmployee({ userId: null, outletId: jkt, positionId });
  empOther = await seedEmployee({
    userId: null,
    outletId: otherOutlet,
    positionId,
  });
  empSelf = await seedEmployee({
    userId: selfManager.userId,
    outletId: jkt,
    positionId,
  });
}, 120_000);

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `DELETE FROM hris_kpi_scores WHERE tenant_id = $1 AND review_id IN
         (SELECT id FROM hris_kpi_reviews WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[]))`,
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_kpi_reviews WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_kpi_definitions WHERE tenant_id = $1 AND position_id = $2",
      [tenant.id, positionId],
    );
    await client.query(
      "DELETE FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await client.query(
      "DELETE FROM positions WHERE tenant_id = $1 AND id = $2",
      [tenant.id, positionId],
    );
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  if (tenantB) {
    for (const table of [
      "hris_kpi_scores",
      "hris_kpi_reviews",
      "hris_kpi_definitions",
      "employees",
      "positions",
    ])
      await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantB.tenantId,
      ]);
    await removeSecondTenant(owner, tenantB);
  }
  await appPool.end();
  await owner.end();
});

// ---- definitions ------------------------------------------------------------

describe("KPI definitions", () => {
  it("[TEN-01] anonymous requests answer 401", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get("/api/hris/kpi-definitions")).status).toBe(401);
    expect((await anonymous.get("/api/hris/kpi-reviews")).status).toBe(401);
    expect(
      (await anonymous.post("/api/hris/kpi-reviews").set(originHeader).send({}))
        .status,
    ).toBe(401);
  });

  it("creates a manager KPI and a system KPI and lists them", async () => {
    const manager = await createDefinition({
      name: "Keramahan",
      source: "manager",
      unit: "poin",
      target: "80.0000",
      direction: "higher_is_better",
    });
    expect(manager.status, JSON.stringify(manager.body)).toBe(201);
    expect(manager.body.data).toMatchObject({
      positionId,
      name: "Keramahan",
      source: "manager",
      metricCode: null,
      target: "80.0000",
      isActive: true,
    });
    defManager = manager.body.data.id;

    const system = await createDefinition({
      name: "Nilai void",
      source: "system",
      metricCode: "void_amount",
      unit: "idr",
      direction: "lower_is_better",
    });
    expect(system.status, JSON.stringify(system.body)).toBe(201);
    expect(system.body.data).toMatchObject({
      source: "system",
      metricCode: "void_amount",
      unit: "idr",
      direction: "lower_is_better",
    });
    defVoid = system.body.data.id;

    const listed = await mgr.get(
      `/api/hris/kpi-definitions?positionId=${positionId}`,
    );
    expect(listed.status).toBe(200);
    expect(
      (listed.body.data as { id: string }[]).map((row) => row.id).sort(),
    ).toEqual([defManager, defVoid].sort());
  });

  it("refuses a system KPI the metric engine could not fill", async () => {
    const unknown = await createDefinition({
      name: "Tidak ada",
      source: "system",
      metricCode: "no_such_metric_code",
      unit: "idr",
      direction: "higher_is_better",
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("KPI_METRIC_UNKNOWN");

    const noSplit = await createDefinition({
      name: "Tanpa karyawan",
      source: "system",
      metricCode: WITHOUT_EMPLOYEE.code,
      unit: WITHOUT_EMPLOYEE.unit,
      direction: "higher_is_better",
    });
    expect(noSplit.status).toBe(422);
    expect(noSplit.body.error.code).toBe("KPI_METRIC_NOT_PER_EMPLOYEE");

    const unit = await createDefinition({
      name: "Satuan salah",
      source: "system",
      metricCode: "void_amount",
      unit: "count",
      direction: "lower_is_better",
    });
    expect(unit.status).toBe(422);
    expect(unit.body.error.code).toBe("KPI_METRIC_UNIT_MISMATCH");

    // metric code set exactly when the source is system (contract refine).
    for (const body of [
      {
        name: "Manajer berkode",
        source: "manager",
        metricCode: "void_amount",
        unit: "idr",
      },
      { name: "Sistem tanpa kode", source: "system", unit: "idr" },
      {
        name: "Tenant sendiri",
        source: "manager",
        unit: "poin",
        tenantId: tenantB?.tenantId ?? randomUUID(),
      },
    ])
      expect(
        (await createDefinition({ direction: "higher_is_better", ...body }))
          .status,
        JSON.stringify(body),
      ).toBe(422);
  });

  it("refuses a second active KPI with the same name for the position", async () => {
    const duplicate = await createDefinition({
      name: "Keramahan",
      source: "manager",
      unit: "poin",
      direction: "higher_is_better",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("KPI_DEFINITION_DUPLICATE");
  });

  it("[HR-01] needs hr.kpi.manage held tenant-wide to write; reading needs any KPI or HRIS read code", async () => {
    const body = {
      positionId,
      name: "Oleh manajer outlet",
      source: "manager",
      metricCode: null,
      target: null,
      unit: "poin",
      direction: "higher_is_better",
    };
    expect((await post(mgrJkt, "/api/hris/kpi-definitions", body)).status).toBe(
      403,
    );
    expect(
      (
        await patch(mgrJkt, `/api/hris/kpi-definitions/${defManager}`, {
          target: "90.0000",
        })
      ).status,
    ).toBe(403);
    expect((await post(nobody, "/api/hris/kpi-definitions", body)).status).toBe(
      403,
    );
    expect((await mgrJkt.get("/api/hris/kpi-definitions")).status).toBe(200);
    expect((await hrReader.get("/api/hris/kpi-definitions")).status).toBe(200);
    expect((await nobody.get("/api/hris/kpi-definitions")).status).toBe(403);
  });

  it("updates a definition and keeps the catalog rules on a system KPI", async () => {
    const updated = await patch(
      mgr,
      `/api/hris/kpi-definitions/${defManager}`,
      { target: "90.0000" },
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.target).toBe("90.0000");

    const wrongUnit = await patch(mgr, `/api/hris/kpi-definitions/${defVoid}`, {
      unit: "count",
    });
    expect(wrongUnit.status).toBe(422);
    expect(wrongUnit.body.error.code).toBe("KPI_METRIC_UNIT_MISMATCH");

    const managerCode = await patch(
      mgr,
      `/api/hris/kpi-definitions/${defManager}`,
      { metricCode: "void_amount" },
    );
    expect(managerCode.status).toBe(422);

    expect(
      (
        await patch(mgr, `/api/hris/kpi-definitions/${randomUUID()}`, {
          target: "1.0000",
        })
      ).status,
    ).toBe(404);
  });
});

// ---- reviews ----------------------------------------------------------------

describe("KPI reviews", () => {
  let reviewMarch: Review;
  let engineMarch = 0;

  it("[HR-01] refuses a partial period and an unknown key", async () => {
    for (const body of [
      { cycle: "monthly", periodStart: "2034-03-02" },
      { cycle: "quarterly", periodStart: "2034-02-01" },
    ]) {
      const response = await post(mgr, "/api/hris/kpi-reviews", {
        employeeId: empSubject,
        ...body,
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body.error.code).toBe("KPI_PERIOD_INVALID");
    }
    expect(
      (
        await post(mgr, "/api/hris/kpi-reviews", {
          employeeId: empSubject,
          cycle: "monthly",
          periodStart: "2034-03-01",
          tenantId: randomUUID(),
        })
      ).status,
    ).toBe(422);
  });

  it("copies the position's active KPIs and stores the system actual the metric engine answers", async () => {
    await voidRow(jkt, "2034-03-05", subjectUserId, 150_000);
    await voidRow(jkt, "2034-03-20", subjectUserId, 50_000);
    // Not this employee, and outside the period: neither may count.
    await voidRow(jkt, "2034-03-06", randomUUID(), 999_999);
    await voidRow(jkt, "2034-04-02", subjectUserId, 70_000);

    reviewMarch = await openReview(mgr, empSubject, "2034-03-01");
    expect(reviewMarch).toMatchObject({
      employeeId: empSubject,
      cycle: "monthly",
      periodStart: "2034-03-01",
      periodEnd: "2034-03-31",
      status: "draft",
      reviewerId: null,
      submittedAt: null,
      overallScore: null,
    });
    expect(
      reviewMarch.scores.map((score) => score.kpiDefinitionId).sort(),
    ).toEqual([defManager, defVoid].sort());

    engineMarch = await engineVoid(subjectUserId, "2034-03-01", "2034-03-31");
    expect(engineMarch).toBe(200_000);
    expect(scoreOf(reviewMarch, defVoid)).toMatchObject({
      systemActual: `${engineMarch}.0000`,
      systemAvailability: "available",
      actual: `${engineMarch}.0000`,
      actualSource: "system",
      score: null,
    });
    expect(scoreOf(reviewMarch, defManager)).toMatchObject({
      systemActual: null,
      systemAvailability: null,
      actual: null,
      actualSource: null,
      score: null,
    });
  });

  it("refuses a second review for the same employee and period", async () => {
    const again = await post(mgr, "/api/hris/kpi-reviews", {
      employeeId: empSubject,
      cycle: "monthly",
      periodStart: "2034-03-01",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("KPI_REVIEW_EXISTS");
  });

  it("[HR-01] a manager of another outlet gets 404 and no-permission gets 403", async () => {
    const body = {
      employeeId: empSubject,
      cycle: "quarterly",
      periodStart: "2034-01-01",
    };
    expect((await post(mgrOther, "/api/hris/kpi-reviews", body)).status).toBe(
      404,
    );
    expect(
      (
        await patch(
          mgrOther,
          `/api/hris/kpi-reviews/${reviewMarch.id}/scores`,
          {
            scores: [{ kpiDefinitionId: defManager, score: 50 }],
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (await post(mgrOther, `/api/hris/kpi-reviews/${reviewMarch.id}/submit`))
        .status,
    ).toBe(404);
    expect(
      (
        await post(
          mgrOther,
          `/api/hris/kpi-reviews/${reviewMarch.id}/refresh-actuals`,
        )
      ).status,
    ).toBe(404);
    expect((await post(nobody, "/api/hris/kpi-reviews", body)).status).toBe(
      403,
    );
    // The other outlet's manager manages its own employee.
    expect(
      (
        await post(mgrOther, "/api/hris/kpi-reviews", {
          ...body,
          employeeId: empOther,
        })
      ).status,
    ).toBe(201);
  });

  it("an employee without a login account gets no system actual and may enter one", async () => {
    const review = await openReview(mgrJkt, empNoUser, "2034-03-01");
    expect(scoreOf(review, defVoid)).toMatchObject({
      systemActual: null,
      systemAvailability: "no_user_account",
      actual: null,
      actualSource: null,
    });
    const entered = await patch(
      mgrJkt,
      `/api/hris/kpi-reviews/${review.id}/scores`,
      { scores: [{ kpiDefinitionId: defVoid, actual: "125000.0000" }] },
    );
    expect(entered.status, JSON.stringify(entered.body)).toBe(200);
    expect(scoreOf(entered.body.data, defVoid)).toMatchObject({
      actual: "125000.0000",
      actualSource: "manual",
      systemActual: null,
    });
  });

  it("refuses a manual actual over an available system actual, and unknown KPIs", async () => {
    const override = await patch(
      mgr,
      `/api/hris/kpi-reviews/${reviewMarch.id}/scores`,
      { scores: [{ kpiDefinitionId: defVoid, actual: "1.0000" }] },
    );
    expect(override.status).toBe(422);
    expect(override.body.error.code).toBe("KPI_ACTUAL_SYSTEM");

    const unknown = await patch(
      mgr,
      `/api/hris/kpi-reviews/${reviewMarch.id}/scores`,
      { scores: [{ kpiDefinitionId: randomUUID(), score: 10 }] },
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("KPI_SCORE_UNKNOWN");

    for (const scores of [
      [{ kpiDefinitionId: defManager, score: 101 }],
      [{ kpiDefinitionId: defManager }],
      [
        { kpiDefinitionId: defManager, score: 1 },
        { kpiDefinitionId: defManager, score: 2 },
      ],
    ])
      expect(
        (
          await patch(mgr, `/api/hris/kpi-reviews/${reviewMarch.id}/scores`, {
            scores,
          })
        ).status,
        JSON.stringify(scores),
      ).toBe(422);
  });

  it("records scores, comments and the note on a draft", async () => {
    const updated = await patch(
      mgr,
      `/api/hris/kpi-reviews/${reviewMarch.id}/scores`,
      {
        scores: [
          { kpiDefinitionId: defManager, score: 90, comment: "Ramah" },
          { kpiDefinitionId: defVoid, score: 70 },
        ],
        note: "Bulan yang baik",
      },
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const review = updated.body.data as Review;
    expect(review.note).toBe("Bulan yang baik");
    expect(scoreOf(review, defManager)).toMatchObject({
      score: 90,
      comment: "Ramah",
    });
    expect(scoreOf(review, defVoid)).toMatchObject({
      score: 70,
      actualSource: "system",
    });
    expect(review.status).toBe("draft");
    expect(review.overallScore).toBeNull();
  });

  it("refresh recomputes the system actual through the engine", async () => {
    await voidRow(jkt, "2034-03-25", subjectUserId, 30_000);
    const refreshed = await post(
      mgr,
      `/api/hris/kpi-reviews/${reviewMarch.id}/refresh-actuals`,
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    engineMarch = await engineVoid(subjectUserId, "2034-03-01", "2034-03-31");
    expect(engineMarch).toBe(230_000);
    expect(scoreOf(refreshed.body.data, defVoid)).toMatchObject({
      systemActual: `${engineMarch}.0000`,
      actual: `${engineMarch}.0000`,
      actualSource: "system",
      score: 70,
    });
  });

  it("a draft is visible to managers only; a submitted review also to HRIS readers and the employee", async () => {
    const draftApril = await openReview(mgr, empSubject, "2034-04-01");
    const idsOf = async (client: Client) => {
      const response = await client.get(
        `/api/hris/kpi-reviews?employeeId=${empSubject}&limit=50`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body.data as Review[]).map((row) => row.id);
    };
    // Draft: managers see it; the employee and the reader do not.
    expect(await idsOf(mgr)).toEqual(
      expect.arrayContaining([reviewMarch.id, draftApril.id]),
    );
    expect(await idsOf(subject)).toEqual([]);
    expect(await idsOf(hrReader)).toEqual([]);
    // A caller with no KPI, HRIS or own employee row has no right at all.
    expect((await nobody.get("/api/hris/kpi-reviews")).status).toBe(403);
    // A manager of another outlet does not see this outlet's reviews.
    expect(await idsOf(mgrOther)).toEqual([]);
  });

  it("submit needs a score on every KPI", async () => {
    const draft = await openReview(mgr, empSubject, "2034-05-01");
    const incomplete = await post(
      mgr,
      `/api/hris/kpi-reviews/${draft.id}/submit`,
    );
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.code).toBe("KPI_SCORES_INCOMPLETE");
    const partial = await patch(
      mgr,
      `/api/hris/kpi-reviews/${draft.id}/scores`,
      {
        scores: [{ kpiDefinitionId: defManager, score: 60 }],
      },
    );
    expect(partial.status).toBe(200);
    expect(
      (await post(mgr, `/api/hris/kpi-reviews/${draft.id}/submit`)).status,
    ).toBe(422);
  });

  it("[HR-01] the reviewer cannot be the subject's own account", async () => {
    const own = await openReview(selfMgr, empSelf, "2034-03-01");
    const scored = await patch(
      selfMgr,
      `/api/hris/kpi-reviews/${own.id}/scores`,
      {
        scores: [
          { kpiDefinitionId: defManager, score: 100 },
          { kpiDefinitionId: defVoid, score: 100 },
        ],
      },
    );
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);
    const refused = await post(
      selfMgr,
      `/api/hris/kpi-reviews/${own.id}/submit`,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("KPI_SELF_REVIEW");
    // Another manager may submit it.
    const submitted = await post(mgr, `/api/hris/kpi-reviews/${own.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.reviewerId).toBe(mgrUserId);
  });

  it("submit freezes the review and sets the overall score", async () => {
    const submitted = await post(
      mgr,
      `/api/hris/kpi-reviews/${reviewMarch.id}/submit`,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const review = submitted.body.data as Review;
    expect(review).toMatchObject({
      status: "submitted",
      reviewerId: mgrUserId,
      overallScore: 80,
    });
    expect(review.submittedAt).toEqual(expect.any(String));
    const frozen = scoreOf(review, defVoid).systemActual;

    // Frozen: new data, refresh, scores and a second submit change nothing.
    await voidRow(jkt, "2034-03-28", subjectUserId, 11_000);
    for (const response of [
      await post(
        mgr,
        `/api/hris/kpi-reviews/${reviewMarch.id}/refresh-actuals`,
      ),
      await patch(mgr, `/api/hris/kpi-reviews/${reviewMarch.id}/scores`, {
        scores: [{ kpiDefinitionId: defManager, score: 10 }],
      }),
      await post(mgr, `/api/hris/kpi-reviews/${reviewMarch.id}/submit`),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("KPI_REVIEW_SUBMITTED");
    }
    const read = await mgr.get(
      `/api/hris/kpi-reviews?reviewId=${reviewMarch.id}`,
    );
    const stored = (read.body.data as Review[])[0]!;
    expect(scoreOf(stored, defVoid).systemActual).toBe(frozen);
    expect(stored.overallScore).toBe(80);
  });

  it("the employee and an HRIS reader see the submitted review, not the draft", async () => {
    for (const client of [subject, hrReader]) {
      const response = await client.get(
        `/api/hris/kpi-reviews?employeeId=${empSubject}&limit=50`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const rows = response.body.data as Review[];
      expect(rows.map((row) => row.id)).toContain(reviewMarch.id);
      expect(rows.every((row) => row.status === "submitted")).toBe(true);
    }
    // The employee cannot read someone else's submitted review.
    const others = await subject.get(
      `/api/hris/kpi-reviews?employeeId=${empSelf}&limit=50`,
    );
    expect(others.status).toBe(200);
    expect(others.body.data).toEqual([]);
  });

  it("[TEN-01] another tenant's employee, reviews and definitions are out of reach", async () => {
    tenantB = await createSecondTenant(owner, "kpi");
    const bPosition = randomUUID();
    const bEmployee = randomUUID();
    const bDefinition = randomUUID();
    const bReview = randomUUID();
    await owner.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, 'Kasir B')",
      [bPosition, tenantB.tenantId],
    );
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              position_id, employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        bEmployee,
        tenantB.tenantId,
        `TB-${bEmployee.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
        bPosition,
      ],
    );
    await owner.query(
      `INSERT INTO hris_kpi_definitions (id, tenant_id, position_id, name, source, unit, direction, created_by)
       VALUES ($1, $2, $3, 'KPI B', 'manager', 'poin', 'higher_is_better', $4)`,
      [bDefinition, tenantB.tenantId, bPosition, randomUUID()],
    );
    await owner.query(
      `INSERT INTO hris_kpi_reviews (id, tenant_id, employee_id, cycle, period_start, period_end, status, created_by)
       VALUES ($1, $2, $3, 'monthly', '2034-03-01', '2034-03-31', 'draft', $4)`,
      [bReview, tenantB.tenantId, bEmployee, randomUUID()],
    );

    // Controls: tenant A's own review reads fine.
    expect(
      (await mgr.get(`/api/hris/kpi-reviews?reviewId=${reviewMarch.id}`)).body
        .data,
    ).toHaveLength(1);

    expect(
      (
        await post(mgr, "/api/hris/kpi-reviews", {
          employeeId: bEmployee,
          cycle: "monthly",
          periodStart: "2034-06-01",
        })
      ).status,
    ).toBe(404);
    for (const response of [
      await patch(mgr, `/api/hris/kpi-reviews/${bReview}/scores`, {
        scores: [{ kpiDefinitionId: bDefinition, score: 10 }],
      }),
      await post(mgr, `/api/hris/kpi-reviews/${bReview}/submit`),
      await post(mgr, `/api/hris/kpi-reviews/${bReview}/refresh-actuals`),
      await patch(mgr, `/api/hris/kpi-definitions/${bDefinition}`, {
        target: "1.0000",
      }),
    ])
      expect(response.status).toBe(404);
    expect(
      (await mgr.get(`/api/hris/kpi-reviews?reviewId=${bReview}`)).body.data,
    ).toEqual([]);
    expect(
      (
        (await mgr.get("/api/hris/kpi-definitions?limit=100")).body.data as {
          id: string;
        }[]
      ).map((row) => row.id),
    ).not.toContain(bDefinition);

    // Row level security: tenant B sees none of tenant A's KPI rows.
    for (const [table, rowId] of [
      ["hris_kpi_reviews", reviewMarch.id],
      ["hris_kpi_definitions", defManager],
    ] as const) {
      const asA = await asRlsTenant(appPool, tenant.id, (client) =>
        client.query(`SELECT id FROM ${table} WHERE id = $1`, [rowId]),
      );
      expect(asA.rowCount, `${table} visible to its tenant`).toBe(1);
      const asB = await asRlsTenant(
        appPool,
        tenantB!.tenantId,
        async (client) => {
          const seen = await client.query(
            `SELECT id FROM ${table} WHERE id = $1`,
            [rowId],
          );
          const deleted = await client.query(
            `DELETE FROM ${table} WHERE id = $1`,
            [rowId],
          );
          return [seen.rowCount, deleted.rowCount];
        },
      );
      expect(asB, `${table} hidden from another tenant`).toEqual([0, 0]);
    }
  });
});
