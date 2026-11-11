// An employee pay component cannot be backdated into a locked payroll period
// (bead legend-8xf32; PRD PAYR-02: a locked run freezes its inputs; contract
// setEmployeePayComponent in packages/shared/src/hris/payroll/components.ts:
// "sets an amount from a date; the server closes the previous row").
//
// Rule under test: setEmployeePayComponent refuses effectiveFrom <= the
// period_end of the tenant's latest LOCKED payroll run, because closing the
// previous row backwards would rewrite the amount of a month already paid.
// Draft/simulated runs do not lock. Locked runs of another tenant do not count.
//
// The service is called directly with a disposable tenant's context (an HTTP
// call would hit the shared Cafe Legend tenant, and a locked run there would
// block other suites' backdated rows).
//
// Assumptions (spec ambiguous):
//  - The refusal is a 4xx domain error (409 PAYROLL_RUN_FROZEN or 422); the
//    exact code is not pinned, only "not 2xx and nothing changed".
//  - "Latest locked run" is by period_end across the tenant (the employee's
//    legal entity is the only one seeded, so per-entity scoping also passes).
//  - The explicit rapel (back-pay) flow has no contract yet, so it is not
//    tested here (see it.todo).
//
// Fail-first expectation: today the backdated calls succeed, so the
// "refuses" tests fail on `expect(error.status)`/"Expected a failure".
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import * as service from "../services/payroll-components.service.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

type Seed = {
  tenantId: string;
  entityId: string;
  employeeId: string;
  componentId: string;
  policyId: string;
};

const createdTenants: string[] = [];
const createdUsers: string[] = [];
let actorUserId: string;
let locked: Seed; // locked runs: March 2030 and April 2030; draft run: May 2030
let clean: Seed; // no payroll runs at all (isolation + regression)

const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const key = () => `locked-period-${randomUUID()}`;

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

/** Walks a run to the given end state with distinct approvers (never the creator). */
const STEPS: Record<string, string> = {
  simulated: `status = 'simulated'`,
  hr_approved: `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  approved: `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  locked: `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
};

async function insertRun(
  client: PoolClient,
  seed: Seed,
  periodStart: string,
  periodEnd: string,
  until: "draft" | "locked",
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
        period_start, period_end, pay_date, created_by)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'payroll-locked-period-test')`,
    [id, seed.tenantId, seed.entityId, seed.policyId, periodStart, periodEnd],
  );
  if (until === "locked")
    for (const step of ["simulated", "hr_approved", "approved", "locked"])
      await client.query(
        `UPDATE payroll_runs SET ${STEPS[step]} WHERE id = $1`,
        [id],
      );
}

/** Gives the actor payroll.view + payroll.run at tenant scope (as payroll-components-api.test.ts). */
async function grantPayrollRole(userId: string, tenantId: string) {
  const roleId = randomUUID();
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Locked period ${roleId.slice(0, 8)}`,
        JSON.stringify(["payroll.view", "payroll.run"]),
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

async function seedTenant(label: string): Promise<Seed> {
  const tenantId = randomUUID();
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenantId,
      `locked-period-${label}-${tenantId.slice(0, 8)}`,
      fixtureTenant,
      `Locked period tenant ${label}`,
    ],
  );
  const seed: Seed = {
    tenantId,
    entityId: randomUUID(),
    employeeId: randomUUID(),
    componentId: randomUUID(),
    policyId: randomUUID(),
  };
  const brandId = randomUUID();
  const outletId = randomUUID();
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [brandId, tenantId],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Locked Period', false)`,
      [seed.entityId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'L-01', 'Outlet L', 'Jl. L', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [outletId, tenantId, brandId, seed.entityId],
    );
    await client.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Periode Terkunci', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        seed.employeeId,
        tenantId,
        `LP-${seed.employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
    await client.query(
      `INSERT INTO pay_components
         (id, tenant_id, code, name, category, kind, recurrence, taxable, tax_scheme,
          bpjs_base, overtime_base, thr_base)
       VALUES ($1, $2, 'GAJI_LP', 'Gaji pokok', 'base_salary', 'earning', 'fixed',
               true, 'gross', true, true, true)`,
      [seed.componentId, tenantId],
    );
    await client.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group,
          cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan LP', 'LP1', $4, $5, 'none', 'low', '[]')`,
      [
        seed.policyId,
        tenantId,
        seed.entityId,
        JSON.stringify({ code: "LP1" }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
  });
  return seed;
}

async function rowsOf(seed: Seed) {
  return asTenant(seed.tenantId, async (client) => {
    const result = await client.query(
      `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
              to_char(effective_to, 'YYYY-MM-DD') AS effective_to
         FROM employee_pay_components
        WHERE tenant_id = $1 AND employee_id = $2 AND component_id = $3
        ORDER BY effective_from`,
      [seed.tenantId, seed.employeeId, seed.componentId],
    );
    return result.rows as {
      effective_from: string;
      effective_to: string | null;
    }[];
  });
}

const setFrom = (seed: Seed, effectiveFrom: string, amountIdr = 5_000_000) =>
  service.setEmployeePayComponent(
    scope(seed.tenantId),
    actorUserId,
    seed.employeeId as never,
    {
      componentId: seed.componentId as never,
      amountIdr: amountIdr as never,
      effectiveFrom: effectiveFrom as never,
      idempotencyKey: key(),
    },
  );

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("Expected a failure, but the call succeeded");
}

/** The refusal is a 4xx domain error (409 frozen / 422), never a 5xx or success. */
function expectRefused(error: { status?: number }) {
  expect([409, 422]).toContain(error.status);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const client = agent(app);
  await signUp(client, "Locked period actor");
  const session = await client.get("/api/auth/get-session");
  actorUserId = session.body.user.id as string;
  createdUsers.push(actorUserId);

  locked = await seedTenant("locked");
  clean = await seedTenant("clean");
  await grantPayrollRole(actorUserId, locked.tenantId);
  await grantPayrollRole(actorUserId, clean.tenantId);
  await asTenant(locked.tenantId, async (client) => {
    await insertRun(client, locked, "2030-03-01", "2030-03-31", "locked");
    await insertRun(client, locked, "2030-04-01", "2030-04-30", "locked");
    // A draft run does not freeze anything.
    await insertRun(client, locked, "2030-05-01", "2030-05-31", "draft");
  });
});

afterAll(async () => {
  // Best effort: locked runs are immutable, so the owner skips triggers for cleanup only.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const tenantId of createdTenants) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      for (const table of [
        "hris_idempotency",
        "role_assignments",
        "roles",
        "payroll_runs",
        "payroll_policies",
        "employee_pay_components",
        "pay_components",
        "employees",
        "outlets",
        "legal_entities",
        "brands",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenantId,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("setEmployeePayComponent and locked payroll periods (legend-8xf32)", () => {
  it("[8xf32] refuses an effectiveFrom inside an earlier locked period and changes nothing", async () => {
    const error = await failure(setFrom(locked, "2030-03-15"));
    expectRefused(error);
    expect(await rowsOf(locked)).toEqual([]);
  });

  it("[8xf32] refuses an effectiveFrom before every locked period", async () => {
    expectRefused(await failure(setFrom(locked, "2029-01-01")));
    expect(await rowsOf(locked)).toEqual([]);
  });

  it("[8xf32] refuses an effectiveFrom inside the latest locked period", async () => {
    expectRefused(await failure(setFrom(locked, "2030-04-15")));
    expect(await rowsOf(locked)).toEqual([]);
  });

  it("[8xf32] refuses an effectiveFrom equal to the last day of the latest locked period (<=)", async () => {
    expectRefused(await failure(setFrom(locked, "2030-04-30")));
    expect(await rowsOf(locked)).toEqual([]);
  });

  it("[8xf32] accepts the day after the latest locked period, and a draft run does not block it", async () => {
    // 2030-05-01 sits inside the draft May run, which is not locked.
    await setFrom(locked, "2030-05-01", 5_000_000);
    expect(await rowsOf(locked)).toEqual([
      { effective_from: "2030-05-01", effective_to: null },
    ]);
  });

  it("[8xf32] a later change closes the previous row at the day before and keeps paid months untouched", async () => {
    await setFrom(locked, "2030-06-01", 6_000_000);
    expect(await rowsOf(locked)).toEqual([
      { effective_from: "2030-05-01", effective_to: "2030-05-31" },
      { effective_from: "2030-06-01", effective_to: null },
    ]);
    // Backdating into the locked months now would have to rewrite the row above.
    expectRefused(await failure(setFrom(locked, "2030-04-20", 9_000_000)));
    expect(await rowsOf(locked)).toEqual([
      { effective_from: "2030-05-01", effective_to: "2030-05-31" },
      { effective_from: "2030-06-01", effective_to: null },
    ]);
  });

  it("[8xf32] a tenant without locked runs may still backdate, and another tenant's locked runs do not block it", async () => {
    // `clean` has no runs; `locked` (a different tenant) locked 2030-03/04.
    await setFrom(clean, "2030-03-15", 4_000_000);
    expect(await rowsOf(clean)).toEqual([
      { effective_from: "2030-03-15", effective_to: null },
    ]);
  });

  // The explicit rapel (back-pay) flow is named by the card but no contract
  // defines its endpoint or marker yet; write the test once it does.
  it.todo("[8xf32] accepts a backdated amount through the explicit rapel flow");
});
