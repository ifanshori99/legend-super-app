// Service-charge pool calculation and distribution (bead legend-pf9u7).
// Written fail-first from the shared contract (`@starter/shared/hris/payroll`
// service-charge.ts: pool state machine, `distributeServiceChargePool`,
// PAYROLL_INVALID_TRANSITION), the table definitions and the brief
// docs/briefs/538-g2-work.md, NOT from any implementation.
//
// Service API under test (names chosen by this test, recorded in the brief):
//   calculateServiceChargePoolAllocations(scope, actorUserId, poolId)
//     draft|calculated -> calculated; rewrites the pool's allocations.
//   distributeServiceChargePoolToRun(scope, actorUserId, poolId, { payrollRunId })
//     approved -> distributed in one transaction.
// Both import from "../services/payroll-service-charge.service.ts".
//
// Assumptions (spec silent):
//  - Participants = active employees whose home outlet is the pool outlet, whose
//    position has service_charge_points > 0 and whose employment type is in the
//    rule. Rule used here: method "points", minAttendanceDays 0 (no attendance
//    data needed).
//  - Distributing is allowed only while the run is draft/simulated (founder Q42);
//    hr_approved/approved/locked/paid/reversed are refused with 409
//    (PAYROLL_RUN_FROZEN or PAYROLL_INVALID_TRANSITION).
//  - Allocations whose sum differs from the pool amount are refused (409 or 422).
//  - Both functions require payroll.run (403 otherwise), checked before the
//    pool is looked up. A foreign tenant's caller has no role there, so 403 or
//    404 are both accepted for the cross-tenant cases.
//  - distribute requires the run to be runType 'regular', of the same legal
//    entity as the pool's outlet, and to cover the pool's whole period (409 or
//    422 otherwise); a frozen run stays 409.
//  - Pools reach `approved` here by direct SQL (approve is not in this slice).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import * as service from "../services/payroll-service-charge.service.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdPools: string[] = [];
const createdEmployees: string[] = [];
const createdPositions: string[] = [];

const RULE = {
  method: "points",
  minAttendanceDays: 0,
  eligibleEmploymentTypes: ["pkwtt"],
};

const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; code?: string; message: string };
  }
  throw new Error("Expected a failure");
}

let actor: string;
/** Signed-in user without any payroll role (403 cases). */
let outsider: string;
const createdRoles: string[] = [];
const createdRuns: string[] = [];
const createdPolicies: string[] = [];
const createdEntities: string[] = [];
const createdOutlets: string[] = [];
/**
 * A fresh outlet of the tenant per test (beforeEach), so neither other suites'
 * employees nor earlier tests' participants take part in a pool.
 */
let outletId: string;
let legalEntityId: string;

/** Each seeded pool/run gets its own month, far in the future. */
let monthSeq = 0;
function nextPeriod() {
  const month = monthSeq++;
  const year = 2120 + Math.floor(month / 12);
  const mm = String((month % 12) + 1).padStart(2, "0");
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-28` };
}

/** Gives the user payroll.view + payroll.run at tenant scope. */
async function grantPayrollRole(userId: string) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `SC distribution ${roleId.slice(0, 8)}`,
        JSON.stringify(["payroll.view", "payroll.run"]),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const client = agent(app);
  await signUp(client, "SC distribution actor");
  const session = await client.get("/api/auth/get-session");
  actor = session.body.user.id as string;
  createdUsers.push(actor);
  await grantPayrollRole(actor);
  const other = agent(app);
  await signUp(other, "SC distribution outsider");
  outsider = (await other.get("/api/auth/get-session")).body.user.id as string;
  createdUsers.push(outsider);

  // Frozen runs belong to this suite's entity, so parallel payroll suites
  // using the fixture entity keep their own editable payroll periods.
  legalEntityId = randomUUID();
  createdEntities.push(legalEntityId);
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'PT SC distribusi terisolasi', false)`,
      [legalEntityId, tenant.id],
    ),
  );
});

beforeEach(async () => {
  outletId = randomUUID();
  createdOutlets.push(outletId);
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, $4, $2, 'Outlet SC distribusi', 'Jl. Uji',
              'Asia/Jakarta', opening_hours, 'active'
         FROM outlets WHERE id = $3`,
      [
        outletId,
        `SCD-${outletId.slice(0, 6).toUpperCase()}`,
        outletA!.id,
        legalEntityId,
      ],
    ),
  );
});

afterAll(async () => {
  await asTenant(tenant.id, async (db) => {
    // Allocations of approved/distributed pools are locked by a guard trigger.
    await db.query("SET LOCAL session_replication_role = replica");
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
      "DELETE FROM positions WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdPositions],
    );
    // FK order (children first): pools -> runs -> policies -> employees (home
    // outlet) -> outlets, legal entities. The locked runs must go: they freeze
    // the shared tenant's periods for the other payroll suites (guard 8xf32).
    await db.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await db.query(
      "DELETE FROM payroll_policies WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdPolicies],
    );
    await db.query(
      "DELETE FROM outlets WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEntities],
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

async function seedParticipant(
  points: string,
  options: {
    status?: string;
    employmentType?: string;
    homeOutletId?: string;
  } = {},
): Promise<string> {
  const positionId = randomUUID();
  const employeeId = randomUUID();
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO positions (id, tenant_id, name, service_charge_points, is_active)
       VALUES ($1, $2, $3, $4, true)`,
      [positionId, tenant.id, `Posisi SC ${positionId.slice(0, 8)}`, points],
    );
    await db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, position_id)
       VALUES ($1, $2, $3, 'Karyawan SC distribusi', $4, $5, '2025-03-01', $6, $7)`,
      [
        employeeId,
        tenant.id,
        `SCD-${employeeId.slice(0, 8).toUpperCase()}`,
        options.homeOutletId ?? outletId,
        options.employmentType ?? "pkwtt",
        options.status ?? "active",
        positionId,
      ],
    );
  });
  createdPositions.push(positionId);
  createdEmployees.push(employeeId);
  return employeeId;
}

type PoolStatus = "draft" | "calculated" | "approved" | "cancelled";

async function seedPool(
  amountIdr: number,
  status: PoolStatus = "draft",
): Promise<string> {
  const id = randomUUID();
  const period = nextPeriod();
  // The database only accepts a pool created as draft; walk it to its status
  // along the contract's state machine (draft -> calculated -> approved).
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO service_charge_pools
         (id, tenant_id, outlet_id, period_start, period_end, amount_idr, rule, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)`,
      [
        id,
        tenant.id,
        outletId,
        period.start,
        period.end,
        amountIdr,
        JSON.stringify(RULE),
        actor,
      ],
    );
    if (status === "draft") return;
    if (status === "cancelled") {
      await db.query(
        "UPDATE service_charge_pools SET status = 'cancelled' WHERE id = $1",
        [id],
      );
      return;
    }
    await db.query(
      "UPDATE service_charge_pools SET status = 'calculated' WHERE id = $1",
      [id],
    );
    if (status === "approved")
      await db.query(
        `UPDATE service_charge_pools
            SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE id = $1`,
        [id, actor],
      );
  });
  createdPools.push(id);
  return id;
}

const shiftDay = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Walks a payroll run through the real state machine up to `status`. By default
 * a regular run of the pool's legal entity covering exactly the pool's period.
 * Every run gets its own payroll policy, so the live-run unique index
 * (policy, period start) never collides.
 */
async function seedRun(
  poolId: string,
  status:
    | "draft"
    | "simulated"
    | "hr_approved"
    | "approved"
    | "locked"
    | "paid"
    | "reversed",
  options: {
    runType?: "regular" | "off_cycle";
    otherEntity?: boolean;
    startShiftDays?: number;
    endShiftDays?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const policyId = randomUUID();
  createdRuns.push(id);
  createdPolicies.push(policyId);
  await asTenant(tenant.id, async (db) => {
    const pool = (
      await db.query(
        "SELECT period_start::text AS s, period_end::text AS e FROM service_charge_pools WHERE id = $1",
        [poolId],
      )
    ).rows[0] as { s: string; e: string };
    const start = shiftDay(pool.s, options.startShiftDays ?? 0);
    const end = shiftDay(pool.e, options.endShiftDays ?? 0);
    let entityId = legalEntityId;
    if (options.otherEntity) {
      entityId = randomUUID();
      createdEntities.push(entityId);
      await db.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT SC lain', false)`,
        [entityId, tenant.id],
      );
    }
    const groupCode = `SC${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group, cycle,
          pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan SC distribusi', $4, $5, '{"kind":"monthly"}',
               'none', 'low', '[]')`,
      [
        policyId,
        tenant.id,
        entityId,
        groupCode,
        JSON.stringify({ code: groupCode }),
      ],
    );
    await db.query(
      `INSERT INTO payroll_runs
         (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
          pay_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'sc-distribution-test')`,
      [
        id,
        tenant.id,
        entityId,
        policyId,
        options.runType ?? "regular",
        start,
        end,
      ],
    );
    if (status === "draft") return;
    const step = (sql: string, values: unknown[] = []) =>
      db.query(`UPDATE payroll_runs SET ${sql} WHERE id = $1`, [id, ...values]);
    await step(`status = 'simulated'`);
    if (status === "simulated") return;
    await step(
      `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
    );
    if (status === "hr_approved") return;
    await step(
      `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
    );
    if (status === "approved") return;
    await step(
      `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
    );
    if (status === "paid")
      await step(`status = 'paid', paid_at = now(), paid_by = 'pay-user'`);
    if (status === "reversed")
      await step(`status = 'reversed', reversal = '{"status":"approved"}'`);
  });
  return id;
}

async function allocationsOf(poolId: string) {
  const rows = await asTenant(tenant.id, (db) =>
    db.query(
      `SELECT employee_id, amount_idr::text AS amount
         FROM service_charge_allocations WHERE tenant_id = $1 AND pool_id = $2
         ORDER BY employee_id`,
      [tenant.id, poolId],
    ),
  );
  return rows.rows.map((row) => ({
    employeeId: row.employee_id as string,
    amount: BigInt(row.amount as string),
  }));
}

async function allocatedTotal(poolId: string): Promise<bigint> {
  return (await allocationsOf(poolId)).reduce((sum, a) => sum + a.amount, 0n);
}

async function poolRow(poolId: string) {
  const rows = await asTenant(tenant.id, (db) =>
    db.query(
      `SELECT status, payroll_run_id, amount_idr::text AS amount
         FROM service_charge_pools WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, poolId],
    ),
  );
  return rows.rows[0] as {
    status: string;
    payroll_run_id: string | null;
    amount: string;
  };
}

const calculate = (poolId: string) =>
  service.calculateServiceChargePoolAllocations(
    scope(tenant.id),
    actor,
    poolId,
  );
const distribute = (poolId: string, payrollRunId: string) =>
  service.distributeServiceChargePoolToRun(scope(tenant.id), actor, poolId, {
    payrollRunId,
  });

/** An approved pool with real allocations, ready to distribute. */
async function approvedPoolWithAllocations(
  amountIdr = 1_000_001,
  /** Rupiah added to the largest share before approval (allocations are locked after). */
  tamperBy = 0,
) {
  await seedParticipant("3.0000");
  await seedParticipant("2.0000");
  const poolId = await seedPool(amountIdr);
  await calculate(poolId);
  if (tamperBy !== 0)
    await asTenant(tenant.id, (db) =>
      db.query(
        `UPDATE service_charge_allocations SET amount_idr = amount_idr + $3
          WHERE id = (SELECT id FROM service_charge_allocations
                       WHERE tenant_id = $1 AND pool_id = $2 ORDER BY amount_idr DESC LIMIT 1)`,
        [tenant.id, poolId, tamperBy],
      ),
    );
  await asTenant(tenant.id, (db) =>
    db.query(
      `UPDATE service_charge_pools
          SET status = 'approved', approved_by = $3, approved_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, poolId, actor],
    ),
  );
  return poolId;
}

describe("service-charge pool calculate", () => {
  it("splits the pool across eligible participants and the shares add up to the pool", async () => {
    const heavy = await seedParticipant("3.0000");
    const light = await seedParticipant("1.0000");
    // Not eligible: zero points, not active, other employment type, other outlet.
    await seedParticipant("0.0000");
    await seedParticipant("5.0000", { status: "terminated" });
    await seedParticipant("5.0000", { employmentType: "intern" });
    await seedParticipant("5.0000", { homeOutletId: outletA!.id });
    // 1_000_001 does not divide evenly, so the remainder must land somewhere.
    const poolId = await seedPool(1_000_001);

    await calculate(poolId);

    const allocations = await allocationsOf(poolId);
    expect(allocations.map((a) => a.employeeId).sort()).toEqual(
      [heavy, light].sort(),
    );
    expect(await allocatedTotal(poolId)).toBe(1_000_001n);
    for (const allocation of allocations)
      expect(allocation.amount).toBeGreaterThanOrEqual(0n);
    const byEmployee = new Map(
      allocations.map((a) => [a.employeeId, a.amount]),
    );
    expect(byEmployee.get(heavy)!).toBeGreaterThan(byEmployee.get(light)!);
    expect((await poolRow(poolId)).status).toBe("calculated");
  });

  it("is idempotent: calculating again gives the same shares, no duplicates", async () => {
    await seedParticipant("2.0000");
    await seedParticipant("2.0000");
    await seedParticipant("1.0000");
    const poolId = await seedPool(999_999);

    await calculate(poolId);
    const first = await allocationsOf(poolId);
    await calculate(poolId);
    const second = await allocationsOf(poolId);

    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
    expect(await allocatedTotal(poolId)).toBe(999_999n);
    expect((await poolRow(poolId)).status).toBe("calculated");
  });

  it("a pool with money but no eligible participant is refused and nothing is written", async () => {
    // Participants exist elsewhere but none qualify for this outlet's pool.
    const emptyOutlet = randomUUID();
    createdOutlets.push(emptyOutlet);
    await asTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet SC kosong', 'Jl. Uji',
                'Asia/Jakarta', opening_hours, 'active'
           FROM outlets WHERE id = $3`,
        [
          emptyOutlet,
          `SCE-${emptyOutlet.slice(0, 6).toUpperCase()}`,
          outletA!.id,
        ],
      ),
    );
    const poolId = randomUUID();
    const period = nextPeriod();
    await asTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO service_charge_pools
           (id, tenant_id, outlet_id, period_start, period_end, amount_idr, rule, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 500000, $6, 'draft', $7)`,
        [
          poolId,
          tenant.id,
          emptyOutlet,
          period.start,
          period.end,
          JSON.stringify(RULE),
          actor,
        ],
      ),
    );
    createdPools.push(poolId);

    const error = await failure(calculate(poolId));
    expect(error.status).toBe(409);
    expect(error.code).toBe("PAYROLL_INVALID_TRANSITION");
    expect(await allocationsOf(poolId)).toEqual([]);
    expect((await poolRow(poolId)).status).toBe("draft");
  });

  it("a participant whose position has zero points never receives money", async () => {
    const zero = await seedParticipant("0.0000");
    const paid = await seedParticipant("1.0000");
    const poolId = await seedPool(100_000);
    await calculate(poolId);
    const allocations = await allocationsOf(poolId);
    expect(allocations.find((a) => a.employeeId === zero)?.amount ?? 0n).toBe(
      0n,
    );
    expect(allocations.find((a) => a.employeeId === paid)?.amount).toBe(
      100_000n,
    );
  });

  it("refuses to calculate an approved, cancelled or distributed pool and keeps its shares", async () => {
    const approved = await approvedPoolWithAllocations();
    const before = await allocationsOf(approved);
    const approvedError = await failure(calculate(approved));
    expect(approvedError.status).toBe(409);
    expect(approvedError.code).toBe("PAYROLL_INVALID_TRANSITION");
    expect(await allocationsOf(approved)).toEqual(before);
    expect((await poolRow(approved)).status).toBe("approved");

    const cancelled = await seedPool(10_000, "cancelled");
    expect((await failure(calculate(cancelled))).code).toBe(
      "PAYROLL_INVALID_TRANSITION",
    );
    expect(await allocationsOf(cancelled)).toEqual([]);

    const distributedId = await approvedPoolWithAllocations();
    await distribute(distributedId, await seedRun(distributedId, "draft"));
    const frozen = await allocationsOf(distributedId);
    expect((await failure(calculate(distributedId))).code).toBe(
      "PAYROLL_INVALID_TRANSITION",
    );
    expect(await allocationsOf(distributedId)).toEqual(frozen);
    expect((await poolRow(distributedId)).status).toBe("distributed");
  });

  it("refuses a pool of another tenant (403 or 404)", async () => {
    await seedParticipant("1.0000");
    const poolId = await seedPool(50_000);
    const error = await failure(
      service.calculateServiceChargePoolAllocations(
        scope(randomUUID()),
        actor,
        poolId,
      ),
    );
    expect([403, 404]).toContain(error.status);
    expect(await allocationsOf(poolId)).toEqual([]);
    expect((await poolRow(poolId)).status).toBe("draft");
  });
});

describe("service-charge pool distribute", () => {
  it.each(["draft", "simulated"] as const)(
    "moves an approved pool to a %s run; allocations still equal the pool",
    async (status) => {
      const poolId = await approvedPoolWithAllocations(1_000_001);
      const before = await allocationsOf(poolId);
      const runId = await seedRun(poolId, status);

      await distribute(poolId, runId);

      const pool = await poolRow(poolId);
      expect(pool.status).toBe("distributed");
      expect(pool.payroll_run_id).toBe(runId);
      // Nobody is paid more than the pool.
      expect(await allocationsOf(poolId)).toEqual(before);
      expect(await allocatedTotal(poolId)).toBe(BigInt(pool.amount));
    },
  );

  it("distributing twice is refused and changes nothing (idempotent, no double pay)", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft");
    await distribute(poolId, runId);
    const before = await allocationsOf(poolId);

    const otherRun = await seedRun(poolId, "draft");
    const again = await failure(distribute(poolId, otherRun));
    expect(again.status).toBe(409);
    expect(again.code).toBe("PAYROLL_INVALID_TRANSITION");
    const same = await failure(distribute(poolId, runId));
    expect(same.code).toBe("PAYROLL_INVALID_TRANSITION");

    expect(await allocationsOf(poolId)).toEqual(before);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("distributed");
    expect(pool.payroll_run_id).toBe(runId);
  });

  it("two simultaneous distributions: exactly one wins, money is paid once", async () => {
    const poolId = await approvedPoolWithAllocations(777_777);
    const runA = await seedRun(poolId, "draft");
    const runB = await seedRun(poolId, "draft");
    const results = await Promise.allSettled([
      distribute(poolId, runA),
      distribute(poolId, runB),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("distributed");
    expect([runA, runB]).toContain(pool.payroll_run_id);
    expect(await allocatedTotal(poolId)).toBe(777_777n);
  });

  it("refuses a pool that is not approved", async () => {
    await seedParticipant("1.0000");
    const draft = await seedPool(100_000, "draft");
    const calculated = await seedPool(100_000, "draft");
    await calculate(calculated);
    const cancelled = await seedPool(100_000, "cancelled");

    for (const [poolId, status] of [
      [draft, "draft"],
      [calculated, "calculated"],
      [cancelled, "cancelled"],
    ] as const) {
      const runId = await seedRun(poolId, "draft");
      const error = await failure(distribute(poolId, runId));
      expect(error.status, status).toBe(409);
      expect(error.code, status).toBe("PAYROLL_INVALID_TRANSITION");
      const pool = await poolRow(poolId);
      expect(pool.status).toBe(status);
      expect(pool.payroll_run_id).toBeNull();
    }
  });

  it.each(["hr_approved", "approved"] as const)(
    "[538-G2b/Q42] refuses distribution to a %s run without adding payroll money",
    async (status) => {
      const poolId = await approvedPoolWithAllocations(500_001);
      const before = await allocationsOf(poolId);
      const runId = await seedRun(poolId, status);

      const error = await failure(distribute(poolId, runId));

      expect(error.status).toBe(409);
      expect(error.code).toBe("PAYROLL_RUN_FROZEN");
      const pool = await poolRow(poolId);
      expect(pool.status).toBe("approved");
      expect(pool.payroll_run_id).toBeNull();
      expect(await allocationsOf(poolId)).toEqual(before);
      expect(await allocatedTotal(poolId)).toBe(500_001n);
    },
  );

  it("refuses to distribute into a locked, paid or reversed run (frozen period)", async () => {
    const poolId = await approvedPoolWithAllocations();
    const before = await allocationsOf(poolId);
    for (const status of ["locked", "paid", "reversed"] as const) {
      const runId = await seedRun(poolId, status);
      const error = await failure(distribute(poolId, runId));
      expect(error.status, status).toBe(409);
      expect(["PAYROLL_RUN_FROZEN", "PAYROLL_INVALID_TRANSITION"]).toContain(
        error.code,
      );
      const pool = await poolRow(poolId);
      expect(pool.status).toBe("approved");
      expect(pool.payroll_run_id).toBeNull();
      expect(await allocationsOf(poolId)).toEqual(before);
    }
  });

  it("refuses when the allocations do not add up to the pool, in either direction", async () => {
    // One rupiah too little / too much, set while the pool is still editable.
    const under = await approvedPoolWithAllocations(500_000, -1);
    const over = await approvedPoolWithAllocations(500_000, 1);

    for (const poolId of [under, over]) {
      const runId = await seedRun(poolId, "draft");
      const error = await failure(distribute(poolId, runId));
      expect([409, 422]).toContain(error.status);
      const pool = await poolRow(poolId);
      expect(pool.status).toBe("approved");
      expect(pool.payroll_run_id).toBeNull();
    }
  });

  it("refuses an approved pool with money but no allocations", async () => {
    const poolId = await seedPool(250_000, "approved");
    const error = await failure(
      distribute(poolId, await seedRun(poolId, "draft")),
    );
    expect([409, 422]).toContain(error.status);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("approved");
    expect(pool.payroll_run_id).toBeNull();
  });

  it("refuses a pool of another tenant and 404 for an unknown run", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft");
    const error = await failure(
      service.distributeServiceChargePoolToRun(
        scope(randomUUID()),
        actor,
        poolId,
        { payrollRunId: runId },
      ),
    );
    // No role in a foreign tenant: refused as 403 or 404, nothing changes.
    expect([403, 404]).toContain(error.status);
    expect((await poolRow(poolId)).status).toBe("approved");

    const unknownRun = await failure(distribute(poolId, randomUUID()));
    expect(unknownRun.status).toBe(404);
    expect((await poolRow(poolId)).status).toBe("approved");
  });
});

describe("service-charge pool: permission and run eligibility", () => {
  it("calculate answers 403 without payroll.run and writes nothing", async () => {
    await seedParticipant("1.0000");
    const poolId = await seedPool(100_000);
    const error = await failure(
      service.calculateServiceChargePoolAllocations(
        scope(tenant.id),
        outsider,
        poolId,
      ),
    );
    expect(error.status).toBe(403);
    expect(await allocationsOf(poolId)).toEqual([]);
    expect((await poolRow(poolId)).status).toBe("draft");
  });

  it("distribute answers 403 without payroll.run and pays nothing", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft");
    const error = await failure(
      service.distributeServiceChargePoolToRun(
        scope(tenant.id),
        outsider,
        poolId,
        { payrollRunId: runId },
      ),
    );
    expect(error.status).toBe(403);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("approved");
    expect(pool.payroll_run_id).toBeNull();
  });

  it("refuses a run that is not a regular run (e.g. off-cycle)", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft", { runType: "off_cycle" });
    const error = await failure(distribute(poolId, runId));
    expect([409, 422]).toContain(error.status);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("approved");
    expect(pool.payroll_run_id).toBeNull();
  });

  it("refuses a run of another legal entity than the pool's outlet", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft", { otherEntity: true });
    const error = await failure(distribute(poolId, runId));
    expect([409, 422]).toContain(error.status);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("approved");
    expect(pool.payroll_run_id).toBeNull();
  });

  it("refuses a run whose period does not cover the pool's whole period", async () => {
    const poolId = await approvedPoolWithAllocations();
    const cases = {
      "ends a day early": { endShiftDays: -1 },
      "starts a day late": { startShiftDays: 1 },
      "a different period": { startShiftDays: 60, endShiftDays: 60 },
    } as const;
    for (const [label, shift] of Object.entries(cases)) {
      const runId = await seedRun(poolId, "draft", shift);
      const error = await failure(distribute(poolId, runId));
      expect([409, 422], label).toContain(error.status);
      const pool = await poolRow(poolId);
      expect(pool.status, label).toBe("approved");
      expect(pool.payroll_run_id, label).toBeNull();
    }
  });

  it("accepts a regular run of the same entity whose period is wider than the pool's", async () => {
    const poolId = await approvedPoolWithAllocations();
    const runId = await seedRun(poolId, "draft", {
      startShiftDays: -1,
      endShiftDays: 2,
    });
    await distribute(poolId, runId);
    const pool = await poolRow(poolId);
    expect(pool.status).toBe("distributed");
    expect(pool.payroll_run_id).toBe(runId);
  });
});
