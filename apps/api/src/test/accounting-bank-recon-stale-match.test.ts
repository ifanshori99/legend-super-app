// Stale bank match when its journal is reversed (bead legend-fnxl.10, WS-07;
// PRD v1.7 §3.19 Kas & Bank, ACC-04 "setiap selisih menjadi kasus dengan PIC";
// TEN-01/02/03). Fail-first: written before the behavior exists.
//
// Behavior under test (from the brief): when a journal that is matched to a
// bank statement line is reversed, the match turns stale instead of silently
// staying "clean": the match row is kept (never deleted, amount untouched), it
// is marked stale, and a reconciliation case is opened so a person decides what
// to do. The journal and its numbers are not touched. Reversing again or
// retrying never doubles the case. Another tenant is not affected.
//
// Assumptions (the contract does not fix them, so the tests do not either):
// - The case is read through the public service `listReconciliationCases`; its
//   `type` is not asserted (bank_statement or a new type are both fine). The
//   case must reference the reversed journal (journal_entry) or the matched
//   statement line (bank_statement_line), whichever the engineer chooses.
// - The only column name locked is `stale_at` on bank_statement_line_matches
//   (non-null once stale, null otherwise). It is read via to_jsonb() so a
//   missing column fails as a wrong value, not as a SQL error.
// - The match is created for a `journal_entry` ref (the type of the journal
//   that is reversed), the same way accounting-bank-recon-cases.test.ts seeds
//   matched journals.
// - "Not counted as a clean match in the summary" has no public contract yet,
//   so it is not asserted here.
// - Fixtures go straight into the tables through the owner pool; every test
//   owns a fresh legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { reconciliationCaseSchema } from "@starter/shared/accounting";
import { createApp } from "../app";
import { listReconciliationCases } from "../services/accounting-bank-recon-cases.service";
import { reverseJournal } from "../services/accounting-journal.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const createdEntities: { tenant: string; id: string }[] = [];
const unique = () => randomBytes(4).toString("hex");

function scope(tenant: string = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

let actorId: string;

async function signedInUser(): Promise<string> {
  const email = `stale-match-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Stale match", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return userId;
}

// ---------------------------------------------------------------- fixtures

type Entity = {
  tenant: string;
  id: string;
  glAccountId: string;
  revenueAccountId: string;
  periodId: string;
  bankAccountId: string;
  importId: string;
};

async function seedEntity(tenant: string = tenantId): Promise<Entity> {
  const id = randomUUID();
  const glAccountId = randomUUID();
  const revenueAccountId = randomUUID();
  const periodId = randomUUID();
  const bankAccountId = randomUUID();
  const importId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenant, `Stale match entity ${unique()}`],
  );
  createdEntities.push({ tenant, id });
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1102', 'Bank', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [glAccountId, revenueAccountId, tenant, id],
  );
  await owner.query(
    "INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, '2026-11')",
    [periodId, tenant, id],
  );
  await owner.query(
    `INSERT INTO bank_accounts
       (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
     VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
    [
      bankAccountId,
      tenant,
      id,
      randomBytes(32),
      randomBytes(32).toString("hex"),
      glAccountId,
    ],
  );
  await owner.query(
    `INSERT INTO bank_statement_imports
       (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by, line_count, duplicate_count, auto_matched_count)
     VALUES ($1, $2, $3, 'seed.csv', $4, 'seed', 0, 0, 0)`,
    [importId, tenant, bankAccountId, randomBytes(32).toString("hex")],
  );
  return {
    tenant,
    id,
    glAccountId,
    revenueAccountId,
    periodId,
    bankAccountId,
    importId,
  };
}

async function seedLine(entity: Entity, amount = 10_000): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description,
        dedupe_key, match_status)
     VALUES ($1, $2, $3, $4, '2026-11-05', $5, 'Setoran', $6, 'auto_matched')`,
    [
      id,
      entity.tenant,
      entity.bankAccountId,
      entity.importId,
      amount,
      `k-${id}`,
    ],
  );
  return id;
}

/** A posted manual entry debiting the bank account `debit` rupiah. */
async function seedJournal(entity: Entity, debit: number): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-05', $3, 'manual', 'Setoran dicocokkan', $4, $5)
       RETURNING id`,
      [
        entity.tenant,
        entity.id,
        entity.periodId,
        `stale-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [entity.tenant, id, entity.glAccountId, entity.revenueAccountId, debit],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedMatch(
  entity: Entity,
  lineId: string,
  journalId: string,
  amount = 10_000,
) {
  await owner.query(
    `INSERT INTO bank_statement_line_matches
       (tenant_id, bank_account_id, line_id, ref_type, ref_id, amount_idr, source, matched_by)
     VALUES ($1, $2, $3, 'journal_entry', $4, $5, 'auto', 'seed')`,
    [entity.tenant, entity.bankAccountId, lineId, journalId, amount],
  );
}

/** One entity with a journal matched to a statement line. */
async function matchedJournal(tenant: string = tenantId, debit = 10_000) {
  const entity = await seedEntity(tenant);
  const journalId = await seedJournal(entity, debit);
  const lineId = await seedLine(entity, debit);
  await seedMatch(entity, lineId, journalId, debit);
  return { entity, journalId, lineId, debit };
}

// ----------------------------------------------------------------- helpers

type MatchRow = {
  id: string;
  line_id: string;
  ref_type: string;
  ref_id: string;
  amount_idr: string;
  source: string;
  stale_at: string | null;
};

async function matchesOf(tenant: string, journalId: string) {
  const { rows } = await owner.query<MatchRow>(
    `SELECT m.id, m.line_id, m.ref_type, m.ref_id, m.amount_idr::text AS amount_idr, m.source,
            to_jsonb(m) ->> 'stale_at' AS stale_at
       FROM bank_statement_line_matches m
      WHERE m.tenant_id = $1 AND m.ref_id = $2`,
    [tenant, journalId],
  );
  return rows;
}

async function journalFigures(entityId: string, journalId: string) {
  const { rows } = await owner.query<{
    debit: string;
    credit: string;
    lines: string;
  }>(
    `SELECT sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit, count(*)::text AS lines
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
    [tenantId, journalId],
  );
  const { rows: entries } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entityId],
  );
  return { ...rows[0]!, entries: entries[0]!.n };
}

async function casesOf(entity: Entity) {
  const result = await listReconciliationCases(scope(entity.tenant), {
    legalEntityId: entity.id,
    limit: 50,
  });
  return result.data.map((row) => reconciliationCaseSchema.parse(row));
}

async function reverse(
  entity: Entity,
  journalId: string,
  idempotencyKey = `rev-${randomUUID()}`,
) {
  return reverseJournal(
    scope(entity.tenant),
    journalId,
    {
      entryDate: businessDateSchema.parse("2026-11-05"),
      reason: "Koreksi (stale match test)",
      idempotencyKey,
    },
    userIdSchema.parse(actorId),
    new Date(),
  );
}

async function newTenant() {
  const id = tenantIdSchema.parse(randomUUID());
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Stale match other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `stale-${unique()}`, tenantId],
  );
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorId = await signedInUser();
});

afterAll(async () => {
  // Journals are append-only and FKs point both ways: replica mode lets the
  // owner remove the fixtures in one go.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const { tenant, id } of createdEntities) {
      const args = [tenant, id];
      const byEntity = "tenant_id = $1 AND legal_entity_id = $2";
      const accounts = `(SELECT id FROM bank_accounts WHERE ${byEntity})`;
      await client.query(
        `DELETE FROM bank_statement_line_matches WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_statement_lines WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_statement_imports WHERE tenant_id = $1 AND bank_account_id IN ${accounts}`,
        args,
      );
      await client.query(
        `DELETE FROM bank_reconciliation_case_events WHERE tenant_id = $1 AND case_id IN
           (SELECT id FROM bank_reconciliation_cases WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM bank_reconciliation_cases WHERE ${byEntity}`,
        args,
      );
      await client.query(`DELETE FROM bank_accounts WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM app.journal_entry_seals WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(`DELETE FROM journal_entries WHERE ${byEntity}`, args);
      await client.query(`DELETE FROM fiscal_periods WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM chart_of_accounts WHERE ${byEntity}`,
        args,
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        args,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (otherTenantIds.length > 0)
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  if (createdUserIds.length > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  await owner.end();
});

describe("legend-fnxl.10 stale bank match when its journal is reversed (ACC-04)", () => {
  it("control: a matched journal that is not reversed stays a clean match with no case", async () => {
    const { entity, journalId } = await matchedJournal();
    const [match] = await matchesOf(tenantId, journalId);
    expect(match?.stale_at ?? null).toBeNull();
    expect(await casesOf(entity)).toEqual([]);
  });

  it("reversing a matched journal marks the match stale and keeps the match row", async () => {
    const { entity, journalId, lineId, debit } = await matchedJournal();
    await reverse(entity, journalId);

    const matches = await matchesOf(tenantId, journalId);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      line_id: lineId,
      ref_type: "journal_entry",
      ref_id: journalId,
      amount_idr: String(debit),
      source: "auto",
    });
    expect(matches[0]!.stale_at).not.toBeNull();
  });

  it("reversing a matched journal opens one open reconciliation case that shows in the list", async () => {
    const { entity, journalId, lineId } = await matchedJournal();
    await reverse(entity, journalId);

    const cases = await casesOf(entity);
    expect(cases).toHaveLength(1);
    const [opened] = cases;
    expect(opened!.status).toBe("open");
    expect(opened!.legalEntityId).toBe(entity.id);
    expect(opened!.resolvedAt).toBeNull();
    expect(opened!.adjustmentJournalEntryId).toBeNull();
    const refs = opened!.refs.map((ref) => `${ref.type}:${ref.id}`);
    expect(
      refs.includes(`journal_entry:${journalId}`) ||
        refs.includes(`bank_statement_line:${lineId}`),
    ).toBe(true);
  });

  it("the original journal's numbers do not change and the reversal posts exactly one mirror entry", async () => {
    const { entity, journalId } = await matchedJournal(tenantId, 12_345);
    const before = await journalFigures(entity.id, journalId);
    expect(before).toMatchObject({
      debit: "12345",
      credit: "12345",
      lines: "2",
      entries: "1",
    });
    await reverse(entity, journalId);
    const after = await journalFigures(entity.id, journalId);
    expect(after).toEqual({ ...before, entries: "2" });
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
      [tenantId, journalId],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("the statement line and the match amount are untouched", async () => {
    const { entity, journalId, lineId } = await matchedJournal(tenantId, 7_500);
    await reverse(entity, journalId);
    const { rows } = await owner.query<{ amount_idr: string }>(
      "SELECT amount_idr::text AS amount_idr FROM bank_statement_lines WHERE id = $1",
      [lineId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe("7500");
    const matches = await matchesOf(tenantId, journalId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.amount_idr).toBe("7500");
  });

  it("retrying the same reversal (same key) does not double the case or the match", async () => {
    const { entity, journalId } = await matchedJournal();
    const key = `rev-${randomUUID()}`;
    await reverse(entity, journalId, key);
    await reverse(entity, journalId, key);

    expect(await casesOf(entity)).toHaveLength(1);
    const matches = await matchesOf(tenantId, journalId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.stale_at).not.toBeNull();
  });

  it("reversing the same journal a second time (new key) never doubles the case", async () => {
    const { entity, journalId } = await matchedJournal();
    await reverse(entity, journalId);
    // The ledger may refuse a second reversal; either answer is fine here.
    await reverse(entity, journalId).catch(() => undefined);

    expect(await casesOf(entity)).toHaveLength(1);
    expect(await matchesOf(tenantId, journalId)).toHaveLength(1);
  });

  it("a journal with no bank match opens no case when reversed", async () => {
    const entity = await seedEntity();
    const journalId = await seedJournal(entity, 10_000);
    await reverse(entity, journalId);
    expect(await casesOf(entity)).toEqual([]);
  });

  it("another matched journal in the same tenant that is not reversed stays clean", async () => {
    const reversed = await matchedJournal();
    const untouched = await matchedJournal();
    await reverse(reversed.entity, reversed.journalId);

    const [other] = await matchesOf(tenantId, untouched.journalId);
    expect(other?.stale_at ?? null).toBeNull();
    expect(await casesOf(untouched.entity)).toEqual([]);
  });

  it("another tenant's match is not affected, even with the same ref id", async () => {
    const { entity, journalId } = await matchedJournal();
    const otherTenant = await newTenant();
    const otherEntity = await seedEntity(otherTenant);
    const otherLine = await seedLine(otherEntity);
    // Same ref id in another tenant: unique is (tenant, refType, refId), so
    // this is allowed and must not be touched by our reversal.
    await seedMatch(otherEntity, otherLine, journalId);

    await reverse(entity, journalId);

    const [foreign] = await matchesOf(otherTenant, journalId);
    expect(foreign).toBeDefined();
    expect(foreign!.stale_at ?? null).toBeNull();
    expect(await casesOf(otherEntity)).toEqual([]);
    // And ours did turn stale, so the test cannot pass by doing nothing.
    const [ours] = await matchesOf(tenantId, journalId);
    expect(ours!.stale_at).not.toBeNull();
  });
});
