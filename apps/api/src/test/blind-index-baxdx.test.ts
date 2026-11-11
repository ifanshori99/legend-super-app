// legend-baxdx: blind index v2 for bank account numbers and MFA recovery codes.
// Follows the legend-n039 pattern: BLIND_INDEX_ACTIVE_VERSION (default 1)
// picks the version writers use; duplicate checks and code lookups consider
// the digest under every version; the version is stored per row.
//
// The active version is read when the modules load, so each phase loads a fresh
// module graph (vi.resetModules + dynamic import) with the env set first. Rows
// written under one version are then checked under the other, both directions.
//
// Assumptions (the brief does not name them):
//  - bank_accounts.account_number_hmac_version stores the version per row.
//    mfa_recovery_codes has no version column: stored digests are compared
//    with recoveryCodeHash(userId, normalizedCode, version) instead.
//  - A duplicate bank account makes the service reject with code "CONFLICT"
//    (the code the HTTP layer already shows as 409).
//  - Digests differ between versions, so the same number written under v1 and
//    under v2 (in two legal entities) gives two different stored hashes.
//  - Consuming a code answers 200; a spent or wrong code answers 401
//    MFA_RECOVERY_CODE_INVALID (same as identity-mfa-recovery-api.test.ts).
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
import {
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "../lib/mfa-recovery-code";
import { totpCode, totpStep } from "../lib/totp";
import { originHeader } from "./helpers";

type Version = 1 | 2;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const PASSWORD = "Test-password-123!";
const createdUserIds = new Set<string>();
const entityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const newNumber = () =>
  String(Math.floor(Math.random() * 9e11) + 1e11).padStart(12, "1");

/**
 * Fresh module graph with the given active blind index version. The tenant
 * context and user id are built from the same reloaded modules: provenance of a
 * context is per module instance (TEN-02), so one built before a reload is
 * rejected after it.
 */
async function loadAt(version: Version) {
  vi.resetModules();
  process.env.BLIND_INDEX_ACTIVE_VERSION = String(version);
  const [{ createApp }, bank, core, coreServer] = await Promise.all([
    import("../app"),
    import("../services/accounting-bank-accounts.service"),
    import("@starter/shared/core"),
    import("@starter/shared/core/server"),
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
  return {
    app: createApp(),
    createBankAccount: (input: ReturnType<typeof bankBody>, userId: string) =>
      bank.createBankAccount(
        scope(),
        input as never,
        core.userIdSchema.parse(userId),
      ),
  };
}

const originalActive = process.env.BLIND_INDEX_ACTIVE_VERSION;
afterEach(() => {
  if (originalActive === undefined)
    delete process.env.BLIND_INDEX_ACTIVE_VERSION;
  else process.env.BLIND_INDEX_ACTIVE_VERSION = originalActive;
});

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
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
  if (createdUserIds.size > 0) {
    const ids = [...createdUserIds];
    await owner.query(
      "DELETE FROM mfa_recovery_code_sets WHERE user_id = ANY($1::uuid[])",
      [ids],
    );
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [ids],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  }
  await owner.end();
});

// ---------------------------------------------------------------- bank accounts

async function newEntityWithGl(): Promise<{ entity: string; gl: string }> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `Baxdx PT ${unique()}`],
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

async function signUpUser(app: TestApp) {
  const email = `baxdx-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Baxdx", email, password: PASSWORD });
  expect(response.status).toBe(200);
  createdUserIds.add(response.body.user.id);
  return { email, userId: response.body.user.id as string };
}

async function bankRow(entity: string, last4: string) {
  const { rows } = await owner.query<{ hmac: string; version: number }>(
    `SELECT account_number_hmac AS hmac, account_number_hmac_version AS version
       FROM bank_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND account_number_last4 = $3`,
    [tenantId, entity, last4],
  );
  return rows;
}

describe("legend-baxdx bank account number blind index", () => {
  it("legend-baxdx: default writes version 1, v2 active writes version 2 with a different digest", async () => {
    const number = newNumber();
    const v1 = await loadAt(1);
    const user = await signUpUser(v1.app);
    const first = await newEntityWithGl();
    await v1.createBankAccount(
      bankBody(first.entity, first.gl, number),
      user.userId,
    );

    const v2 = await loadAt(2);
    const second = await newEntityWithGl();
    await v2.createBankAccount(
      bankBody(second.entity, second.gl, number),
      user.userId,
    );

    const [rowV1] = await bankRow(first.entity, number.slice(-4));
    const [rowV2] = await bankRow(second.entity, number.slice(-4));
    expect(rowV1!.version).toBe(1);
    expect(rowV2!.version).toBe(2);
    expect(rowV1!.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(rowV2!.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(rowV2!.hmac).not.toBe(rowV1!.hmac);
  });

  it.each([
    { written: 1 as Version, later: 2 as Version },
    { written: 2 as Version, later: 1 as Version },
  ])(
    "legend-baxdx: a number written under v$written is refused as duplicate under v$later (same entity), allowed in another entity",
    async ({ written, later }) => {
      const number = newNumber();
      const first = await loadAt(written);
      const user = await signUpUser(first.app);
      const { entity, gl } = await newEntityWithGl();
      await first.createBankAccount(bankBody(entity, gl, number), user.userId);

      const second = await loadAt(later);
      await expect(
        second.createBankAccount(bankBody(entity, gl, number), user.userId),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await bankRow(entity, number.slice(-4))).toHaveLength(1);

      // Another legal entity may reuse the number, a new number is fine.
      const other = await newEntityWithGl();
      await expect(
        second.createBankAccount(
          bankBody(other.entity, other.gl, number),
          user.userId,
        ),
      ).resolves.toMatchObject({ legalEntityId: other.entity });
      await expect(
        second.createBankAccount(
          bankBody(entity, gl, newNumber()),
          user.userId,
        ),
      ).resolves.toMatchObject({ legalEntityId: entity });
    },
  );

  it("legend-baxdx: two concurrent creates of one number across versions leave exactly one row", async () => {
    const number = newNumber();
    const v1 = await loadAt(1);
    const user = await signUpUser(v1.app);
    const v2 = await loadAt(2);
    const { entity, gl } = await newEntityWithGl();
    const results = await Promise.allSettled([
      v1.createBankAccount(bankBody(entity, gl, number), user.userId),
      v2.createBankAccount(bankBody(entity, gl, number), user.userId),
    ]);
    // Money rule: never two rows for one real account, never a 500-style error.
    expect(await bankRow(entity, number.slice(-4))).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(rejected?.reason).toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------- MFA recovery codes

type Staff = { email: string; userId: string; cookie: string };
type TestApp = Awaited<ReturnType<typeof loadAt>>["app"];

async function signIn(app: TestApp, email: string): Promise<string> {
  const response = await request(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/** A user with a verified TOTP factor and one MFA-verified session. */
async function staffWithFactor(app: TestApp): Promise<Staff> {
  const { email, userId } = await signUpUser(app);
  const cookie = await signIn(app, email);
  const enroll = await request(app)
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ type: "totp" });
  expect(enroll.status).toBe(201);
  const { factorId, secretBase32 } = enroll.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await request(app)
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status).toBe(200);
  return { email, userId, cookie };
}

async function generateCodes(app: TestApp, cookie: string): Promise<string[]> {
  const response = await request(app)
    .post("/api/auth/mfa/recovery-codes")
    .set(originHeader)
    .set("Cookie", cookie);
  expect(response.status).toBeLessThan(300);
  return response.body.data.codes as string[];
}

/** Consume on a fresh password-only session, as a user locked out of TOTP. */
async function consume(app: TestApp, email: string, code: string) {
  const cookie = await signIn(app, email);
  return request(app)
    .post("/api/auth/mfa/recovery")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ code });
}

async function codeRows(userId: string) {
  const { rows } = await owner.query<{
    code_hash: string;
    used_at: Date | null;
  }>(
    `SELECT c.code_hash, c.used_at
       FROM mfa_recovery_codes c
       JOIN mfa_recovery_code_sets s ON s.id = c.set_id
      WHERE s.user_id = $1`,
    [userId],
  );
  return rows;
}

describe("legend-baxdx MFA recovery code blind index", () => {
  it.each([1, 2] as const)(
    "legend-baxdx: codes generated under v%i are stored hashed with the digest of that version",
    async (version) => {
      const { app } = await loadAt(version);
      const staff = await staffWithFactor(app);
      const codes = await generateCodes(app, staff.cookie);
      const rows = await codeRows(staff.userId);
      expect(rows).toHaveLength(10);
      const stored = new Set(rows.map((row) => row.code_hash));
      for (const row of rows) {
        expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(codes).not.toContain(row.code_hash);
        expect(row.used_at).toBeNull();
      }
      // Every issued code is stored as its digest under the version active at
      // generation (no per-row version column: consume matches both digests),
      // and not as the digest of the other version.
      const other = (version === 1 ? 2 : 1) as Version;
      for (const code of codes) {
        const normalized = normalizeRecoveryCode(code);
        expect(
          stored.has(recoveryCodeHash(staff.userId, normalized, version)),
        ).toBe(true);
        expect(
          stored.has(recoveryCodeHash(staff.userId, normalized, other)),
        ).toBe(false);
      }
    },
  );

  it.each([
    { issued: 1 as Version, used: 2 as Version },
    { issued: 2 as Version, used: 1 as Version },
  ])(
    "legend-baxdx: a code issued under v$issued works once under v$used and is then spent under both versions",
    async ({ issued, used }) => {
      const issuing = await loadAt(issued);
      const staff = await staffWithFactor(issuing.app);
      const codes = await generateCodes(issuing.app, staff.cookie);

      const consuming = await loadAt(used);
      const ok = await consume(consuming.app, staff.email, codes[0]!);
      expect(ok.status).toBe(200);
      expect(ok.body.data.remaining).toBe(9);

      // Replay under the consuming version, the issuing version and a third
      // load of each: a recovery code is single use across versions.
      for (const version of [used, issued, used, issued] as Version[]) {
        const { app } = await loadAt(version);
        const replay = await consume(app, staff.email, codes[0]!);
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
      }

      const rows = await codeRows(staff.userId);
      expect(rows.filter((row) => row.used_at !== null)).toHaveLength(1);

      // A different unused code from the same set still works.
      const next = await consume(consuming.app, staff.email, codes[1]!);
      expect(next.status).toBe(200);
      expect(next.body.data.remaining).toBe(8);
    },
  );

  it("legend-baxdx: the same code used at the same time under both versions succeeds exactly once", async () => {
    const v1 = await loadAt(1);
    const staff = await staffWithFactor(v1.app);
    const codes = await generateCodes(v1.app, staff.cookie);
    const v2 = await loadAt(2);
    const [a, b] = await Promise.all([
      consume(v1.app, staff.email, codes[0]!),
      consume(v2.app, staff.email, codes[0]!),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(
      (await codeRows(staff.userId)).filter((row) => row.used_at !== null),
    ).toHaveLength(1);
  });

  it("legend-baxdx: a wrong code is refused under v2 and consumes nothing", async () => {
    const { app } = await loadAt(2);
    const staff = await staffWithFactor(app);
    await generateCodes(app, staff.cookie);
    const wrong = await consume(app, staff.email, "AAAAA-AAAAA");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
    expect(
      (await codeRows(staff.userId)).filter((row) => row.used_at !== null),
    ).toHaveLength(0);
  });
});
