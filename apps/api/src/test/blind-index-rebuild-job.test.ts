// legend-n039: blind-index rebuild job against PostgreSQL with the restricted
// app role (RLS enforced). The default active version is 1 (legend-488); this
// file sets BLIND_INDEX_ACTIVE_VERSION=2 before the config loads, as the
// operator does after a rollout. Rows are forced back to version 1 / legacy
// digests to stand for data written before the cutover.
//
// Assumptions (contract: docs/design legend-n039):
// - run entry `runBlindIndexRebuild({ batchSize, log, listTenantIds })` and
//   `registerBlindIndexRebuildJob({ boss, listTenantIds, log })`, mirroring the
//   HRIS PII re-seal job; result {tenants, employees, legalEntities, conflicts,
//   incompleteTenants, failedTenants}.
// - the queued payload names the target as `targetVersion`.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BLIND_INDEX_ACTIVE_VERSION = "2";
});

import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
} from "../lib/blind-index.ts";
import { hrisBlindIndex } from "../lib/hris-pii.ts";
import { sealSecret } from "../lib/secrets.ts";
import {
  BLIND_INDEX_REBUILD_QUEUE,
  registerBlindIndexRebuildJob,
  runBlindIndexRebuild,
} from "../worker/blind-index-rebuild.job.ts";
import {
  asOwner,
  forceEmployeeV1,
  freshNik,
  freshNpwp,
  legacyNikDigest,
  legacyNpwpDigest,
  newFixture,
  owner,
  seedEmployee,
  setupTenants,
  teardown,
} from "./blind-index-fixtures.ts";

const fx = newFixture(4);
const [tenantA, tenantB, tenantC, tenantD] = fx.tenants as [
  string,
  string,
  string,
  string,
];

type Seed = { id: string; nik: string };
const employees: Record<string, Seed[]> = {};

async function seedLegalEntity(tenant: string, npwp: string): Promise<string> {
  const id = randomUUID();
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4, npwp_hash, npwp_hash_version)
       VALUES ($1, $2, 'PT NPWP', false, $3, $4, $5, 1)`,
      [
        id,
        tenant,
        sealSecret(npwp, `legal_entity:${tenant}`),
        npwp.slice(-4),
        legacyNpwpDigest(tenant, npwp),
      ],
    ),
  );
  return id;
}

async function seedV1Employee(tenant: string, nik = freshNik()): Promise<Seed> {
  const id = await seedEmployee(fx, tenant, nik);
  await forceEmployeeV1(tenant, id, nik);
  const seed = { id, nik };
  (employees[tenant] ??= []).push(seed);
  return seed;
}

const employeeRow = (tenant: string, id: string) =>
  asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT nik_encrypted, nik_hmac, blind_index_version, updated_at
         FROM employees WHERE tenant_id = $1 AND id = $2`,
      [tenant, id],
    );
    return rows[0] as {
      nik_encrypted: Buffer;
      nik_hmac: string;
      blind_index_version: number;
      updated_at: Date;
    };
  });

const entityRow = (tenant: string, id: string) =>
  asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT npwp_encrypted, npwp_hash, npwp_hash_version
         FROM legal_entities WHERE tenant_id = $1 AND id = $2`,
      [tenant, id],
    );
    return rows[0] as {
      npwp_encrypted: string | null;
      npwp_hash: string | null;
      npwp_hash_version: number;
    };
  });

const logs: string[] = [];
const capture = {
  error: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  warn: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  info: (...args: unknown[]) => logs.push(JSON.stringify(args)),
};
const rebuild = (only: string[], extra: Record<string, unknown> = {}) =>
  runBlindIndexRebuild({
    batchSize: 2,
    log: capture,
    listTenantIds: async () => only,
    ...extra,
  } as Parameters<typeof runBlindIndexRebuild>[0]);

let entityNpwp: { id: string; npwp: string };
let entityNoNpwp: string;
let sharedNik: string;

beforeAll(async () => {
  await setupTenants(fx, "blind-index-job");
  expect(BLIND_INDEX_ACTIVE_VERSION).toBe(2);
  // Tenant A: two employees, one legal entity with NPWP, one without.
  sharedNik = freshNik();
  await seedV1Employee(tenantA, sharedNik);
  await seedV1Employee(tenantA);
  const npwp = freshNpwp();
  entityNpwp = { id: await seedLegalEntity(tenantA, npwp), npwp };
  entityNoNpwp = fx.entity[tenantA]!;
  // Tenant B holds the same NIK as tenant A's first employee.
  await seedV1Employee(tenantB, sharedNik);
});

afterAll(async () => {
  for (const tenant of fx.tenants)
    await asOwner(tenant, (client) =>
      client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id <> $2",
        [tenant, fx.entity[tenant]],
      ),
    );
  await teardown(fx);
});

describe("legend-n039 blind-index rebuild job", () => {
  it("[HR-03] starts from version 1 rows with legacy digests", async () => {
    const first = employees[tenantA]![0]!;
    const row = await employeeRow(tenantA, first.id);
    expect(row.blind_index_version).toBe(1);
    expect(row.nik_hmac).toBe(legacyNikDigest(tenantA, first.nik));
    expect((await entityRow(tenantA, entityNpwp.id)).npwp_hash_version).toBe(1);
  });

  it("[HR-03] moves employees and legal entities to v2 digests without touching sealed bytes or updated_at", async () => {
    const targets = [
      ...employees[tenantA]!.map((seed) => ({ seed, tenant: tenantA })),
      ...employees[tenantB]!.map((seed) => ({ seed, tenant: tenantB })),
    ];
    const before = await Promise.all(
      targets.map(async ({ seed, tenant }) => ({
        seed,
        tenant,
        row: await employeeRow(tenant, seed.id),
      })),
    );
    const entityBefore = await entityRow(tenantA, entityNpwp.id);

    const result = await rebuild([tenantA, tenantB]);
    expect(result).toMatchObject({
      tenants: 2,
      employees: 3,
      legalEntities: 3,
      conflicts: 0,
      incompleteTenants: 0,
      failedTenants: 0,
    });

    for (const { seed, tenant, row } of before) {
      const after = await employeeRow(tenant, seed.id);
      expect(after.blind_index_version).toBe(2);
      expect(after.nik_hmac).toBe(hrisBlindIndex("nik", tenant, seed.nik, 2));
      expect(after.nik_hmac).not.toBe(row.nik_hmac);
      expect(after.nik_encrypted.equals(row.nik_encrypted)).toBe(true);
      expect(after.updated_at).toEqual(row.updated_at);
    }

    const entityAfter = await entityRow(tenantA, entityNpwp.id);
    expect(entityAfter.npwp_hash_version).toBe(2);
    expect(entityAfter.npwp_hash).toBe(
      blindIndexAt(2, entityNpwp.npwp, `legal_entity-npwp:${tenantA}`),
    );
    expect(entityAfter.npwp_encrypted).toBe(entityBefore.npwp_encrypted);

    // An entity without an NPWP only gets its version set.
    const empty = await entityRow(tenantA, entityNoNpwp);
    expect(empty.npwp_hash).toBeNull();
    expect(empty.npwp_hash_version).toBe(2);
  });

  it("[HR-03] the same NIK in two tenants never conflicts (digests are tenant-separated)", async () => {
    const a = await employeeRow(tenantA, employees[tenantA]![0]!.id);
    const b = await employeeRow(tenantB, employees[tenantB]![0]!.id);
    expect(a.nik_hmac).not.toBe(b.nik_hmac);
  });

  it("[HR-03] a second run changes nothing", async () => {
    const before = await employeeRow(tenantA, employees[tenantA]![0]!.id);
    const result = await rebuild([tenantA, tenantB]);
    expect(result).toMatchObject({
      employees: 0,
      legalEntities: 0,
      conflicts: 0,
      incompleteTenants: 0,
      failedTenants: 0,
    });
    expect(await employeeRow(tenantA, employees[tenantA]![0]!.id)).toEqual(
      before,
    );
  });

  it("[HR-03] a v1 row whose v2 digest is already taken stays v1, is counted as a conflict and the tenant is incomplete", async () => {
    logs.length = 0;
    const x = await seedV1Employee(tenantC);
    const y = await seedV1Employee(tenantC);
    // Y was written after the cutover with the same NIK as X (rolling deploy).
    await asOwner(tenantC, (client) =>
      client.query(
        `UPDATE employees SET nik_hmac = $3, blind_index_version = 2
          WHERE tenant_id = $1 AND id = $2`,
        [tenantC, y.id, hrisBlindIndex("nik", tenantC, x.nik, 2)],
      ),
    );
    const result = await rebuild([tenantC]);
    expect(result).toMatchObject({
      conflicts: 1,
      incompleteTenants: 1,
      failedTenants: 0,
    });
    const rowX = await employeeRow(tenantC, x.id);
    expect(rowX.blind_index_version).toBe(1);
    expect(rowX.nik_hmac).toBe(legacyNikDigest(tenantC, x.nik));
    // Logs name tenant/row/constraint at most, never the value or a digest.
    const output = logs.join("\n");
    expect(output).not.toContain(x.nik);
    expect(output).not.toContain(legacyNikDigest(tenantC, x.nik));
    expect(output).not.toContain(hrisBlindIndex("nik", tenantC, x.nik, 2));
  });

  it("[HR-03] a legal-entity NPWP whose v2 digest is already taken is a conflict too", async () => {
    const npwp = freshNpwp();
    const stale = await seedLegalEntity(tenantC, npwp);
    const taken = randomUUID();
    await asOwner(tenantC, (client) =>
      client.query(
        `INSERT INTO legal_entities
           (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4, npwp_hash, npwp_hash_version)
         VALUES ($1, $2, 'PT Twin', false, $3, $4, $5, 2)`,
        [
          taken,
          tenantC,
          sealSecret(npwp, `legal_entity:${tenantC}`),
          npwp.slice(-4),
          blindIndexAt(2, npwp, `legal_entity-npwp:${tenantC}`),
        ],
      ),
    );
    const result = await rebuild([tenantC]);
    expect(result.conflicts).toBeGreaterThanOrEqual(1);
    expect(result.incompleteTenants).toBe(1);
    const row = await entityRow(tenantC, stale);
    expect(row.npwp_hash_version).toBe(1);
    expect(row.npwp_hash).toBe(legacyNpwpDigest(tenantC, npwp));
  });

  it("[HR-03] a suspended tenant is still rebuilt", async () => {
    const seed = await seedV1Employee(tenantD);
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantD,
    ]);
    try {
      const result = await rebuild([tenantD]);
      expect(result).toMatchObject({ employees: 1, incompleteTenants: 0 });
      expect((await employeeRow(tenantD, seed.id)).blind_index_version).toBe(2);
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        tenantD,
      ]);
    }
  });

  it("[HR-03] createEmployee writes the active blind-index version, even without PII", async () => {
    const withoutPii = await seedEmployee(fx, tenantD, null);
    const withNik = freshNik();
    const withPii = await seedEmployee(fx, tenantD, withNik);
    expect(
      (
        await asOwner(tenantD, async (client) => {
          const { rows } = await client.query(
            `SELECT id, blind_index_version FROM employees
            WHERE tenant_id = $1 AND id = ANY($2)`,
            [tenantD, [withoutPii, withPii]],
          );
          return rows;
        })
      ).map((row) => row.blind_index_version),
    ).toEqual([BLIND_INDEX_ACTIVE_VERSION, BLIND_INDEX_ACTIVE_VERSION]);
    expect((await employeeRow(tenantD, withPii)).nik_hmac).toBe(
      hrisBlindIndex("nik", tenantD, withNik, 2),
    );
  });

  it("[HR-03] verify mode scans rows already at the active version and rewrites wrong digests", async () => {
    // Version column says 2, digests are wrong: the normal run cannot see it.
    const nik = freshNik();
    const wrongEmployee = await seedEmployee(fx, tenantA, nik);
    const entityNpwp2 = freshNpwp();
    const wrongEntity = await seedLegalEntity(tenantA, entityNpwp2);
    await asOwner(tenantA, async (client) => {
      await client.query(
        `UPDATE employees SET nik_hmac = $3, blind_index_version = 2
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA, wrongEmployee, legacyNikDigest(tenantA, nik)],
      );
      await client.query(
        `UPDATE legal_entities SET npwp_hash_version = 2
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA, wrongEntity],
      );
    });
    const normal = await rebuild([tenantA]);
    expect(normal).toMatchObject({
      employees: 0,
      legalEntities: 0,
      rewrites: 0,
    });
    expect((await employeeRow(tenantA, wrongEmployee)).nik_hmac).toBe(
      legacyNikDigest(tenantA, nik),
    );

    const verified = await rebuild([tenantA], { verify: true });
    expect(verified).toMatchObject({
      verify: true,
      employees: 1,
      legalEntities: 1,
      rewrites: 2,
      conflicts: 0,
      incompleteTenants: 0,
      failedTenants: 0,
    });
    const fixed = await employeeRow(tenantA, wrongEmployee);
    expect(fixed.nik_hmac).toBe(hrisBlindIndex("nik", tenantA, nik, 2));
    expect(fixed.blind_index_version).toBe(2);
    expect((await entityRow(tenantA, wrongEntity)).npwp_hash).toBe(
      blindIndexAt(2, entityNpwp2, `legal_entity-npwp:${tenantA}`),
    );

    // The proof run: nothing left to rewrite.
    expect(await rebuild([tenantA], { verify: true })).toMatchObject({
      rewrites: 0,
      conflicts: 0,
      incompleteTenants: 0,
    });
  });

  it("[HR-03] an interrupted run resumes: abort after the first batch, rerun finishes", async () => {
    const seeds = [
      await seedV1Employee(tenantD),
      await seedV1Employee(tenantD),
      await seedV1Employee(tenantD),
    ];
    const controller = new AbortController();
    const first = await rebuild([tenantD], {
      batchSize: 1,
      signal: controller.signal,
      afterBatch: () => controller.abort(),
    });
    expect(first.aborted).toBe(true);
    const resumed = await rebuild([tenantD], { batchSize: 1 });
    expect(resumed).toMatchObject({ aborted: false, failedTenants: 0 });
    expect(first.employees + resumed.employees).toBe(seeds.length);
    for (const seed of seeds)
      expect((await employeeRow(tenantD, seed.id)).blind_index_version).toBe(2);
  });

  describe("queued job", () => {
    type Handler = (jobs: { data: unknown }[]) => Promise<void>;
    async function handler(only: string[]): Promise<{
      run: Handler;
      queue: string | undefined;
      errors: string[];
      infos: string[];
    }> {
      const errors: string[] = [];
      const infos: string[] = [];
      let run: Handler | undefined;
      let queue: string | undefined;
      await registerBlindIndexRebuildJob({
        boss: {
          createQueue: async (name: string) => {
            queue = name;
          },
          work: async (_name: string, fn: Handler) => {
            run = fn;
          },
        },
        listTenantIds: async () => only,
        log: {
          error: (message: string) => errors.push(message),
          info: (message: string) => infos.push(message),
          warn: () => {},
        },
      } as unknown as Parameters<typeof registerBlindIndexRebuildJob>[0]);
      return { run: run!, queue, errors, infos };
    }

    it("[HR-03] registers the on-demand queue 'blind-index-rebuild'", async () => {
      expect(BLIND_INDEX_REBUILD_QUEUE).toBe("blind-index-rebuild");
      expect((await handler([tenantD])).queue).toBe("blind-index-rebuild");
    });

    it("[HR-03] refuses without writes when the target version is not the worker's active version", async () => {
      const seed = await seedV1Employee(tenantD);
      const { run } = await handler([tenantD]);
      await expect(run([{ data: { targetVersion: 1 } }])).rejects.toThrow(
        /target/i,
      );
      await expect(run([{ data: {} }])).rejects.toThrow(/target/i);
      await expect(run([{ data: null }])).rejects.toThrow(/target/i);
      expect((await employeeRow(tenantD, seed.id)).blind_index_version).toBe(1);
      await run([{ data: { targetVersion: BLIND_INDEX_ACTIVE_VERSION } }]);
      expect((await employeeRow(tenantD, seed.id)).blind_index_version).toBe(2);
    });

    it("[HR-03] a permanent conflict does not fail the job (no endless retry); it is logged", async () => {
      const { run, errors } = await handler([tenantC]);
      await expect(
        run([{ data: { targetVersion: BLIND_INDEX_ACTIVE_VERSION } }]),
      ).resolves.toBeUndefined();
      expect(errors.join("\n")).toMatch(/conflict/i);
    });

    it("[HR-03] fails the job when stale rows are locked by another transaction (retryable)", async () => {
      const seed = await seedV1Employee(tenantD);
      const { run } = await handler([tenantD]);
      await asOwner(tenantD, async (client) => {
        await client.query(
          "SELECT id FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [tenantD, seed.id],
        );
        const locked = await rebuild([tenantD]);
        expect(locked).toMatchObject({
          employees: 0,
          conflicts: 0,
          incompleteTenants: 1,
          retryableTenants: 1,
        });
        await expect(
          run([{ data: { targetVersion: BLIND_INDEX_ACTIVE_VERSION } }]),
        ).rejects.toThrow(/incomplete/i);
      });
      const retry = await rebuild([tenantD]);
      expect(retry).toMatchObject({ employees: 1, retryableTenants: 0 });
      expect((await employeeRow(tenantD, seed.id)).blind_index_version).toBe(2);
    });

    it("[HR-03] a job with verify:true runs the full scan and reports rewrites", async () => {
      const seed = await seedV1Employee(tenantD);
      await asOwner(tenantD, (client) =>
        client.query(
          `UPDATE employees SET nik_hmac = $3, blind_index_version = 2
            WHERE tenant_id = $1 AND id = $2`,
          [tenantD, seed.id, "0".repeat(64)],
        ),
      );
      const { run, infos } = await handler([tenantD]);
      await run([
        { data: { targetVersion: BLIND_INDEX_ACTIVE_VERSION, verify: true } },
      ]);
      expect(infos.join("\n")).toContain('"verify":true');
      expect(infos.join("\n")).toContain('"rewrites":1');
      expect((await employeeRow(tenantD, seed.id)).nik_hmac).toBe(
        hrisBlindIndex("nik", tenantD, seed.nik, 2),
      );
    });
  });
});
