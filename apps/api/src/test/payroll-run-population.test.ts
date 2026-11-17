// Payroll run population rule (O7) and partial-year tax subject (O8) (bead
// legend-0ytbu, WS-10; brief docs/briefs/949-context.md section 0ytbu).
// Founder rule "jangan sampai rugi": nobody who must be paid is skipped, nobody
// outside the run is paid, and tax is never under-withheld by a wrong flag.
//
// DECIDED RULES UNDER TEST (the docs never defined O7/O8; the brief fixes them)
//  O7 population of a run = employees of the run's legal entity, where the
//     entity is the employee's own legal entity, or (when none) the home
//     outlet's legal entity; employment type in the payroll policy group;
//     employed in the period: joinDate <= periodEnd AND (endDate IS NULL OR
//     endDate >= periodStart). Other tenants are never in. No eligible
//     employee: 422 PAYROLL_RUN_EMPTY.
//  O8 partialYearTaxSubject is false for every employee (no data field marks a
//     foreign national leaving for good; false never under-withholds).
//
// ASSUMPTIONS
//  - Employee status is kept 'active' on every case: the rule above does not
//    filter on status, only on dates (also for ended employees).
//  - O8 is observed through the stored calculation's pph21Idr in a December run
//    (last tax period) for a mid-year joiner (6 months worked): it equals the
//    shared engine with partialYearTaxSubject false, and differs from the same
//    call with true (guard: the test would otherwise prove nothing).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  computePayslipTax,
  DEFAULT_PPH21_POLICY,
  payrollRunIdSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";
import {
  deleteStatutoryTables,
  insertDraftRun,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
} from "./payroll-simulate-kit.ts";

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});

const tenant = cafeLegendPlatformFixtures.tenant;
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];
const createdOutlets: string[] = [];
let otherTenant: SecondTenant | null = null;
let otherTenantEmployee: string | null = null;

const SALARY = 8_000_020;
// O8 needs tax above the PTKP threshold, or both variants withhold 0.
const HIGH_SALARY = 60_000_020;
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};
const DEC = {
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  payDate: "2026-12-28",
};

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
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

async function signedInUser(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Population ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

let runnerId: string;
let hr: Awaited<ReturnType<typeof signedInUser>>["client"];
let counter = 0;
const key = () => `population-${randomUUID()}`;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };

async function makeEntity(label: string): Promise<string> {
  const id = randomUUID();
  createdEntities.push(id);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [id, tenant.id, `PT Populasi ${label} ${++counter}`],
    ),
  );
  return id;
}

async function makeWorld(): Promise<World> {
  const world = { entityId: await makeEntity("run"), policyId: randomUUID() };
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, runnerId);
  });
  return world;
}

/** An outlet whose legal entity is `entityId` (for the outlet fallback rule). */
async function makeOutlet(entityId: string): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((conn) =>
    conn.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address,
                            timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Populasi', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}',
               'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        entityId,
        `PP-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet populasi ${++counter}`,
      ],
    ),
  );
  return id;
}

type EmployeeShape = {
  entityId: string | null; // employee's own legal entity (null = fall back to outlet)
  outletId?: string;
  joinDate?: string;
  endDate?: string | null;
  employmentType?: "pkwtt" | "pkwt" | "daily" | "intern";
};

async function makeEmployee(
  baseEntityId: string,
  shape: EmployeeShape,
): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: shape.outletId ?? fixtureOutlet.id,
      entityId: baseEntityId,
      id,
      name: `Populasi ${++counter}`,
      ...(shape.joinDate ? { joinDate: shape.joinDate } : {}),
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: id,
      amount: SALARY,
      createdBy: runnerId,
    });
  });
  // Raw role: the shape columns are not all reachable through the kit helper.
  await asTenant(
    (conn) =>
      conn.query(
        `UPDATE employees SET legal_entity_id = $2, end_date = $3,
                employment_type = $4 WHERE tenant_id = $5 AND id = $1`,
        [
          id,
          shape.entityId,
          shape.endDate ?? null,
          shape.employmentType ?? "pkwtt",
          tenant.id,
        ],
      ),
    true,
  );
  return id;
}

async function draftRun(
  world: World,
  dates: { periodStart: string; periodEnd: string; payDate: string },
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...dates,
    }),
  );
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      runnerId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

const resultEmployees = (runId: string) =>
  asTenant(async (conn) =>
    (
      await conn.query<{ employee_id: string }>(
        `SELECT employee_id FROM payroll_run_results
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows.map((row) => row.employee_id),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const runner = await signedInUser("Population runner");
  runnerId = runner.userId;
  await grantRole(runnerId, ["payroll.view", "payroll.run", "payroll.lock"]);
  const hrUser = await signedInUser("Population HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  if (otherTenant) {
    await owner.query("DELETE FROM employees WHERE id = $1", [
      otherTenantEmployee,
    ]);
    await removeSecondTenant(owner, otherTenant);
  }
  await asTenant(async (conn) => {
    for (const table of [
      "payroll_run_results",
      "payroll_run_month_priors",
      "payslip_bank_snapshots",
    ])
      await conn.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, createdRuns],
      );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'population-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND code LIKE 'SM\\_%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query("DELETE FROM outlets WHERE id = ANY($1)", [
      createdOutlets,
    ]);
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      createdEntities,
    ]);
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRoles],
    );
  }, true);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- O7 population -------------------------------------------------------------

describe("[O7] who is in a run", () => {
  const ids: Record<string, string> = {};
  let included: string[] = [];

  beforeAll(async () => {
    const world = await makeWorld();
    const otherEntity = await makeEntity("lain");
    const outletOfRun = await makeOutlet(world.entityId);
    const outletOfOther = await makeOutlet(otherEntity);
    const mine = world.entityId;

    // Included.
    ids.plain = await makeEmployee(mine, { entityId: mine });
    ids.outletFallback = await makeEmployee(mine, {
      entityId: null,
      outletId: outletOfRun,
    });
    ids.ownEntityBeatsOutlet = await makeEmployee(mine, {
      entityId: mine,
      outletId: outletOfOther,
    });
    ids.joinsOnLastDay = await makeEmployee(mine, {
      entityId: mine,
      joinDate: "2026-11-30",
    });
    ids.endsOnFirstDay = await makeEmployee(mine, {
      entityId: mine,
      endDate: "2026-11-01",
    });
    // Excluded.
    ids.otherEntity = await makeEmployee(mine, { entityId: otherEntity });
    ids.otherEntityViaOutlet = await makeEmployee(mine, {
      entityId: null,
      outletId: outletOfOther,
    });
    ids.ownOtherEntityBeatsOutlet = await makeEmployee(mine, {
      entityId: otherEntity,
      outletId: outletOfRun,
    });
    ids.pkwt = await makeEmployee(mine, {
      entityId: mine,
      employmentType: "pkwt",
    });
    ids.daily = await makeEmployee(mine, {
      entityId: mine,
      employmentType: "daily",
    });
    ids.joinsAfterPeriod = await makeEmployee(mine, {
      entityId: mine,
      joinDate: "2026-12-01",
    });
    ids.endedBeforePeriod = await makeEmployee(mine, {
      entityId: mine,
      endDate: "2026-10-31",
    });

    // Another tenant: a same-shaped employee that must never appear.
    otherTenant = await createSecondTenant(owner, "popu");
    otherTenantEmployee = randomUUID();
    await owner.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status, ptkp_status)
       VALUES ($1, $2, $3, 'Karyawan Tenant Lain', $4, $5, 'pkwtt', '2025-03-01', 'active', 'TK/0')`,
      [
        otherTenantEmployee,
        otherTenant.tenantId,
        `PO-${otherTenantEmployee.slice(0, 8).toUpperCase()}`,
        otherTenant.outletId,
        otherTenant.legalEntityId,
      ],
    );
    ids.otherTenant = otherTenantEmployee;

    const runId = await draftRun(world, NOV);
    await simulateRun(runId);
    included = await resultEmployees(runId);
  }, 180_000);

  it.each([
    ["plain", "own legal entity, pkwtt, employed all period"],
    ["outletFallback", "no own entity: the home outlet's entity counts"],
    ["ownEntityBeatsOutlet", "own entity wins over a foreign outlet entity"],
    ["joinsOnLastDay", "joinDate == periodEnd is in"],
    ["endsOnFirstDay", "endDate == periodStart is in"],
  ])("includes %s (%s)", (name) => {
    expect(included).toContain(ids[name]);
  });

  it.each([
    ["otherEntity", "another legal entity"],
    ["otherEntityViaOutlet", "no own entity and the outlet belongs elsewhere"],
    [
      "ownOtherEntityBeatsOutlet",
      "own other entity wins over the run's outlet",
    ],
    ["pkwt", "employment type not in the policy group"],
    ["daily", "employment type not in the policy group"],
    ["joinsAfterPeriod", "joins the day after periodEnd"],
    ["endedBeforePeriod", "ended the day before periodStart"],
    ["otherTenant", "belongs to another tenant"],
  ])("excludes %s (%s)", (name) => {
    expect(included).not.toContain(ids[name]);
  });

  it("the run has exactly the five included employees, one result each", () => {
    expect([...included].sort()).toEqual(
      [
        ids.plain,
        ids.outletFallback,
        ids.ownEntityBeatsOutlet,
        ids.joinsOnLastDay,
        ids.endsOnFirstDay,
      ].sort(),
    );
  });

  it("[empty] a run whose legal entity has only excluded employees is 422 PAYROLL_RUN_EMPTY and stays draft", async () => {
    const world = await makeWorld();
    const otherEntity = await makeEntity("lain");
    await makeEmployee(world.entityId, { entityId: otherEntity });
    await makeEmployee(world.entityId, {
      entityId: world.entityId,
      employmentType: "intern",
    });
    await makeEmployee(world.entityId, {
      entityId: world.entityId,
      endDate: "2026-10-31",
    });
    const runId = await draftRun(world, NOV);

    const refused = await failureOf(simulateRun(runId));
    expect(refused, "empty population must be refused").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_RUN_EMPTY");
    expect(await resultEmployees(runId)).toEqual([]);
  }, 90_000);
});

// ---- O8 partial-year tax subject ---------------------------------------------------

describe("[O8] partialYearTaxSubject is false for every employee", () => {
  it("a December run for a mid-year joiner withholds the amount of the engine with partialYearTaxSubject=false (never the true variant)", async () => {
    const world = await makeWorld();
    const empId = randomUUID();
    createdEmployees.push(empId);
    await asTenant(async (conn) => {
      await insertEmployee(conn, {
        tenantId: tenant.id,
        outletId: fixtureOutlet.id,
        entityId: world.entityId,
        id: empId,
        name: `Populasi ${++counter}`,
        joinDate: "2026-07-01",
      });
      await insertSalary(conn, {
        tenantId: tenant.id,
        employeeId: empId,
        amount: HIGH_SALARY,
        createdBy: runnerId,
        effectiveFrom: "2026-07-01",
      });
    });
    const put = await hr
      .put(`/api/hris/employees/${empId}/pii`)
      .set(originHeader)
      .send({ nik: digits(16), npwp: digits(15), idempotencyKey: key() });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const runId = await draftRun(world, DEC);
    await simulateRun(runId);

    const stored = await asTenant(async (conn) => {
      const row = (
        await conn.query(
          `SELECT payslip_id, result_encrypted, pii_key_version FROM payroll_run_results
            WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
          [tenant.id, runId, empId],
        )
      ).rows[0];
      return JSON.parse(
        openPayrollValue(
          row.result_encrypted,
          {
            tenantId: tenant.id,
            table: "payroll_run_results",
            rowId: row.payslip_id,
            field: "result",
          } as never,
          row.pii_key_version,
        ),
      ) as { calculation: { grossIdr: number; pph21Idr: number } };
    });

    const oracle = (partialYearTaxSubject: boolean) =>
      Number(
        computePayslipTax({
          tables: REFERENCE_TABLES,
          policy: DEFAULT_PPH21_POLICY,
          ptkpStatus: "TK/0",
          hasTaxId: true,
          lastTaxPeriod: true,
          monthsWorked: 6,
          partialYearTaxSubject,
          contractTaxScheme: "gross",
          earnings: [
            {
              amountIdr: idr(stored.calculation.grossIdr),
              taxable: true,
              taxScheme: "gross",
            },
          ],
          employerBenefitIdr: 0,
          employeeDeductibleIdr: 0,
          prior: {
            taxableGrossIdr: 0,
            employeeDeductibleIdr: 0,
            pph21WithheldIdr: 0,
            pph21EmployerBorneIdr: 0,
          },
        }).tax.pph21Idr,
      );
    const wrong = oracle(true);
    const right = oracle(false);
    expect(
      right,
      "oracle sanity: true and false must differ for the test to mean anything",
    ).not.toBe(wrong);
    expect(stored.calculation.pph21Idr).toBe(right);
  }, 120_000);
});
