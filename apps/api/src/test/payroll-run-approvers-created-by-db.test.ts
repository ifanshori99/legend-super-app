// Payroll run maker-checker at the database level (bead legend-7ui6v; PRD
// "Matriks Approval": the approver differs from the requester; contract error
// PAYROLL_APPROVER_NOT_DISTINCT in packages/shared/src/hris/payroll/errors.ts).
//
// Rule under test: on payroll_runs, neither approved_by_finance nor
// approved_by_hr may equal created_by, enforced by a CHECK, so a direct write
// (any role, any code path) is refused with 23514. The existing rule
// hr approver <> final approver must keep working.
//
// Every attempt runs inside a transaction that is always rolled back, so no
// payroll history is left behind (locked runs are immutable).
//
// Fail-first expectation: before the migration, rows with approver ==
// created_by are accepted, so the "refuses" assertions fail with
// `ok: true` (a missing constraint), while the "accepts" control rows pass.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const CHECK_VIOLATION = "23514";
const CREATOR = "run-creator";

type Attempt =
  | { ok: true }
  | { ok: false; code: string | undefined; constraint: string | undefined };

async function attempt(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<Attempt> {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(text, values);
    await client.query("RELEASE SAVEPOINT attempt");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    const pgError = error as { code?: string; constraint?: string };
    return { ok: false, code: pgError.code, constraint: pgError.constraint };
  }
}

/** Always rolled back; seeds a legal entity and a policy for the fixture tenant. */
async function withRollback<T>(
  run: (
    client: PoolClient,
    ctx: { entityId: string; policyId: string },
  ) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const entityId = randomUUID();
    const policyId = randomUUID();
    // The policy CHECK requires employee_group_code = employee_group ->> 'code'.
    const groupCode = `AP${policyId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Approver DB', false)`,
      [entityId, tenantId],
    );
    await client.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group,
          cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan approver', $4, $5, $6, 'none', 'low', '[]')`,
      [
        policyId,
        tenantId,
        entityId,
        groupCode,
        JSON.stringify({ code: groupCode }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
    return await run(client, { entityId, policyId });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

let periodCounter = 0;
/** A unique one-month period far in the future per call. */
const nextPeriod = () => {
  periodCounter += 1;
  const start = new Date(Date.UTC(2040, periodCounter, 1));
  const end = new Date(Date.UTC(2040, periodCounter + 1, 0));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
};

/** Direct INSERT of a draft run with the given approver columns. */
function insertRun(
  client: PoolClient,
  ctx: { entityId: string; policyId: string },
  approvers: { hr?: string; finance?: string },
  createdBy = CREATOR,
) {
  const period = nextPeriod();
  const cols: Record<string, unknown> = {
    tenant_id: tenantId,
    legal_entity_id: ctx.entityId,
    payroll_policy_id: ctx.policyId,
    run_type: "regular",
    period_start: period.start,
    period_end: period.end,
    pay_date: period.end,
    created_by: createdBy,
  };
  if (approvers.hr !== undefined) {
    cols.approved_by_hr = approvers.hr;
    cols.approved_by_hr_at = new Date();
  }
  if (approvers.finance !== undefined) {
    cols.approved_by_finance = approvers.finance;
    cols.approved_by_finance_at = new Date();
  }
  const keys = Object.keys(cols);
  return attempt(
    client,
    `INSERT INTO payroll_runs (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((key) => cols[key]),
  );
}

/** A new draft run created by CREATOR, walked to `simulated`. */
async function newSimulatedRun(
  client: PoolClient,
  ctx: { entityId: string; policyId: string },
): Promise<string> {
  const id = randomUUID();
  const period = nextPeriod();
  await client.query(
    `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
        period_start, period_end, pay_date, created_by)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, $7)`,
    [id, tenantId, ctx.entityId, ctx.policyId, period.start, period.end, CREATOR],
  );
  await client.query(
    `UPDATE payroll_runs SET status = 'simulated' WHERE id = $1`,
    [id],
  );
  return id;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("payroll_runs: approvers differ from the creator (legend-7ui6v)", () => {
  it("[7ui6v] refuses a direct INSERT whose finance approver is the creator", async () => {
    const result = await withRollback(async (client, ctx) => ({
      // Control: same shape with a different approver is accepted.
      control: await insertRun(client, ctx, { finance: "finance-user" }),
      same: await insertRun(client, ctx, { finance: CREATOR }),
    }));
    expect(result.control).toEqual({ ok: true });
    expect(result.same).toMatchObject({ ok: false, code: CHECK_VIOLATION });
  });

  it("[7ui6v] refuses a direct INSERT whose HR approver is the creator", async () => {
    const result = await withRollback(async (client, ctx) => ({
      control: await insertRun(client, ctx, { hr: "hr-user" }),
      same: await insertRun(client, ctx, { hr: CREATOR }),
    }));
    expect(result.control).toEqual({ ok: true });
    expect(result.same).toMatchObject({ ok: false, code: CHECK_VIOLATION });
  });

  it("[7ui6v] refuses a creator who is both approvers, and accepts three distinct people", async () => {
    const result = await withRollback(async (client, ctx) => ({
      allThree: await insertRun(client, ctx, { hr: "hr-user", finance: "finance-user" }),
      creatorBoth: await insertRun(client, ctx, { hr: CREATOR, finance: CREATOR }),
      // Only one of the two equals the creator: still refused.
      financeIsCreator: await insertRun(client, ctx, {
        hr: "hr-user",
        finance: CREATOR,
      }),
      hrIsCreator: await insertRun(client, ctx, {
        hr: CREATOR,
        finance: "finance-user",
      }),
    }));
    expect(result.allThree).toEqual({ ok: true });
    expect(result.creatorBoth).toMatchObject({ ok: false, code: CHECK_VIOLATION });
    expect(result.financeIsCreator).toMatchObject({
      ok: false,
      code: CHECK_VIOLATION,
    });
    expect(result.hrIsCreator).toMatchObject({
      ok: false,
      code: CHECK_VIOLATION,
    });
  });

  it("[7ui6v] refuses an UPDATE that makes the HR approver the creator, and accepts another person", async () => {
    const result = await withRollback(async (client, ctx) => {
      const id = await newSimulatedRun(client, ctx);
      const asCreator = await attempt(
        client,
        `UPDATE payroll_runs
            SET status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()
          WHERE id = $1`,
        [id, CREATOR],
      );
      const asOther = await attempt(
        client,
        `UPDATE payroll_runs
            SET status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()
          WHERE id = $1`,
        [id],
      );
      return { asCreator, asOther };
    });
    expect(result.asCreator).toMatchObject({ ok: false, code: CHECK_VIOLATION });
    expect(result.asOther).toEqual({ ok: true });
  });

  it("[7ui6v] refuses an UPDATE that makes the final approver the creator, and accepts another person", async () => {
    const result = await withRollback(async (client, ctx) => {
      const id = await newSimulatedRun(client, ctx);
      await client.query(
        `UPDATE payroll_runs
            SET status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()
          WHERE id = $1`,
        [id],
      );
      const asCreator = await attempt(
        client,
        `UPDATE payroll_runs
            SET status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()
          WHERE id = $1`,
        [id, CREATOR],
      );
      const asOther = await attempt(
        client,
        `UPDATE payroll_runs
            SET status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()
          WHERE id = $1`,
        [id],
      );
      return { asCreator, asOther };
    });
    expect(result.asCreator).toMatchObject({ ok: false, code: CHECK_VIOLATION });
    expect(result.asOther).toEqual({ ok: true });
  });

  it("[7ui6v] still refuses the same person as HR and final approver, and still allows unapproved runs", async () => {
    const result = await withRollback(async (client, ctx) => {
      const id = await newSimulatedRun(client, ctx);
      await client.query(
        `UPDATE payroll_runs
            SET status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()
          WHERE id = $1`,
        [id],
      );
      const sameApprover = await attempt(
        client,
        `UPDATE payroll_runs
            SET status = 'approved', approved_by_finance = 'hr-user', approved_by_finance_at = now()
          WHERE id = $1`,
        [id],
      );
      // A run with no approver yet (NULL columns) must not trip the new checks.
      const noApprovers = await insertRun(client, ctx, {});
      return { sameApprover, noApprovers };
    });
    expect(result.sameApprover).toMatchObject({
      ok: false,
      code: CHECK_VIOLATION,
    });
    expect(result.noApprovers).toEqual({ ok: true });
  });
});
