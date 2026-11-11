// legend-488 item 10 (Codex finding blind-index-rebuild.job.ts:221): verify mode
// must not skip rows locked by another transaction silently. It counts them and
// the run is clean only when the skipped count is 0.
//
// Assumptions (brief docs/briefs/488-findings-fixes.md item 10; the result
// shape extends the one in blind-index-rebuild-job.test.ts):
// - the run result carries `skipped`: number of rows verify could not inspect
//   because another transaction held the row lock.
// - skipped > 0 makes the tenant incomplete and retryable
//   (`incompleteTenants` 1, `retryableTenants` 1), so the queued verify job
//   rejects with /incomplete/ (pg-boss retries) instead of reporting clean.
// - a locked row counts as skipped even when its digest happens to be right:
//   verify cannot know while it is locked.
// - Tests use the worker's active version, so they hold under either default.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLIND_INDEX_ACTIVE_VERSION } from "../lib/blind-index.ts";
import { hrisBlindIndex } from "../lib/hris-pii.ts";
import {
  registerBlindIndexRebuildJob,
  runBlindIndexRebuild,
} from "../worker/blind-index-rebuild.job.ts";
import {
  asOwner,
  freshNik,
  newFixture,
  seedEmployee,
  setupTenants,
  teardown,
} from "./blind-index-fixtures.ts";

const fx = newFixture(1);
const tenant = fx.tenants[0]!;
const silent = { error: () => {}, warn: () => {}, info: () => {} };

type Result = Awaited<ReturnType<typeof runBlindIndexRebuild>> & {
  skipped: number;
  rewrites: number;
  incompleteTenants: number;
  retryableTenants: number;
};

const verify = () =>
  runBlindIndexRebuild({
    batchSize: 2,
    log: silent,
    listTenantIds: async () => [tenant],
    verify: true,
  } as Parameters<typeof runBlindIndexRebuild>[0]) as Promise<Result>;

/** An employee whose version says "active" but whose digest is wrong. */
async function seedWrongDigest(): Promise<{ id: string; nik: string }> {
  const nik = freshNik();
  const id = await seedEmployee(fx, tenant, nik);
  await asOwner(tenant, (client) =>
    client.query(
      `UPDATE employees SET nik_hmac = $3, blind_index_version = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, id, "0".repeat(64), BLIND_INDEX_ACTIVE_VERSION],
    ),
  );
  return { id, nik };
}

const nikDigest = (id: string) =>
  asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT nik_hmac FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant, id],
    );
    return rows[0].nik_hmac as string;
  });

const lock = (client: import("pg").PoolClient, id: string) =>
  client.query(
    "SELECT id FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [tenant, id],
  );

beforeAll(async () => {
  await setupTenants(fx, "blind-index-skipped");
});

afterAll(async () => {
  await teardown(fx);
});

describe("blind-index verify counts locked rows (legend-488 #10)", () => {
  it("a locked wrong row is skipped, counted and keeps the run incomplete", async () => {
    const seed = await seedWrongDigest();
    await asOwner(tenant, async (client) => {
      await lock(client, seed.id);
      const locked = await verify();
      expect(locked.skipped).toBeGreaterThanOrEqual(1);
      expect(locked.rewrites).toBe(0);
      expect(locked.incompleteTenants).toBe(1);
      expect(locked.retryableTenants).toBe(1);
      // Nothing was written behind the lock.
      expect(await nikDigest(seed.id)).toBe("0".repeat(64));
    });

    // Lock released: the retry fixes the row, nothing is skipped.
    const retry = await verify();
    expect(retry).toMatchObject({
      skipped: 0,
      rewrites: 1,
      incompleteTenants: 0,
      retryableTenants: 0,
    });
    expect(await nikDigest(seed.id)).toBe(
      hrisBlindIndex("nik", tenant, seed.nik, BLIND_INDEX_ACTIVE_VERSION),
    );
  });

  it("a locked row that is already correct still counts as skipped", async () => {
    const nik = freshNik();
    const id = await seedEmployee(fx, tenant, nik);
    await asOwner(tenant, async (client) => {
      await lock(client, id);
      const locked = await verify();
      expect(locked.skipped).toBeGreaterThanOrEqual(1);
      expect(locked.incompleteTenants).toBe(1);
    });
  });

  it("verify is clean only at skipped = 0 and rewrites = 0", async () => {
    await seedWrongDigest();
    const fixed = await verify();
    expect(fixed).toMatchObject({ skipped: 0, rewrites: 1 });
    const proof = await verify();
    expect(proof).toMatchObject({
      skipped: 0,
      rewrites: 0,
      conflicts: 0,
      incompleteTenants: 0,
      failedTenants: 0,
      retryableTenants: 0,
    });
  });

  describe("queued verify job", () => {
    type Handler = (jobs: { data: unknown }[]) => Promise<void>;
    async function handler() {
      const errors: string[] = [];
      const infos: string[] = [];
      let run: Handler | undefined;
      await registerBlindIndexRebuildJob({
        boss: {
          createQueue: async () => {},
          work: async (_name: string, fn: Handler) => {
            run = fn;
          },
        },
        listTenantIds: async () => [tenant],
        log: {
          error: (message: string) => errors.push(message),
          info: (message: string) => infos.push(message),
          warn: () => {},
        },
      } as unknown as Parameters<typeof registerBlindIndexRebuildJob>[0]);
      return { run: run!, errors, infos };
    }
    const payload = {
      data: { targetVersion: BLIND_INDEX_ACTIVE_VERSION, verify: true },
    };

    it("fails (so pg-boss retries) while rows are locked, instead of reporting a clean verify", async () => {
      const seed = await seedWrongDigest();
      const { run } = await handler();
      await asOwner(tenant, async (client) => {
        await lock(client, seed.id);
        await expect(run([payload])).rejects.toThrow(/incomplete/i);
      });
    });

    it("succeeds and logs skipped 0 once nothing is locked", async () => {
      const { run, infos } = await handler();
      await run([payload]);
      expect(infos.join("\n")).toContain('"skipped":0');
    });
  });
});
