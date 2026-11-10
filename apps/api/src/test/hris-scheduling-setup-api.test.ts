// Shift scheduling setup over HTTP: shift templates and working-time
// compliance policy (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", F26, HR-05;
// TEN-01/02/03; bead legend-jstx, slice T1). Runs the real Express app, Better
// Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant,
// plus a throwaway second tenant for cross-tenant isolation of every new table.
//
// Assumptions (the spec leaves these open):
//  - Create answers 201, update/PUT/GET answer 200. A body with an unknown key
//    or a client-sent tenantId is answered 422, as for every HRIS route; a
//    request without the Origin header is answered 403.
//  - Template times are "HH:MM"; a duplicate template name in one outlet is 409
//    (the schema has a unique name per outlet); the same name in another outlet
//    is allowed.
//  - A template/policy endpoint addressing an outlet outside the caller's scope
//    (or in another tenant) answers 404, never 403, so existence is not leaked.
//  - Writing the tenant-wide default policy (outletId null) needs tenant scope;
//    an outlet-scoped manager is refused with 403 or 404.
//  - Reading templates without `outletId` returns the templates of every outlet
//    the caller can manage, and nothing else.
//  - A request resolves to the seeded Cafe Legend tenant (as in the other
//    isolation suites), so the throwaway tenant B is driven through the
//    scheduling services with a context minted for tenant B only; tenant A is
//    always driven over HTTP.
//  - Reads by an employee without `hr.schedule.manage` are not asserted (the
//    spec only names who may manage); only the writes are checked as 403.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  createShiftTemplate,
  getShiftCompliancePolicy,
  listShiftTemplates,
  updateShiftTemplate,
} from "../services/hris-scheduling-setup.service.ts";
import { listShiftAssignments } from "../services/hris-scheduling-roster.service.ts";
import { listShiftSwapRequests } from "../services/hris-scheduling-swap.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  asTenant as asAppTenant,
  createAppPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = createAppPool();
const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdEmployees: { tenantId: string; id: string }[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let tenantB: SecondTenant;

const DEFAULT_LIMITS = {
  maxShiftMinutes: 600,
  maxDailyMinutes: 720,
  maxWeeklyMinutes: 2700,
  minRestMinutesBetweenShifts: 660,
  maxConsecutiveWorkDays: 6,
};

async function ownerTx<T>(
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
    await client.query("ROLLBACK").catch(() => undefined);
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

async function grantCustomRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push({ tenantId, id: roleId });
  await ownerTx(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Jadwal API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

async function seedEmployee(tenantId: string, outletId: string) {
  const id = randomUUID();
  createdEmployees.push({ tenantId, id });
  await ownerTx(tenantId, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Jadwal API', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenantId, `SCH-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let managerAll: Client;
let managerAllUserId: string;
let managerOutletA: Client;
let staff: Client;
let ctxB: ScopedTenantContext;
let managerBUserId: string;

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const patch = (client: Client, path: string, body: unknown) =>
  client
    .patch(path)
    .set(originHeader)
    .send(body as object);
const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

const uniqueName = (label: string) =>
  `APITEST ${label} ${randomUUID().slice(0, 8)}`;
const SINGLE = [{ startTime: "07:00", endTime: "15:00" }];
const SPLIT = [
  { startTime: "10:00", endTime: "14:00" },
  { startTime: "17:00", endTime: "21:00" },
];
const NIGHT = [{ startTime: "22:00", endTime: "06:00" }];

function templateBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outlet.id,
    name: uniqueName("Template"),
    segments: SINGLE,
    breakMinutes: 30,
    stationId: null,
    positionId: null,
    ...overrides,
  };
}

function policyBody(overrides: Record<string, unknown> = {}) {
  return { outletId: null, ...DEFAULT_LIMITS, ...overrides };
}

async function listAll(client: Client, path: string) {
  const seen: { id: string }[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    seen.push(...(page.body.data as { id: string }[]));
    cursor = page.body.meta.nextCursor as string | null;
  } while (cursor);
  return seen;
}

async function auditCount(): Promise<number> {
  const { rows } = await owner.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'hris.shift_policy.updated'",
    [tenant.id],
  );
  return rows[0].n;
}

async function policyAuditRows(): Promise<
  { outlet_id: string | null; event: Record<string, unknown> }[]
> {
  const { rows } = await owner.query(
    "SELECT outlet_id, event FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'hris.shift_policy.updated' ORDER BY created_at, id",
    [tenant.id],
  );
  return rows;
}

async function clearPolicies(tenantId: string) {
  await ownerTx(tenantId, (db) =>
    db.query("DELETE FROM shift_compliance_policies WHERE tenant_id = $1", [
      tenantId,
    ]),
  );
}

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "sched");
  savedPolicies = (
    await owner.query(
      "SELECT * FROM shift_compliance_policies WHERE tenant_id = $1",
      [tenant.id],
    )
  ).rows;

  const all = await signedInClient("Manajer Jadwal Semua");
  await grantCustomRole(
    tenant.id,
    all.userId,
    ["hr.schedule.manage", "hr.employee.view"],
    { type: "tenant" },
  );
  managerAll = all.client;
  managerAllUserId = all.userId;

  const scoped = await signedInClient("Manajer Jadwal Outlet");
  await grantCustomRole(
    tenant.id,
    scoped.userId,
    ["hr.schedule.manage", "hr.employee.view"],
    { type: "outlet", id: outlet.id },
  );
  managerOutletA = scoped.client;

  const plain = await signedInClient("Staf Jadwal");
  await grantCustomRole(
    tenant.id,
    plain.userId,
    ["self.profile.view", "self.schedule.view"],
    { type: "outlet", id: outlet.id },
  );
  staff = plain.client;

  const other = await signedInClient("Manajer Jadwal Tenant B");
  await grantCustomRole(
    tenantB.tenantId,
    other.userId,
    ["hr.schedule.manage", "hr.employee.view"],
    { type: "tenant" },
  );
  ctxB = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantB.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  managerBUserId = other.userId;
}, 60_000);

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    const tenantBId = tenantB?.tenantId ?? randomUUID();
    for (const tenantId of [tenant.id, tenantBId])
      await step(() =>
        ownerTx(tenantId, async (db) => {
          const employees = createdEmployees
            .filter((row) => row.tenantId === tenantId)
            .map((row) => row.id);
          await db.query(
            "DELETE FROM shift_swap_requests WHERE tenant_id = $1 AND requested_by_user_id = ANY($2::text[])",
            [tenantId, createdUsers],
          );
          await db.query(
            "DELETE FROM shift_swap_requests WHERE tenant_id = $1 AND requested_by = ANY($2::uuid[])",
            [tenantId, employees],
          );
          await db.query(
            "DELETE FROM roster_publications WHERE tenant_id = $1 AND published_by = ANY($2::text[])",
            [tenantId, createdUsers],
          );
          await db.query(
            "DELETE FROM shift_assignments WHERE tenant_id = $1 AND (created_by = ANY($2::text[]) OR employee_id = ANY($3::uuid[]))",
            [tenantId, createdUsers, employees],
          );
          await db.query(
            "DELETE FROM shift_templates WHERE tenant_id = $1 AND created_by = ANY($2::text[])",
            [tenantId, createdUsers],
          );
          await db.query(
            "DELETE FROM shift_compliance_policies WHERE tenant_id = $1",
            [tenantId],
          );
        }),
      );
    await step(() =>
      ownerTx(tenant.id, async (db) => {
        for (const row of savedPolicies)
          await db.query(
            `INSERT INTO shift_compliance_policies
               (id, tenant_id, outlet_id, max_shift_minutes, max_daily_minutes,
                max_weekly_minutes, min_rest_minutes_between_shifts,
                max_consecutive_work_days, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              row.id,
              row.tenant_id,
              row.outlet_id,
              row.max_shift_minutes,
              row.max_daily_minutes,
              row.max_weekly_minutes,
              row.min_rest_minutes_between_shifts,
              row.max_consecutive_work_days,
              row.updated_by,
              row.updated_at,
            ],
          );
      }),
    );
    await step(async () => {
      // Audit rows are append-only; replica mode lets the owner remove ours.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
          tenantBId,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
    for (const employee of createdEmployees)
      await step(() =>
        ownerTx(employee.tenantId, (db) =>
          db.query("DELETE FROM employees WHERE tenant_id = $1 AND id = $2", [
            employee.tenantId,
            employee.id,
          ]),
        ),
      );
    for (const role of createdRoles)
      await step(() =>
        ownerTx(role.tenantId, async (db) => {
          await db.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
            [role.tenantId, role.id],
          );
          await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [
            role.tenantId,
            role.id,
          ]);
        }),
      );
    if (tenantB) await step(() => removeSecondTenant(owner, tenantB));
    if (createdUsers.length > 0)
      await step(() =>
        owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
          createdUsers,
        ]),
      );
  } finally {
    await step(() => owner.end());
    await step(() => appPool.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

describe("shift templates", () => {
  it("[F26 Template shift] a manager creates a single-segment template and sees it listed", async () => {
    const body = templateBody();
    const created = await post(managerAll, "/api/hris/shift-templates", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: outlet.id,
      name: body.name,
      segments: SINGLE,
      breakMinutes: 30,
      stationId: null,
      positionId: null,
      isActive: true,
    });
    const id = created.body.data.id as string;

    const list = await listAll(
      managerAll,
      `/api/hris/shift-templates?outletId=${outlet.id}`,
    );
    expect(list.map((row) => row.id)).toContain(id);
  });

  it("[F26 Template shift] a split shift keeps both segments in order", async () => {
    const created = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({
        name: uniqueName("Split"),
        segments: SPLIT,
        breakMinutes: 60,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.segments).toEqual(SPLIT);
    expect(created.body.data.breakMinutes).toBe(60);
  });

  it("[F26 Template shift] a night template may cross midnight and keeps its times", async () => {
    const created = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({ name: uniqueName("Malam"), segments: NIGHT }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.segments).toEqual(NIGHT);
  });

  it("[F26 Template shift] invalid templates are refused with 422", async () => {
    const refused = async (overrides: Record<string, unknown>) =>
      (
        await post(
          managerAll,
          "/api/hris/shift-templates",
          templateBody({ name: uniqueName("Buruk"), ...overrides }),
        )
      ).status;
    // Overlapping split segments.
    expect(
      await refused({
        segments: [
          { startTime: "08:00", endTime: "13:00" },
          { startTime: "12:00", endTime: "18:00" },
        ],
      }),
    ).toBe(422);
    // Only a single segment may cross midnight.
    expect(
      await refused({
        segments: [
          { startTime: "08:00", endTime: "12:00" },
          { startTime: "20:00", endTime: "02:00" },
        ],
      }),
    ).toBe(422);
    // Zero duration, no segment, three segments, break out of range.
    expect(
      await refused({ segments: [{ startTime: "08:00", endTime: "08:00" }] }),
    ).toBe(422);
    expect(await refused({ segments: [] })).toBe(422);
    expect(
      await refused({
        segments: [
          { startTime: "06:00", endTime: "08:00" },
          { startTime: "09:00", endTime: "11:00" },
          { startTime: "12:00", endTime: "14:00" },
        ],
      }),
    ).toBe(422);
    expect(await refused({ breakMinutes: 241 })).toBe(422);
    expect(await refused({ breakMinutes: -1 })).toBe(422);
    expect(await refused({ name: "" })).toBe(422);
    expect(
      await refused({ segments: [{ startTime: "25:00", endTime: "08:00" }] }),
    ).toBe(422);
  });

  it("[TEN-02] a template body with a tenantId or an unknown field is refused (422) and a missing Origin is 403", async () => {
    expect(
      (
        await post(
          managerAll,
          "/api/hris/shift-templates",
          templateBody({ tenantId: tenant.id }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          managerAll,
          "/api/hris/shift-templates",
          templateBody({ extra: 1 }),
        )
      ).status,
    ).toBe(422);
    const noOrigin = await managerAll
      .post("/api/hris/shift-templates")
      .send(templateBody());
    expect(noOrigin.status).toBe(403);
  });

  it("[F26 Template shift] a duplicate name in the same outlet is 409; the same name in another outlet is allowed", async () => {
    const body = templateBody({ name: uniqueName("Kembar") });
    expect(
      (await post(managerAll, "/api/hris/shift-templates", body)).status,
    ).toBe(201);
    expect(
      (await post(managerAll, "/api/hris/shift-templates", body)).status,
    ).toBe(409);
    const elsewhere = await post(managerAll, "/api/hris/shift-templates", {
      ...body,
      outletId: secondOutlet.id,
    });
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
    expect(elsewhere.body.data.outletId).toBe(secondOutlet.id);
  });

  it("[F26 Template shift] a manager renames, reschedules and deactivates a template; inactive ones are hidden unless requested", async () => {
    const created = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({ name: uniqueName("Ubah") }),
    );
    const id = created.body.data.id as string;
    const url = `/api/hris/shift-templates/${id}`;

    const renamed = await patch(managerAll, url, {
      name: uniqueName("Diubah"),
      segments: SPLIT,
      breakMinutes: 45,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({
      id,
      segments: SPLIT,
      breakMinutes: 45,
      isActive: true,
    });

    const off = await patch(managerAll, url, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const hidden = await listAll(
      managerAll,
      `/api/hris/shift-templates?outletId=${outlet.id}`,
    );
    expect(hidden.map((row) => row.id)).not.toContain(id);
    const shown = await listAll(
      managerAll,
      `/api/hris/shift-templates?outletId=${outlet.id}&includeInactive=true`,
    );
    expect(shown.map((row) => row.id)).toContain(id);

    const on = await patch(managerAll, url, { isActive: true });
    expect(on.body.data.isActive).toBe(true);
  });

  it("[F26 Template shift] an empty update, an invalid change or an unknown template is refused", async () => {
    const created = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({ name: uniqueName("Tolak") }),
    );
    const url = `/api/hris/shift-templates/${created.body.data.id}`;
    expect((await patch(managerAll, url, {})).status).toBe(422);
    expect((await patch(managerAll, url, { breakMinutes: 999 })).status).toBe(
      422,
    );
    expect(
      (await patch(managerAll, url, { tenantId: tenant.id, name: "x" })).status,
    ).toBe(422);
    expect(
      (
        await patch(managerAll, `/api/hris/shift-templates/${randomUUID()}`, {
          name: "Tidak ada",
        })
      ).status,
    ).toBe(404);
  });

  it("[F26 Template shift] an outlet with no templates lists an empty page", async () => {
    const empty = await listShiftTemplates(ctxB, managerBUserId, {
      outletId: tenantB.outletId,
      limit: 100,
    } as never);
    expect(empty.data).toEqual([]);
  });

  it("[F26 Template shift] an employee without schedule management cannot create or change a template (403); anonymous callers get 401", async () => {
    const created = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({ name: uniqueName("Dilindungi") }),
    );
    const id = created.body.data.id as string;
    expect(
      (await post(staff, "/api/hris/shift-templates", templateBody())).status,
    ).toBe(403);
    expect(
      (
        await patch(staff, `/api/hris/shift-templates/${id}`, {
          name: "Diretas",
        })
      ).status,
    ).toBe(403);
    const after = await listAll(
      managerAll,
      `/api/hris/shift-templates?outletId=${outlet.id}`,
    );
    expect(after.map((row) => row.id)).toContain(id);

    const anonymous = agent(app);
    expect((await anonymous.get("/api/hris/shift-templates")).status).toBe(401);
    expect(
      (await anonymous.get("/api/hris/shift-compliance-policy")).status,
    ).toBe(401);
  });

  it("[TEN-03] an outlet-scoped manager manages its own outlet and gets 404 for another outlet", async () => {
    const own = await post(
      managerOutletA,
      "/api/hris/shift-templates",
      templateBody({ name: uniqueName("Outlet sendiri") }),
    );
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const foreign = await post(
      managerAll,
      "/api/hris/shift-templates",
      templateBody({
        outletId: secondOutlet.id,
        name: uniqueName("Outlet lain"),
      }),
    );
    expect(foreign.status).toBe(201);
    const foreignId = foreign.body.data.id as string;

    expect(
      (
        await post(
          managerOutletA,
          "/api/hris/shift-templates",
          templateBody({
            outletId: secondOutlet.id,
            name: uniqueName("Tembus"),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(managerOutletA, `/api/hris/shift-templates/${foreignId}`, {
          name: "Diretas",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await managerOutletA.get(
          `/api/hris/shift-templates?outletId=${secondOutlet.id}`,
        )
      ).status,
    ).toBe(404);

    // Without a filter the scoped manager sees its own outlet only.
    const visible = await listAll(
      managerOutletA,
      "/api/hris/shift-templates?includeInactive=true",
    );
    expect(visible.map((row) => row.id)).toContain(own.body.data.id);
    expect(visible.map((row) => row.id)).not.toContain(foreignId);
  });
});

describe("shift compliance policy", () => {
  it("[HR-05 Kebijakan] without any row the effective policy is the default", async () => {
    await clearPolicies(tenant.id);
    const view = await managerAll.get("/api/hris/shift-compliance-policy");
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: null,
      source: "default",
      ...DEFAULT_LIMITS,
    });
    const forOutlet = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(forOutlet.body.data.source).toBe("default");
  });

  it("[HR-05 Kebijakan] a tenant policy applies to every outlet without its own policy", async () => {
    await clearPolicies(tenant.id);
    const saved = await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({ maxShiftMinutes: 540, maxDailyMinutes: 600 }),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const view = await managerAll.get("/api/hris/shift-compliance-policy");
    expect(view.body.data).toMatchObject({
      outletId: null,
      source: "tenant",
      maxShiftMinutes: 540,
      maxDailyMinutes: 600,
    });
    const forOutlet = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(forOutlet.body.data).toMatchObject({
      source: "tenant",
      maxShiftMinutes: 540,
    });
  });

  it("[HR-05 Kebijakan] an outlet policy overrides the tenant policy for that outlet only, and a second save replaces it", async () => {
    await clearPolicies(tenant.id);
    await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({ maxShiftMinutes: 540, maxDailyMinutes: 600 }),
    );
    const first = await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({
        outletId: outlet.id,
        maxShiftMinutes: 480,
        maxDailyMinutes: 540,
        maxWeeklyMinutes: 2400,
        minRestMinutesBetweenShifts: 720,
        maxConsecutiveWorkDays: 5,
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const own = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(own.body.data).toMatchObject({
      outletId: outlet.id,
      source: "outlet",
      maxShiftMinutes: 480,
      maxDailyMinutes: 540,
      maxWeeklyMinutes: 2400,
      minRestMinutesBetweenShifts: 720,
      maxConsecutiveWorkDays: 5,
    });
    const other = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${secondOutlet.id}`,
    );
    expect(other.body.data).toMatchObject({
      source: "tenant",
      maxShiftMinutes: 540,
    });

    const second = await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({ outletId: outlet.id, maxShiftMinutes: 420 }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const again = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(again.body.data).toMatchObject({
      source: "outlet",
      maxShiftMinutes: 420,
      maxDailyMinutes: DEFAULT_LIMITS.maxDailyMinutes,
    });
  });

  it("[HR-05 Kebijakan] inconsistent or out-of-range limits are refused with 422 and change nothing", async () => {
    await clearPolicies(tenant.id);
    const refused = async (overrides: Record<string, unknown>) =>
      (
        await put(
          managerAll,
          "/api/hris/shift-compliance-policy",
          policyBody(overrides),
        )
      ).status;
    // The daily limit cannot be lower than one shift; the weekly limit cannot
    // be lower than one day.
    expect(await refused({ maxShiftMinutes: 600, maxDailyMinutes: 500 })).toBe(
      422,
    );
    expect(await refused({ maxDailyMinutes: 720, maxWeeklyMinutes: 600 })).toBe(
      422,
    );
    expect(await refused({ maxShiftMinutes: 59 })).toBe(422);
    expect(await refused({ maxConsecutiveWorkDays: 0 })).toBe(422);
    expect(await refused({ maxConsecutiveWorkDays: 32 })).toBe(422);
    expect(await refused({ minRestMinutesBetweenShifts: -1 })).toBe(422);
    expect(await refused({ tenantId: tenant.id })).toBe(422);
    expect(await refused({ extra: true })).toBe(422);

    const view = await managerAll.get("/api/hris/shift-compliance-policy");
    expect(view.body.data.source).toBe("default");
  });

  it("[HR-05 Kebijakan] an employee cannot change the policy (403)", async () => {
    await clearPolicies(tenant.id);
    const denied = await put(
      staff,
      "/api/hris/shift-compliance-policy",
      policyBody({ maxShiftMinutes: 300, maxDailyMinutes: 360 }),
    );
    expect(denied.status).toBe(403);
    const view = await managerAll.get("/api/hris/shift-compliance-policy");
    expect(view.body.data.source).toBe("default");
  });

  it("[TEN-03] an outlet-scoped manager reads its own outlet policy but cannot change any policy (403)", async () => {
    await clearPolicies(tenant.id);
    const before = await auditCount();
    for (const outletId of [outlet.id, secondOutlet.id, null]) {
      const denied = await put(
        managerOutletA,
        "/api/hris/shift-compliance-policy",
        policyBody({ outletId, maxShiftMinutes: 500 }),
      );
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    }
    expect(await auditCount()).toBe(before);

    // Reading the effective policy stays allowed within the outlet reach.
    const view = await managerOutletA.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data.source).toBe("default");
    expect(
      (
        await managerOutletA.get(
          `/api/hris/shift-compliance-policy?outletId=${secondOutlet.id}`,
        )
      ).status,
    ).toBe(404);
    // Nothing was written.
    const other = await managerAll.get(
      `/api/hris/shift-compliance-policy?outletId=${outlet.id}`,
    );
    expect(other.body.data.source).toBe("default");
  });

  it("[HR-05 Audit] a tenant-wide holder changing the policy is audited with outlet id and limits only", async () => {
    await clearPolicies(tenant.id);
    const before = await auditCount();
    const tenantRow = await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({ maxShiftMinutes: 540, maxDailyMinutes: 600 }),
    );
    expect(tenantRow.status, JSON.stringify(tenantRow.body)).toBe(200);
    const outletRow = await put(
      managerAll,
      "/api/hris/shift-compliance-policy",
      policyBody({ outletId: outlet.id, maxShiftMinutes: 500 }),
    );
    expect(outletRow.status, JSON.stringify(outletRow.body)).toBe(200);

    const rows = (await policyAuditRows()).slice(before);
    expect(rows).toHaveLength(2);
    const tenantAudit = rows.find((row) => row.outlet_id === null);
    const outletAudit = rows.find((row) => row.outlet_id === outlet.id);
    expect(tenantAudit?.event).toMatchObject({
      action: "hris.shift_policy.updated",
      objectType: "shift_compliance_policy",
      actorId: managerAllUserId,
      maskedChanges: {
        before: null,
        after: { maxShiftMinutes: 540, maxDailyMinutes: 600 },
      },
    });
    expect(outletAudit?.event).toMatchObject({
      action: "hris.shift_policy.updated",
      actorId: managerAllUserId,
      maskedChanges: { before: null, after: { maxShiftMinutes: 500 } },
    });
    expect(JSON.stringify(rows.map((row) => row.event))).not.toMatch(
      /name|email|phone/i,
    );
  });
});

describe("scheduling setup tenant isolation", () => {
  type Seed = {
    employeeId: string;
    otherEmployeeId: string;
    templateId: string;
    assignmentId: string;
    publicationId: string;
    swapId: string;
    policyId: string;
  };
  let seedA: Seed;
  let seedB: Seed;

  async function seedSide(
    tenantId: string,
    outletId: string,
    actorUserId: string,
    maxShiftMinutes: number,
  ): Promise<Seed> {
    const employeeId = await seedEmployee(tenantId, outletId);
    const otherEmployeeId = await seedEmployee(tenantId, outletId);
    const seed: Seed = {
      employeeId,
      otherEmployeeId,
      templateId: randomUUID(),
      assignmentId: randomUUID(),
      publicationId: randomUUID(),
      swapId: randomUUID(),
      policyId: randomUUID(),
    };
    await ownerTx(tenantId, async (db) => {
      await db.query(
        `INSERT INTO shift_templates (id, tenant_id, outlet_id, name, segments, break_minutes, created_by)
         VALUES ($1, $2, $3, $4, $5, 30, $6)`,
        [
          seed.templateId,
          tenantId,
          outletId,
          uniqueName("Isolasi"),
          JSON.stringify(SINGLE),
          actorUserId,
        ],
      );
      await db.query(
        `INSERT INTO shift_assignments
           (id, tenant_id, outlet_id, employee_id, shift_template_id, business_date,
            segments, break_minutes, status, published_by, published_at, created_by)
         VALUES ($1, $2, $3, $4, $5, '2033-03-07', $6, 30, 'published', $7, now(), $7)`,
        [
          seed.assignmentId,
          tenantId,
          outletId,
          employeeId,
          seed.templateId,
          JSON.stringify([
            {
              startsAt: "2033-03-07T00:00:00.000Z",
              endsAt: "2033-03-07T08:00:00.000Z",
            },
          ]),
          actorUserId,
        ],
      );
      await db.query(
        `INSERT INTO roster_publications
           (id, tenant_id, outlet_id, week_start, idempotency_key, assignment_count,
            assignment_ids, snapshot, published_by)
         VALUES ($1, $2, $3, '2033-03-07', $4, 1, ARRAY[$5]::uuid[], '[]'::jsonb, $6)`,
        [
          seed.publicationId,
          tenantId,
          outletId,
          `sched-iso-${randomUUID()}`,
          seed.assignmentId,
          actorUserId,
        ],
      );
      await db.query(
        `INSERT INTO shift_swap_requests
           (id, tenant_id, outlet_id, from_assignment_id, requested_by, to_employee_id,
            requested_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          seed.swapId,
          tenantId,
          outletId,
          seed.assignmentId,
          employeeId,
          otherEmployeeId,
          actorUserId,
        ],
      );
      await db.query(
        `INSERT INTO shift_compliance_policies
           (id, tenant_id, outlet_id, max_shift_minutes, updated_by)
         VALUES ($1, $2, NULL, $3, $4)`,
        [seed.policyId, tenantId, maxShiftMinutes, actorUserId],
      );
    });
    return seed;
  }

  beforeAll(async () => {
    await clearPolicies(tenant.id);
    seedA = await seedSide(tenant.id, outlet.id, managerAllUserId, 480);
    seedB = await seedSide(
      tenantB.tenantId,
      tenantB.outletId,
      managerBUserId,
      540,
    );
  }, 60_000);

  const tables = (): {
    table: string;
    updateSet: string;
    a: string;
    b: string;
  }[] => [
    {
      table: "shift_templates",
      updateSet: "break_minutes = break_minutes",
      a: seedA.templateId,
      b: seedB.templateId,
    },
    {
      table: "shift_assignments",
      updateSet: "break_minutes = break_minutes",
      a: seedA.assignmentId,
      b: seedB.assignmentId,
    },
    {
      table: "roster_publications",
      updateSet: "assignment_count = assignment_count",
      a: seedA.publicationId,
      b: seedB.publicationId,
    },
    {
      table: "shift_swap_requests",
      updateSet: "status = status",
      a: seedA.swapId,
      b: seedB.swapId,
    },
    {
      table: "shift_compliance_policies",
      updateSet: "max_shift_minutes = max_shift_minutes",
      a: seedA.policyId,
      b: seedB.policyId,
    },
  ];

  it("[TEN-01] RLS isolates every scheduling table for legend_app", async () => {
    for (const spec of tables())
      await expectRowsIsolated(
        appPool,
        {
          table: spec.table,
          updateSet: spec.updateSet,
          tenantA: { tenantId: tenant.id, rowId: spec.a },
          tenantB: { tenantId: tenantB.tenantId, rowId: spec.b },
        },
        owner,
      );
  });

  it("[TEN-03] outlet RLS hides another outlet's scheduling rows from a connection limited to a different outlet", async () => {
    const outletTables = tables().filter(
      (spec) => spec.table !== "shift_compliance_policies",
    );
    for (const spec of outletTables) {
      const count = (outletIds: string[]) =>
        asAppTenant(
          appPool,
          tenant.id,
          async (client) =>
            (
              await client.query(`SELECT id FROM ${spec.table} WHERE id = $1`, [
                spec.a,
              ])
            ).rowCount,
          outletIds,
        );
      // Control: the connection scoped to the row's own outlet sees it.
      expect(await count([outlet.id]), `${spec.table} own outlet`).toBe(1);
      expect(await count([secondOutlet.id]), `${spec.table} other outlet`).toBe(
        0,
      );
    }
  });

  it("[TEN-01] the template and policy routes show each tenant only its own rows", async () => {
    const listA = await listAll(
      managerAll,
      "/api/hris/shift-templates?includeInactive=true",
    );
    expect(listA.map((row) => row.id)).toContain(seedA.templateId);
    expect(listA.map((row) => row.id)).not.toContain(seedB.templateId);

    const listB = await listShiftTemplates(ctxB, managerBUserId, {
      includeInactive: true,
      limit: 100,
    } as never);
    expect(listB.data.map((row) => row.id)).toContain(seedB.templateId);
    expect(listB.data.map((row) => row.id)).not.toContain(seedA.templateId);

    const policyA = await managerAll.get("/api/hris/shift-compliance-policy");
    expect(policyA.body.data).toMatchObject({
      tenantId: tenant.id,
      source: "tenant",
      maxShiftMinutes: 480,
    });
    const policyB = await getShiftCompliancePolicy(
      ctxB,
      managerBUserId,
      {} as never,
    );
    expect(policyB).toMatchObject({
      tenantId: tenantB.tenantId,
      source: "tenant",
      maxShiftMinutes: 540,
    });
  });

  it("[TEN-01] the shift and swap lists show each tenant only its own rows", async () => {
    const shiftsA = await listAll(managerAll, "/api/hris/shifts");
    expect(shiftsA.map((row) => row.id)).toContain(seedA.assignmentId);
    expect(shiftsA.map((row) => row.id)).not.toContain(seedB.assignmentId);
    const shiftsB = await listShiftAssignments(ctxB, managerBUserId, {
      limit: 100,
    } as never);
    expect(shiftsB.data.map((row) => row.id)).toEqual([seedB.assignmentId]);

    const swapsA = await listAll(managerAll, "/api/hris/shift-swaps");
    expect(swapsA.map((row) => row.id)).toContain(seedA.swapId);
    expect(swapsA.map((row) => row.id)).not.toContain(seedB.swapId);
    const swapsB = await listShiftSwapRequests(ctxB, managerBUserId, {
      limit: 100,
    } as never);
    expect(swapsB.data.map((row) => row.id)).toEqual([seedB.swapId]);
  });

  it("[TEN-01] another tenant's outlet and template answer 404 and stay untouched", async () => {
    const nameOf = async (tenantId: string, id: string) =>
      (
        await ownerTx(tenantId, (db) =>
          db.query<{ name: string }>(
            "SELECT name FROM shift_templates WHERE tenant_id = $1 AND id = $2",
            [tenantId, id],
          ),
        )
      ).rows[0]?.name;
    const beforeA = await nameOf(tenant.id, seedA.templateId);
    const beforeB = await nameOf(tenantB.tenantId, seedB.templateId);

    // Control: each manager can change its own tenant's template.
    expect(
      (
        await patch(
          managerAll,
          `/api/hris/shift-templates/${seedA.templateId}`,
          { breakMinutes: 20 },
        )
      ).status,
    ).toBe(200);
    await expect(
      updateShiftTemplate(ctxB, managerBUserId, seedB.templateId, {
        breakMinutes: 20,
      } as never),
    ).resolves.toMatchObject({ id: seedB.templateId, breakMinutes: 20 });

    expect(
      (
        await patch(
          managerAll,
          `/api/hris/shift-templates/${seedB.templateId}`,
          { name: "Diretas A" },
        )
      ).status,
    ).toBe(404);
    await expect(
      updateShiftTemplate(ctxB, managerBUserId, seedA.templateId, {
        name: "Diretas B",
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(await nameOf(tenant.id, seedA.templateId)).toBe(beforeA);
    expect(await nameOf(tenantB.tenantId, seedB.templateId)).toBe(beforeB);

    expect(
      (
        await managerAll.get(
          `/api/hris/shift-templates?outletId=${tenantB.outletId}`,
        )
      ).status,
    ).toBe(404);
    await expect(
      listShiftTemplates(ctxB, managerBUserId, {
        outletId: outlet.id,
        limit: 100,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createShiftTemplate(ctxB, managerBUserId, {
        ...templateBody({ name: uniqueName("Lintas tenant B") }),
        outletId: outlet.id,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await post(
          managerAll,
          "/api/hris/shift-templates",
          templateBody({
            outletId: tenantB.outletId,
            name: uniqueName("Lintas tenant"),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await put(
          managerAll,
          "/api/hris/shift-compliance-policy",
          policyBody({ outletId: tenantB.outletId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await managerAll.get(
          `/api/hris/shift-compliance-policy?outletId=${tenantB.outletId}`,
        )
      ).status,
    ).toBe(404);

    const leaked = await owner.query(
      "SELECT 1 FROM shift_templates WHERE outlet_id = $1 AND tenant_id = $2",
      [tenantB.outletId, tenant.id],
    );
    expect(leaked.rowCount).toBe(0);
    const policyB = await getShiftCompliancePolicy(
      ctxB,
      managerBUserId,
      {} as never,
    );
    expect(policyB.maxShiftMinutes).toBe(540);
  });
});
