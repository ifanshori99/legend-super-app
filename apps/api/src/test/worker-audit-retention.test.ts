import { expect, it, vi } from "vitest";
import {
  AUDIT_RETENTION_BATCH,
  AUDIT_RETENTION_CRON,
  AUDIT_RETENTION_MAX_BATCHES_PER_TENANT,
  AUDIT_RETENTION_QUEUE,
  AUDIT_RETENTION_RUN_BUDGET_MS,
  AUDIT_RETENTION_TZ,
  probeMaintenanceConnection,
  registerAuditRetentionJob,
  runAuditRetentionPurge,
} from "../worker/audit-retention.job.ts";
import { resolveMaintenanceDatabaseUrl } from "../worker/production-config.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const DUE = "SELECT app.audit_retention_due_tenants() AS tenant_id";
const PURGE = "SELECT app.purge_audit_retention_batch($1, $2) AS deleted";

/** Mock pool: `due` lists tenants, `purge` answers each batch call per tenant. */
function mockPool(options: {
  due: string[] | Error;
  purge: (tenant: string, call: number) => number | Error;
}) {
  const calls = new Map<string, number>();
  const log: { text: string; values?: unknown[] }[] = [];
  return {
    log,
    calls,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      log.push({ text, values });
      if (text === DUE) {
        if (options.due instanceof Error) throw options.due;
        return { rows: options.due.map((tenant_id) => ({ tenant_id })) };
      }
      expect(text).toBe(PURGE);
      const tenant = String(values?.[0]);
      const call = (calls.get(tenant) ?? 0) + 1;
      calls.set(tenant, call);
      const outcome = options.purge(tenant, call);
      if (outcome instanceof Error) throw outcome;
      return { rows: [{ deleted: String(outcome) }] };
    }),
  };
}

const quiet = { error: vi.fn(), info: vi.fn() };

it("legend-usyi: loops each tenant until a batch comes back short", async () => {
  const pool = mockPool({
    due: [A, B],
    purge: (tenant, call) =>
      tenant === A ? (call < 3 ? AUDIT_RETENTION_BATCH : 40) : 7,
  });
  const result = await runAuditRetentionPurge({ pool, log: quiet });
  expect(pool.calls.get(A)).toBe(3);
  expect(pool.calls.get(B)).toBe(1);
  expect(result).toMatchObject({
    tenants: 2,
    deleted: 2 * AUDIT_RETENTION_BATCH + 40 + 7,
    failedTenants: 0,
    truncated: false,
  });
  const purges = pool.log.filter((entry) => entry.text === PURGE);
  expect(purges.every((entry) => entry.values?.[1] === 1000)).toBe(true);
});

it("legend-usyi: an exactly full last batch is followed by one empty batch", async () => {
  const pool = mockPool({
    due: [A],
    purge: (_tenant, call) => (call === 1 ? AUDIT_RETENTION_BATCH : 0),
  });
  const result = await runAuditRetentionPurge({ pool, log: quiet });
  expect(pool.calls.get(A)).toBe(2);
  expect(result.deleted).toBe(AUDIT_RETENTION_BATCH);
});

it("legend-usyi: caps batches per tenant and leaves the rest for the next run", async () => {
  const pool = mockPool({ due: [A, B], purge: () => AUDIT_RETENTION_BATCH });
  const result = await runAuditRetentionPurge({ pool, log: quiet });
  expect(pool.calls.get(A)).toBe(AUDIT_RETENTION_MAX_BATCHES_PER_TENANT);
  // The cap stops one tenant only; the next tenant still gets its turn.
  expect(pool.calls.get(B)).toBe(AUDIT_RETENTION_MAX_BATCHES_PER_TENANT);
  expect(result.truncated).toBe(true);
});

it("legend-usyi: the run budget stops work before the next tenant and batch", async () => {
  let now = 0;
  const pool = mockPool({
    due: [A, B, C],
    purge: () => {
      now += AUDIT_RETENTION_RUN_BUDGET_MS / 2;
      return AUDIT_RETENTION_BATCH;
    },
  });
  const result = await runAuditRetentionPurge({
    pool,
    log: quiet,
    clock: () => now,
  });
  expect(pool.calls.get(A)).toBe(2);
  expect(pool.calls.get(B)).toBeUndefined();
  expect(pool.calls.get(C)).toBeUndefined();
  expect(result.truncated).toBe(true);
  expect(result.deleted).toBe(2 * AUDIT_RETENTION_BATCH);
});

it("legend-usyi: one failing tenant is logged and the others still run (fail closed per tenant)", async () => {
  const log = { error: vi.fn() };
  const pool = mockPool({
    due: [A, B, C],
    purge: (tenant) =>
      tenant === B ? new Error("canceling statement due to lock timeout") : 5,
  });
  const result = await runAuditRetentionPurge({ pool, log });
  expect(pool.calls.get(A)).toBe(1);
  expect(pool.calls.get(B)).toBe(1);
  expect(pool.calls.get(C)).toBe(1);
  expect(result).toMatchObject({
    tenants: 3,
    deleted: 10,
    failedTenants: 1,
  });
  expect(log.error).toHaveBeenCalledTimes(1);
});

it("legend-usyi: a failure after earlier batches keeps their count and skips only that tenant", async () => {
  const pool = mockPool({
    due: [A, B],
    purge: (tenant, call) =>
      tenant === A
        ? call === 1
          ? AUDIT_RETENTION_BATCH
          : new Error("boom")
        : 3,
  });
  const result = await runAuditRetentionPurge({ pool, log: quiet });
  expect(result).toMatchObject({
    deleted: AUDIT_RETENTION_BATCH + 3,
    failedTenants: 1,
  });
});

it("legend-usyi: no due tenant means no purge call", async () => {
  const pool = mockPool({ due: [], purge: () => 0 });
  const result = await runAuditRetentionPurge({ pool, log: quiet });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ tenants: 0, deleted: 0, failedTenants: 0 });
});

it("legend-usyi: a failing tenant listing fails the run so pg-boss retries and reports it", async () => {
  const pool = mockPool({
    due: new Error("permission denied"),
    purge: () => 0,
  });
  await expect(runAuditRetentionPurge({ pool, log: quiet })).rejects.toThrow(
    "permission denied",
  );
});

it("legend-usyi: registers an exclusive queue, the 02:30 Jakarta schedule and the worker", async () => {
  const order: string[] = [];
  const boss = {
    createQueue: vi.fn(async () => void order.push("createQueue")),
    schedule: vi.fn(async () => void order.push("schedule")),
    work: vi.fn(async () => void order.push("work")),
  };
  const pool = mockPool({ due: [A], purge: () => 2 });
  await registerAuditRetentionJob({ boss, pool, log: quiet });
  expect(AUDIT_RETENTION_QUEUE).toBe("audit-retention-purge");
  expect(boss.createQueue).toHaveBeenCalledWith(
    "audit-retention-purge",
    expect.objectContaining({ policy: "exclusive" }),
  );
  expect(boss.schedule).toHaveBeenCalledWith(
    "audit-retention-purge",
    "30 2 * * *",
    null,
    { tz: "Asia/Jakarta" },
  );
  expect(AUDIT_RETENTION_CRON).toBe("30 2 * * *");
  expect(AUDIT_RETENTION_TZ).toBe("Asia/Jakarta");
  expect(order).toEqual(["createQueue", "schedule", "work"]);
  // The scheduled job runs the purge loop.
  const handler = (
    boss.work.mock.calls[0] as unknown as [
      string,
      (jobs: unknown[]) => Promise<void>,
    ]
  )[1];
  await handler([{ data: null }]);
  expect(pool.calls.get(A)).toBe(1);
});

type Handler = (jobs: unknown[]) => Promise<void>;
async function registeredHandler(
  pool: ReturnType<typeof mockPool>,
  log: Pick<Console, "error" | "info">,
) {
  const boss = {
    createQueue: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    work: vi.fn(async () => {}),
  };
  await registerAuditRetentionJob({ boss, pool, log });
  return (boss.work.mock.calls[0] as unknown as [string, Handler])[1];
}

it("legend-usyi: the job logs the run result and passes when no tenant failed", async () => {
  const log = { error: vi.fn(), info: vi.fn() };
  const pool = mockPool({ due: [A, B], purge: () => 4 });
  const handler = await registeredHandler(pool, log);
  await expect(handler([{ data: null }])).resolves.toBeUndefined();
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(String(log.info.mock.calls[0][0])).toContain(
    '{"tenants":2,"deleted":8,"failedTenants":0,"truncated":false}',
  );
});

it("legend-usyi: the job throws when a tenant failed so pg-boss marks the run failed", async () => {
  const log = { error: vi.fn(), info: vi.fn() };
  const pool = mockPool({
    due: [A, B],
    purge: (tenant) => (tenant === B ? new Error("boom") : 5),
  });
  const handler = await registeredHandler(pool, log);
  await expect(handler([{ data: null }])).rejects.toThrow("1");
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(String(log.info.mock.calls[0][0])).toContain('"failedTenants":1');
});

it("legend-usyi: the job logs a listing failure and rethrows it", async () => {
  const log = { error: vi.fn(), info: vi.fn() };
  const pool = mockPool({
    due: new Error("permission denied"),
    purge: () => 0,
  });
  const handler = await registeredHandler(pool, log);
  await expect(handler([{ data: null }])).rejects.toThrow("permission denied");
  expect(
    log.error.mock.calls.some((call) =>
      JSON.stringify(call).includes("permission denied"),
    ),
  ).toBe(true);
});

it("legend-usyi: the start probe opens and releases one connection, and a refused login fails it", async () => {
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ release })) };
  await probeMaintenanceConnection(pool);
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  const refused = {
    connect: vi.fn(async () => {
      throw new Error("Unsafe database role for maintenance access");
    }),
  };
  await expect(probeMaintenanceConnection(refused)).rejects.toThrow(
    "Unsafe database role",
  );
});

it("legend-usyi: production cloud worker refuses to start without MAINTENANCE_DATABASE_URL", () => {
  const url = "postgres://legend_maint_x:pw@db.internal:5432/legend";
  expect(() =>
    resolveMaintenanceDatabaseUrl({
      env: { NODE_ENV: "production" },
      cloud: true,
    }),
  ).toThrow("MAINTENANCE_DATABASE_URL");
  expect(() =>
    resolveMaintenanceDatabaseUrl({
      env: { NODE_ENV: "production", MAINTENANCE_DATABASE_URL: "  " },
      cloud: true,
    }),
  ).toThrow("MAINTENANCE_DATABASE_URL");
  expect(() =>
    resolveMaintenanceDatabaseUrl({
      env: { NODE_ENV: "production", MAINTENANCE_DATABASE_URL: "not a url" },
      cloud: true,
    }),
  ).toThrow("MAINTENANCE_DATABASE_URL");
  expect(
    resolveMaintenanceDatabaseUrl({
      env: { NODE_ENV: "production", MAINTENANCE_DATABASE_URL: url },
      cloud: true,
    }),
  ).toBe(url);
});

it("legend-usyi: an edge worker and a non-production worker skip the job without the URL", () => {
  expect(
    resolveMaintenanceDatabaseUrl({
      env: { NODE_ENV: "production" },
      cloud: false,
    }),
  ).toBeNull();
  expect(
    resolveMaintenanceDatabaseUrl({
      env: {
        NODE_ENV: "production",
        MAINTENANCE_DATABASE_URL: "postgres://u:p@h/d",
      },
      cloud: false,
    }),
  ).toBeNull();
  expect(
    resolveMaintenanceDatabaseUrl({ env: { NODE_ENV: "test" }, cloud: true }),
  ).toBeNull();
  expect(resolveMaintenanceDatabaseUrl({ env: {}, cloud: true })).toBeNull();
});
