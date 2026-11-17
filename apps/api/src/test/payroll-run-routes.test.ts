// Payroll run ROUTES: create, HR approval, final approval, return-to-draft
// (bead legend-vepv0, decision O6; PRD PAYR-01 "only a run approved at two levels
// by two people locks"; founder rule "jangan sampai rugi": nobody is paid twice,
// no stale approval survives a return to draft). Fail-first: written before the
// routes exist. Expected behavior comes from packages/shared (endpoints.ts,
// run.ts transitions + side effects, errors.ts status map), not from the API code.
//
// RULES UNDER TEST
//  1. [create] POST /runs derives the period from referenceDate, answers the run
//     in `draft` with no totals, approvals or events. Replaying the same
//     idempotencyKey returns the same run (one row).
//  2. [create-duplicate] a second live regular run for the same policy and
//     period is 409 (also when both race); exactly one row exists.
//  3. [approve-hr] simulated -> hr_approved, records approvedByHr, writes exactly
//     one `approval_requested` event (PAYROLL_RUN_SIDE_EFFECTS.approve_hr).
//  4. [approve-final] hr_approved -> approved, records approvedByFinance, no event.
//  5. [approve-twice] the second approval of the same level is 409
//     PAYROLL_RUN_INVALID_TRANSITION (also when raced): approver unchanged,
//     no second event. Same idempotencyKey replay = same answer, no new effect.
//  6. [maker-checker] creator, HR approver and final approver are three
//     different people: PAYROLL_APPROVER_NOT_DISTINCT (403), state unchanged.
//     Final before HR approval is refused (409).
//  7. [return-to-draft] simulated/hr_approved/approved -> draft clears both
//     approvals; re-approval needs a fresh simulate and fresh HR + final
//     approvals; a draft cannot be approved or returned.
//  8. [permissions] anonymous 401, foreign origin 403; create needs payroll.run,
//     approvals need payroll.approve; a body error is 422 VALIDATION_ERROR (repo convention).
//  9. [tenant-isolation] another tenant's policy/run answers 404, nothing changes.
// 10. [no-double-effects] none of the routes writes payslips or loan deductions.
//
// ASSUMPTIONS (spec silent; stated so the engineer can contest them)
//  - create status code is 200 or 201; the permission is payroll.run (brief +
//    permissions.ts comment: payroll.run / payroll.approve / payroll.lock).
//  - HR and final approval both need payroll.approve (no separate permission).
//  - return-to-draft is allowed for a user holding payroll.run + payroll.approve;
//    only a viewer is asserted as refused.
//  - A duplicate live run is 409 (conflict), a foreign-tenant id is 404.
//  - Employees have no bank account here: payment method falls back to cash (Q10).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
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
const outlet = cafeLegendPlatformFixtures.outlets[0];
const otherTenant = randomUUID();
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

const key = () => `runroutes-${randomUUID()}`;
const RUNS = "/api/hris/payroll/runs";
const REFERENCE_DATE = "2026-11-15"; // period 2026-11-01 .. 2026-11-30
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-11-28",
};

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
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
const inTenant = <T>(run: (client: PoolClient) => Promise<T>, raw = false) =>
  asTenant(tenant.id, run, raw);

async function signedInClient(name: string) {
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
  await inTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `RunRoutes ${roleId.slice(0, 8)}`,
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

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
type Actor = { client: Client; userId: string };
let maker: Actor; // payroll.view + payroll.run + payroll.approve (creator)
let hr1: Actor; // payroll.view + payroll.approve
let hr2: Actor;
let fin1: Actor;
let fin2: Actor;
let runOnly: Actor; // payroll.view + payroll.run (no approve)
let viewer: Actor; // payroll.view only
let locker: Actor; // payroll.view + payroll.lock

async function actor(name: string, permissions: string[]): Promise<Actor> {
  const made = await signedInClient(name);
  await grantRole(made.userId, permissions);
  return made;
}

let counter = 0;
type World = { entityId: string; policyId: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await inTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Rute Run ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, maker.userId);
  });
  return world;
}

async function makeEmployee(world: World) {
  const id = randomUUID();
  createdEmployees.push(id);
  await inTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id,
      name: `Rute Run ${++counter}`,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: id,
      amount: 8_000_020,
      createdBy: maker.userId,
    });
  });
  return id;
}

const post = (who: Actor, path: string, body: unknown) =>
  who.client
    .post(path)
    .set(originHeader)
    .send(body as object);

const createBody = (world: World, idempotencyKey = key()) => ({
  payrollPolicyId: world.policyId,
  runType: "regular",
  referenceDate: REFERENCE_DATE,
  thrScheduleId: null,
  idempotencyKey,
});

async function createRun(world: World, who: Actor = maker, k = key()) {
  const response = await post(who, RUNS, createBody(world, k));
  const id = response.body?.data?.id as string | undefined;
  if (id) createdRuns.push(id);
  return response;
}

/** Creates a draft run through the route and returns its id (asserts success). */
async function newRun(world: World): Promise<string> {
  const response = await createRun(world);
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data.id as string;
}

const simulate = (runId: string, who: Actor = maker) =>
  post(who, `${RUNS}/${runId}/simulate`, { idempotencyKey: key() });
/** HR approval of the simulation as loaded: the count defaults to the run's current one. */
const approveHr = async (
  runId: string,
  who: Actor,
  k = key(),
  expectedSimulationCount?: number,
) =>
  post(who, `${RUNS}/${runId}/hr-approval`, {
    expectedSimulationCount:
      expectedSimulationCount ??
      Math.max(1, (await runRowOrNull(runId))?.simulation_count ?? 1),
    idempotencyKey: k,
  });
const approveFinal = (runId: string, who: Actor, k = key()) =>
  post(who, `${RUNS}/${runId}/final-approval`, { idempotencyKey: k });
const returnToDraft = (runId: string, who: Actor = maker, reason = "Koreksi") =>
  post(who, `${RUNS}/${runId}/return-to-draft`, {
    reason,
    idempotencyKey: key(),
  });

/** A simulated run (one employee), created and simulated through the routes. */
async function simulatedRun(world?: World) {
  const w = world ?? (await makeWorld());
  await makeEmployee(w);
  const runId = await newRun(w);
  const sim = await simulate(runId);
  expect(sim.status, JSON.stringify(sim.body)).toBe(200);
  expect(sim.body.data.status).toBe("simulated");
  return { world: w, runId };
}

type RunRow = {
  status: string;
  created_by: string;
  approved_by_hr: string | null;
  approved_by_finance: string | null;
  simulation_count: number;
  totals_is_null: boolean;
};
const runRowOrNull = async (runId: string): Promise<RunRow | undefined> =>
  (
    await inTenant((conn) =>
      conn.query<RunRow>(
        `SELECT status, created_by, approved_by_hr, approved_by_finance,
                simulation_count, (totals IS NULL) AS totals_is_null
           FROM payroll_runs WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, runId],
      ),
    )
  ).rows[0];
const runRow = async (runId: string): Promise<RunRow> =>
  (await runRowOrNull(runId))!;

const countOf = async (table: string, runId: string) =>
  Number(
    (
      await inTenant((conn) =>
        conn.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = $2`,
          [tenant.id, runId],
        ),
      )
    ).rows[0].n,
  );

/** Loan deductions table is created by card xo0xx; absent = zero rows. */
const loanDeductionCount = async (runId: string) =>
  inTenant(async (conn) => {
    const exists = (
      await conn.query(
        "SELECT to_regclass('public.payroll_loan_deductions') AS t",
      )
    ).rows[0].t;
    if (exists === null) return 0;
    return countOf("payroll_loan_deductions", runId);
  });

const eventCount = async (runId: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    ).rows[0].n,
  );

const runsFor = async (policyId: string) =>
  Number(
    (
      await inTenant((conn) =>
        conn.query(
          `SELECT count(*)::int AS n FROM payroll_runs
            WHERE tenant_id = $1 AND payroll_policy_id = $2`,
          [tenant.id, policyId],
        ),
      )
    ).rows[0].n,
  );

let otherPolicy: string;
let otherRun: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const view = "payroll.view";
  maker = await actor("RunRoutes maker", [
    view,
    "payroll.run",
    "payroll.approve",
  ]);
  hr1 = await actor("RunRoutes HR 1", [view, "payroll.approve"]);
  hr2 = await actor("RunRoutes HR 2", [view, "payroll.approve"]);
  fin1 = await actor("RunRoutes finance 1", [view, "payroll.approve"]);
  fin2 = await actor("RunRoutes finance 2", [view, "payroll.approve"]);
  runOnly = await actor("RunRoutes run-only", [view, "payroll.run"]);
  viewer = await actor("RunRoutes viewer", [view]);
  locker = await actor("RunRoutes locker", [view, "payroll.lock"]);
  // The default PPh 21 policy applies: no tenant policy version.
  await inTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );

  // Tenant B: an entity, a policy and a draft run that must stay untouchable.
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Run routes tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `run-routes-${otherTenant.slice(0, 8)}`, tenant.id],
  );
  const entityId = randomUUID();
  otherPolicy = randomUUID();
  otherRun = randomUUID();
  await asTenant(otherTenant, async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Rute B', false)`,
      [entityId, otherTenant],
    );
    await insertPolicy(conn, otherTenant, entityId, otherPolicy);
    await insertDraftRun(conn, {
      tenantId: otherTenant,
      runId: otherRun,
      entityId,
      policyId: otherPolicy,
      ...NOV,
    });
  });
});

afterAll(async () => {
  await inTenant(async (conn) => {
    for (const table of [
      "payroll_run_results",
      "payroll_run_month_priors",
      "payslip_bank_snapshots",
    ])
      if (
        (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
          .rows[0].t !== null
      )
        await conn.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
          [tenant.id, createdRuns],
        );
    await conn.query(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'runroutes-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    const ownComponentIds = (
      await conn.query<{ component_id: string }>(
        "SELECT DISTINCT component_id FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
        [tenant.id, createdEmployees],
      )
    ).rows.map((row) => row.component_id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, ownComponentIds],
    );
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
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
  await asTenant(
    otherTenant,
    async (conn) => {
      await conn.query("DELETE FROM payroll_runs WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await conn.query("DELETE FROM payroll_policies WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await conn.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        otherTenant,
      ]);
    },
    true,
  );
  // Audit rows are append-only: an audited tenant stays in place.
  const audited = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 LIMIT 1",
    [otherTenant],
  );
  if ((audited.rowCount ?? 0) === 0)
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- 1. [create] -----------------------------------------------------------------

describe("[create] POST /runs", () => {
  it("creates a draft run for the period of referenceDate with no totals, approvals or events; the same key replays the same run", async () => {
    const world = await makeWorld();
    const k = key();
    const first = await createRun(world, maker, k);
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);
    const run = first.body.data;
    expect(run).toMatchObject({
      payrollPolicyId: world.policyId,
      legalEntityId: world.entityId,
      runType: "regular",
      status: "draft",
      periodStart: NOV.periodStart,
      periodEnd: NOV.periodEnd,
      totals: null,
      simulationCount: 0,
      approvedByHr: null,
      approvedByFinance: null,
      createdBy: maker.userId,
    });
    expect(await eventCount(run.id)).toBe(0);
    expect(await countOf("payslips", run.id)).toBe(0);

    const replay = await createRun(world, maker, k);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.id).toBe(run.id);
    expect(await runsFor(world.policyId)).toBe(1);
  }, 90_000);

  it("[create-validation] a missing idempotencyKey, an unknown field and a bad date are 422 VALIDATION_ERROR; nothing is written", async () => {
    const world = await makeWorld();
    const { idempotencyKey, ...withoutKey } = createBody(world);
    void idempotencyKey;
    for (const body of [
      withoutKey,
      { ...createBody(world), extra: "x" },
      { ...createBody(world), referenceDate: "15-11-2026" },
      { ...createBody(world), runType: "bonus" },
    ]) {
      const response = await post(maker, RUNS, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await runsFor(world.policyId)).toBe(0);
  }, 90_000);
});

// ---- 2. [create-duplicate] -------------------------------------------------------

describe("[create-duplicate] one live run per policy and period", () => {
  it("a second create with a new key is 409 and leaves one row", async () => {
    const world = await makeWorld();
    const first = await newRun(world);
    const second = await createRun(world);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(await runsFor(world.policyId)).toBe(1);
    expect((await runRow(first)).status).toBe("draft");
  }, 90_000);

  it("two racing creates: exactly one succeeds, one row", async () => {
    const world = await makeWorld();
    const [a, b] = await Promise.all([createRun(world), createRun(world)]);
    const statuses = [a.status, b.status].sort();
    expect(
      statuses[0],
      JSON.stringify([a.body, b.body]),
    ).toBeGreaterThanOrEqual(200);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    expect(await runsFor(world.policyId)).toBe(1);
  }, 90_000);

  it("a different period of the same policy is a separate run", async () => {
    const world = await makeWorld();
    await newRun(world);
    const december = await post(maker, RUNS, {
      ...createBody(world),
      referenceDate: "2026-12-10",
    });
    expect([200, 201], JSON.stringify(december.body)).toContain(
      december.status,
    );
    createdRuns.push(december.body.data.id);
    expect(december.body.data.periodStart).toBe("2026-12-01");
    expect(await runsFor(world.policyId)).toBe(2);
  }, 90_000);
});

// ---- 3 + 4. [approve-hr] / [approve-final] ---------------------------------------

describe("[approve] HR then final approval", () => {
  it("HR approval: simulated -> hr_approved, records the approver, one approval_requested event; final approval: -> approved, no event", async () => {
    const { runId } = await simulatedRun();
    const eventsBefore = await eventCount(runId);

    const hr = await approveHr(runId, hr1);
    expect(hr.status, JSON.stringify(hr.body)).toBe(200);
    expect(hr.body.data).toMatchObject({
      status: "hr_approved",
      approvedByHr: hr1.userId,
      approvedByFinance: null,
    });
    expect(hr.body.data.approvedByHrAt).toEqual(expect.any(String));
    const eventsAfterHr = await eventCount(runId);
    expect(eventsAfterHr - eventsBefore).toBe(1);

    const final = await approveFinal(runId, fin1);
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.data).toMatchObject({
      status: "approved",
      approvedByHr: hr1.userId,
      approvedByFinance: fin1.userId,
    });
    expect(final.body.data.approvedByFinanceAt).toEqual(expect.any(String));
    expect(await eventCount(runId)).toBe(eventsAfterHr);

    const row = await runRow(runId);
    expect(row.status).toBe("approved");
    expect(
      new Set([row.created_by, row.approved_by_hr, row.approved_by_finance])
        .size,
    ).toBe(3);
  }, 90_000);

  it("approving a draft run (never simulated) is 409 for both levels", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const runId = await newRun(world);
    const hr = await approveHr(runId, hr1);
    expect(hr.status, JSON.stringify(hr.body)).toBe(409);
    expect(hr.body.error.code).toBe("PAYROLL_RUN_INVALID_TRANSITION");
    const final = await approveFinal(runId, fin1);
    expect(final.status, JSON.stringify(final.body)).toBe(409);
    expect((await runRow(runId)).status).toBe("draft");
  }, 90_000);

  it("final approval before HR approval is 409 and records nothing", async () => {
    const { runId } = await simulatedRun();
    const final = await approveFinal(runId, fin1);
    expect(final.status, JSON.stringify(final.body)).toBe(409);
    const row = await runRow(runId);
    expect(row.status).toBe("simulated");
    expect(row.approved_by_finance).toBeNull();
  }, 90_000);
});

// ---- 5. [approve-twice] ----------------------------------------------------------

describe("[approve-twice] no second approval, no second effect", () => {
  it("a second HR approval is 409 PAYROLL_RUN_INVALID_TRANSITION; the first approver and the event count stay", async () => {
    const { runId } = await simulatedRun();
    const first = await approveHr(runId, hr1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const events = await eventCount(runId);

    const again = await approveHr(runId, hr2);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_RUN_INVALID_TRANSITION");
    const row = await runRow(runId);
    expect(row.approved_by_hr).toBe(hr1.userId);
    expect(await eventCount(runId)).toBe(events);
  }, 90_000);

  it("a second final approval is 409; the first finance approver stays", async () => {
    const { runId } = await simulatedRun();
    await approveHr(runId, hr1);
    const first = await approveFinal(runId, fin1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const events = await eventCount(runId);

    const again = await approveFinal(runId, fin2);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_RUN_INVALID_TRANSITION");
    expect((await runRow(runId)).approved_by_finance).toBe(fin1.userId);
    expect(await eventCount(runId)).toBe(events);
  }, 90_000);

  it("HR approval is bound to the simulation HR reviewed: an old expectedSimulationCount is 409 PAYROLL_RUN_SIMULATION_STALE, no state change, no event", async () => {
    const { runId } = await simulatedRun();
    const loaded = (await runRow(runId)).simulation_count;
    const again = await simulate(runId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await runRow(runId)).simulation_count).toBe(loaded + 1);
    const events = await eventCount(runId);
    const stale = await approveHr(runId, hr1, key(), loaded);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("PAYROLL_RUN_SIMULATION_STALE");
    const row = await runRow(runId);
    expect(row.status).toBe("simulated");
    expect(row.approved_by_hr).toBeNull();
    expect(await eventCount(runId)).toBe(events);
    // The current count is approved.
    const fresh = await approveHr(runId, hr1, key(), loaded + 1);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.data.status).toBe("hr_approved");
  }, 90_000);

  it("the same idempotencyKey replays the first answer without a new event", async () => {
    const { runId } = await simulatedRun();
    const k = key();
    const first = await approveHr(runId, hr1, k);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const events = await eventCount(runId);
    const replay = await approveHr(runId, hr1, k);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.status).toBe("hr_approved");
    expect(replay.body.data.approvedByHr).toBe(hr1.userId);
    expect(await eventCount(runId)).toBe(events);
  }, 90_000);

  it("two racing HR approvals: exactly one 200, one 409, one approval_requested event", async () => {
    const { runId } = await simulatedRun();
    const before = await eventCount(runId);
    const [a, b] = await Promise.all([
      approveHr(runId, hr1),
      approveHr(runId, hr2),
    ]);
    expect(
      [a.status, b.status].sort(),
      JSON.stringify([a.body, b.body]),
    ).toEqual([200, 409]);
    expect((await eventCount(runId)) - before).toBe(1);
    const row = await runRow(runId);
    expect([hr1.userId, hr2.userId]).toContain(row.approved_by_hr);
  }, 90_000);
});

// ---- 6. [maker-checker] ----------------------------------------------------------

describe("[maker-checker] creator, HR approver and final approver are distinct", () => {
  it("the creator cannot approve at the HR level: 403 PAYROLL_APPROVER_NOT_DISTINCT, still simulated", async () => {
    const { runId } = await simulatedRun();
    const response = await approveHr(runId, maker);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    const row = await runRow(runId);
    expect(row.status).toBe("simulated");
    expect(row.approved_by_hr).toBeNull();
  }, 90_000);

  it("the HR approver cannot also give the final approval: 403, still hr_approved", async () => {
    const { runId } = await simulatedRun();
    await approveHr(runId, hr1);
    const response = await approveFinal(runId, hr1);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    const row = await runRow(runId);
    expect(row.status).toBe("hr_approved");
    expect(row.approved_by_finance).toBeNull();
  }, 90_000);

  it("the creator cannot give the final approval either; a third person can", async () => {
    const { runId } = await simulatedRun();
    await approveHr(runId, hr1);
    const refused = await approveFinal(runId, maker);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect((await runRow(runId)).status).toBe("hr_approved");

    const ok = await approveFinal(runId, fin1);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe("approved");
  }, 90_000);
});

// ---- 7. [return-to-draft] --------------------------------------------------------

describe("[return-to-draft] clears approvals; re-approval needs fresh ones", () => {
  it("from approved: draft, both approvals and totals cleared; approving again needs a fresh simulate, a fresh HR approval and a fresh final approval", async () => {
    const { runId } = await simulatedRun();
    expect((await approveHr(runId, hr1)).status).toBe(200);
    expect((await approveFinal(runId, fin1)).status).toBe(200);

    const back = await returnToDraft(runId, maker, "Salah komponen");
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({
      status: "draft",
      approvedByHr: null,
      approvedByFinance: null,
      totals: null,
      simulationCount: 0,
    });
    const cleared = await runRow(runId);
    expect(cleared.status).toBe("draft");
    expect(cleared.approved_by_hr).toBeNull();
    expect(cleared.approved_by_finance).toBeNull();

    // The old approvals do not carry over: nothing can be approved or locked yet.
    for (const response of [
      await approveHr(runId, hr2),
      await approveFinal(runId, fin2),
    ])
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    const lockWhileDraft = await post(locker, `${RUNS}/${runId}/lock`, {
      idempotencyKey: key(),
    });
    expect(lockWhileDraft.status, JSON.stringify(lockWhileDraft.body)).toBe(
      409,
    );

    // Simulate again: simulated with no approvals; final alone is still refused.
    const sim = await simulate(runId);
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect(sim.body.data).toMatchObject({
      status: "simulated",
      approvedByHr: null,
      approvedByFinance: null,
    });
    expect((await approveFinal(runId, fin2)).status).toBe(409);
    const lockSimulated = await post(locker, `${RUNS}/${runId}/lock`, {
      idempotencyKey: key(),
    });
    expect(lockSimulated.status, JSON.stringify(lockSimulated.body)).toBe(409);
    // One stored result per employee after re-simulation (nothing doubled).
    expect(await countOf("payroll_run_results", runId)).toBe(1);

    // Fresh approvers by fresh approvals.
    const hr = await approveHr(runId, hr2);
    expect(hr.status, JSON.stringify(hr.body)).toBe(200);
    expect(hr.body.data.approvedByHr).toBe(hr2.userId);
    const final = await approveFinal(runId, fin2);
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.data).toMatchObject({
      status: "approved",
      approvedByHr: hr2.userId,
      approvedByFinance: fin2.userId,
    });
    expect(await countOf("payslips", runId)).toBe(0);
    expect(await loanDeductionCount(runId)).toBe(0);
  }, 120_000);

  it("from hr_approved: the HR approval is cleared too", async () => {
    const { runId } = await simulatedRun();
    await approveHr(runId, hr1);
    const back = await returnToDraft(runId);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const row = await runRow(runId);
    expect(row.status).toBe("draft");
    expect(row.approved_by_hr).toBeNull();
    expect(row.approved_by_finance).toBeNull();
    expect(row.simulation_count).toBe(0);
    expect(row.totals_is_null).toBe(true);
  }, 90_000);

  it("from simulated: back to draft; no event is written", async () => {
    const { runId } = await simulatedRun();
    const events = await eventCount(runId);
    const back = await returnToDraft(runId);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data.status).toBe("draft");
    expect(await eventCount(runId)).toBe(events);
  }, 90_000);

  it("a draft run cannot be returned to draft (409) and a blank reason is 422", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const runId = await newRun(world);
    const draft = await returnToDraft(runId);
    expect(draft.status, JSON.stringify(draft.body)).toBe(409);
    expect(draft.body.error.code).toBe("PAYROLL_RUN_INVALID_TRANSITION");

    await simulate(runId);
    const blank = await returnToDraft(runId, maker, "   ");
    expect(blank.status, JSON.stringify(blank.body)).toBe(422);
    expect((await runRow(runId)).status).toBe("simulated");
  }, 90_000);

  it("the same idempotencyKey does not return a re-approved run to draft again", async () => {
    const { runId } = await simulatedRun();
    const k = key();
    const body = { reason: "Koreksi", idempotencyKey: k };
    const first = await post(maker, `${RUNS}/${runId}/return-to-draft`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await simulate(runId);
    await approveHr(runId, hr1);
    const replay = await post(maker, `${RUNS}/${runId}/return-to-draft`, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const row = await runRow(runId);
    expect(row.status).toBe("hr_approved");
    expect(row.approved_by_hr).toBe(hr1.userId);
  }, 120_000);
});

// ---- 8. [permissions] ------------------------------------------------------------

describe("[permissions] guards on the four routes", () => {
  it("anonymous 401 and a foreign origin 403 on create, approvals and return-to-draft", async () => {
    const { runId, world } = await simulatedRun();
    const anonymous = agent(app);
    const calls: [string, object][] = [
      [RUNS, createBody(world)],
      [
        `${RUNS}/${runId}/hr-approval`,
        { expectedSimulationCount: 1, idempotencyKey: key() },
      ],
      [`${RUNS}/${runId}/final-approval`, { idempotencyKey: key() }],
      [
        `${RUNS}/${runId}/return-to-draft`,
        { reason: "x", idempotencyKey: key() },
      ],
    ];
    for (const [path, body] of calls) {
      const noSession = await anonymous.post(path).set(originHeader).send(body);
      expect(noSession.status, path).toBe(401);
      const badOrigin = await hr1.client
        .post(path)
        .set("Origin", "https://evil.example")
        .send(body);
      expect(badOrigin.status, path).toBe(403);
    }
    expect((await runRow(runId)).status).toBe("simulated");
    expect(await runsFor(world.policyId)).toBe(1);
  }, 90_000);

  it("create needs payroll.run: a viewer gets 403 and nothing is created", async () => {
    const world = await makeWorld();
    const response = await post(viewer, RUNS, createBody(world));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await runsFor(world.policyId)).toBe(0);
    // The payroll.lock holder cannot create either.
    const lockOnly = await post(locker, RUNS, createBody(world));
    expect(lockOnly.status, JSON.stringify(lockOnly.body)).toBe(403);
    expect(await runsFor(world.policyId)).toBe(0);
  }, 90_000);

  it("approvals need payroll.approve: payroll.run alone, payroll.view alone and payroll.lock alone get 403", async () => {
    const { runId } = await simulatedRun();
    for (const who of [runOnly, viewer, locker]) {
      const hr = await approveHr(runId, who);
      expect(hr.status, JSON.stringify(hr.body)).toBe(403);
    }
    expect((await runRow(runId)).status).toBe("simulated");

    await approveHr(runId, hr1);
    for (const who of [runOnly, viewer, locker]) {
      const final = await approveFinal(runId, who);
      expect(final.status, JSON.stringify(final.body)).toBe(403);
    }
    const row = await runRow(runId);
    expect(row.status).toBe("hr_approved");
    expect(row.approved_by_finance).toBeNull();
  }, 90_000);

  it("a viewer cannot return a run to draft", async () => {
    const { runId } = await simulatedRun();
    const response = await returnToDraft(runId, viewer);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect((await runRow(runId)).status).toBe("simulated");
  }, 90_000);

  it("an unknown run id is 404 on every action", async () => {
    const ghost = randomUUID();
    for (const response of [
      await approveHr(ghost, hr1),
      await approveFinal(ghost, fin1),
      await returnToDraft(ghost),
    ])
      expect(response.status, JSON.stringify(response.body)).toBe(404);
  }, 90_000);
});

// ---- 9. [tenant-isolation] -------------------------------------------------------

describe("[tenant-isolation] another tenant's data", () => {
  it("creating a run on another tenant's policy is 404 and writes nothing there or here", async () => {
    const response = await post(maker, RUNS, {
      payrollPolicyId: otherPolicy,
      runType: "regular",
      referenceDate: "2026-12-15",
      thrScheduleId: null,
      idempotencyKey: key(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    const count = (
      await owner.query(
        "SELECT count(*)::int AS n FROM payroll_runs WHERE payroll_policy_id = $1",
        [otherPolicy],
      )
    ).rows[0].n;
    expect(Number(count)).toBe(1); // only tenant B's own seeded draft run
  }, 90_000);

  it("approving or returning tenant B's run is 404 (not 409), and the run is unchanged", async () => {
    for (const response of [
      await approveHr(otherRun, hr1),
      await approveFinal(otherRun, fin1),
      await returnToDraft(otherRun),
    ])
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    const row = (
      await owner.query(
        `SELECT status, approved_by_hr, approved_by_finance
           FROM payroll_runs WHERE id = $1`,
        [otherRun],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "draft",
      approved_by_hr: null,
      approved_by_finance: null,
    });
  }, 90_000);
});

// ---- 10. [no-double-effects] -----------------------------------------------------

describe("[no-double-effects] the routes only move approval state", () => {
  it("create, both approvals, return-to-draft and re-approval write no payslip and no loan deduction; events only for HR approval", async () => {
    const { runId } = await simulatedRun();
    const base = await eventCount(runId);
    await approveHr(runId, hr1);
    await approveHr(runId, hr2); // refused (409)
    await approveFinal(runId, fin1);
    await approveFinal(runId, fin2); // refused (409)
    expect(await eventCount(runId)).toBe(base + 1);
    expect(await countOf("payslips", runId)).toBe(0);
    expect(await countOf("payslip_bank_snapshots", runId)).toBe(0);
    expect(await loanDeductionCount(runId)).toBe(0);

    await returnToDraft(runId);
    await simulate(runId);
    await approveHr(runId, hr2);
    await approveFinal(runId, fin2);
    // Second round: one more approval_requested, nothing else.
    expect(await eventCount(runId)).toBe(base + 2);
    expect(await countOf("payslips", runId)).toBe(0);
    expect(await loanDeductionCount(runId)).toBe(0);
    expect(await countOf("payroll_run_results", runId)).toBe(1);
  }, 120_000);
});
