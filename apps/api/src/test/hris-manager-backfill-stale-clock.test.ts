// legend-c79uy P2 (tier K, access + personal data): the employee-manager backfill
// (apps/api/src/db/backfill-employee-managers.ts) must judge "is the proposed manager an
// active outlet_manager" with the LATEST time AFTER it holds the manager lock, then
// reclassify. A wait on the manager lock (e.g. a concurrent offboarding or manager edit)
// can last long enough for the proposed manager's role assignment to expire; the time
// captured before the wait is stale and must not be used to approve the row.
//
// Written from the brief (docs/briefs/fix-ykk88-c79uy.md section B) and the run() surface
// that hris-manager-backfill.test.ts already exercises (pool, apply, manifest, now, log,
// tenantId), not from the implementation.
//
// Assumptions:
// - run() is called with `now` captured at call time (as the CLI does) and an HR-approved
//   manifest tuple { employeeId, currentManagerId, proposedManagerId }.
// - The apply waits for a row lock on the proposed manager (the existing offboarding test in
//   hris-manager-backfill.test.ts proves it does); the test holds that lock with an
//   uncommitted UPDATE of the manager's employee row and releases it after the manager's
//   outlet_manager assignment has expired.
// - Expired assignment (valid_until in the past) means "not an active outlet_manager", the
//   same rule the existing O6 scenario relies on; the row must then be skipped (listed in
//   `skipped`), manager_id stays NULL and no audit row is written.
// - `applied` / `skipped` may be a number or an array (read through count()/toContain).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { BACKFILL_ACTION, run } from "../db/backfill-employee-managers.ts";
import { agent, signUp } from "./helpers.ts";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createdTenants: string[] = [];
const createdUsers: string[] = [];

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

async function newUserId(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

/** One tenant, one outlet, an outlet manager (assignment ends at `validUntil`) and an employee without manager. */
async function buildScenario(validUntil: Date | null) {
  const tenantId = randomUUID();
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Manager backfill clock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `mgr-clock-${tenantId}`, randomUUID()],
  );
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const roleId = randomUUID();
  const outletId = randomUUID();
  const omEmployee = randomUUID();
  const target = randomUUID();
  const omUser = await newUserId("Backfill Clock Outlet Manager");
  await inTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand clock')`,
      [brandId, tenantId, `mc-${brandId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'PT Clock')`,
      [legalEntityId, tenantId],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'outlet_manager', true, 'outlet_manager', '[]'::jsonb, false, '["outlet"]'::jsonb)`,
      [roleId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet clock', 'Jl. Clock', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        legalEntityId,
        `MK-${outletId.slice(0, 8)}`.toUpperCase(),
      ],
    );
    for (const [id, userId] of [
      [omEmployee, omUser],
      [target, null],
    ] as const)
      await client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', NULL)`,
        [
          id,
          tenantId,
          userId,
          `MK-${id.slice(0, 8).toUpperCase()}`,
          `Nama Rahasia ${id.slice(0, 8)}`,
          outletId,
        ],
      );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $5::timestamptz, $2)`,
      [tenantId, omUser, roleId, outletId, validUntil],
    );
  });
  return { tenantId, omEmployee, target };
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

async function auditCount(tenantId: string): Promise<number> {
  return inTenant(tenantId, async (client) => {
    const result = await client.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
      [tenantId, BACKFILL_ACTION],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Start an approved apply while another transaction holds the proposed manager's employee
 * row, wait until the apply is really blocked on it, run `beforeRelease`, then commit the
 * holder and return the apply result.
 */
async function applyWhileManagerLocked(
  s: Awaited<ReturnType<typeof buildScenario>>,
  beforeRelease: () => Promise<void>,
) {
  const manifest = [
    {
      employeeId: s.target,
      currentManagerId: null,
      proposedManagerId: s.omEmployee,
    },
  ];
  const holder = await owner.connect();
  let applying: ReturnType<typeof run> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [s.tenantId],
    );
    const backend = await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await holder.query(
      "UPDATE employees SET status = 'active' WHERE tenant_id = $1 AND id = $2",
      [s.tenantId, s.omEmployee],
    );
    let settled = false;
    applying = run({
      pool: owner,
      apply: true,
      now: new Date(),
      log: () => {},
      tenantId: s.tenantId,
      manifest,
    });
    void applying.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = Date.now() + 15_000;
    let waiting = false;
    while (!settled && Date.now() < deadline) {
      const blockers = await owner.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
        [backend.rows[0]!.pid],
      );
      if (blockers.rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await sleep(20);
    }
    expect(
      waiting,
      "the apply must wait on the proposed manager's row lock (setup precondition)",
    ).toBe(true);
    await beforeRelease();
    await holder.query("COMMIT");
    return await applying;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (applying) await applying.catch(() => undefined);
  }
}

describe("legend-c79uy P2 backfill uses the latest time after the manager lock", () => {
  it("control: a manager whose assignment stays valid is applied after waiting on the lock", async () => {
    const s = await buildScenario(null);
    const result = await applyWhileManagerLocked(s, () => sleep(300));
    expect(count(result.applied)).toBe(1);
    expect(await managerOf(s.tenantId, s.target)).toBe(s.omEmployee);
    expect(await auditCount(s.tenantId)).toBe(1);
  });

  it("skips the employee when the proposed manager's outlet_manager assignment expired while waiting for the lock", async () => {
    // Fails on current code: it classified with the `now` taken before the wait, saw the
    // assignment as still valid and wrote manager_id for a manager who is no longer one.
    const validUntil = new Date(Date.now() + 3_000);
    const s = await buildScenario(validUntil);
    const result = await applyWhileManagerLocked(s, async () => {
      await sleep(Math.max(0, validUntil.getTime() - Date.now()) + 300);
    });
    expect(count(result.applied)).toBe(0);
    expect(result.skipped).toContain(s.target);
    expect(await managerOf(s.tenantId, s.target)).toBeNull();
    expect(await auditCount(s.tenantId)).toBe(0);
  });
});

afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const tenantId of createdTenants) {
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
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
