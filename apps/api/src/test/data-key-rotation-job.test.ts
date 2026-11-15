// Scheduled data-key rotation (bead legend-rg8yl, brief 790 card C). The module
// worker/data-key-rotation.job.ts exports
//   runDataKeyRotation({ database, log }) -> { tenants, aiRotated,
//     integrationsRotated, skipped }
//   registerDataKeyRotationJob({ boss, database, log })
// The job walks every tenant and calls rotateIntegrationCredentials and
// rotateAiProviderKeys (no force), under a Postgres advisory lock so only one
// worker instance rotates at a time. It logs counts and tenant ids only.
//
// Shape (same pattern as platform-integration-key-rotation.test.ts): phase 1
// seals an integration and an AI provider key under the default ring (version
// 1) with the static imports. Phase 2 re-imports the job and services with the
// ring env stubbed to version 2 (active) and runs the job.
//
// Assumptions (the brief, not the implementation):
//   - `skipped` is true when the advisory lock is held by another session and
//     the run did nothing (tenants 0, both counts 0); falsy on a normal run.
//   - The job module also exports DATA_KEY_ROTATION_LOCK_KEY (string) and
//     DATA_KEY_ROTATION_QUEUE (string). The lock is
//     pg_try_advisory_lock(hashtextextended(DATA_KEY_ROTATION_LOCK_KEY, 0)),
//     the pattern of edge/runtime.ts. The test holds that lock from a separate
//     session to prove the "lock held -> skipped" rule.
//   - registerDataKeyRotationJob follows the other worker jobs: createQueue
//     (policy "exclusive"), then a pg-boss cron schedule (5-field cron string,
//     "daily-ish"), then work. The exact hour is not asserted.
//   - The test database is shared with other files. Only tenant enumeration is
//     scoped to this file's fixtures; locks, rotations and read-back use SQL.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { sealSecret, sealedVersion } from "../lib/secrets.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";

// Rotations use real database transactions; give a busy test host room.
vi.setConfig({ testTimeout: 180_000 });

const actor = randomUUID();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const KEY2 = randomBytes(32).toString("base64");
const createdTenants: string[] = [];
const jobTenantIds: string[] = [];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

function contextFor(id: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function createTenant(includeInRotation = true): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant rotasi terjadwal', plan, status, deployment_mode,
            '{"modules":[],"integrationProviders":["doit","email"]}', limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `uji-rotjob-${randomBytes(4).toString("hex")}`, seededTenantId],
  );
  createdTenants.push(id);
  if (includeInRotation) jobTenantIds.push(id);
  return id;
}

type Seeded = {
  tenantId: string;
  integrationId: string;
  aiId: string;
  apiKey: string;
  aiKey: string;
};

const aiAad = (tenantId: string, id: string) =>
  `ai_provider_config:${tenantId}:${id}`;

/** Phase 1: one active integration and one AI provider key sealed at version 1. */
async function seedStaleTenant(includeInRotation = true): Promise<Seeded> {
  const tenantId = await createTenant(includeInRotation);
  const ctx = contextFor(tenantId);
  const apiKey = `doit-${randomBytes(12).toString("hex")}`;
  const aiKey = `sk-ai-${randomBytes(16).toString("hex")}`;
  const created = await upsertIntegration(
    ctx,
    {
      outletId: null,
      provider: "doit",
      config: { merchantCode: `ROTJ-${randomBytes(3).toString("hex")}` },
      credentials: { apiKey },
    },
    actor,
  );
  await setIntegrationStatus(ctx, created.id, { status: "active" }, actor);

  const aiId = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO ai_provider_configs
         (id, tenant_id, connection_type, base_url, default_model,
          api_key_encrypted, api_key_key_version, api_key_last4, api_key_set_at)
       VALUES ($1, $2, 'api_key', 'https://api.example.test/v1', 'test-model',
               $3, 1, $4, now())`,
      [
        aiId,
        tenantId,
        sealSecret(aiKey, aiAad(tenantId, aiId)),
        aiKey.slice(-4),
      ],
    ),
  );
  const seeded = { tenantId, integrationId: created.id, aiId, apiKey, aiKey };
  const integration = await integrationRow(created.id);
  expect(integration.credentials_key_version).toBe(1);
  expect(sealedVersion(integration.credentials_encrypted)).toBe(1);
  const ai = await aiRow(seeded);
  expect(ai.api_key_key_version).toBe(1);
  expect(sealedVersion(ai.api_key_encrypted)).toBe(1);
  return seeded;
}

async function integrationRow(integrationId: string) {
  return (
    await owner.query<{
      credentials_encrypted: string;
      credentials_key_version: number;
    }>(
      "SELECT credentials_encrypted, credentials_key_version FROM tenant_integrations WHERE id = $1",
      [integrationId],
    )
  ).rows[0]!;
}

async function aiRow(seeded: Pick<Seeded, "tenantId" | "aiId">) {
  return asOwner(seeded.tenantId, async (client) => {
    const result = await client.query<{
      api_key_encrypted: string;
      api_key_key_version: number;
    }>(
      "SELECT api_key_encrypted, api_key_key_version FROM ai_provider_configs WHERE id = $1",
      [seeded.aiId],
    );
    return result.rows[0]!;
  });
}

/** Phase 2: modules re-imported with key version 2 active. */
async function loadPhase2() {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_KEYS", `2:${KEY2}`);
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", "2");
  const audit = await import("../services/audit-writer.ts");
  const core = await import("../services/core-audit-writer.ts");
  audit.setAuditWriter(core.coreAuditWriter);
  const shared = await import("@starter/shared/core/server");
  const secrets = await import("../lib/secrets.ts");
  const service = await import("../services/platform-integration.service.ts");
  const { db } = await import("../db/index.ts");
  const job = await import("../worker/data-key-rotation.job.ts");
  // The job's only database.execute call enumerates tenants. Run that original
  // SQL, limited to our fixture IDs: sweeping other files can meet deliberately
  // unreadable keys or re-seal their data under this file's private KEY2.
  // Services and the advisory lock still use their real database connections.
  const database = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "execute") {
        return (query: Parameters<typeof db.execute>[0]) => {
          const statement = typeof query === "string" ? sql.raw(query) : query;
          const scope = jobTenantIds.length
            ? sql`fixture_tenants.id IN (${sql.join(
                jobTenantIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql`false`;
          return target.execute(
            sql`SELECT fixture_tenants.id FROM (${statement}) AS fixture_tenants WHERE ${scope}`,
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expect(secrets.currentSealVersion()).toBe(2);
  const ctxFor = (id: string) =>
    shared.establishScopedTenantContext(
      shared.establishTenantContext({
        tenantId: id,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
  return { job, db: database, service, secrets, ctxFor };
}

function captureLog() {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => void calls.push(args);
  return {
    log: { info: record, error: record, warn: record },
    text: () => JSON.stringify(calls),
    calls,
  };
}

/** Advisory lock of the job, held by this test from a separate session. */
async function holdJobLock(lockKey: string): Promise<() => Promise<void>> {
  const client = await owner.connect();
  const got = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
    [lockKey],
  );
  if (!got.rows[0]?.ok) {
    client.release();
    throw new Error("Could not take the rotation lock for the test");
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        lockKey,
      ]);
    } finally {
      client.release();
    }
  };
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(async () => {
  setAuditWriter(null);
  for (const id of createdTenants) {
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
      id,
    ]);
    await asOwner(id, (client) =>
      client.query("DELETE FROM ai_provider_configs WHERE tenant_id = $1", [
        id,
      ]),
    );
    await owner.query("DELETE FROM tenants WHERE id = $1", [id]);
  }
  await owner.end();
});

describe("legend-rg8yl runDataKeyRotation", () => {
  it("legend-rg8yl rotates stale integration and AI keys of every tenant once, readable afterwards, and the second run rotates 0", async () => {
    const a = await seedStaleTenant();
    const b = await seedStaleTenant();
    // Another file may deliberately keep an unreadable key while proving its
    // AAD guard. It belongs to that file, not to this job's fixture sweep.
    const foreign = await seedStaleTenant(false);
    await asOwner(foreign.tenantId, (client) =>
      client.query(
        "UPDATE ai_provider_configs SET api_key_encrypted = $2 WHERE id = $1",
        [
          foreign.aiId,
          sealSecret(foreign.aiKey, aiAad(foreign.tenantId, randomUUID())),
        ],
      ),
    );
    const foreignIntegration = await integrationRow(foreign.integrationId);
    const foreignAi = await aiRow(foreign);
    const beforeIntegrationA = await integrationRow(a.integrationId);
    const beforeAiA = await aiRow(a);

    const { job, db, service, secrets, ctxFor } = await loadPhase2();
    const first = captureLog();
    const result = await job.runDataKeyRotation({
      database: db,
      log: first.log,
    });

    // Exactly our two tenants were visited; the foreign canary was untouched.
    expect(result.tenants).toBe(2);
    expect(result.integrationsRotated).toBe(2);
    expect(result.aiRotated).toBe(2);
    expect(result.skipped).toBeFalsy();
    expect(result.failedTenants).toBe(0);
    expect(await integrationRow(foreign.integrationId)).toEqual(
      foreignIntegration,
    );
    expect(await aiRow(foreign)).toEqual(foreignAi);

    for (const seeded of [a, b]) {
      const integration = await integrationRow(seeded.integrationId);
      expect(integration.credentials_key_version).toBe(2);
      expect(sealedVersion(integration.credentials_encrypted)).toBe(2);
      const ai = await aiRow(seeded);
      expect(ai.api_key_key_version).toBe(2);
      expect(sealedVersion(ai.api_key_encrypted)).toBe(2);
      // Same secret values, readable with the new ring.
      expect(
        (
          await service.loadActiveIntegrationCredentials(
            ctxFor(seeded.tenantId),
            "doit",
            null,
          )
        )?.credentials,
      ).toEqual({ apiKey: seeded.apiKey });
      expect(
        secrets.openSecret(
          ai.api_key_encrypted,
          aiAad(seeded.tenantId, seeded.aiId),
        ),
      ).toBe(seeded.aiKey);
    }
    expect(
      (await integrationRow(a.integrationId)).credentials_encrypted,
    ).not.toBe(beforeIntegrationA.credentials_encrypted);
    expect((await aiRow(a)).api_key_encrypted).not.toBe(
      beforeAiA.api_key_encrypted,
    );

    // Idempotent: nothing stale is left, so nothing changes.
    const afterFirstA = await integrationRow(a.integrationId);
    const afterFirstAiA = await aiRow(a);
    const second = await job.runDataKeyRotation({
      database: db,
      log: captureLog().log,
    });
    expect(second.integrationsRotated).toBe(0);
    expect(second.aiRotated).toBe(0);
    expect(second.failedTenants).toBe(0);
    expect(second.skipped).toBeFalsy();
    expect((await integrationRow(a.integrationId)).credentials_encrypted).toBe(
      afterFirstA.credentials_encrypted,
    );
    expect((await aiRow(a)).api_key_encrypted).toBe(
      afterFirstAiA.api_key_encrypted,
    );
  });

  it("legend-rg8yl while another session holds the lock the run is skipped and touches nothing; after release it rotates", async () => {
    const seeded = await seedStaleTenant();
    const { job, db } = await loadPhase2();
    const release = await holdJobLock(job.DATA_KEY_ROTATION_LOCK_KEY);
    try {
      const held = await job.runDataKeyRotation({
        database: db,
        log: captureLog().log,
      });
      expect(held.skipped).toBe(true);
      expect(held.tenants).toBe(0);
      expect(held.integrationsRotated).toBe(0);
      expect(held.aiRotated).toBe(0);
      expect(
        (await integrationRow(seeded.integrationId)).credentials_key_version,
      ).toBe(1);
      expect((await aiRow(seeded)).api_key_key_version).toBe(1);
    } finally {
      await release();
    }

    const freed = await job.runDataKeyRotation({
      database: db,
      log: captureLog().log,
    });
    expect(freed.skipped).toBeFalsy();
    expect(freed.integrationsRotated).toBeGreaterThanOrEqual(1);
    expect(freed.aiRotated).toBeGreaterThanOrEqual(1);
    expect(freed.failedTenants).toBe(0);
    expect(
      (await integrationRow(seeded.integrationId)).credentials_key_version,
    ).toBe(2);
    expect((await aiRow(seeded)).api_key_key_version).toBe(2);
  });

  it("legend-rg8yl the lock is released after a run, so the next run is not skipped", async () => {
    const { job, db } = await loadPhase2();
    const one = await job.runDataKeyRotation({
      database: db,
      log: captureLog().log,
    });
    const two = await job.runDataKeyRotation({
      database: db,
      log: captureLog().log,
    });
    expect(one.skipped).toBeFalsy();
    expect(two.skipped).toBeFalsy();
    expect(one.failedTenants).toBe(0);
    expect(two.failedTenants).toBe(0);
    // The lock is free: this session can take it.
    const release = await holdJobLock(job.DATA_KEY_ROTATION_LOCK_KEY);
    await release();
  });

  it("legend-rg8yl no key value or ciphertext reaches the logs or the console", async () => {
    const seeded = await seedStaleTenant();
    const sealedBefore = [
      (await integrationRow(seeded.integrationId)).credentials_encrypted,
      (await aiRow(seeded)).api_key_encrypted,
    ];
    const consoleCalls: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });

    const { job, db } = await loadPhase2();
    const captured = captureLog();
    const result = await job.runDataKeyRotation({
      database: db,
      log: captured.log,
    });
    expect(result.integrationsRotated).toBeGreaterThanOrEqual(1);
    expect(result.failedTenants).toBe(0);

    const sealedAfter = [
      (await integrationRow(seeded.integrationId)).credentials_encrypted,
      (await aiRow(seeded)).api_key_encrypted,
    ];
    const output = captured.text() + JSON.stringify(consoleCalls);
    for (const secret of [
      seeded.apiKey,
      seeded.aiKey,
      KEY2,
      ...sealedBefore,
      ...sealedAfter,
    ])
      expect(output).not.toContain(secret);
  });
});

describe("legend-rg8yl registerDataKeyRotationJob", () => {
  it("legend-rg8yl creates an exclusive queue, schedules a cron, registers a worker that rotates stale rows", async () => {
    const seeded = await seedStaleTenant();
    const { job, db } = await loadPhase2();
    const order: string[] = [];
    const boss = {
      createQueue: vi.fn(async () => void order.push("createQueue")),
      schedule: vi.fn(async () => void order.push("schedule")),
      work: vi.fn(async () => void order.push("work")),
    };
    const log = captureLog();
    await job.registerDataKeyRotationJob({
      boss,
      database: db,
      log: log.log,
    });

    expect(order).toEqual(["createQueue", "schedule", "work"]);
    expect(typeof job.DATA_KEY_ROTATION_QUEUE).toBe("string");
    expect(boss.createQueue).toHaveBeenCalledWith(
      job.DATA_KEY_ROTATION_QUEUE,
      expect.objectContaining({ policy: "exclusive" }),
    );
    const scheduleArgs = boss.schedule.mock.calls[0] as unknown as unknown[];
    expect(scheduleArgs[0]).toBe(job.DATA_KEY_ROTATION_QUEUE);
    expect(String(scheduleArgs[1]).trim().split(/\s+/)).toHaveLength(5);
    const workArgs = boss.work.mock.calls[0] as unknown as [
      string,
      (jobs: unknown[]) => Promise<void>,
    ];
    expect(workArgs[0]).toBe(job.DATA_KEY_ROTATION_QUEUE);

    // The scheduled job rotates the stale rows (no force).
    await expect(workArgs[1]([{ data: null }])).resolves.toBeUndefined();
    expect(
      (await integrationRow(seeded.integrationId)).credentials_key_version,
    ).toBe(2);
    expect((await aiRow(seeded)).api_key_key_version).toBe(2);
    expect(log.text()).not.toContain(seeded.apiKey);
    expect(log.text()).not.toContain(seeded.aiKey);
  });
});

// Second opinion (docs/qa/second-opinion-pajak-fk-rotasi.md, P2, brief 800 part
// 3). A stale AI key that cannot be opened is skipped by rotateAiProviderKeys
// with only a warning. The job must not report that as success: the tenant is
// counted as failed and the pg-boss handler rejects, so the failure is
// recorded and retried. Secrets stay out of the logs.
//
// Assumptions:
//   - The result carries `failedTenants`, the documented field (docs/
//     deployment.md); it may be a number or a list of tenant ids, so both are
//     accepted. When it is a list it must contain the broken tenant's id.
//   - "Cannot be opened" is a version-1 ciphertext sealed with the wrong AAD:
//     it is stale, well formed, but fails authentication under any key.
//   - The broken row is deleted at the end of each test so later tests of this
//     file (and the shared database) are not left with a permanent failure.
describe("legend-rg8yl stale AI key that cannot be opened", () => {
  const failedCount = (value: unknown): number =>
    Array.isArray(value) ? value.length : Number(value ?? 0);

  async function seedBrokenTenant() {
    const seeded = await seedStaleTenant();
    // Replace the good ciphertext with one sealed for another record.
    const unreadable = sealSecret(
      seeded.aiKey,
      aiAad(seeded.tenantId, randomUUID()),
    );
    await asOwner(seeded.tenantId, (client) =>
      client.query(
        "UPDATE ai_provider_configs SET api_key_encrypted = $2 WHERE id = $1",
        [seeded.aiId, unreadable],
      ),
    );
    expect(sealedVersion(unreadable)).toBe(1);
    return { ...seeded, unreadable };
  }

  async function dropBrokenRow(seeded: { tenantId: string; aiId: string }) {
    await asOwner(seeded.tenantId, (client) =>
      client.query("DELETE FROM ai_provider_configs WHERE id = $1", [
        seeded.aiId,
      ]),
    );
  }

  it("legend-rg8yl counts the broken tenant as failed, still rotates the healthy tenant, leaves the broken row untouched, and logs no secrets", async () => {
    const healthy = await seedStaleTenant();
    const broken = await seedBrokenTenant();
    const consoleCalls: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    try {
      const { job, db, secrets, ctxFor, service } = await loadPhase2();
      const captured = captureLog();
      const result = await job.runDataKeyRotation({
        database: db,
        log: captured.log,
      });

      // The broken tenant is counted as failed (and named when a list).
      const failed = (result as { failedTenants?: unknown }).failedTenants;
      expect(failedCount(failed)).toBe(1);
      if (Array.isArray(failed)) {
        const ids = failed.map((entry) =>
          typeof entry === "string"
            ? entry
            : String((entry as { tenantId?: unknown }).tenantId),
        );
        expect(ids).toContain(broken.tenantId);
        expect(ids).not.toContain(healthy.tenantId);
      }

      // The healthy tenant still rotated in the same run.
      expect(
        (await integrationRow(healthy.integrationId)).credentials_key_version,
      ).toBe(2);
      const healthyAi = await aiRow(healthy);
      expect(healthyAi.api_key_key_version).toBe(2);
      expect(
        secrets.openSecret(
          healthyAi.api_key_encrypted,
          aiAad(healthy.tenantId, healthy.aiId),
        ),
      ).toBe(healthy.aiKey);
      expect(
        (
          await service.loadActiveIntegrationCredentials(
            ctxFor(healthy.tenantId),
            "doit",
            null,
          )
        )?.credentials,
      ).toEqual({ apiKey: healthy.apiKey });

      // The broken row is not rewritten or lost.
      const brokenAi = await aiRow(broken);
      expect(brokenAi.api_key_key_version).toBe(1);
      expect(brokenAi.api_key_encrypted).toBe(broken.unreadable);

      // No key, plaintext, ciphertext or ring key in logs or console.
      const output = captured.text() + JSON.stringify(consoleCalls);
      for (const secret of [
        broken.aiKey,
        broken.apiKey,
        broken.unreadable,
        healthy.aiKey,
        healthy.apiKey,
        healthyAi.api_key_encrypted,
        KEY2,
      ])
        expect(output).not.toContain(secret);
    } finally {
      await dropBrokenRow(broken);
    }
  });

  it("legend-rg8yl the scheduled handler rejects (so pg-boss records the failure) without leaking secrets, while the healthy tenant rotated", async () => {
    const healthy = await seedStaleTenant();
    const broken = await seedBrokenTenant();
    try {
      const { job, db } = await loadPhase2();
      const boss = {
        createQueue: vi.fn(async () => undefined),
        schedule: vi.fn(async () => undefined),
        work: vi.fn(async () => undefined),
      };
      const log = captureLog();
      await job.registerDataKeyRotationJob({
        boss,
        database: db,
        log: log.log,
      });
      const handler = (
        boss.work.mock.calls[0] as unknown as [
          string,
          (jobs: unknown[]) => Promise<void>,
        ]
      )[1];

      const error = await handler([{ data: null }]).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);

      expect(
        (await integrationRow(healthy.integrationId)).credentials_key_version,
      ).toBe(2);
      expect((await aiRow(healthy)).api_key_key_version).toBe(2);
      expect((await aiRow(broken)).api_key_encrypted).toBe(broken.unreadable);

      const output =
        log.text() +
        String((error as Error).message) +
        String((error as Error).stack);
      for (const secret of [
        broken.aiKey,
        broken.apiKey,
        broken.unreadable,
        healthy.aiKey,
        healthy.apiKey,
        KEY2,
      ])
        expect(output).not.toContain(secret);

      // Retry is safe: the next run fails again for the same reason (the row
      // is still unreadable) instead of silently succeeding.
      await expect(handler([{ data: null }])).rejects.toBeInstanceOf(Error);
    } finally {
      await dropBrokenRow(broken);
    }
  });
});
