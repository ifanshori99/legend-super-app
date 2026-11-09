// Bank statement import + automatic matching — HTTP tests (bead
// legend-fnxl.3, WS-07; PRD v1.7 §3.19 "Impor mutasi bank (CSV)" and
// "Pencocokan otomatis"; ACC-04, TEN-01/03). Real Better Auth, RLS and
// PostgreSQL on the disposable test DB. The router is mounted on a small host
// app (same tenant resolver as the API, pinned to the seeded tenant or, via
// x-test-tenant, to a second one) because registering it in routes/index.ts is
// the engineer's step. Bank accounts, journals, outlets and cash deposits are
// seeded by direct owner-pool INSERTs; the finance policy by an owner upsert.
//
// Assumptions (spec silent):
// - A successful import answers 201 `{ data }`; a replay of the same
//   idempotency key answers the identical body.
// - Money in is a positive statement amount and matches a journal whose lines
//   on the account's GL account sum to a positive (debit) amount; money out is
//   negative and matches a net credit.
// - A line of an earlier import that matches only after a later import (or a
//   policy change) is matched by that later import, but is counted on the
//   import that created the line; so those tests assert line state, not the
//   later import's autoMatchedCount.

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BankCsvMapping } from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingBankStatementsRouter } from "../routes/accounting-bank-statements.routes";
import { importBankStatement } from "../services/accounting-bank-statements.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const brandId = cafeLegendPlatformFixtures.brand.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const entityIds: string[] = [];
const outletIds: string[] = [];
const otherTenantIds: string[] = [];
const bankAccountIds: string[] = [];

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
host.use("/api/accounting", createAccountingBankStatementsRouter());
host.use(notFound);
host.use(errorHandler);

const importPath = (bankAccountId: string) =>
  `/api/accounting/bank-accounts/${bankAccountId}/statement-imports`;

const MAPPING: BankCsvMapping = {
  hasHeader: true,
  delimiter: ",",
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amount: { kind: "signed", column: 2 },
  decimalSeparator: ",",
  referenceColumn: null,
};

/** 1500000 → "1.500.000,00" (quoted for the CSV). */
const money = (value: number) =>
  `"${value < 0 ? "-" : ""}${Math.abs(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".")},00"`;
type Row = { date: string; description: string; amount: number };
const csvOf = (rows: Row[]) =>
  [
    "Tanggal,Keterangan,Jumlah",
    ...rows.map((r) => `${r.date},${r.description},${money(r.amount)}`),
  ].join("\n");

function scopeFor(
  scope: Parameters<typeof establishScopedTenantContext>[1],
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    scope,
  );
}

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `bank-stmt-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Bank statements", email, password: "Test-password-123!" });
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

async function assignOutletScopedReconcile(userId: string, outletId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, false, $3::jsonb, '["outlet"]'::jsonb) RETURNING id`,
    [
      tenantId,
      `Outlet reconciler ${unique()}`,
      JSON.stringify(["accounting.reconcile", "accounting.journal.view"]),
    ],
  );
  createdRoleIds.push(rows[0]!.id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, rows[0]!.id, outletId],
  );
}

async function ownerTx<T>(
  tenant: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let finance: { cookie: string; userId: string };
let entity: string;
let revenueAccount: string;
let periodId: string;
let outletJakarta: string;
let glCounter = 1200;

async function newEntity(tenant: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenant, `Statement PT ${unique()}`],
  );
  if (tenant === tenantId) entityIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function newGl(
  legalEntityId: string,
  code: string,
  options: { tenant?: string; type?: string; group?: string } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, 'Akun uji', $4, $5) RETURNING id`,
    [
      options.tenant ?? tenantId,
      legalEntityId,
      code,
      options.type ?? "asset",
      options.group ?? "cash_and_equivalents",
    ],
  );
  return rows[0]!.id;
}

type Bank = { id: string; glAccountId: string };

/** A bank account with its own GL account, so tests never share candidates. */
async function newBank(): Promise<Bank> {
  const glAccountId = await newGl(entity, String(glCounter++));
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO bank_accounts
       (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version,
        gl_account_id, created_by)
     VALUES ($1, $2, 'BCA', 'Kas Operasional', '\\x00', $3, '1234', 1, $4, $5)
     RETURNING id`,
    [
      tenantId,
      entity,
      randomBytes(32).toString("hex"),
      glAccountId,
      finance.userId,
    ],
  );
  bankAccountIds.push(rows[0]!.id);
  return { id: rows[0]!.id, glAccountId };
}

/** One posted, balanced journal moving the bank's GL account by `amount`. */
async function seedJournal(
  bank: Bank,
  date: string,
  amount: number,
  options: { reversalOf?: string } = {},
): Promise<string> {
  return ownerTx(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)
       RETURNING id`,
      [
        tenantId,
        entity,
        date,
        periodId,
        options.reversalOf ? "reversal" : "manual",
        `Jurnal uji ${unique()}`,
        options.reversalOf ?? null,
        `stmt-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    const abs = Math.abs(amount);
    const bankDebit = amount > 0 ? abs : 0;
    const bankCredit = amount > 0 ? 0 : abs;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, $6), ($1, $2, $4, 2, $6, $5)`,
      [tenantId, id, bank.glAccountId, revenueAccount, bankDebit, bankCredit],
    );
    return id;
  });
}

async function seedDeposit(
  bank: Bank,
  amount: number,
  depositedAt: string,
  outletId = outletJakarta,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO cash_deposits
       (tenant_id, legal_entity_id, outlet_id, bank_account_id, amount_idr,
        covers_from, covers_to, deposited_at, deposited_by)
     VALUES ($1, $2, $3, $4, $5, '2026-10-30', '2026-10-31', $6, $7)
     RETURNING id`,
    [tenantId, entity, outletId, bank.id, amount, depositedAt, finance.userId],
  );
  return rows[0]!.id;
}

async function setTolerance(days: number) {
  await owner.query(
    `INSERT INTO finance_policies (tenant_id, bank_matching_date_tolerance_days)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET bank_matching_date_tolerance_days = EXCLUDED.bank_matching_date_tolerance_days`,
    [tenantId, days],
  );
}

const post = (
  cookie: string,
  bankAccountId: string,
  rows: Row[] | string,
  options: { key?: string; tenantHeader?: string; fileName?: string } = {},
) => {
  const call = request(host)
    .post(importPath(bankAccountId))
    .set(originHeader)
    .set("Cookie", cookie)
    .send({
      fileName: options.fileName ?? "mutasi-nov.csv",
      csv: typeof rows === "string" ? rows : csvOf(rows),
      mapping: MAPPING,
      idempotencyKey: options.key ?? `imp-${randomUUID()}`,
    });
  return options.tenantHeader
    ? call.set("x-test-tenant", options.tenantHeader)
    : call;
};

type LineRow = {
  description: string;
  match_status: string;
  amount_idr: string;
};
async function lines(bank: Bank): Promise<Record<string, LineRow>> {
  const { rows } = await owner.query<LineRow>(
    `SELECT description, match_status, amount_idr::text
       FROM bank_statement_lines WHERE bank_account_id = $1`,
    [bank.id],
  );
  return Object.fromEntries(rows.map((row) => [row.description, row]));
}
const count = async (table: string, bank: Bank) =>
  (
    await owner.query(
      `SELECT 1 FROM ${table} WHERE bank_account_id = $1`,
      [bank.id],
    )
  ).rowCount;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  entity = await newEntity(tenantId);
  revenueAccount = await newGl(entity, "4101", {
    type: "revenue",
    group: "revenue",
  });
  const period = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11') RETURNING id`,
    [tenantId, entity],
  );
  periodId = period.rows[0]!.id;
  // Own outlet so its time zone is known: Asia/Jakarta (UTC+7).
  outletJakarta = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Mutasi', 'Jl. Mutasi', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletJakarta, tenantId, brandId, entity, `MT-${unique()}`.toUpperCase()],
  );
  outletIds.push(outletJakarta);
  await setTolerance(2);
});

afterAll(async () => {
  const tenants = [tenantId, ...otherTenantIds];
  const quiet = (sql: string, params: unknown[]) =>
    owner.query(sql, params).catch(() => undefined);
  await quiet(
    "DELETE FROM bank_statement_line_matches WHERE bank_account_id = ANY($1::uuid[])",
    [bankAccountIds],
  );
  await quiet("DELETE FROM cash_deposits WHERE legal_entity_id = ANY($1::uuid[])", [
    entityIds,
  ]);
  await quiet(
    "DELETE FROM bank_statement_lines WHERE tenant_id = ANY($1::uuid[]) AND bank_account_id IN (SELECT id FROM bank_accounts WHERE legal_entity_id = ANY($2::uuid[]) OR tenant_id = ANY($3::uuid[]))",
    [tenants, entityIds, otherTenantIds],
  );
  await quiet(
    "DELETE FROM bank_statement_imports WHERE bank_account_id = ANY($1::uuid[])",
    [bankAccountIds],
  );
  await quiet(
    "DELETE FROM bank_accounts WHERE legal_entity_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])",
    [entityIds, otherTenantIds],
  );
  await quiet(
    "DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE legal_entity_id = ANY($1::uuid[]))",
    [entityIds],
  );
  await quiet(
    "DELETE FROM journal_entries WHERE legal_entity_id = ANY($1::uuid[])",
    [entityIds],
  );
  await quiet("DELETE FROM fiscal_periods WHERE legal_entity_id = ANY($1::uuid[])", [
    entityIds,
  ]);
  await quiet(
    "DELETE FROM chart_of_accounts WHERE legal_entity_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])",
    [entityIds, otherTenantIds],
  );
  await quiet("DELETE FROM outlets WHERE id = ANY($1::uuid[])", [outletIds]);
  await quiet("DELETE FROM finance_policies WHERE tenant_id = $1", [tenantId]);
  await quiet("DELETE FROM legal_entities WHERE id = ANY($1::uuid[])", [
    entityIds,
  ]);
  if (otherTenantIds.length > 0) {
    await quiet("DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
    await quiet("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await quiet(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await quiet("DELETE FROM roles WHERE id = ANY($1::uuid[])", [createdRoleIds]);
    await quiet('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-fnxl.3 bank statement import", () => {
  it("(a) imports lines, a re-upload under a new key adds nothing, the same key replays the identical answer", async () => {
    const bank = await newBank();
    const rows: Row[] = [
      { date: "2026-11-03", description: "Biaya admin", amount: -15_000 },
      { date: "2026-11-03", description: "Biaya admin", amount: -15_000 },
      { date: "2026-11-04", description: "Setoran", amount: 900_000 },
    ];
    const key = `imp-${randomUUID()}`;
    const first = await post(finance.cookie, bank.id, rows, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      bankAccountId: bank.id,
      fileName: "mutasi-nov.csv",
      importedBy: finance.userId,
      lineCount: 3,
      duplicateCount: 0,
      autoMatchedCount: 0,
      postedFrom: "2026-11-03",
      postedTo: "2026-11-04",
    });
    // The two identical fees are two real lines.
    expect(await count("bank_statement_lines", bank)).toBe(3);

    const again = await post(finance.cookie, bank.id, rows);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).not.toBe(first.body.data.id);
    expect(again.body.data).toMatchObject({
      lineCount: 0,
      duplicateCount: 3,
      autoMatchedCount: 0,
    });
    expect(await count("bank_statement_lines", bank)).toBe(3);

    const importsBefore = await count("bank_statement_imports", bank);
    const replay = await post(finance.cookie, bank.id, rows, { key });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await count("bank_statement_imports", bank)).toBe(importsBefore);
    expect(await count("bank_statement_lines", bank)).toBe(3);
  });

  it("(b) auto-matches only an exact amount inside the tolerance; one day outside or 1 rupiah off stays unmatched", async () => {
    await setTolerance(2);
    const bank = await newBank();
    const inside = await seedJournal(bank, "2026-11-12", 500_000); // +2 days
    await seedJournal(bank, "2026-11-23", 600_000); // 3 days after the line
    await seedJournal(bank, "2026-11-10", 700_001); // amount off by 1
    const moneyOut = await seedJournal(bank, "2026-11-10", -15_000);

    const response = await post(finance.cookie, bank.id, [
      { date: "2026-11-10", description: "Dalam toleransi", amount: 500_000 },
      { date: "2026-11-20", description: "Luar toleransi", amount: 600_000 },
      { date: "2026-11-10", description: "Selisih satu", amount: 700_000 },
      { date: "2026-11-10", description: "Uang keluar", amount: -15_000 },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      lineCount: 4,
      autoMatchedCount: 2,
    });
    const state = await lines(bank);
    expect(state["Dalam toleransi"]!.match_status).toBe("auto_matched");
    expect(state["Uang keluar"]!.match_status).toBe("auto_matched");
    expect(state["Luar toleransi"]!.match_status).toBe("unmatched");
    expect(state["Selisih satu"]!.match_status).toBe("unmatched");
    const matches = await owner.query<{ ref_type: string; ref_id: string }>(
      "SELECT ref_type, ref_id FROM bank_statement_line_matches WHERE bank_account_id = $1",
      [bank.id],
    );
    expect(matches.rows.map((row) => row.ref_id).sort()).toEqual(
      [inside, moneyOut].sort(),
    );
    expect(matches.rows.every((row) => row.ref_type === "journal_entry")).toBe(
      true,
    );
  });

  it("(b) a policy tolerance of 0 days is honoured, and raising it later lets the waiting line match on the next import", async () => {
    const bank = await newBank();
    await seedJournal(bank, "2026-11-11", 800_000); // one day after the line
    await seedJournal(bank, "2026-11-10", 810_000); // same day

    await setTolerance(0);
    const first = await post(finance.cookie, bank.id, [
      { date: "2026-11-10", description: "Sehari lewat", amount: 800_000 },
      { date: "2026-11-10", description: "Hari sama", amount: 810_000 },
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.autoMatchedCount).toBe(1);
    let state = await lines(bank);
    expect(state["Hari sama"]!.match_status).toBe("auto_matched");
    expect(state["Sehari lewat"]!.match_status).toBe("unmatched");

    await setTolerance(1);
    const second = await post(finance.cookie, bank.id, [
      { date: "2026-11-15", description: "Baris lain", amount: 1_000 },
    ]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    state = await lines(bank);
    expect(state["Sehari lewat"]!.match_status).toBe("auto_matched");
    expect(state["Baris lain"]!.match_status).toBe("unmatched");
    await setTolerance(2);
  });

  it("(c) two candidates with the same amount and date: the line stays unmatched (no guess)", async () => {
    await setTolerance(2);
    const bank = await newBank();
    await seedJournal(bank, "2026-11-10", 400_000);
    await seedJournal(bank, "2026-11-10", 400_000);
    await seedJournal(bank, "2026-11-10", 410_000); // control: unique pair

    const response = await post(finance.cookie, bank.id, [
      { date: "2026-11-10", description: "Dua kandidat", amount: 400_000 },
      { date: "2026-11-10", description: "Satu kandidat", amount: 410_000 },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.autoMatchedCount).toBe(1);
    const state = await lines(bank);
    expect(state["Dua kandidat"]!.match_status).toBe("unmatched");
    expect(state["Satu kandidat"]!.match_status).toBe("auto_matched");
    expect(await count("bank_statement_line_matches", bank)).toBe(1);
  });

  it("(c) two lines wanting one document: both stay unmatched", async () => {
    await setTolerance(2);
    const bank = await newBank();
    await seedJournal(bank, "2026-11-10", 300_000);
    await seedJournal(bank, "2026-11-10", 310_000); // control: unique pair

    const response = await post(finance.cookie, bank.id, [
      { date: "2026-11-10", description: "Kembar satu", amount: 300_000 },
      { date: "2026-11-11", description: "Kembar dua", amount: 300_000 },
      { date: "2026-11-10", description: "Pasangan unik", amount: 310_000 },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.autoMatchedCount).toBe(1);
    const state = await lines(bank);
    expect(state["Kembar satu"]!.match_status).toBe("unmatched");
    expect(state["Kembar dua"]!.match_status).toBe("unmatched");
    expect(state["Pasangan unik"]!.match_status).toBe("auto_matched");
    expect(await count("bank_statement_line_matches", bank)).toBe(1);
  });

  it("(d) a cash deposit's date is its day in the outlet time zone (2026-11-01T18:30Z in Asia/Jakarta is 2026-11-02)", async () => {
    await setTolerance(0);
    const bank = await newBank();
    const onLocalDay = await seedDeposit(bank, 250_000, "2026-11-01T18:30:00Z");
    const onUtcDay = await seedDeposit(bank, 260_000, "2026-11-01T18:30:00Z");

    const response = await post(finance.cookie, bank.id, [
      { date: "2026-11-02", description: "Setoran tanggal lokal", amount: 250_000 },
      { date: "2026-11-01", description: "Setoran tanggal UTC", amount: 260_000 },
    ]);
    await setTolerance(2);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.autoMatchedCount).toBe(1);

    const state = await lines(bank);
    expect(state["Setoran tanggal lokal"]!.match_status).toBe("auto_matched");
    expect(state["Setoran tanggal UTC"]!.match_status).toBe("unmatched");

    const deposits = await owner.query<{
      id: string;
      status: string;
      bank_statement_line_id: string | null;
    }>("SELECT id, status, bank_statement_line_id FROM cash_deposits WHERE bank_account_id = $1", [
      bank.id,
    ]);
    const byId = Object.fromEntries(deposits.rows.map((row) => [row.id, row]));
    expect(byId[onLocalDay]).toMatchObject({ status: "matched" });
    expect(byId[onLocalDay]!.bank_statement_line_id).not.toBeNull();
    expect(byId[onUtcDay]).toMatchObject({
      status: "recorded",
      bank_statement_line_id: null,
    });
    const match = await owner.query(
      "SELECT 1 FROM bank_statement_line_matches WHERE bank_account_id = $1 AND ref_type = 'cash_deposit' AND ref_id = $2",
      [bank.id, onLocalDay],
    );
    expect(match.rowCount).toBe(1);
  });

  it("(e) a reversed journal and its reversal are not candidates", async () => {
    await setTolerance(2);
    const bank = await newBank();
    const original = await seedJournal(bank, "2026-11-10", 350_000);
    await seedJournal(bank, "2026-11-10", -350_000, { reversalOf: original });
    await seedJournal(bank, "2026-11-10", 360_000); // control

    const response = await post(finance.cookie, bank.id, [
      { date: "2026-11-10", description: "Jurnal dibalik", amount: 350_000 },
      { date: "2026-11-10", description: "Jurnal pembalik", amount: -350_000 },
      { date: "2026-11-10", description: "Jurnal sehat", amount: 360_000 },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.autoMatchedCount).toBe(1);
    const state = await lines(bank);
    expect(state["Jurnal dibalik"]!.match_status).toBe("unmatched");
    expect(state["Jurnal pembalik"]!.match_status).toBe("unmatched");
    expect(state["Jurnal sehat"]!.match_status).toBe("auto_matched");
  });

  it("(f) another tenant's bank account is 404 and nothing is written; an unknown id is 404 too", async () => {
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Statements other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `bnkstmt-${unique()}`, tenantId],
    );
    const otherEntity = await newEntity(otherTenant);
    const otherGl = await newGl(otherEntity, "1103", { tenant: otherTenant });
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version,
          gl_account_id, created_by)
       VALUES ($1, $2, 'BNI', 'Other', '\\x00', $3, '0000', 1, $4, $5)
       RETURNING id`,
      [otherTenant, otherEntity, "b".repeat(64), otherGl, finance.userId],
    );
    const foreign = rows[0]!.id;

    const crossTenant = await post(finance.cookie, foreign, [
      { date: "2026-11-10", description: "Lintas tenant", amount: 1_000 },
    ]);
    expect(crossTenant.status, JSON.stringify(crossTenant.body)).toBe(404);
    expect(crossTenant.body.error.code).toBe("NOT_FOUND");
    expect(
      (
        await owner.query(
          "SELECT 1 FROM bank_statement_lines WHERE bank_account_id = $1",
          [foreign],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM bank_statement_imports WHERE bank_account_id = $1",
          [foreign],
        )
      ).rowCount,
    ).toBe(0);

    const unknown = await post(finance.cookie, randomUUID(), [
      { date: "2026-11-10", description: "Tidak ada", amount: 1_000 },
    ]);
    expect(unknown.status).toBe(404);

    // The same user pinned to the other tenant holds no role there.
    const mine = await newBank();
    const pinned = await post(
      finance.cookie,
      mine.id,
      [{ date: "2026-11-10", description: "Tenant lain", amount: 1_000 }],
      { tenantHeader: otherTenant },
    );
    expect(pinned.status).toBe(403);
    expect(await count("bank_statement_lines", mine)).toBe(0);
  });

  it("(f) no permission is 403, no session is 401; nothing is written", async () => {
    const bank = await newBank();
    const rows: Row[] = [
      { date: "2026-11-10", description: "Tanpa izin", amount: 1_000 },
    ];
    const stranger = await signedIn();
    expect((await post(stranger.cookie, bank.id, rows)).status).toBe(403);

    const cashier = await signedIn();
    await assignTemplate(cashier.userId, "cashier");
    expect((await post(cashier.cookie, bank.id, rows)).status).toBe(403);

    const anonymous = await request(host)
      .post(importPath(bank.id))
      .set(originHeader)
      .send({
        fileName: "x.csv",
        csv: csvOf(rows),
        mapping: MAPPING,
        idempotencyKey: `imp-${randomUUID()}`,
      });
    expect(anonymous.status).toBe(401);
    expect(await count("bank_statement_lines", bank)).toBe(0);
    expect(await count("bank_statement_imports", bank)).toBe(0);
  });

  it("(f) an outlet-scoped caller is refused 403 (OUTLET_OUT_OF_SCOPE at the service) and nothing is written", async () => {
    const bank = await newBank();
    const rows: Row[] = [
      { date: "2026-11-10", description: "Per outlet", amount: 1_000 },
    ];
    const scoped = await signedIn();
    await assignOutletScopedReconcile(scoped.userId, outletA);
    expect((await post(scoped.cookie, bank.id, rows)).status).toBe(403);

    await expect(
      importBankStatement(
        scopeFor({ kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] }),
        bank.id,
        {
          fileName: "x.csv",
          csv: csvOf(rows),
          mapping: MAPPING,
          idempotencyKey: `imp-${randomUUID()}`,
        },
        userIdSchema.parse(finance.userId),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    expect(await count("bank_statement_lines", bank)).toBe(0);
    expect(await count("bank_statement_imports", bank)).toBe(0);
  });

  it("(g) one unreadable row refuses the whole file with 422 STATEMENT_VALUE_INVALID naming the row; nothing is written", async () => {
    await setTolerance(2);
    const bank = await newBank();
    await seedJournal(bank, "2026-11-10", 450_000); // would match row 2
    const csv = [
      "Tanggal,Keterangan,Jumlah",
      `2026-11-10,Baris baik,${money(450_000)}`,
      `2026-11-11,Baris rusak,"1.234,50"`,
    ].join("\n");
    const response = await post(finance.cookie, bank.id, csv);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(response.body.error.message).toContain("Baris 3");
    expect(await count("bank_statement_lines", bank)).toBe(0);
    expect(await count("bank_statement_imports", bank)).toBe(0);
    expect(await count("bank_statement_line_matches", bank)).toBe(0);
  });

  it("(g) an unterminated quote and an empty file body are refused 422 and write nothing", async () => {
    const bank = await newBank();
    const broken = await post(
      finance.cookie,
      bank.id,
      `Tanggal,Keterangan,Jumlah\n2026-11-10,"Tanpa tutup,${money(1_000)}\n`,
    );
    expect(broken.status, JSON.stringify(broken.body)).toBe(422);
    expect(broken.body.error.code).toBe("STATEMENT_VALUE_INVALID");

    const headerOnly = await post(
      finance.cookie,
      bank.id,
      "Tanggal,Keterangan,Jumlah\n",
    );
    expect(headerOnly.status, JSON.stringify(headerOnly.body)).toBe(422);
    expect(headerOnly.body.error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(await count("bank_statement_lines", bank)).toBe(0);
    expect(await count("bank_statement_imports", bank)).toBe(0);
  });
});
