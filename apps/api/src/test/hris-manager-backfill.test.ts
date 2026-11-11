// legend-qhqf8 (tier K, personal data): one-off backfill of employees.manager_id.
// Since 4b7eb37a a supervisor / outlet_manager only reaches DIRECT reports
// (employees.manager_id = own employee id), so employees whose manager_id is NULL
// are invisible to them. The script proposes the single active outlet_manager of
// the employee's home outlet; a human approves rows (--ids) before --apply.
// GM (brand scope) sees every employee of the brand (Q41) and must stay so.
//
// Written from the brief (Deliverable A contract), not from the implementation.
// Assumptions where the contract is silent:
// - `applied`, `skipped`, `manual` of run() may be a number or an array: the
//   tests read them through count().
// - The same employee listed twice in outletManagers (two assignments) is ONE
//   candidate, not an ambiguity.
// - With tenantId unset, run() visits tenants in ascending id order; the
//   per-tenant failure test creates tenant A with the smaller id and first.
// - parseArgs() returns an object whose `tenantId` carries --tenant.
// - Addendum 1: an employee holding any role outside JUNIOR_ROLE_KEYS (cashier,
//   waiter, barista_cook, facility_attendant, kitchen_lead, warehouse, employee)
//   is never auto-assigned: manual with reason "holds_manager_role", except a
//   cross-outlet manager which keeps "cross_outlet_needs_review".
// - Logging is per tenant (summary line, auto lines, `updated/skipped` line);
//   the manual CSV carries a tenant column and its header is printed once at
//   the end. A failing tenant makes run() reject after earlier tenants logged.
//
// Layout of the DB scenario (one fresh tenant per test, see buildScenario):
//   O1  om1 (outlet_manager)      a1, a2 (manager NULL)   i1 (manager resigned)
//       ok1 (manager om1)         m3 (manager om2 of O2 = cross outlet)
//       na (suspended, NULL)      gone (resigned, NULL)
//   O2  om2 (outlet_manager)      a3 (manager NULL)
//   O3  nobody                    m1 (manager NULL)
//   O4  om4a + om4b               m2 (manager NULL) -> ambiguous
//   O5  only a supervisor         m5 (manager NULL)
//   O6  outlet_manager assignment expired               m6 (manager NULL)
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import {
  BACKFILL_ACTION,
  BACKFILL_REASON,
  BackfillUsageError,
  classifyEmployees,
  cli,
  parseArgs,
  run,
  USAGE,
} from "../db/backfill-employee-managers.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const fixtureTenant = cafeLegendPlatformFixtures.tenant;

const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.example.test/file/${objectId}`,
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

const count = (value: unknown): number =>
  Array.isArray(value) ? value.length : Number(value);

// ---------------------------------------------------------------------------
// 1. Pure classification
// ---------------------------------------------------------------------------
type ClassifyInput = Parameters<typeof classifyEmployees>[0];
type EmployeeRow = ClassifyInput["employees"][number];

const O1 = randomUUID();
const O2 = randomUUID();
const pid = () => randomUUID();
const emp = (
  id: string,
  overrides: Partial<EmployeeRow> = {},
): EmployeeRow => ({
  id,
  employeeNo: `E-${id.slice(0, 8)}`,
  userId: null,
  managerId: null,
  homeOutletId: O1,
  status: "active",
  roleKeys: [],
  ...overrides,
});

function classify(
  employees: EmployeeRow[],
  outletManagers: ClassifyInput["outletManagers"] = [],
) {
  return classifyEmployees({ employees, outletManagers }).findings;
}
const findingOf = (findings: ReturnType<typeof classify>, employeeId: string) =>
  findings.find((finding) => finding.employeeId === employeeId);

describe("legend-qhqf8 classifyEmployees (pure)", () => {
  it("proposes the outlet manager for an active employee without manager", () => {
    const om = emp(pid());
    const e = emp(pid());
    const findings = classify([om, e], [{ outletId: O1, employeeId: om.id }]);
    expect(findingOf(findings, e.id)).toMatchObject({
      employeeId: e.id,
      employeeNo: e.employeeNo,
      outletId: O1,
      issue: "no_manager",
      currentManagerId: null,
      proposedManagerId: om.id,
      action: "auto",
    });
    expect(findings.filter((f) => f.employeeId === e.id)).toHaveLength(1);
  });

  it("flags an inactive manager and proposes the outlet manager", () => {
    const om = emp(pid());
    const gone = emp(pid(), { status: "resigned" });
    const e = emp(pid(), { managerId: gone.id });
    const finding = findingOf(
      classify([om, gone, e], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({
      issue: "manager_inactive",
      currentManagerId: gone.id,
      proposedManagerId: om.id,
      action: "auto",
    });
  });

  it("treats a manager that is missing from the data as inactive", () => {
    const om = emp(pid());
    const ghost = pid();
    const e = emp(pid(), { managerId: ghost });
    const finding = findingOf(
      classify([om, e], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({
      issue: "manager_inactive",
      currentManagerId: ghost,
    });
  });

  it("never auto-fixes a cross-outlet manager, even when an outlet manager exists", () => {
    const om = emp(pid());
    const area = emp(pid(), { homeOutletId: O2 });
    const e = emp(pid(), { managerId: area.id });
    const finding = findingOf(
      classify([om, area, e], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({
      issue: "manager_cross_outlet",
      currentManagerId: area.id,
      action: "manual",
      manualReason: "cross_outlet_needs_review",
    });
    // proposedManagerId may be filled for information, but only with that outlet manager.
    expect([null, om.id]).toContain(finding?.proposedManagerId);
  });

  it("keeps cross-outlet manual when the outlet has no outlet manager either", () => {
    const area = emp(pid(), { homeOutletId: O2 });
    const e = emp(pid(), { managerId: area.id });
    const finding = findingOf(classify([area, e]), e.id);
    expect(finding).toMatchObject({
      issue: "manager_cross_outlet",
      action: "manual",
    });
  });

  it("leaves an employee with an active same-outlet manager alone", () => {
    const boss = emp(pid());
    const om = emp(pid());
    const e = emp(pid(), { managerId: boss.id });
    expect(
      findingOf(
        classify([boss, om, e], [{ outletId: O1, employeeId: om.id }]),
        e.id,
      ),
    ).toBeUndefined();
  });

  it("goes manual when the outlet has no outlet manager", () => {
    const e = emp(pid());
    const finding = findingOf(classify([e]), e.id);
    expect(finding).toMatchObject({
      issue: "no_manager",
      action: "manual",
      manualReason: "no_outlet_manager",
      proposedManagerId: null,
    });
  });

  it("ignores an outlet manager row whose employee is not active or lives in another outlet", () => {
    const resigned = emp(pid(), { status: "resigned" });
    const elsewhere = emp(pid(), { homeOutletId: O2 });
    const e = emp(pid());
    const finding = findingOf(
      classify(
        [resigned, elsewhere, e],
        [
          { outletId: O1, employeeId: resigned.id },
          { outletId: O1, employeeId: elsewhere.id },
        ],
      ),
      e.id,
    );
    expect(finding).toMatchObject({
      action: "manual",
      manualReason: "no_outlet_manager",
      proposedManagerId: null,
    });
  });

  it("goes manual when two outlet managers share the outlet", () => {
    const omA = emp(pid());
    const omB = emp(pid());
    const e = emp(pid());
    const finding = findingOf(
      classify(
        [omA, omB, e],
        [
          { outletId: O1, employeeId: omA.id },
          { outletId: O1, employeeId: omB.id },
        ],
      ),
      e.id,
    );
    expect(finding).toMatchObject({
      action: "manual",
      manualReason: "ambiguous_outlet_manager",
      proposedManagerId: null,
    });
  });

  it("counts one person with two outlet_manager rows as a single candidate", () => {
    const om = emp(pid());
    const e = emp(pid());
    const finding = findingOf(
      classify(
        [om, e],
        [
          { outletId: O1, employeeId: om.id },
          { outletId: O1, employeeId: om.id },
        ],
      ),
      e.id,
    );
    expect(finding).toMatchObject({
      action: "auto",
      proposedManagerId: om.id,
    });
  });

  it("never proposes the outlet manager as his own manager", () => {
    const om = emp(pid());
    const finding = findingOf(
      classify([om], [{ outletId: O1, employeeId: om.id }]),
      om.id,
    );
    expect(finding).toBeDefined();
    expect(finding?.action).toBe("manual");
    expect(finding?.proposedManagerId).toBeNull();
    expect(finding?.manualReason).toBeTruthy();
  });

  it("goes manual with would_cycle when the outlet manager already reports to the employee", () => {
    const e = emp(pid());
    const om = emp(pid(), { managerId: e.id });
    const finding = findingOf(
      classify([e, om], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({
      action: "manual",
      manualReason: "would_cycle",
    });
  });

  it("detects a longer cycle through the manager chain", () => {
    const e = emp(pid());
    const middle = emp(pid(), { managerId: e.id });
    const om = emp(pid(), { managerId: middle.id });
    const finding = findingOf(
      classify([e, middle, om], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({
      action: "manual",
      manualReason: "would_cycle",
    });
  });

  it("does not call a manager chain that never reaches the employee a cycle", () => {
    const top = emp(pid());
    const middle = emp(pid(), { managerId: top.id });
    const om = emp(pid(), { managerId: middle.id });
    const e = emp(pid());
    const finding = findingOf(
      classify([top, middle, om, e], [{ outletId: O1, employeeId: om.id }]),
      e.id,
    );
    expect(finding).toMatchObject({ action: "auto", proposedManagerId: om.id });
  });

  it("examines only active employees", () => {
    const om = emp(pid());
    const others = (
      ["onboarding", "suspended", "resigned", "terminated"] as const
    ).map((status) => emp(pid(), { status }));
    const findings = classify(
      [om, ...others],
      [{ outletId: O1, employeeId: om.id }],
    );
    for (const other of others)
      expect(findingOf(findings, other.id)).toBeUndefined();
  });

  it.each([
    ["general_manager", ["general_manager"]],
    ["supervisor", ["supervisor"]],
    ["outlet_manager", ["outlet_manager"]],
    ["hr", ["hr"]],
    ["custom role", ["custom"]],
    ["junior plus senior mix", ["cashier", "supervisor"]],
  ])(
    "never auto-assigns a manager to a %s holder (holds_manager_role)",
    (_label, roleKeys) => {
      const om = emp(pid());
      const senior = emp(pid(), { roleKeys });
      const finding = findingOf(
        classify([om, senior], [{ outletId: O1, employeeId: om.id }]),
        senior.id,
      );
      expect(finding).toMatchObject({
        issue: "no_manager",
        action: "manual",
        manualReason: "holds_manager_role",
      });
    },
  );

  it("also holds back a senior whose manager is inactive", () => {
    const om = emp(pid());
    const gone = emp(pid(), { status: "resigned" });
    const senior = emp(pid(), {
      managerId: gone.id,
      roleKeys: ["general_manager"],
    });
    expect(
      findingOf(
        classify([om, gone, senior], [{ outletId: O1, employeeId: om.id }]),
        senior.id,
      ),
    ).toMatchObject({
      issue: "manager_inactive",
      action: "manual",
      manualReason: "holds_manager_role",
    });
  });

  it("keeps cross_outlet_needs_review for a senior with a cross-outlet manager", () => {
    const om = emp(pid());
    const area = emp(pid(), { homeOutletId: O2 });
    const senior = emp(pid(), { managerId: area.id, roleKeys: ["supervisor"] });
    expect(
      findingOf(
        classify([om, area, senior], [{ outletId: O1, employeeId: om.id }]),
        senior.id,
      ),
    ).toMatchObject({
      issue: "manager_cross_outlet",
      action: "manual",
      manualReason: "cross_outlet_needs_review",
    });
  });

  it("auto-assigns a holder of only junior roles (cashier + employee) and a roleless employee", () => {
    const om = emp(pid());
    const junior = emp(pid(), { roleKeys: ["cashier", "employee"] });
    const plain = emp(pid(), { roleKeys: [] });
    const findings = classify(
      [om, junior, plain],
      [{ outletId: O1, employeeId: om.id }],
    );
    for (const e of [junior, plain])
      expect(findingOf(findings, e.id)).toMatchObject({
        action: "auto",
        proposedManagerId: om.id,
      });
  });

  it("each outlet gets its own outlet manager", () => {
    const om1 = emp(pid());
    const om2 = emp(pid(), { homeOutletId: O2 });
    const e1 = emp(pid());
    const e2 = emp(pid(), { homeOutletId: O2 });
    const findings = classify(
      [om1, om2, e1, e2],
      [
        { outletId: O1, employeeId: om1.id },
        { outletId: O2, employeeId: om2.id },
      ],
    );
    expect(findingOf(findings, e1.id)?.proposedManagerId).toBe(om1.id);
    expect(findingOf(findings, e2.id)?.proposedManagerId).toBe(om2.id);
  });
});

// ---------------------------------------------------------------------------
// CLI argument handling (stops before any database connection)
// ---------------------------------------------------------------------------
function tempFile(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), "qhqf8-")), "ids.txt");
  writeFileSync(path, text);
  return path;
}

describe("legend-qhqf8 backfill CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses dry-run (default) and apply with an ids file and tenant", () => {
    expect(parseArgs([])).toMatchObject({ apply: false });
    expect(parseArgs(["--dry-run"])).toMatchObject({ apply: false });
    const employeeId = randomUUID();
    const tenant = randomUUID();
    expect(
      parseArgs([
        "--apply",
        "--ids",
        tempFile(`# reviewed by HR\n${employeeId.toUpperCase()}\n\n`),
        "--tenant",
        tenant,
      ]),
    ).toMatchObject({ apply: true, ids: [employeeId], tenantId: tenant });
  });

  it("refuses bad arguments as usage errors", () => {
    for (const args of [
      ["--bogus"],
      ["--apply"],
      ["--ids", "/nonexistent/qhqf8-ids.txt"],
      ["--tenant", "not-a-uuid"],
    ])
      expect(() => parseArgs(args)).toThrow(BackfillUsageError);
    expect(USAGE).toContain("--apply");
    expect(USAGE).toContain("--ids");
  });

  it("exits 2 with usage when --apply has no ids, before reading settings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await cli(["--apply"], { loadEnv: false })).toBe(2);
    expect(await cli(["--bogus"], { loadEnv: false })).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
type Ctx = {
  id: string;
  brandId: string;
  legalEntityId: string;
  omRoleId: string;
  supervisorRoleId: string | null;
};

const createdTenants: string[] = [];
const createdUsers: string[] = [];
const logs: string[] = [];
const log = (line: string) => logs.push(line);
const clock = () => new Date();

async function inTenant<T>(
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createTenant(id: string = randomUUID()): Promise<Ctx> {
  createdTenants.push(id);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Manager backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [id, `mgr-backfill-${id}`, randomUUID()],
  );
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const omRoleId = randomUUID();
  const supervisorRoleId = randomUUID();
  await inTenant(id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand backfill')`,
      [brandId, id, `mb-${brandId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'PT Backfill')`,
      [legalEntityId, id],
    );
    for (const [roleId, key] of [
      [omRoleId, "outlet_manager"],
      [supervisorRoleId, "supervisor"],
    ] as const)
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         VALUES ($1, $2, $3, true, $4, '[]'::jsonb, false, '["outlet"]'::jsonb)`,
        [roleId, id, key, key],
      );
  });
  return { id, brandId, legalEntityId, omRoleId, supervisorRoleId };
}

async function seedOutlet(ctx: Ctx): Promise<string> {
  const id = randomUUID();
  await inTenant(ctx.id, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet backfill', 'Jl. Backfill', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        ctx.id,
        ctx.brandId,
        ctx.legalEntityId,
        `MB-${id.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  return id;
}

async function seedEmployee(
  ctx: Ctx,
  options: {
    homeOutletId: string;
    userId?: string | null;
    managerId?: string | null;
    status?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await inTenant(ctx.id, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', $7, $8)`,
      [
        id,
        ctx.id,
        options.userId ?? null,
        `MB-${id.slice(0, 8).toUpperCase()}`,
        `Nama Rahasia ${id.slice(0, 8)}`,
        options.homeOutletId,
        options.status ?? "active",
        options.managerId ?? null,
      ],
    ),
  );
  return id;
}

async function assignRole(
  ctx: Ctx,
  userId: string,
  roleId: string,
  outletId: string,
  validity: { from?: string; until?: string | null } = {},
) {
  await inTenant(ctx.id, (client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - $5::interval, ${
         validity.until ? "now() - $6::interval" : "$6::timestamptz"
       }, $2)`,
      [
        ctx.id,
        userId,
        roleId,
        outletId,
        validity.from ?? "1 day",
        validity.until ?? null,
      ],
    ),
  );
}

async function newUserId(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

async function seedOutletManager(
  ctx: Ctx,
  outletId: string,
  userId: string,
  validity: { from?: string; until?: string | null } = {},
) {
  const employeeId = await seedEmployee(ctx, {
    homeOutletId: outletId,
    userId,
  });
  await assignRole(ctx, userId, ctx.omRoleId, outletId, validity);
  return employeeId;
}

let userPool: string[] = [];

async function buildScenario(id?: string) {
  const ctx = await createTenant(id);
  const [o1, o2, o3, o4, o5, o6] = (await Promise.all(
    Array.from({ length: 6 }, () => seedOutlet(ctx)),
  )) as [string, string, string, string, string, string];
  const om1 = await seedOutletManager(ctx, o1, userPool[0]!);
  const om2 = await seedOutletManager(ctx, o2, userPool[1]!);
  const om4a = await seedOutletManager(ctx, o4, userPool[2]!);
  const om4b = await seedOutletManager(ctx, o4, userPool[3]!);
  // O5: a supervisor is not an outlet_manager.
  const sup5 = await seedEmployee(ctx, {
    homeOutletId: o5,
    userId: userPool[4]!,
  });
  await assignRole(ctx, userPool[4]!, ctx.supervisorRoleId!, o5);
  // O6: the outlet_manager assignment ended yesterday.
  const om6 = await seedOutletManager(ctx, o6, userPool[5]!, {
    from: "2 days",
    until: "1 day",
  });
  const gone = await seedEmployee(ctx, {
    homeOutletId: o1,
    status: "resigned",
  });
  const e = {
    a1: await seedEmployee(ctx, { homeOutletId: o1 }),
    a2: await seedEmployee(ctx, { homeOutletId: o1 }),
    a3: await seedEmployee(ctx, { homeOutletId: o2 }),
    i1: await seedEmployee(ctx, { homeOutletId: o1, managerId: gone }),
    ok1: await seedEmployee(ctx, { homeOutletId: o1, managerId: om1 }),
    m1: await seedEmployee(ctx, { homeOutletId: o3 }),
    m2: await seedEmployee(ctx, { homeOutletId: o4 }),
    m3: await seedEmployee(ctx, { homeOutletId: o1, managerId: om2 }),
    m5: await seedEmployee(ctx, { homeOutletId: o5 }),
    m6: await seedEmployee(ctx, { homeOutletId: o6 }),
    na: await seedEmployee(ctx, { homeOutletId: o1, status: "suspended" }),
  };
  return {
    ctx,
    outlets: { o1, o2, o3, o4, o5, o6 },
    om: { om1, om2, om4a, om4b, om6, sup5 },
    gone,
    e,
  };
}
type Scenario = Awaited<ReturnType<typeof buildScenario>>;

type EmployeeJson = Record<string, unknown> & { id: string };
async function snapshot(tenantId: string): Promise<Map<string, EmployeeJson>> {
  const rows = await inTenant(tenantId, async (client) => {
    const result = await client.query<{ row: EmployeeJson }>(
      "SELECT to_jsonb(e) AS row FROM employees e WHERE tenant_id = $1 ORDER BY id",
      [tenantId],
    );
    return result.rows;
  });
  return new Map(rows.map(({ row }) => [row.id, row]));
}

function withoutManagerColumns(row: EmployeeJson): EmployeeJson {
  const copy = { ...row };
  delete copy.manager_id;
  delete copy.updated_at;
  return copy;
}

async function setManager(
  tenantId: string,
  employeeId: string,
  managerId: string | null,
) {
  await inTenant(tenantId, (client) =>
    client.query(
      "UPDATE employees SET manager_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, employeeId, managerId],
    ),
  );
}

// A template role (e.g. general_manager at brand scope) for the "senior" tests.
async function seedTemplateRole(
  ctx: Ctx,
  key: string,
  scopeType: "brand" | "outlet",
): Promise<string> {
  const id = randomUUID();
  await inTenant(ctx.id, (client) =>
    client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, '[]'::jsonb, false, $5::jsonb)`,
      [id, ctx.id, key, key, JSON.stringify([scopeType])],
    ),
  );
  return id;
}

async function managerOf(tenantId: string, employeeId: string) {
  const rows = await inTenant(tenantId, async (client) => {
    const result = await client.query<{ manager_id: string | null }>(
      "SELECT manager_id FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenantId, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.manager_id;
}

type AuditRow = {
  outlet_id: string | null;
  event: {
    action: string;
    objectType: string;
    objectId: string;
    actorType: string;
    reason: string;
    maskedChanges: {
      before: { managerId: string | null };
      after: { managerId: string | null };
    };
  };
};
async function auditRows(tenantId: string): Promise<AuditRow[]> {
  return inTenant(tenantId, async (client) => {
    const result = await client.query<AuditRow>(
      "SELECT outlet_id, event FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
      [tenantId, BACKFILL_ACTION],
    );
    return result.rows;
  });
}

const runIn = (
  tenantId: string | undefined,
  options: { apply: boolean; ids?: string[] },
) =>
  run({
    pool: owner,
    apply: options.apply,
    now: clock(),
    log,
    ids: options.ids,
    tenantId,
  });

const AUTO = (s: Scenario) => [s.e.a1, s.e.a2, s.e.a3, s.e.i1];

beforeAll(async () => {
  userPool = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      newUserId(`Backfill User ${index}`),
    ),
  );
}, 120_000);

afterEach(() => {
  logs.length = 0;
});

// ---------------------------------------------------------------------------
// 2. Dry-run
// ---------------------------------------------------------------------------
describe("legend-qhqf8 dry-run", () => {
  it("writes nothing, lists auto and manual items, and never prints names or user ids", async () => {
    const s = await buildScenario();
    const before = await snapshot(s.ctx.id);

    const result = await runIn(s.ctx.id, { apply: false });

    expect(result.apply).toBe(false);
    expect(count(result.applied)).toBe(0);
    expect(await snapshot(s.ctx.id)).toEqual(before);
    expect(await auditRows(s.ctx.id)).toHaveLength(0);

    // Classification (the two outlet managers of O4 are left out: whether one
    // proposes the other is not defined by the contract).
    const skipO4 = new Set([s.om.om4a, s.om.om4b]);
    const mine = result.findings.filter((f) => !skipO4.has(f.employeeId));
    const auto = mine.filter((f) => f.action === "auto");
    expect(auto.map((f) => f.employeeId).sort()).toEqual([...AUTO(s)].sort());
    const byId = new Map(mine.map((f) => [f.employeeId, f]));
    expect(byId.get(s.e.a1)).toMatchObject({
      issue: "no_manager",
      proposedManagerId: s.om.om1,
      outletId: s.outlets.o1,
    });
    expect(byId.get(s.e.a3)).toMatchObject({
      issue: "no_manager",
      proposedManagerId: s.om.om2,
    });
    expect(byId.get(s.e.i1)).toMatchObject({
      issue: "manager_inactive",
      currentManagerId: s.gone,
      proposedManagerId: s.om.om1,
    });
    expect(byId.get(s.e.m1)).toMatchObject({
      action: "manual",
      manualReason: "no_outlet_manager",
    });
    expect(byId.get(s.e.m2)).toMatchObject({
      action: "manual",
      manualReason: "ambiguous_outlet_manager",
    });
    expect(byId.get(s.e.m3)).toMatchObject({
      issue: "manager_cross_outlet",
      action: "manual",
      manualReason: "cross_outlet_needs_review",
    });
    // Supervisor-only outlet and expired assignment are not outlet managers.
    expect(byId.get(s.e.m5)).toMatchObject({
      action: "manual",
      manualReason: "no_outlet_manager",
    });
    expect(byId.get(s.e.m6)).toMatchObject({
      action: "manual",
      manualReason: "no_outlet_manager",
    });
    // Healthy and non-active employees produce no finding.
    for (const quiet of [s.e.ok1, s.e.na, s.gone])
      expect(byId.has(quiet)).toBe(false);
    // The outlet manager himself is never his own proposal.
    expect(byId.get(s.om.om1)).toMatchObject({ action: "manual" });
    expect(byId.get(s.om.om1)?.proposedManagerId).toBeNull();
  });

  it("prints the review lists in the agreed format without full names or user ids", async () => {
    const s = await buildScenario();
    const a1No = (await snapshot(s.ctx.id)).get(s.e.a1)!.employee_no as string;
    const m1No = (await snapshot(s.ctx.id)).get(s.e.m1)!.employee_no as string;

    await runIn(s.ctx.id, { apply: false });

    const text = logs.join("\n");
    expect(logs).toContain(
      `tenant=${s.ctx.id} employee=${s.e.a1} no=${a1No} outlet=${s.outlets.o1} issue=no_manager current=- proposed=${s.om.om1}`,
    );
    const autoLines = logs.filter((line) => line.startsWith("tenant="));
    for (const id of AUTO(s))
      expect(autoLines.some((line) => line.includes(`employee=${id} `))).toBe(
        true,
      );
    // Manual items are not in the auto list.
    for (const id of [s.e.m1, s.e.m2, s.e.m3, s.e.m5, s.e.m6])
      expect(autoLines.some((line) => line.includes(`employee=${id} `))).toBe(
        false,
      );
    // Per-tenant summary line (O4's two outlet managers make the manual count
    // scenario-dependent, so only the auto count is pinned: a1, a2, a3, i1).
    expect(
      logs.some((line) =>
        new RegExp(
          `^tenant=${s.ctx.id} findings=\\d+ auto=4 manual=\\d+ no_manager=\\d+ manager_inactive=\\d+ manager_cross_outlet=\\d+$`,
        ).test(line),
      ),
    ).toBe(true);
    const header =
      "# MANUAL LIST (csv: tenant_id,employee_id,employee_no,outlet_id,issue,reason)";
    expect(text).toContain(header);
    expect(text.split(header)).toHaveLength(2); // printed exactly once
    expect(text).toContain(
      `${s.ctx.id},${s.e.m1},${m1No},${s.outlets.o3},no_manager,no_outlet_manager`,
    );
    expect(text).toContain(`${s.ctx.id},${s.e.m3},`);
    // The outlet manager himself and the supervisor hold manager roles.
    expect(text).toContain(`${s.ctx.id},${s.om.om1},`);
    expect(text).toContain("holds_manager_role");
    expect(text).toContain("Total: findings=");
    expect(text).toContain(
      "# Ids for review (save approved to a file for --ids)",
    );
    expect(text).toContain("Dry-run: nothing written");
    expect(text).not.toContain("Nama Rahasia");
    for (const userId of userPool) expect(text).not.toContain(userId);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Apply, audit, idempotency
// ---------------------------------------------------------------------------
describe("legend-qhqf8 apply", () => {
  it("updates only the reviewed auto rows, audits each one, and touches nothing else", async () => {
    const s = await buildScenario();
    const before = await snapshot(s.ctx.id);
    // a2 and a3 are auto but not reviewed; m1 and m3 are reviewed but manual.
    const ids = [s.e.a1, s.e.i1, s.e.m1, s.e.m3];

    const result = await runIn(s.ctx.id, { apply: true, ids });

    expect(result.apply).toBe(true);
    expect(count(result.applied)).toBe(2);
    expect(await managerOf(s.ctx.id, s.e.a1)).toBe(s.om.om1);
    expect(await managerOf(s.ctx.id, s.e.i1)).toBe(s.om.om1);
    expect(await managerOf(s.ctx.id, s.e.a2)).toBeNull();
    expect(await managerOf(s.ctx.id, s.e.a3)).toBeNull();
    expect(await managerOf(s.ctx.id, s.e.m1)).toBeNull();
    expect(await managerOf(s.ctx.id, s.e.m3)).toBe(s.om.om2);

    // Every other column of every row is unchanged (status included).
    const after = await snapshot(s.ctx.id);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, row] of before) {
      const next = after.get(id)!;
      if (id === s.e.a1 || id === s.e.i1)
        expect(withoutManagerColumns(next)).toEqual(withoutManagerColumns(row));
      else expect(next).toEqual(row);
    }

    const audits = await auditRows(s.ctx.id);
    expect(audits).toHaveLength(2);
    const byObject = new Map(audits.map((row) => [row.event.objectId, row]));
    expect([...byObject.keys()].sort()).toEqual([s.e.a1, s.e.i1].sort());
    expect(byObject.get(s.e.a1)).toMatchObject({
      outlet_id: s.outlets.o1,
      event: {
        action: BACKFILL_ACTION,
        objectType: "employee",
        actorType: "system",
        reason: BACKFILL_REASON,
        maskedChanges: {
          before: { managerId: null },
          after: { managerId: s.om.om1 },
        },
      },
    });
    expect(byObject.get(s.e.i1)!.event.maskedChanges).toEqual({
      before: { managerId: s.gone },
      after: { managerId: s.om.om1 },
    });
  });

  it("refuses --apply without reviewed ids and writes nothing", async () => {
    const s = await buildScenario();
    const before = await snapshot(s.ctx.id);

    await expect(runIn(s.ctx.id, { apply: true })).rejects.toThrow(
      BackfillUsageError,
    );

    expect(await snapshot(s.ctx.id)).toEqual(before);
    expect(await auditRows(s.ctx.id)).toHaveLength(0);
  });

  it("never touches a senior (general_manager, brand scope) even when listed in --ids", async () => {
    const s = await buildScenario();
    const gmUser = await newUserId("Backfill GM Senior");
    const gmRoleId = await seedTemplateRole(s.ctx, "general_manager", "brand");
    const gm = await seedEmployee(s.ctx, {
      homeOutletId: s.outlets.o1,
      userId: gmUser,
    });
    await inTenant(s.ctx.id, (client) =>
      client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'brand', $4, now() - interval '1 day', $2)`,
        [s.ctx.id, gmUser, gmRoleId, s.ctx.brandId],
      ),
    );
    const gmNo = (await snapshot(s.ctx.id)).get(gm)!.employee_no as string;

    const dry = await runIn(s.ctx.id, { apply: false });
    expect(dry.findings.find((f) => f.employeeId === gm)).toMatchObject({
      issue: "no_manager",
      action: "manual",
      manualReason: "holds_manager_role",
    });
    expect(logs.join("\n")).toContain(
      `${s.ctx.id},${gm},${gmNo},${s.outlets.o1},no_manager,holds_manager_role`,
    );
    logs.length = 0;

    const result = await runIn(s.ctx.id, { apply: true, ids: [gm, s.e.a1] });

    expect(count(result.applied)).toBe(1);
    expect(count(result.skipped)).toBe(1);
    expect(await managerOf(s.ctx.id, gm)).toBeNull();
    expect(await managerOf(s.ctx.id, s.e.a1)).toBe(s.om.om1);
    expect((await auditRows(s.ctx.id)).map((r) => r.event.objectId)).toEqual([
      s.e.a1,
    ]);
    expect(logs).toContain(`tenant=${s.ctx.id} updated=1 skipped=1`);
  });

  it("skips a reviewed id whose row changed since the dry-run, and an id that was never auto", async () => {
    const s = await buildScenario();
    // a1 and a2 are auto items in the dry-run the reviewer saw.
    const dry = await runIn(s.ctx.id, { apply: false });
    const autoIds = dry.findings
      .filter((f) => f.action === "auto")
      .map((f) => f.employeeId);
    expect(autoIds).toEqual(expect.arrayContaining([s.e.a1, s.e.a2]));
    logs.length = 0;

    // Between review and apply a1 got a healthy same-outlet manager (ok1), so
    // the apply's own read pass no longer classifies it as auto.
    await setManager(s.ctx.id, s.e.a1, s.e.ok1);
    const before = await snapshot(s.ctx.id);

    // m1 was never an auto item (no outlet manager in its outlet).
    const result = await runIn(s.ctx.id, {
      apply: true,
      ids: [s.e.a1, s.e.a2, s.e.m1],
    });

    expect(count(result.applied)).toBe(1);
    expect(count(result.skipped)).toBe(2);
    expect(await managerOf(s.ctx.id, s.e.a1)).toBe(s.e.ok1);
    expect(await managerOf(s.ctx.id, s.e.m1)).toBeNull();
    expect(await managerOf(s.ctx.id, s.e.a2)).toBe(s.om.om1);
    const after = await snapshot(s.ctx.id);
    for (const id of [s.e.a1, s.e.m1])
      expect(after.get(id)).toEqual(before.get(id));
    expect((await auditRows(s.ctx.id)).map((r) => r.event.objectId)).toEqual([
      s.e.a2,
    ]);
    expect(logs).toContain(`tenant=${s.ctx.id} updated=1 skipped=2`);
  });

  it("is idempotent: a second apply changes and audits nothing, and the fixed rows leave the auto list", async () => {
    const s = await buildScenario();
    const ids = [s.e.a1, s.e.i1];
    expect(count((await runIn(s.ctx.id, { apply: true, ids })).applied)).toBe(
      2,
    );
    const afterFirst = await snapshot(s.ctx.id);
    const auditsFirst = await auditRows(s.ctx.id);
    expect(auditsFirst).toHaveLength(2);

    const second = await runIn(s.ctx.id, { apply: true, ids });

    expect(count(second.applied)).toBe(0);
    expect(await snapshot(s.ctx.id)).toEqual(afterFirst);
    expect(await auditRows(s.ctx.id)).toHaveLength(2);

    const dry = await runIn(s.ctx.id, { apply: false });
    const autoLeft = dry.findings
      .filter((f) => f.action === "auto")
      .map((f) => f.employeeId);
    expect(autoLeft).not.toContain(s.e.a1);
    expect(autoLeft).not.toContain(s.e.i1);
    expect(autoLeft).toContain(s.e.a2);
  });
});

// ---------------------------------------------------------------------------
// 5. One transaction per tenant, tenant isolation
// ---------------------------------------------------------------------------
describe("legend-qhqf8 tenant isolation and per-tenant transactions", () => {
  it("--tenant limits the run: another tenant's reviewed id is left alone", async () => {
    const a = await buildScenario();
    const b = await buildScenario();

    const result = await runIn(a.ctx.id, {
      apply: true,
      ids: [a.e.a1, b.e.a1],
    });

    expect(count(result.applied)).toBe(1);
    expect(await managerOf(a.ctx.id, a.e.a1)).toBe(a.om.om1);
    expect(await managerOf(b.ctx.id, b.e.a1)).toBeNull();
    expect(await auditRows(b.ctx.id)).toHaveLength(0);
  });

  it("one run over several tenants applies each tenant's own ids with its own audit rows", async () => {
    const a = await buildScenario();
    const b = await buildScenario();

    await runIn(undefined, { apply: true, ids: [a.e.a1, b.e.a3] });

    expect(await managerOf(a.ctx.id, a.e.a1)).toBe(a.om.om1);
    expect(await managerOf(b.ctx.id, b.e.a3)).toBe(b.om.om2);
    expect((await auditRows(a.ctx.id)).map((r) => r.event.objectId)).toEqual([
      a.e.a1,
    ]);
    expect((await auditRows(b.ctx.id)).map((r) => r.event.objectId)).toEqual([
      b.e.a3,
    ]);
    expect(await managerOf(a.ctx.id, a.e.a2)).toBeNull();
    expect(await managerOf(b.ctx.id, b.e.a1)).toBeNull();
  });

  it("a failure in tenant B rolls back only tenant B, tenant A stays committed", async () => {
    // Tenant A has the smaller id and is created first, so it is processed first
    // whether the run orders by id or by creation.
    const [idA, idB] = [randomUUID(), randomUUID()].sort() as [string, string];
    const a = await buildScenario(idA);
    const b = await buildScenario(idB);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const fn = `hris_backfill_test_fail_${suffix}`;
    await owner.query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${b.e.a1}'::uuid AND NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
           RAISE EXCEPTION 'forced failure for tenant B';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON public.employees
         FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
    );
    try {
      // Addendum 1: the error propagates after tenant A committed and logged.
      await expect(
        runIn(undefined, { apply: true, ids: [a.e.a1, b.e.a1] }),
      ).rejects.toThrow();

      // Tenant A's result line was logged before tenant B threw.
      expect(
        logs.some((line) => line.startsWith(`tenant=${a.ctx.id} updated=1 `)),
      ).toBe(true);
      expect(
        logs.some((line) => line.startsWith(`tenant=${b.ctx.id} updated=`)),
      ).toBe(false);

      expect(await managerOf(a.ctx.id, a.e.a1)).toBe(a.om.om1);
      expect(await auditRows(a.ctx.id)).toHaveLength(1);
      expect(await managerOf(b.ctx.id, b.e.a1)).toBeNull();
      expect(await auditRows(b.ctx.id)).toHaveLength(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON public.employees`);
      await owner.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }

    // Once the cause is gone, tenant B applies normally and tenant A is not redone.
    await runIn(undefined, { apply: true, ids: [a.e.a1, b.e.a1] });
    expect(await managerOf(b.ctx.id, b.e.a1)).toBe(b.om.om1);
    expect(await auditRows(b.ctx.id)).toHaveLength(1);
    expect(await auditRows(a.ctx.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Visibility through the existing access path (HTTP)
// ---------------------------------------------------------------------------
const ATTENDANCE_PERMISSIONS = [
  "hr.attendance.manage",
  "hr.attendance_correction.approve",
];
type Client = ReturnType<typeof agent>;
type JsonRow = Record<string, unknown>;

const visibilityRoles: string[] = [];
const visibilityEmployees: string[] = [];
const visibilityOutlets: string[] = [];
const visibilityCorrections: string[] = [];
let createdOmRole: string | null = null;

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function grantAttendanceRole(
  userId: string,
  scope:
    | { type: "brand"; brandId: string }
    | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  visibilityRoles.push(roleId);
  await inTenant(fixtureTenant.id, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        fixtureTenant.id,
        `Backfill visibility ${roleId.slice(0, 8)}`,
        JSON.stringify(ATTENDANCE_PERMISSIONS),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "brand" ? [scope.brandId] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [fixtureTenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

async function seedCorrection(ctx: Ctx, employeeId: string, outletId: string) {
  const id = randomUUID();
  visibilityCorrections.push(id);
  await inTenant(ctx.id, (client) =>
    client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'Lupa absen pulang', $5, $6)`,
      [id, ctx.id, outletId, employeeId, randomUUID(), `mb-${id}`],
    ),
  );
  return id;
}

async function correctionIds(client: Client): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `/api/hris/attendance/corrections?limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    ids.push(
      ...(response.body.data as JsonRow[]).map((row) =>
        String(row.id).toLowerCase(),
      ),
    );
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return ids;
}

describe("legend-qhqf8 visibility after the backfill", () => {
  it("the outlet manager now sees the backfilled employee; the GM still sees the whole brand", async () => {
    // The fixture tenant is the one the signed-in HTTP users belong to.
    const existing = await inTenant(fixtureTenant.id, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'outlet_manager' LIMIT 1",
        [fixtureTenant.id],
      );
      return result.rows[0]?.id ?? null;
    });
    let omRoleId = existing;
    if (!omRoleId) {
      omRoleId = randomUUID();
      createdOmRole = omRoleId;
      await inTenant(fixtureTenant.id, (client) =>
        client.query(
          `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
           VALUES ($1, $2, 'outlet_manager', true, 'outlet_manager', '[]'::jsonb, false, '["outlet"]'::jsonb)`,
          [omRoleId, fixtureTenant.id],
        ),
      );
    }
    const ctx: Ctx = {
      id: fixtureTenant.id,
      brandId: cafeLegendPlatformFixtures.brand.id,
      legalEntityId: cafeLegendPlatformFixtures.legalEntity.id,
      omRoleId,
      supervisorRoleId: null,
    };
    const outletV1 = await seedOutlet(ctx);
    const outletV2 = await seedOutlet(ctx);
    visibilityOutlets.push(outletV1, outletV2);

    const om = await signedInClient("Outlet Manager Backfill");
    const gm = await signedInClient("GM Backfill");
    await grantAttendanceRole(om.userId, {
      type: "outlet",
      outletIds: [outletV1],
    });
    await grantAttendanceRole(gm.userId, {
      type: "brand",
      brandId: ctx.brandId,
    });
    const omEmployee = await seedEmployee(ctx, {
      homeOutletId: outletV1,
      userId: om.userId,
    });
    await assignRole(ctx, om.userId, omRoleId, outletV1);
    const gmEmployee = await seedEmployee(ctx, {
      homeOutletId: outletV1,
      userId: gm.userId,
    });
    // E1 will be backfilled (outlet V1 has a single outlet manager); E2 lives in
    // an outlet without outlet manager and is not reviewed.
    const e1 = await seedEmployee(ctx, { homeOutletId: outletV1 });
    const e2 = await seedEmployee(ctx, { homeOutletId: outletV2 });
    visibilityEmployees.push(omEmployee, gmEmployee, e1, e2);
    const corrE1 = await seedCorrection(ctx, e1, outletV1);
    const corrE2 = await seedCorrection(ctx, e2, outletV2);

    // Before: manager_id is NULL, so the outlet manager reaches nobody; the GM reaches all.
    const omBefore = await correctionIds(om.client);
    expect(omBefore).not.toContain(corrE1);
    expect(omBefore).not.toContain(corrE2);
    const gmBefore = await correctionIds(gm.client);
    expect(gmBefore).toContain(corrE1);
    expect(gmBefore).toContain(corrE2);

    const result = await runIn(ctx.id, { apply: true, ids: [e1] });
    expect(count(result.applied)).toBe(1);
    expect(await managerOf(ctx.id, e1)).toBe(omEmployee);
    expect(await managerOf(ctx.id, e2)).toBeNull();

    // After: the outlet manager sees the backfilled employee only.
    const omAfter = await correctionIds(om.client);
    expect(omAfter).toContain(corrE1);
    expect(omAfter).not.toContain(corrE2);
    // The GM (brand scope) still sees every employee of the brand, backfilled or not.
    const gmAfter = await correctionIds(gm.client);
    expect(gmAfter).toContain(corrE1);
    expect(gmAfter).toContain(corrE2);
  });
});

// ---------------------------------------------------------------------------
// Cleanup (audit_logs is append-only: delete with triggers off, like the GM test)
// ---------------------------------------------------------------------------
afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const scope = (tenantId: string) =>
        client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
      await scope(fixtureTenant.id);
      await client.query(
        "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = ANY($2::text[])",
        [fixtureTenant.id, visibilityEmployees],
      );
      await client.query(
        "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [fixtureTenant.id, visibilityCorrections],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [fixtureTenant.id, visibilityEmployees],
      );
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [fixtureTenant.id, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [
          fixtureTenant.id,
          [...visibilityRoles, ...(createdOmRole ? [createdOmRole] : [])],
        ],
      );
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [fixtureTenant.id, visibilityOutlets],
      );
      for (const tenantId of createdTenants) {
        await scope(tenantId);
        for (const table of [
          "audit_logs",
          "employees",
          "role_assignments",
          "roles",
          "outlets",
          "legal_entities",
          "brands",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            tenantId,
          ]);
      }
      await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
        createdTenants,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } finally {
    await owner.end();
  }
}, 60_000);
