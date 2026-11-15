// legend-v0kta: the blind-index rebuild job also covers bank_accounts
// (account_number_hmac + account_number_hmac_version, sealed
// account_number_encrypted), and the version column is constrained to 1 or 2.
//
// Money rule under test: after the cutover a v1 bank account must still be
// refused as a duplicate, and the rebuild must never rewrite a row into a
// digest that another row of the same legal entity already holds.
//
// Assumptions (written from the brief, not the implementation):
//  - The run result counts rewritten bank rows in `bankAccounts`; the other
//    fields are the ones the existing rebuild tests use (`conflicts`,
//    `skipped`, `rewrites`, `incompleteTenants`, `retryableTenants`).
//  - A conflicting bank pair counts in `conflicts`, leaves the stale row
//    untouched and makes the tenant incomplete (non-retry, like HRIS).
//  - Rows are put into the pre-cutover state without knowing how the digest is
//    built: a number is created under v1 and under v2 through the service, and
//    the two digests are swapped in with SQL. No digest is computed here.
//  - The CHECK violation is PostgreSQL error 23514; the constraint name is not
//    asserted (the brief only suggests one).
//  - The active version is read at module load, so every phase reloads the
//    module graph after setting the env, and contexts are built afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
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
import { originHeader } from "./helpers";

type Version = 1 | 2;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
// A rebuild sweeps every indexed table in its tenant before reaching banks.
// Other suites intentionally seed unreadable PII in the shared cafe tenant,
// so this suite owns a tenant as well as its bank/entity rows.
const tenantId = randomUUID();
const PASSWORD = "Test-password-123!";
const createdUserIds = new Set<string>();
const entityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const newNumber = () =>
  String(Math.floor(Math.random() * 9e11) + 1e11).padStart(12, "1");
const ZEROS = "0".repeat(64);

const logs: string[] = [];
const capture = {
  error: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  warn: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  info: (...args: unknown[]) => logs.push(JSON.stringify(args)),
};

async function loadAt(version: Version) {
  vi.resetModules();
  process.env.BLIND_INDEX_ACTIVE_VERSION = String(version);
  const [{ createApp }, bank, core, coreServer, job] = await Promise.all([
    import("../app"),
    import("../services/accounting-bank-accounts.service"),
    import("@starter/shared/core"),
    import("@starter/shared/core/server"),
    import("../worker/blind-index-rebuild.job"),
  ]);
  const scope = () =>
    coreServer.establishScopedTenantContext(
      coreServer.establishTenantContext({
        tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
  type Result = Awaited<ReturnType<typeof job.runBlindIndexRebuild>> & {
    bankAccounts: number;
    conflicts: number;
    skipped: number;
    rewrites: number;
    incompleteTenants: number;
    retryableTenants: number;
  };
  return {
    app: createApp(),
    createBankAccount: (input: ReturnType<typeof bankBody>, userId: string) =>
      bank.createBankAccount(
        scope(),
        input as never,
        core.userIdSchema.parse(userId),
      ),
    rebuild: (extra: Record<string, unknown> = {}) =>
      job.runBlindIndexRebuild({
        batchSize: 2,
        log: capture,
        listTenantIds: async () => [tenantId],
        ...extra,
      } as Parameters<typeof job.runBlindIndexRebuild>[0]) as Promise<Result>,
  };
}

const originalActive = process.env.BLIND_INDEX_ACTIVE_VERSION;
afterEach(() => {
  if (originalActive === undefined)
    delete process.env.BLIND_INDEX_ACTIVE_VERSION;
  else process.env.BLIND_INDEX_ACTIVE_VERSION = originalActive;
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const inserted = await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank blind-index rebuild', plan, status, deployment_mode,
            feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenantId,
      `bank-blind-index-${tenantId}`,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  expect(inserted.rowCount).toBe(1);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM bank_accounts WHERE legal_entity_id = ANY($1::uuid[])",
    [entityIds],
  );
  await owner.query(
    "DELETE FROM chart_of_accounts WHERE legal_entity_id = ANY($1::uuid[])",
    [entityIds],
  );
  await owner.query("DELETE FROM legal_entities WHERE id = ANY($1::uuid[])", [
    entityIds,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  if (createdUserIds.size > 0) {
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      [...createdUserIds],
    ]);
  }
  await owner.end();
});

async function newEntityWithGl(): Promise<{ entity: string; gl: string }> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `V0kta PT ${unique()}`],
  );
  const entity = rows[0]!.id;
  entityIds.push(entity);
  const glRows = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents')
     RETURNING id`,
    [tenantId, entity],
  );
  return { entity, gl: glRows.rows[0]!.id };
}

const bankBody = (entity: string, gl: string, accountNumber: string) => ({
  legalEntityId: entity,
  bank: "BCA",
  accountName: "Kas Operasional",
  accountNumber,
  glAccountId: gl,
});

async function signUpUser(app: Awaited<ReturnType<typeof loadAt>>["app"]) {
  const response = await request(app)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({
      name: "V0kta",
      email: `v0kta-${randomUUID()}@example.com`,
      password: PASSWORD,
    });
  expect(response.status).toBe(200);
  createdUserIds.add(response.body.user.id);
  return response.body.user.id as string;
}

type BankRow = {
  id: string;
  hmac: string;
  version: number;
  enc: unknown;
};

async function rowsOf(entity: string): Promise<BankRow[]> {
  const { rows } = await owner.query<BankRow>(
    `SELECT id, account_number_hmac AS hmac,
            account_number_hmac_version AS version,
            account_number_encrypted AS enc
       FROM bank_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [tenantId, entity],
  );
  return rows;
}

async function onlyRow(entity: string): Promise<BankRow> {
  const rows = await rowsOf(entity);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function setDigest(id: string, hmac: string, version: number) {
  await owner.query(
    `UPDATE bank_accounts
        SET account_number_hmac = $2, account_number_hmac_version = $3
      WHERE tenant_id = $1 AND id = $4`,
    [tenantId, hmac, version, id],
  );
}

async function dropRows(entity: string) {
  await owner.query(
    "DELETE FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entity],
  );
}

/**
 * A bank account in the pre-cutover state: one row whose digest is the v1
 * digest and version 1, plus the v2 digest the rebuild must produce. Both
 * digests come from the service itself (create under v1, drop, create under
 * v2), then the v1 digest is put back.
 */
async function seedStaleV1(
  entity: string,
  gl: string,
  number: string,
  userId: string,
) {
  const v1 = await loadAt(1);
  await v1.createBankAccount(bankBody(entity, gl, number), userId);
  const d1 = (await onlyRow(entity)).hmac;
  await dropRows(entity);
  const v2 = await loadAt(2);
  await v2.createBankAccount(bankBody(entity, gl, number), userId);
  const row = await onlyRow(entity);
  expect(row.version).toBe(2);
  expect(row.hmac).not.toBe(d1);
  await setDigest(row.id, d1, 1);
  return { id: row.id, d1, d2: row.hmac, enc: row.enc };
}

describe("legend-v0kta bank account blind-index rebuild", () => {
  it("legend-v0kta: a v1 bank account cannot be registered twice after the rebuild to v2", async () => {
    const number = newNumber();
    const v1 = await loadAt(1);
    const userId = await signUpUser(v1.app);
    const { entity, gl } = await newEntityWithGl();
    await v1.createBankAccount(bankBody(entity, gl, number), userId);
    expect((await onlyRow(entity)).version).toBe(1);

    const v2 = await loadAt(2);
    await v2.rebuild();
    expect((await onlyRow(entity)).version).toBe(2);

    await expect(
      v2.createBankAccount(bankBody(entity, gl, number), userId),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rowsOf(entity)).toHaveLength(1);
    // Another number in the same entity is still fine.
    await expect(
      v2.createBankAccount(bankBody(entity, gl, newNumber()), userId),
    ).resolves.toMatchObject({ legalEntityId: entity });
  });

  it("legend-v0kta: the rebuild rewrites digest and version to the active version and keeps the sealed number", async () => {
    const v1 = await loadAt(1);
    const userId = await signUpUser(v1.app);
    const { entity, gl } = await newEntityWithGl();
    const seed = await seedStaleV1(entity, gl, newNumber(), userId);
    const before = await onlyRow(entity);
    expect(before).toMatchObject({ version: 1, hmac: seed.d1 });

    const v2 = await loadAt(2);
    const result = await v2.rebuild();
    expect(result.bankAccounts).toBeGreaterThanOrEqual(1);
    expect(result.failedTenants).toBe(0);

    const after = await onlyRow(entity);
    expect(after.version).toBe(2);
    expect(after.hmac).toBe(seed.d2);
    expect(after.hmac).not.toBe(seed.d1);
    expect(after.enc).toEqual(before.enc);

    // A second run has nothing left to change on this row.
    await v2.rebuild();
    expect(await onlyRow(entity)).toEqual(after);
  });

  it("legend-v0kta: a conflicting pair is flagged and the stale row is not overwritten", async () => {
    logs.length = 0;
    const number = newNumber();
    const v1 = await loadAt(1);
    const userId = await signUpUser(v1.app);
    const { entity, gl } = await newEntityWithGl();
    // Row A: written under v1.
    await v1.createBankAccount(bankBody(entity, gl, number), userId);
    const a = await onlyRow(entity);
    // Park A's digest so the service accepts row B (the same number written
    // after the cutover, as during a rolling deploy), then restore it.
    await setDigest(a.id, ZEROS, 1);
    const v2 = await loadAt(2);
    await v2.createBankAccount(bankBody(entity, gl, number), userId);
    await setDigest(a.id, a.hmac, 1);
    const rows = await rowsOf(entity);
    expect(rows).toHaveLength(2);
    const b = rows.find((row) => row.id !== a.id)!;
    expect(b.version).toBe(2);

    try {
      const result = await v2.rebuild();
      expect(result.conflicts).toBeGreaterThanOrEqual(1);
      expect(result.incompleteTenants).toBeGreaterThanOrEqual(1);
      expect(result.failedTenants).toBe(0);

      const after = await rowsOf(entity);
      const staleA = after.find((row) => row.id === a.id)!;
      const twinB = after.find((row) => row.id === b.id)!;
      expect(staleA).toMatchObject({ version: 1, hmac: a.hmac });
      expect(twinB).toMatchObject({ version: 2, hmac: b.hmac });

      // Logs may name tenant/row, never the account number or a digest.
      const output = logs.join("\n");
      expect(output).not.toContain(number);
      expect(output).not.toContain(a.hmac);
      expect(output).not.toContain(b.hmac);
    } finally {
      await dropRows(entity);
    }
  });

  it("legend-v0kta: verify rewrites a wrong bank digest at the active version", async () => {
    const v2 = await loadAt(2);
    const userId = await signUpUser(v2.app);
    const { entity, gl } = await newEntityWithGl();
    await v2.createBankAccount(bankBody(entity, gl, newNumber()), userId);
    const good = await onlyRow(entity);
    await setDigest(good.id, ZEROS, 2);

    // A normal run never touches a row already at the active version (the
    // run counts every tenant, so only this row is asserted).
    await v2.rebuild();
    expect((await onlyRow(entity)).hmac).toBe(ZEROS);

    const verified = await v2.rebuild({ verify: true });
    expect(verified.rewrites).toBeGreaterThanOrEqual(1);
    expect(await onlyRow(entity)).toMatchObject({
      hmac: good.hmac,
      version: 2,
    });
    expect(await v2.rebuild({ verify: true })).toMatchObject({
      rewrites: 0,
      skipped: 0,
    });
  });

  it("legend-v0kta: verify counts a locked bank row as skipped and stays unclean until it is released", async () => {
    const v2 = await loadAt(2);
    const userId = await signUpUser(v2.app);
    const { entity, gl } = await newEntityWithGl();
    await v2.createBankAccount(bankBody(entity, gl, newNumber()), userId);
    const row = await onlyRow(entity);
    // Wrong digest behind the lock: verify must not write it, must not call
    // the run clean.
    await setDigest(row.id, ZEROS, 2);

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, row.id],
      );
      const locked = await v2.rebuild({ verify: true });
      expect(locked.skipped).toBeGreaterThanOrEqual(1);
      expect(locked.incompleteTenants).toBeGreaterThanOrEqual(1);
      expect(locked.retryableTenants).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await onlyRow(entity)).hmac).toBe(ZEROS);

    const retry = await v2.rebuild({ verify: true });
    expect(retry.rewrites).toBeGreaterThanOrEqual(1);
    expect(await onlyRow(entity)).toMatchObject({
      hmac: row.hmac,
      version: 2,
    });
  });
});

describe("legend-v0kta bank_accounts hmac version constraint", () => {
  async function expectCheckViolation(
    run: (client: import("pg").PoolClient) => Promise<unknown>,
  ) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await expect(run(client)).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("legend-v0kta: version 3 is rejected on update and on insert, 1 and 2 are accepted", async () => {
    const v1 = await loadAt(1);
    const userId = await signUpUser(v1.app);
    const { entity, gl } = await newEntityWithGl();
    await v1.createBankAccount(bankBody(entity, gl, newNumber()), userId);
    const row = await onlyRow(entity);

    await expectCheckViolation((client) =>
      client.query(
        `UPDATE bank_accounts SET account_number_hmac_version = 3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id],
      ),
    );

    // Insert a copy of the row with version 3 (copied through a temp table so
    // no column list is needed).
    await expectCheckViolation(async (client) => {
      await client.query(
        "CREATE TEMP TABLE v0kta_copy ON COMMIT DROP AS SELECT * FROM bank_accounts WHERE id = $1",
        [row.id],
      );
      await client.query(
        `UPDATE v0kta_copy
            SET id = gen_random_uuid(),
                account_number_hmac = $1,
                account_number_hmac_version = 3`,
        ["f".repeat(64)],
      );
      return client.query("INSERT INTO bank_accounts SELECT * FROM v0kta_copy");
    });

    expect((await onlyRow(entity)).version).toBe(1);
    for (const version of [2, 1]) {
      await setDigest(row.id, row.hmac, version);
      expect((await onlyRow(entity)).version).toBe(version);
    }
  });
});
