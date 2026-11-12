// Payroll549 P2: a moved employee retains the freeze of their historical run.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setEmployeePayComponent } from "../services/payroll-components.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const actorId = randomUUID();
const roleId = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const ctx = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
type Seed = {
  employeeId: string;
  componentId: string;
  runId: string;
  policyId: string;
  entityA: string;
  entityB: string;
};
const seeds: Seed[] = [];

async function asTenant<T>(run: (db: PoolClient) => Promise<T>) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

function setAmount(seed: Seed, effectiveFrom: string, amountIdr = 12_000_000) {
  return setEmployeePayComponent(ctx, actorId, seed.employeeId as never, {
    componentId: seed.componentId as never,
    amountIdr: amountIdr as never,
    effectiveFrom: effectiveFrom as never,
    idempotencyKey: `historical549-${randomUUID()}`,
  });
}

async function freeze(db: PoolClient, runId: string) {
  await db.query(
    `UPDATE payroll_runs SET status = 'locked', config_snapshot = '{"v":1}',
       totals = '{"t":1}', locked_by = 'finance549', locked_at = now()
     WHERE id = $1`,
    [runId],
  );
}

async function seedHistoricalRun(): Promise<Seed> {
  const seed: Seed = {
    employeeId: randomUUID(),
    componentId: randomUUID(),
    runId: randomUUID(),
    policyId: randomUUID(),
    entityA: randomUUID(),
    entityB: randomUUID(),
  };
  seeds.push(seed);
  const code = `H549${seed.policyId.slice(0, 8).toUpperCase()}`;
  await asTenant(async (db) => {
    for (const id of [seed.entityA, seed.entityB])
      await db.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Historical549', false)",
        [id, tenantId],
      );
    await db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
        legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Historical549 Employee', $4, $5, 'pkwtt', '2025-01-01', 'active')`,
      [seed.employeeId, tenantId, code, outletId, seed.entityA],
    );
    await db.query(
      `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
        recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
       VALUES ($1, $2, $3, 'Historical549 Salary', 'base_salary', 'earning', 'fixed',
        true, 'gross', true, true, true)`,
      [seed.componentId, tenantId, code],
    );
    await db.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name,
        employee_group_code, employee_group, cycle, pay_date_adjustment,
        jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Historical549 Policy', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [seed.policyId, tenantId, seed.entityA, code, JSON.stringify({ code })],
    );
  });
  await setAmount(seed, "2026-01-01", 6_000_000);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id,
        run_type, period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', '2026-06-01', '2026-06-30', '2026-06-30', 'maker549')`,
      [seed.runId, tenantId, seed.entityA, seed.policyId],
    );
    for (const step of [
      "status = 'simulated'",
      "status = 'hr_approved', approved_by_hr = 'hr549', approved_by_hr_at = now()",
      "status = 'approved', approved_by_finance = 'finance549', approved_by_finance_at = now()",
    ])
      await db.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        seed.runId,
      ]);
    await freeze(db, seed.runId);
    await db.query(
      `INSERT INTO payslips (tenant_id, payroll_run_id, employee_id,
        payment_method, calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, 'cash', $4, 1)`,
      [
        tenantId,
        seed.runId,
        seed.employeeId,
        Buffer.from("historical549 sealed fixture"),
      ],
    );
    // org.service updates the employee's legal entity when their outlet moves;
    // the historical payslip continues to belong to the original entity's run.
    await db.query("UPDATE employees SET legal_entity_id = $2 WHERE id = $1", [
      seed.employeeId,
      seed.entityB,
    ]);
  });
  return seed;
}

async function history(seed: Seed) {
  return asTenant(async (db) => {
    const rows = await db.query(
      "SELECT to_jsonb(c) AS snapshot FROM employee_pay_components c WHERE tenant_id = $1 AND employee_id = $2 ORDER BY effective_from",
      [tenantId, seed.employeeId],
    );
    return rows.rows;
  });
}

async function frozenSnapshot(seed: Seed) {
  return asTenant(async (db) => {
    const rows = await db.query(
      `SELECT to_jsonb(r) AS run, (SELECT jsonb_agg(to_jsonb(p)) FROM payslips p
       WHERE p.tenant_id = r.tenant_id AND p.payroll_run_id = r.id) AS payslips
       FROM payroll_runs r WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, seed.runId],
    );
    return rows.rows;
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [actorId, "Historical549 Actor", `historical549-${actorId}@example.test`],
  );
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, '["payroll.view","payroll.run"]', '["tenant"]')`,
      [roleId, tenantId, `Historical549 ${roleId}`],
    );
    await db.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type,
        scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, actorId, roleId],
    );
  });
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'historical549-%'",
      [tenantId],
    );
    for (const seed of seeds) {
      await db.query(
        "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenantId, seed.runId],
      );
      await db.query(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, seed.runId],
      );
      await db.query(
        "DELETE FROM payroll_policies WHERE tenant_id = $1 AND id = $2",
        [tenantId, seed.policyId],
      );
      await db.query(
        "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, seed.employeeId],
      );
      await db.query(
        "DELETE FROM pay_components WHERE tenant_id = $1 AND id = $2",
        [tenantId, seed.componentId],
      );
      await db.query("DELETE FROM employees WHERE tenant_id = $1 AND id = $2", [
        tenantId,
        seed.employeeId,
      ]);
      await db.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, [seed.entityA, seed.entityB]],
      );
    }
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, actorId],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      roleId,
    ]);
  });
  await owner.query('DELETE FROM "user" WHERE id = $1', [actorId]);
  await owner.end();
});

describe("[549-P2-HISTORY] freeze survives a legal entity move", () => {
  it("[549-P2-HISTORY] refuses a June backdate via the old payslip and preserves paid inputs", async () => {
    const seed = await seedHistoricalRun();
    const before = await history(seed);
    const paid = await frozenSnapshot(seed);
    await expect(setAmount(seed, "2026-06-15")).rejects.toMatchObject({
      status: 409,
      code: "PAYROLL_RUN_FROZEN",
    });
    expect(await history(seed)).toEqual(before);
    expect(await frozenSnapshot(seed)).toEqual(paid);
  });

  it("[549-P2-HISTORY-LOCK] waits on the same frozen historical run row before refusing", async () => {
    const seed = await seedHistoricalRun();
    const before = await history(seed);
    const holder = await owner.connect();
    let operation: Promise<{ error: unknown }> | undefined;
    let transactionOpen = false;
    let settled = false;
    try {
      await holder.query("BEGIN");
      transactionOpen = true;
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      const pid = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await holder.query(
        "SELECT id FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, seed.runId],
      );
      operation = setAmount(seed, "2026-06-15")
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !settled) {
        const observation = await owner.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a
           WHERE a.state = 'active' AND a.wait_event_type = 'Lock'
             AND $1::int = ANY(pg_blocking_pids(a.pid))) AS blocked`,
          [pid.rows[0]!.pid],
        );
        if (observation.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await owner.query("SELECT pg_sleep(0.01)");
      }
      await holder.query("COMMIT");
      transactionOpen = false;
      const outcome = await operation;
      expect(blocked).toBe(true);
      expect(outcome.error).toMatchObject({
        status: 409,
        code: "PAYROLL_RUN_FROZEN",
      });
      expect(await history(seed)).toEqual(before);
    } finally {
      if (transactionOpen) await holder.query("ROLLBACK");
      holder.release();
      await operation;
    }
  });
});
