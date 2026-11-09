// Bank statement lines — HTTP + service tests (bead legend-fnxl.4, WS-07; PRD
// v1.7 §3.19 Kas & Bank, ACC-04; TEN-01/02/03). Real Better Auth, RLS and
// PostgreSQL on the disposable test DB. The router is mounted on a small host
// app (same tenant resolver as the API, pinned to the seeded tenant or, via
// x-test-tenant, to a second one); registering it in routes/index.ts is the
// engineer's step.
//
// Covers: list paging and filters, manual match (cash deposit, journal, both
// at once), amount mismatch 422, a document already used by another line 409,
// match refused from matched / excluded / in_case, exclude, unmatch restoring
// the exact prior state of line and deposit (idempotent), the reconciliation
// summary, audit rows, tenant isolation (404) and permissions (403).

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingBankLinesRouter } from "../routes/accounting-bank-lines.routes";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const accountIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");

const host = express();
host.use(
  "/api",
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
    fallback: async (req) => ({
      tenantId: req.get("x-test-tenant") ?? tenantId,
      brandId: null,
      source: "session" as const,
    }),
  }),
);
host.use("/api/accounting", createAccountingBankLinesRouter());
host.use(notFound);
host.use(errorHandler);

const BASE = "/api/accounting";
const linesPath = (account: string, query = "") =>
  `${BASE}/bank-accounts/${account}/statement-lines${query}`;
const summaryPath = (account: string, query = "") =>
  `${BASE}/bank-accounts/${account}/reconciliation-summary${query}`;
const linePath = (line: string, action: string) =>
  `${BASE}/statement-lines/${line}/${action}`;

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `bank-lines-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Bank lines", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { cookie, userId };
}

async function assignTemplate(userId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
}

async function newTenant(): Promise<string> {
  const id = randomUUID();
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank lines other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `bnkln-${unique()}`, tenantId],
  );
  return id;
}

type Fixture = {
  entity: string;
  gl: string;
  period: string;
  account: string;
  otherAccount: string;
  importId: string;
  otherImportId: string;
};

/** One legal entity with a GL cash account and two bank accounts. */
async function newFixture(): Promise<Fixture> {
  const { rows: entityRows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `Bank lines PT ${unique()}`],
  );
  const entity = entityRows[0]!.id;
  const { rows: glRows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents') RETURNING id`,
    [tenantId, entity],
  );
  const gl = glRows[0]!.id;
  await owner.query(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [tenantId, entity],
  );
  const { rows: periodRows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11') RETURNING id`,
    [tenantId, entity],
  );
  const makeAccount = async (name: string) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version,
          gl_account_id, created_by)
       VALUES ($1, $2, 'BCA', $3, decode('00', 'hex'), $4, '1234', 1, $5, 'test') RETURNING id`,
      [tenantId, entity, name, randomBytes(32).toString("hex"), gl],
    );
    accountIds.push(rows[0]!.id);
    return rows[0]!.id;
  };
  const account = await makeAccount("Kas Operasional");
  const otherAccount = await makeAccount("Kas Lain");
  const makeImport = async (bankAccountId: string) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO bank_statement_imports
         (tenant_id, bank_account_id, file_name, file_sha256, imported_by,
          line_count, duplicate_count, auto_matched_count)
       VALUES ($1, $2, 'mutasi.csv', $3, 'test', 0, 0, 0) RETURNING id`,
      [tenantId, bankAccountId, randomBytes(32).toString("hex")],
    );
    return rows[0]!.id;
  };
  return {
    entity,
    gl,
    period: periodRows[0]!.id,
    account,
    otherAccount,
    importId: await makeImport(account),
    otherImportId: await makeImport(otherAccount),
  };
}

async function newLine(
  fx: Fixture,
  input: {
    postedOn: string;
    amountIdr: number;
    status?: string;
    account?: string;
    caseId?: string;
    reason?: string;
  },
): Promise<string> {
  const account = input.account ?? fx.account;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO bank_statement_lines
       (tenant_id, bank_account_id, import_id, posted_on, amount_idr, description,
        dedupe_key, match_status, reconciliation_case_id, excluded_reason)
     VALUES ($1, $2, $3, $4, $5, 'Setoran', $6, $7, $8, $9) RETURNING id`,
    [
      tenantId,
      account,
      account === fx.account ? fx.importId : fx.otherImportId,
      input.postedOn,
      input.amountIdr,
      `k-${randomUUID()}`,
      input.status ?? "unmatched",
      input.caseId ?? null,
      input.reason ?? null,
    ],
  );
  return rows[0]!.id;
}

async function newDeposit(
  fx: Fixture,
  amountIdr: number,
  account = fx.account,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO cash_deposits
       (tenant_id, legal_entity_id, outlet_id, bank_account_id, amount_idr,
        covers_from, covers_to, deposited_at, deposited_by)
     VALUES ($1, $2, $3, $4, $5, '2026-11-03', '2026-11-03', '2026-11-04T03:00:00Z', 'test')
     RETURNING id`,
    [tenantId, fx.entity, outletA, account, amountIdr],
  );
  return rows[0]!.id;
}

/** A balanced posted journal that debits the bank GL account by `amountIdr`. */
async function newJournal(fx: Fixture, amountIdr: number): Promise<string> {
  const revenue = (
    await owner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '4101'",
      [tenantId, fx.entity],
    )
  ).rows[0]!.id;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-04', $3, 'sale', NULL, 'Bank journal', $4, $5)
       RETURNING id`,
      [
        tenantId,
        fx.entity,
        fx.period,
        `bl-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entry = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, entry, fx.gl, revenue, amountIdr],
    );
    await client.query("COMMIT");
    return entry;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A line (with its account, import, entity) that belongs to another tenant. */
async function foreignLine(
  other: string,
): Promise<{ account: string; line: string }> {
  const { rows: e } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [other, `Foreign PT ${unique()}`],
  );
  const { rows: g } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents') RETURNING id`,
    [other, e[0]!.id],
  );
  const { rows: a } = await owner.query<{ id: string }>(
    `INSERT INTO bank_accounts
       (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version,
        gl_account_id, created_by)
     VALUES ($1, $2, 'BCA', 'Foreign', decode('00', 'hex'), $3, '1234', 1, $4, 'test') RETURNING id`,
    [other, e[0]!.id, randomBytes(32).toString("hex"), g[0]!.id],
  );
  accountIds.push(a[0]!.id);
  const { rows: i } = await owner.query<{ id: string }>(
    `INSERT INTO bank_statement_imports
       (tenant_id, bank_account_id, file_name, file_sha256, imported_by,
        line_count, duplicate_count, auto_matched_count)
     VALUES ($1, $2, 'mutasi.csv', $3, 'test', 0, 0, 0) RETURNING id`,
    [other, a[0]!.id, randomBytes(32).toString("hex")],
  );
  const { rows: l } = await owner.query<{ id: string }>(
    `INSERT INTO bank_statement_lines
       (tenant_id, bank_account_id, import_id, posted_on, amount_idr, description, dedupe_key)
     VALUES ($1, $2, $3, '2026-11-07', 12000, 'Setoran', $4) RETURNING id`,
    [other, a[0]!.id, i[0]!.id, `k-${randomUUID()}`],
  );
  return { account: a[0]!.id, line: l[0]!.id };
}

async function newCase(fx: Fixture, ownerId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO bank_reconciliation_cases
       (tenant_id, legal_entity_id, type, difference_idr, owner_id, due_at, refs, opened_by)
     VALUES ($1, $2, 'bank_statement', 1000, $3, now() + interval '7 days', $4::jsonb, $3)
     RETURNING id`,
    [
      tenantId,
      fx.entity,
      ownerId,
      JSON.stringify([{ type: "bank_statement_line", id: randomUUID() }]),
    ],
  );
  return rows[0]!.id;
}

const dbLine = async (id: string) =>
  (
    await owner.query(
      "SELECT * FROM bank_statement_lines WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!;
const dbDeposit = async (id: string) =>
  (
    await owner.query(
      "SELECT * FROM cash_deposits WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!;
const matchRows = async (lineId: string) =>
  (
    await owner.query(
      "SELECT ref_type, ref_id, source FROM bank_statement_line_matches WHERE tenant_id = $1 AND line_id = $2",
      [tenantId, lineId],
    )
  ).rows;
const auditCount = async (action: string, objectId: string) =>
  (
    await owner.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenantId, action, objectId],
    )
  ).rowCount;

const post = (
  cookie: string,
  path: string,
  body: unknown,
  tenantHeader?: string,
) => {
  const call = request(host)
    .post(path)
    .set(originHeader)
    .set("Cookie", cookie)
    .send(body as object);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const get = (cookie: string, path: string, tenantHeader?: string) => {
  const call = request(host).get(path).set("Cookie", cookie);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const match = (cookie: string, line: string, refs: unknown[]) =>
  post(cookie, linePath(line, "match"), { refs });
const unmatch = (cookie: string, line: string, key = randomUUID()) =>
  post(cookie, linePath(line, "unmatch"), { idempotencyKey: key });
const ref = (type: string, id: string) => ({ type, id });

let finance: { cookie: string; userId: string };
let fx: Fixture;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  fx = await newFixture();
});

afterAll(async () => {
  // Journals are immutable ledger rows: the entity and its GL accounts stay
  // behind on the disposable database; everything else is removed.
  await owner.query(
    "UPDATE cash_deposits SET status = 'recorded', bank_statement_line_id = NULL WHERE bank_account_id = ANY($1::uuid[])",
    [accountIds],
  );
  for (const table of [
    "bank_statement_line_matches",
    "cash_deposits",
    "bank_statement_lines",
    "bank_statement_imports",
  ])
    await owner.query(
      `DELETE FROM ${table} WHERE bank_account_id = ANY($1::uuid[])`,
      [accountIds],
    );
  await owner.query(
    "DELETE FROM bank_reconciliation_cases WHERE legal_entity_id = $1",
    [fx.entity],
  );
  await owner.query("DELETE FROM bank_accounts WHERE id = ANY($1::uuid[])", [
    accountIds,
  ]);
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM chart_of_accounts WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query(
      "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-fnxl.4 bank statement lines", () => {
  it("lists lines of one account in a window: keyset paging, status filter, matched refs", async () => {
    const own = await newFixture(); // empty account of its own
    const account = own.account;
    const a = await newLine(own, { postedOn: "2026-11-01", amountIdr: 1000 });
    const b = await newLine(own, { postedOn: "2026-11-02", amountIdr: 2000 });
    const c = await newLine(own, {
      postedOn: "2026-11-02",
      amountIdr: 3000,
      status: "excluded",
      reason: "biaya admin",
    });
    await newLine(own, { postedOn: "2026-12-01", amountIdr: 4000 });

    const first = await get(
      finance.cookie,
      linesPath(account, "?from=2026-11-01&to=2026-11-30&limit=2"),
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].id).toBe(a);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first.body)).not.toContain("tenant_id");

    const second = await get(
      finance.cookie,
      linesPath(
        account,
        `?from=2026-11-01&to=2026-11-30&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
      ),
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeNull();
    expect(
      [...first.body.data, ...second.body.data]
        .map((l: { id: string }) => l.id)
        .sort(),
    ).toEqual([a, b, c].sort());

    const excluded = await get(
      finance.cookie,
      linesPath(account, "?from=2026-11-01&to=2026-11-30&matchStatus=excluded"),
    );
    expect(excluded.body.data).toHaveLength(1);
    expect(excluded.body.data[0]).toMatchObject({
      id: c,
      matchStatus: "excluded",
      excludedReason: "biaya admin",
      matchedRefs: [],
    });

    const bad = await get(
      finance.cookie,
      linesPath(account, "?from=2026-11-30&to=2026-11-01"),
    );
    expect(bad.status).toBe(422);
    const badCursor = await get(
      finance.cookie,
      linesPath(account, "?from=2026-11-01&to=2026-11-30&cursor=not-a-cursor"),
    );
    expect(badCursor.status).toBe(422);
  });

  it("manual match of a cash deposit, then unmatch restores the exact prior state of line and deposit", async () => {
    const line = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 500_000,
    });
    const deposit = await newDeposit(fx, 500_000);
    const lineBefore = await dbLine(line);
    const depositBefore = await dbDeposit(deposit);

    const matched = await match(finance.cookie, line, [
      ref("cash_deposit", deposit),
    ]);
    expect(matched.status).toBe(200);
    expect(matched.body.data).toMatchObject({
      id: line,
      matchStatus: "manually_matched",
      matchedRefs: [{ type: "cash_deposit", id: deposit }],
    });
    expect(await matchRows(line)).toEqual([
      { ref_type: "cash_deposit", ref_id: deposit, source: "manual" },
    ]);
    expect(await dbDeposit(deposit)).toMatchObject({
      status: "matched",
      bank_statement_line_id: line,
    });
    expect(await dbLine(line)).toMatchObject({
      match_status: "manually_matched",
      status_changed_by: finance.userId,
      version: lineBefore.version + 1,
    });
    expect(
      await auditCount("accounting.bank_statement_line.matched", line),
    ).toBe(1);

    const unmatched = await unmatch(finance.cookie, line);
    expect(unmatched.status).toBe(200);
    expect(unmatched.body.data).toMatchObject({
      id: line,
      matchStatus: "unmatched",
      matchedRefs: [],
      excludedReason: null,
    });
    expect(await matchRows(line)).toEqual([]);

    const strip = (row: Record<string, unknown>) => {
      const { version, status_changed_by, status_changed_at, ...rest } = row;
      void version;
      void status_changed_by;
      void status_changed_at;
      return rest;
    };
    const lineAfter = await dbLine(line);
    const depositAfter = await dbDeposit(deposit);
    expect(strip(lineAfter)).toEqual(strip(lineBefore));
    expect(strip(depositAfter)).toEqual(strip(depositBefore));
    expect(lineAfter.version).toBe(lineBefore.version + 2);
    expect(depositAfter.version).toBe(depositBefore.version + 2);
    expect(
      await auditCount("accounting.bank_statement_line.unmatched", line),
    ).toBe(1);

    // The freed deposit can be matched again.
    const again = await match(finance.cookie, line, [
      ref("cash_deposit", deposit),
    ]);
    expect(again.status).toBe(200);
  });

  it("unmatch is idempotent: a replay returns the stored answer, a new key on an unmatched line is refused", async () => {
    const line = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 710_000,
    });
    const deposit = await newDeposit(fx, 710_000);
    await match(finance.cookie, line, [ref("cash_deposit", deposit)]);
    const key = randomUUID();
    const first = await unmatch(finance.cookie, line, key);
    const replay = await unmatch(finance.cookie, line, key);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(
      await auditCount("accounting.bank_statement_line.unmatched", line),
    ).toBe(1);
    expect((await dbLine(line)).version).toBe(3);

    const other = await unmatch(finance.cookie, line, randomUUID());
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("INVALID_TRANSITION");

    // Same key for another line is a different request.
    const line2 = await newLine(fx, { postedOn: "2026-11-04", amountIdr: 1 });
    const reused = await unmatch(finance.cookie, line2, key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("matches a line to several documents that add up exactly (deposit + journal)", async () => {
    const line = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 750_000,
    });
    const deposit = await newDeposit(fx, 500_000);
    const journal = await newJournal(fx, 250_000);
    const response = await match(finance.cookie, line, [
      ref("cash_deposit", deposit),
      ref("journal_entry", journal),
    ]);
    expect(response.status).toBe(200);
    expect(response.body.data.matchedRefs).toHaveLength(2);
    expect((await matchRows(line)).map((row) => row.ref_id).sort()).toEqual(
      [deposit, journal].sort(),
    );

    // The journal is now taken: another line cannot claim it.
    const other = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 250_000,
    });
    const taken = await match(finance.cookie, other, [
      ref("journal_entry", journal),
    ]);
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");

    await unmatch(finance.cookie, line);
    expect((await dbDeposit(deposit)).status).toBe("recorded");
    expect(await matchRows(line)).toEqual([]);
  });

  it("amount mismatch answers 422 and changes nothing", async () => {
    const line = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 600_000,
    });
    const deposit = await newDeposit(fx, 599_999);
    const before = await dbLine(line);
    const response = await match(finance.cookie, line, [
      ref("cash_deposit", deposit),
    ]);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("MATCH_AMOUNT_MISMATCH");
    expect(await dbLine(line)).toEqual(before);
    expect((await dbDeposit(deposit)).status).toBe("recorded");
    expect(await matchRows(line)).toEqual([]);
  });

  it("a document already used by another line answers 409 STATEMENT_LINE_ALREADY_MATCHED", async () => {
    const deposit = await newDeposit(fx, 420_000);
    const first = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 420_000,
    });
    const second = await newLine(fx, {
      postedOn: "2026-11-05",
      amountIdr: 420_000,
    });
    expect(
      (await match(finance.cookie, first, [ref("cash_deposit", deposit)]))
        .status,
    ).toBe(200);
    const response = await match(finance.cookie, second, [
      ref("cash_deposit", deposit),
    ]);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");
    expect((await dbLine(second)).match_status).toBe("unmatched");
  });

  it("two concurrent matches of the same deposit: exactly one wins", async () => {
    const deposit = await newDeposit(fx, 333_000);
    const a = await newLine(fx, { postedOn: "2026-11-04", amountIdr: 333_000 });
    const b = await newLine(fx, { postedOn: "2026-11-04", amountIdr: 333_000 });
    const [ra, rb] = await Promise.all([
      match(finance.cookie, a, [ref("cash_deposit", deposit)]),
      match(finance.cookie, b, [ref("cash_deposit", deposit)]),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM bank_statement_line_matches WHERE tenant_id = $1 AND ref_id = $2",
          [tenantId, deposit],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("refuses a match from matched, excluded and in_case; refuses documents of another account, other types and unknown ids", async () => {
    const matchedLine = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 100_000,
    });
    const d1 = await newDeposit(fx, 100_000);
    await match(finance.cookie, matchedLine, [ref("cash_deposit", d1)]);
    const d2 = await newDeposit(fx, 100_000);
    const again = await match(finance.cookie, matchedLine, [
      ref("cash_deposit", d2),
    ]);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");

    const excludedLine = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 100_000,
      status: "excluded",
      reason: "salah akun",
    });
    const refused = await match(finance.cookie, excludedLine, [
      ref("cash_deposit", d2),
    ]);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("INVALID_TRANSITION");

    const caseId = await newCase(fx, finance.userId);
    const caseLine = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 100_000,
      status: "in_case",
      caseId,
    });
    const inCase = await match(finance.cookie, caseLine, [
      ref("cash_deposit", d2),
    ]);
    expect(inCase.status).toBe(409);
    expect(inCase.body.error.code).toBe("INVALID_TRANSITION");
    // The failed attempts left d2 free.
    expect((await dbDeposit(d2)).status).toBe("recorded");

    const target = await newLine(fx, {
      postedOn: "2026-11-04",
      amountIdr: 100_000,
    });
    const foreignDeposit = await newDeposit(fx, 100_000, fx.otherAccount);
    const wrongAccount = await match(finance.cookie, target, [
      ref("cash_deposit", foreignDeposit),
    ]);
    expect(wrongAccount.status).toBe(404);
    expect(wrongAccount.body.error.code).toBe("NOT_FOUND");

    const unsupported = await match(finance.cookie, target, [
      ref("gateway_settlement", randomUUID()),
    ]);
    // CoreError VALIDATION_ERROR answers 400 (zod body errors answer 422).
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await match(finance.cookie, target, [
      ref("cash_deposit", randomUUID()),
    ]);
    expect(unknown.status).toBe(404);
    const unknownJournal = await match(finance.cookie, target, [
      ref("journal_entry", randomUUID()),
    ]);
    expect(unknownJournal.status).toBe(404);

    const duplicate = await match(finance.cookie, target, [
      ref("cash_deposit", d2),
      ref("cash_deposit", d2),
    ]);
    expect(duplicate.status).toBe(400);
    expect((await dbLine(target)).match_status).toBe("unmatched");
  });

  it("exclude only from unmatched; unmatch clears the reason; unmatch refused for in_case and unmatched lines", async () => {
    const line = await newLine(fx, {
      postedOn: "2026-11-06",
      amountIdr: -2500,
    });
    const excluded = await post(finance.cookie, linePath(line, "exclude"), {
      reason: "biaya admin bulanan",
    });
    expect(excluded.status).toBe(200);
    expect(excluded.body.data).toMatchObject({
      matchStatus: "excluded",
      excludedReason: "biaya admin bulanan",
    });
    expect(await dbLine(line)).toMatchObject({
      status_changed_by: finance.userId,
      version: 2,
    });
    expect(
      await auditCount("accounting.bank_statement_line.excluded", line),
    ).toBe(1);

    const twice = await post(finance.cookie, linePath(line, "exclude"), {
      reason: "lagi",
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("INVALID_TRANSITION");
    expect((await dbLine(line)).excluded_reason).toBe("biaya admin bulanan");

    const restored = await unmatch(finance.cookie, line);
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({
      matchStatus: "unmatched",
      excludedReason: null,
    });
    expect(await dbLine(line)).toMatchObject({
      excluded_reason: null,
      version: 3,
    });

    const notMatched = await unmatch(finance.cookie, line);
    expect(notMatched.status).toBe(409);
    expect(notMatched.body.error.code).toBe("INVALID_TRANSITION");

    const matchedLine = await newLine(fx, {
      postedOn: "2026-11-06",
      amountIdr: 90_000,
    });
    const deposit = await newDeposit(fx, 90_000);
    await match(finance.cookie, matchedLine, [ref("cash_deposit", deposit)]);
    const excludeMatched = await post(
      finance.cookie,
      linePath(matchedLine, "exclude"),
      {
        reason: "x",
      },
    );
    expect(excludeMatched.status).toBe(409);

    const caseId = await newCase(fx, finance.userId);
    const caseLine = await newLine(fx, {
      postedOn: "2026-11-06",
      amountIdr: 10,
      status: "in_case",
      caseId,
    });
    const inCaseUnmatch = await unmatch(finance.cookie, caseLine);
    expect(inCaseUnmatch.status).toBe(409);
    expect(inCaseUnmatch.body.error.code).toBe("INVALID_TRANSITION");
    expect((await dbLine(caseLine)).match_status).toBe("in_case");
    const inCaseExclude = await post(
      finance.cookie,
      linePath(caseLine, "exclude"),
      {
        reason: "x",
      },
    );
    expect(inCaseExclude.status).toBe(409);

    const noReason = await post(finance.cookie, linePath(line, "exclude"), {
      reason: " ",
    });
    expect(noReason.status).toBe(422);
  });

  it("summary counts lines by status in the window and reports the auto-match rate", async () => {
    const solo = await newFixture();
    const mk = (status: string, postedOn = "2026-11-10") =>
      newLine(solo, {
        postedOn,
        amountIdr: 1000 + Math.floor(Math.random() * 1000),
        status,
        reason: status === "excluded" ? "x" : undefined,
        caseId: undefined,
      });
    await mk("auto_matched");
    await mk("auto_matched");
    await mk("auto_matched");
    await mk("manually_matched");
    await mk("unmatched");
    await mk("excluded");
    await mk("unmatched", "2026-12-31"); // outside the window

    const response = await get(
      finance.cookie,
      summaryPath(solo.account, "?from=2026-11-01&to=2026-11-30"),
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      bankAccountId: solo.account,
      from: "2026-11-01",
      to: "2026-11-30",
      lineCount: 6,
      autoMatchedCount: 3,
      manuallyMatchedCount: 1,
      unmatchedCount: 1,
      inCaseCount: 0,
      excludedCount: 1,
      // 3 of 5 lines that need matching (excluded does not count).
      autoMatchRateBp: 6000,
    });

    const empty = await get(
      finance.cookie,
      summaryPath(solo.account, "?from=2027-01-01&to=2027-01-31"),
    );
    expect(empty.body.data).toMatchObject({
      lineCount: 0,
      autoMatchRateBp: 10_000,
    });
    expect(
      (
        await get(
          finance.cookie,
          summaryPath(solo.account, "?from=2026-11-30&to=2026-11-01"),
        )
      ).status,
    ).toBe(422);
  });

  it("TEN-01/02 another tenant's ids are 404 on every endpoint (RLS hides them) and nothing changes", async () => {
    const other = await newTenant();
    const foreign = await foreignLine(other);
    const deposit = await newDeposit(fx, 12_000);
    const before = (
      await owner.query("SELECT * FROM bank_statement_lines WHERE id = $1", [
        foreign.line,
      ])
    ).rows[0];

    expect(
      (
        await get(
          finance.cookie,
          linesPath(foreign.account, "?from=2026-11-01&to=2026-11-30"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          finance.cookie,
          summaryPath(foreign.account, "?from=2026-11-01&to=2026-11-30"),
        )
      ).status,
    ).toBe(404);
    const m = await match(finance.cookie, foreign.line, [
      ref("cash_deposit", deposit),
    ]);
    expect(m.status).toBe(404);
    expect(m.body.error.code).toBe("NOT_FOUND");
    expect(
      (
        await post(finance.cookie, linePath(foreign.line, "exclude"), {
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect((await unmatch(finance.cookie, foreign.line)).status).toBe(404);
    expect(
      (
        await owner.query("SELECT * FROM bank_statement_lines WHERE id = $1", [
          foreign.line,
        ])
      ).rows[0],
    ).toEqual(before);
    expect((await dbDeposit(deposit)).status).toBe("recorded");

    // A tenant that has no role in the pinned tenant is refused before any lookup.
    expect(
      (
        await get(
          finance.cookie,
          linesPath(fx.account, "?from=2026-11-01&to=2026-11-30"),
          other,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await match(finance.cookie, randomUUID(), [
          ref("cash_deposit", deposit),
        ])
      ).status,
    ).toBe(404);
  });

  it("TEN-03 without the permission every endpoint answers 403; a viewer cannot write; without a session 401", async () => {
    const stranger = await signedIn(); // no role assignment at all
    const line = await newLine(fx, { postedOn: "2026-11-08", amountIdr: 8000 });
    const window = "?from=2026-11-01&to=2026-11-30";
    expect(
      (await get(stranger.cookie, linesPath(fx.account, window))).status,
    ).toBe(403);
    expect(
      (await get(stranger.cookie, summaryPath(fx.account, window))).status,
    ).toBe(403);
    expect(
      (await match(stranger.cookie, line, [ref("cash_deposit", randomUUID())]))
        .status,
    ).toBe(403);
    expect(
      (await post(stranger.cookie, linePath(line, "exclude"), { reason: "x" }))
        .status,
    ).toBe(403);
    expect((await unmatch(stranger.cookie, line)).status).toBe(403);
    expect((await dbLine(line)).match_status).toBe("unmatched");

    expect(
      (await request(host).get(linesPath(fx.account, window))).status,
    ).toBe(401);
    expect(
      (
        await request(host)
          .post(linePath(line, "exclude"))
          .set(originHeader)
          .send({ reason: "x" })
      ).status,
    ).toBe(401);
  });

  it("a cross-site POST is refused before the body is read (origin check)", async () => {
    const line = await newLine(fx, { postedOn: "2026-11-08", amountIdr: 8100 });
    const response = await request(host)
      .post(linePath(line, "exclude"))
      .set("Origin", "https://evil.example")
      .set("Cookie", finance.cookie)
      .send({ reason: "x" });
    expect(response.status).toBe(403);
    expect((await dbLine(line)).match_status).toBe("unmatched");
  });
});
